/**
 * Loop executor: sequential, verified, round-based.
 *
 *   add leverage   ("up"):        borrow USDC -> spot BUY INJ -> deposit_collateral
 *   reduce leverage ("down"):     [repay from wallet USDC first] -> withdraw_collateral -> spot SELL INJ -> return USDC
 *   full exit ("emergency"):      reduce until the debt is 0, then optionally sell the remaining INJ
 *
 * Every step is its own transaction and is verified against the bank balance before the next
 * one starts. Between the withdraw and the sale the interim LTV never exceeds `roundLtvCap`
 * (0.70 = ~12.5 % price buffer); if the LTV is already above that, small steps up to
 * `stepLtvLimit` (0.77, contract limit 0.78) are taken - never the whole amount at once.
 *
 * This is a port of the author's production executor (ten audit rounds, fault-injection harness).
 * Differences: no distributed lease (single runner per address is enforced by the caller), pause is
 * a `shouldStop()` callback, the signer is a port. Do not "simplify" the bookkeeping around
 * unsold withdrawn INJ, pending withdraws or proceeds - each line exists because of a real incident.
 */
import type { Status } from '../chain/neptune'
import { ASSETS } from '../config/chain'
import { worstBuy, worstSell } from './orderbook'
import { DEFAULT_EXECUTION, StoppedError, UnclearTxError, type ExecLogEntry, type ExecPorts, type ExecResult, type ExecutionConfig, type LoopRequest } from './types'

const UNCLEAR_RE = /timeout|unclear|not included|not found|late|fetch failed|network|ECONN|socket|abort|429|5\d\d/i
const isUnclear = (e: unknown) => e instanceof UnclearTxError || UNCLEAR_RE.test(String(e))

const USDC = ASSETS.USDC.denom
const USDT = ASSETS.USDT.denom

/** Helix min notional is 1 USDC -> never place orders below ~$1.05. */
const minQty = (price: number) => Math.max(0.05, 1.05 / Math.max(price, 0.01))

const clampSlip = (pct: number | undefined, cfg: ExecutionConfig) =>
  Math.min(cfg.slipMax, Math.max(cfg.slipMin, (Number.isFinite(pct as number) ? (pct as number) : 1.0) / 100))

/**
 * Safe withdraw step (USD, valued at C): interim LTV at most max(roundLtvCap, LTV + 0.04) so that even
 * just below the cap a step of >= 4 LTV points remains (no geometrically shrinking mini-steps), and never
 * above the contract limit (allowable − 0.01). Both bounds scale with the chain's liquidation LTV (base 0.80).
 */
export function safeStep(C: number, D: number, liq = 0.8, allowable = 0.78, cfg: ExecutionConfig = DEFAULT_EXECUTION): number {
  if (!(C > 0) || !(D >= 0)) return 0
  const sc = liq > 0 ? liq / 0.8 : 1
  const roundCap = cfg.roundLtvCap * sc
  const stepLimit = Math.min(cfg.stepLtvLimit * sc, (allowable > 0 ? allowable : 0.78) - 0.01)
  const cap = Math.min(stepLimit, Math.max(roundCap, D / C + 0.04))
  return Math.max(0, C - D / cap)
}

/** Health projection from the current collateral factor (health × ltv), 0.8 when debt-free. */
export function projHealth(s: Status, collUsd: number, debtUsd: number): number {
  if (debtUsd <= 0.01) return 99
  const cf = s.debtUsd > 1 && s.health > 0 && s.ltv > 0 ? s.health * s.ltv : 0.8
  return (cf * collUsd) / debtUsd
}

/** INJ amount -> raw 18-decimal integer string, via BigInt (no float exponent notation). */
export function injToRaw(amount: number): string {
  return (BigInt(Math.floor(amount * 1e6)) * 10n ** 12n).toString()
}

/** Convert an INJ amount to collateral SHARES using the exact pool figures from the status. */
export function injAmountToShares(amountInj: number, s: Status): string {
  const pool = s.collateralShares['inj']
  if (!pool) throw new Error('No INJ collateral position')
  if (/[eE]/.test(pool.poolBalance) || /[eE]/.test(pool.poolShares)) throw new Error('Pool figures in exponent notation - share conversion aborted (safety stop)')
  const pb = BigInt(pool.poolBalance.split('.')[0])
  const ps = BigInt(pool.poolShares.split('.')[0])
  if (pb <= 0n || ps <= 0n) throw new Error('Pool figures invalid')
  const ratio = Number((ps * 1_000_000n) / pb) / 1e6
  if (ratio < 0.5 || ratio > 1.5) throw new Error(`Share rate implausible (${ratio}) - withdraw aborted`)
  const raw = BigInt(injToRaw(amountInj))
  return ((raw * ps) / pb).toString()
}

export async function executeLoop(req: LoopRequest, ports: ExecPorts, cfg: ExecutionConfig = DEFAULT_EXECUTION): Promise<ExecResult> {
  const log: ExecLogEntry[] = []
  const push = (e: ExecLogEntry) => {
    log.push(e)
    ports.log(e)
  }
  const slip = clampSlip(req.slippagePct, cfg)
  const fee = cfg.feePct / 100
  const t0 = req.startedAt ?? ports.now()
  const outOfTime = () => ports.now() - t0 > cfg.timeBudgetMs
  const outOfTimeForRound = () => ports.now() - t0 > cfg.timeBudgetMs - cfg.roundMarginMs
  const GAS = cfg.gasReserveInj
  let unsoldWithdrawn = 0 // INJ this run withdrew and has NOT sold yet
  let proceedsUsdc = 0 // USDC proceeds of this run not yet repaid
  const targetT = req.mode === 'emergency' ? 0 : (req.targetLtv ?? 0)
  if ((req.mode === 'down' || req.mode === 'up') && !(Number.isFinite(targetT) && targetT >= 0 && targetT <= 0.7)) {
    return { log: [{ step: 'ERROR', info: 'target LTV invalid (0..0.70)' }], done: false }
  }
  let stoppedNow = false
  let pendingWithdraw: { qty: number; injBefore: number } | null = null
  let reservePaid = 0
  const noWalletInj = () => !!req.noWalletInj || stoppedNow
  const noWalletUsdc = () => !!req.noWalletUsdc || stoppedNow
  const checkpoint = async () => {
    if (!stoppedNow && (await ports.shouldStop())) {
      stoppedNow = true
      push({ step: 'stop', info: 'stop/pause requested during the run - wallet funds are no longer touched from here on' })
    }
  }
  const kOf = (st: Status) => (req.refPrice && req.refPrice > 0 && st.injPrice > 0 && req.refPrice < st.injPrice ? Math.max(1 / 1.15, req.refPrice / st.injPrice) : 1)

  const repayFromWallet = async (maxUsd: number, label: string): Promise<number> => {
    const s = await ports.status()
    const debtAmt = s.debts.find((d) => d.symbol === 'USDC')?.amount ?? 0
    const bank = (await ports.bankRaw(USDC)) / 1e6
    const amt = Math.min(maxUsd, bank, debtAmt * 1.0005)
    const fullPayoff = amt >= debtAmt * 0.999
    if ((amt < 1 && !fullPayoff) || amt < 0.05 || debtAmt < 0.05) return 0
    const r = await ports.repay(USDC, Math.floor(amt * 1e6).toString())
    push({ step: label, txHash: r.txHash, info: `${amt.toFixed(2)} USDC repaid from the wallet (reserve-first, no INJ sale)` })
    return amt
  }

  /** Sell wallet INJ (above the gas reserve) in tranches sized by bid depth. Returns USDC gained (base units). */
  const sellWalletInj = async (maxInj: number, slipUse: number, label: string, floorPrice = 0): Promise<number> => {
    let soldRaw = 0
    for (let i = 1; i <= 15; i++) {
      if (outOfTime()) {
        push({ step: label, info: 'time budget - the rest continues next tick' })
        break
      }
      await checkpoint()
      const injBank = (await ports.bankRaw('inj')) / 1e18
      const s0 = await ports.status()
      const mq = minQty(s0.injPrice)
      const avail = Math.min(maxInj, injBank - GAS)
      if (avail < mq) break
      const book = await ports.book('INJ/USDC')
      if (floorPrice > 0 && book.bestBid < floorPrice) {
        push({ step: label, info: `bid ${book.bestBid.toFixed(3)} below reference ${floorPrice.toFixed(3)} - ${avail.toFixed(3)} INJ stay in the wallet for now` })
        break
      }
      const maxByDepth = (book.depthBidNearUsd * cfg.depthShare) / s0.injPrice
      const qty = Math.min(avail, maxByDepth)
      if (qty < mq) {
        push({ step: label, info: `bid depth (2 %) too thin ($${book.depthBidNearUsd.toFixed(0)}) - ${avail.toFixed(3)} INJ stay in the wallet` })
        break
      }
      const worst = worstSell(book, qty, slipUse)
      const before = await ports.bankRaw(USDC)
      const r = await ports.spotMarketOrder('INJ/USDC', 'sell', qty, worst)
      const gained = await ports.waitForFill(USDC, before, qty * worst * 0.98 * 1e6)
      soldRaw += gained
      push({ step: `${label} T${i}`, txHash: r.txHash, info: `${qty.toFixed(3)} INJ sold (worst ${worst.toFixed(3)}) -> ${(gained / 1e6).toFixed(2)} USDC` })
      maxInj -= Math.min(qty, gained / 1e6 / worst)
      if (maxInj < mq) break
    }
    return soldRaw
  }

  const withdrawInj = async (amountInj: number, s: Status) => ports.withdrawCollateral('inj', injAmountToShares(amountInj, s))

  let reserveRawUp = -1
  const returnExcessUsdc = async () => {
    if (reserveRawUp < 0) return
    try {
      const excess = ((await ports.bankRaw(USDC)) - reserveRawUp) / 1e6
      if (excess > 5) await repayFromWallet(excess, 'excess repay')
    } catch (e) {
      push({ step: 'excess repay', info: 'not possible: ' + String(e).slice(0, 100) })
    }
  }

  try {
    const st0 = await ports.status()
    if (!(st0.injPrice > 0)) throw new Error('oracle price 0/invalid - no execution')
    if (st0.address !== ports.address) throw new Error(`address mismatch: status ${st0.address.slice(0, 12)}… vs signer ${ports.address.slice(0, 12)}… - no execution`)

    // ---------------------------------------------------------------- UP
    if (req.mode === 'up') {
      const t = req.targetLtv ?? 0
      if (t > 0.7) throw new Error('target LTV above 70 % is locked')
      const reserveRaw = await ports.bankRaw(USDC)
      reserveRawUp = reserveRaw
      if (reserveRaw > 5e6) push({ step: 'reserve', info: `${(reserveRaw / 1e6).toFixed(2)} USDC stay in the wallet as reserve` })
      for (let round = 1; round <= cfg.maxRounds; round++) {
        if (outOfTimeForRound()) {
          push({ step: 'time', info: 'time budget reached - next tick continues' })
          await returnExcessUsdc()
          return { log, done: false, deferred: true }
        }
        await checkpoint()
        if (stoppedNow) {
          push({ step: 'stop', info: 'stopped - adding halted, excess USDC returned' })
          await returnExcessUsdc()
          return { log, done: false, deferred: true }
        }
        const s = await ports.status()
        const C = s.collateralUsd
        const D = s.debtUsd
        const eff = 1 - fee - slip
        const needed = (t * C - D) / (1 - t * eff)
        const bankLeft = Math.max(0, ((await ports.bankRaw(USDC)) - reserveRaw) / 1e6)
        if (needed < 5) {
          push({ step: 'done', info: `target LTV reached (${((D / C) * 100).toFixed(1)} %)` })
          if (bankLeft >= 5) await returnExcessUsdc()
          return { log, done: true }
        }
        const cap = Math.max(0, cfg.roundLtvCap * C - D)
        const book0 = await ports.book('INJ/USDC')
        const maxByDepth = book0.depthAskNearUsd * cfg.depthShare
        if (book0.bestAsk > s.injPrice * 1.02) {
          push({ step: `R${round}`, info: `book ${((book0.bestAsk / s.injPrice - 1) * 100).toFixed(1)} % above oracle - buy postponed` })
          await returnExcessUsdc()
          return { log, done: false, deferred: true }
        }
        const toBorrow = Math.max(0, Math.min(needed, cap, maxByDepth) - bankLeft)
        if (toBorrow > 1) {
          let r1: { txHash: string }
          try {
            r1 = await ports.borrow(USDC, Math.floor(toBorrow * 1e6).toString())
          } catch (e) {
            push({ step: `R${round} borrow`, info: `borrow rejected (${String(e).slice(0, 100)}) - postponed` })
            await returnExcessUsdc()
            return { log, done: false, deferred: true }
          }
          push({ step: `R${round} borrow`, txHash: r1.txHash, info: `${toBorrow.toFixed(2)} USDC borrowed` })
        } else {
          push({ step: `R${round} borrow`, info: `skipped - ${bankLeft.toFixed(2)} USDC already in the wallet` })
        }
        const book = await ports.book('INJ/USDC')
        const budgetAll = Math.max(0, ((await ports.bankRaw(USDC)) - reserveRaw) / 1e6)
        const budget = Math.min(budgetAll, Math.max(0, Math.min(needed, cap, maxByDepth)) + 2)
        const worst = worstBuy(book, budget / s.injPrice, slip)
        // The chain reserves qty × worst price + taker fee for BUY market orders.
        const injQty = budget / (worst * 1.003)
        if (injQty < 0.01) {
          push({ step: `R${round}`, info: 'buy quantity too small (book too thin) - postponed' })
          await returnExcessUsdc()
          return { log, done: false, deferred: true }
        }
        const beforeInj = await ports.bankRaw('inj')
        const r2 = await ports.spotMarketOrder('INJ/USDC', 'buy', injQty, worst)
        push({ step: `R${round} buy`, txHash: r2.txHash, info: `${injQty.toFixed(3)} INJ bought (worst $${worst.toFixed(3)})` })
        const gained = await ports.waitForFill('inj', beforeInj, injQty * 0.95 * 1e18)
        const depositRaw = (BigInt(Math.floor(gained / 1e12)) * 10n ** 12n).toString()
        const r3 = await ports.deposit('inj', depositRaw)
        push({ step: `R${round} deposit`, txHash: r3.txHash, info: `${(gained / 1e18).toFixed(3)} INJ deposited` })
      }
      await returnExcessUsdc()
      return { log, done: false, deferred: true }
    }

    // ---------------------------------------------------------------- DOWN / EMERGENCY
    await checkpoint()
    {
      const s0 = await ports.status()
      const k0 = kOf(s0)
      const usdcDebt0 = s0.debts.find((d) => d.symbol === 'USDC')?.usd ?? 0
      if (usdcDebt0 > 0.5) {
        // Direct repayment r lowers the LTV to t at r = D − t·C (no sale factor - otherwise the reserve is drained ~2.6× too fast)
        const needRepay = req.mode === 'emergency' ? usdcDebt0 : Math.max(0, s0.debtUsd - targetT * s0.collateralUsd * k0)
        if (noWalletUsdc()) push({ step: 'R0 repay', info: 'wallet USDC left untouched (stop/pause active)' })
        else if (needRepay > 1) {
          try {
            reservePaid = await repayFromWallet(needRepay, 'R0 repay')
          } catch (e) {
            push({ step: 'R0 repay', info: 'skipped: ' + String(e).slice(0, 120) })
          }
        }
      }
    }
    if (req.walletOnly) {
      push({
        step: 'wallet-only',
        info: reservePaid > 0
          ? `oracle expired in the contract or market halted: ${reservePaid.toFixed(2)} USDC repaid from the wallet, nothing more is possible - put more USDC into the wallet!`
          : 'oracle expired in the contract or market halted: no withdraw/sale possible and no wallet USDC available - NOTHING repaid. Put USDC into the wallet!',
      })
      return { log, done: false, deferred: true }
    }
    // Orphaned wallet INJ (earlier partial abort): sell only as much as the target still needs
    {
      const injBank0 = (await ports.bankRaw('inj')) / 1e18
      const orphan = injBank0 - GAS - 0.5 - (req.keepInj ?? 0)
      const s0 = await ports.status()
      const k0 = kOf(s0)
      const pRef0 = s0.injPrice * k0
      if (noWalletInj() && orphan >= 1 && !(s0.health * k0 < 1.1)) push({ step: 'cleanup', info: `${orphan.toFixed(3)} wallet INJ left untouched (stop/pause active)` })
      else if (orphan >= 1 && s0.debtUsd > 0.5 && s0.injPrice > 0) {
        const eff0 = 1 - fee - slip
        const needUsd = req.mode === 'emergency' ? Infinity : Math.max(0, (s0.debtUsd - targetT * s0.collateralUsd * k0) / eff0) * 1.02
        const sellInj = Math.min(orphan, needUsd / pRef0)
        if (sellInj >= minQty(pRef0)) {
          push({ step: 'cleanup', info: `${orphan.toFixed(3)} wallet INJ found - ${sellInj.toFixed(3)} will be sold for repayment` })
          try {
            const sold = await sellWalletInj(sellInj, slip, 'orphan sell', pRef0 * 0.95)
            proceedsUsdc += sold / 1e6
            if (sold > 1e6 && !outOfTime()) {
              const paid = await repayFromWallet(sold / 1e6, 'orphan repay')
              proceedsUsdc = Math.max(0, proceedsUsdc - paid)
            }
          } catch (e) {
            if (e instanceof StoppedError) throw e
            push({ step: 'orphan sell', info: 'skipped: ' + String(e).slice(0, 120) })
          }
        }
      }
    }

    for (let round = 1; round <= cfg.maxRounds; round++) {
      if (outOfTime()) {
        push({ step: 'time', info: 'time budget reached - next tick continues' })
        return { log, done: false, deferred: true }
      }
      await checkpoint()
      const s = await ports.status()
      const k = kOf(s)
      const pRef = s.injPrice * k
      if (!(pRef > 0)) throw new Error('oracle price invalid during the run - abort')
      const C = s.collateralUsd * k
      const D = s.debtUsd
      const usdcDebtNow = s.debts.find((d) => d.symbol === 'USDC')
      const eff = 1 - fee - slip
      if (D < 0.5 || (req.mode === 'down' && D / C <= targetT + 0.005)) break
      if (!usdcDebtNow || usdcDebtNow.usd < 0.5) {
        if (req.mode === 'down' && D > 1) {
          push({ step: `R${round}`, info: `no USDC debt, but $${D.toFixed(0)} of other debt (USDT/AUSD) - rotate it to USDC manually` })
          return { log, done: false }
        }
        break
      }
      const needSell = req.mode === 'emergency' ? usdcDebtNow.usd / eff : (D - targetT * C) / (eff - targetT)
      const injBankNow = await ports.bankRaw('inj')
      const pileInj = Math.max(0, noWalletInj() ? Math.min(unsoldWithdrawn, injBankNow / 1e18 - GAS) : injBankNow / 1e18 - GAS - (req.keepInj ?? 0))
      const pileUsd = pileInj * pRef
      const book = await ports.book('INJ/USDC')
      const wMax = safeStep(C, D, s.injLiqLtv, s.injAllowableLtv, cfg)
      const wDepth = book.depthBidNearUsd * cfg.depthShare
      let w = Math.min(Math.max(0, needSell - (pileUsd * eff) / Math.max(eff - targetT, 0.05)), wMax, wDepth)
      if (req.mode === 'emergency' && w < 5 && wMax >= 5 && wDepth >= 5 && pileUsd < 5) w = 5
      if (wMax < 5 && pileUsd < 5) {
        push({ step: `R${round}`, info: `LIQUIDATION ZONE: no safe withdraw step (LTV ${((D / C) * 100).toFixed(1)} %) - only wallet USDC can still repay` })
        return { log, done: false }
      }
      if (w < 5 && pileUsd < 5) {
        push({ step: `R${round}`, info: `round too small ($${w.toFixed(0)}) - bid depth (2 %) $${book.depthBidNearUsd.toFixed(0)} - postponed` })
        return { log, done: false, deferred: true }
      }
      if (book.bestBid < pRef * 0.95 && s.health * k >= 1.1) {
        push({ step: `R${round}`, info: `book ${((1 - book.bestBid / pRef) * 100).toFixed(1)} % below reference ${pRef.toFixed(3)} - sale postponed (health ${(s.health * k).toFixed(2)})` })
        return { log, done: false, deferred: true }
      }
      if (outOfTimeForRound()) {
        push({ step: 'time', info: 'not enough budget for another round - next tick' })
        return { log, done: false, deferred: true }
      }
      let injQty = 0
      const injBefore = injBankNow
      if (w >= 5) {
        injQty = w / pRef
        if (injBefore / 1e18 < GAS * 0.6) throw new Error(`gas reserve too low (${(injBefore / 1e18).toFixed(3)} INJ) - top up INJ`)
        pendingWithdraw = { qty: injQty, injBefore }
        const r1 = await withdrawInj(injQty, s)
        pendingWithdraw = null
        unsoldWithdrawn += injQty
        push({ step: `R${round} withdraw`, txHash: r1.txHash, info: `${injQty.toFixed(3)} INJ withdrawn` })
        const delta = await ports.waitForFill('inj', injBefore, injQty * 0.99 * 1e18, 30_000)
        unsoldWithdrawn = Math.max(0, unsoldWithdrawn + Math.min(delta, injQty * 1e18) / 1e18 - injQty)
      } else {
        push({ step: `R${round}`, info: `${pileInj.toFixed(3)} INJ already unsold in the wallet - no new withdraw, sale only` })
      }
      await checkpoint()
      const beforeUsdc = await ports.bankRaw(USDC)
      const injBank = Math.max(await ports.bankRaw('inj'), injQty > 0 ? injBefore : 0)
      const walletCap = noWalletInj() ? unsoldWithdrawn : injBank / 1e18 - GAS - (req.keepInj ?? 0)
      const sellNeed = req.mode === 'emergency' ? Math.max(needSell, w) : needSell
      const sellQty = Math.max(0, Math.min(sellNeed / pRef, walletCap))
      if (sellQty < minQty(pRef)) throw new Error('sale quantity below market minimum after withdraw - abort (INJ stays in the wallet)')
      let book2 = await ports.book('INJ/USDC')
      let worst = worstSell(book2, sellQty, slip)
      let r2: { txHash: string }
      try {
        r2 = await ports.spotMarketOrder('INJ/USDC', 'sell', sellQty, worst)
      } catch (e) {
        // Retry ONLY on a clear rejection. Timeout/unclear: the order may still land -> never a second sale, wait for the fill.
        const msg = String(e)
        let executed = false
        try {
          executed = injBank - (await ports.bankRaw('inj')) >= sellQty * 0.5 * 1e18
        } catch {
          /* ignore */
        }
        if (executed || isUnclear(e)) {
          push({ step: `R${round} sell`, info: `response unclear (${msg.slice(0, 80)}) - no second sale, waiting for the fill` })
          r2 = { txHash: executed ? 'executed' : 'unknown' }
        } else {
          push({ step: `R${round} sell`, info: `first attempt rejected (${msg.slice(0, 80)}) - retry with a fresh book` })
          book2 = await ports.book('INJ/USDC')
          worst = worstSell(book2, sellQty, Math.min(cfg.slipMax, slip * 2))
          r2 = await ports.spotMarketOrder('INJ/USDC', 'sell', sellQty, worst)
        }
      }
      push({ step: `R${round} sell`, txHash: r2.txHash, info: `${sellQty.toFixed(3)} INJ sold (worst ${worst.toFixed(3)}, bid ${book2.bestBid.toFixed(3)})` })
      const gained = Math.min(await ports.waitForFill(USDC, beforeUsdc, sellQty * worst * 0.98 * 1e6), Math.ceil(sellQty * book2.bestAsk * 1e6))
      unsoldWithdrawn = Math.max(0, unsoldWithdrawn - Math.min(sellQty, gained / 1e6 / worst))
      proceedsUsdc += gained / 1e6
      const repay = Math.min(gained, Math.floor(usdcDebtNow.amount * 1e6 * 1.0005))
      // Subtract BEFORE the broadcast: if the response is lost the repayment still happened.
      proceedsUsdc = Math.max(0, proceedsUsdc - repay / 1e6)
      const r3 = await ports.repay(USDC, Math.floor(repay).toString())
      push({ step: `R${round} repay`, txHash: r3.txHash, info: `${(repay / 1e6).toFixed(2)} USDC repaid (fill ${(gained / 1e6).toFixed(2)})` })
    }
    if (req.mode === 'down') {
      const chk = await ports.status()
      const ltvReal = chk.ltv / kOf(chk)
      if (chk.debtUsd > 0.5 && ltvReal > targetT + 0.01) {
        push({ step: 'result', info: `target not reached yet (LTV ${(ltvReal * 100).toFixed(1)} % > ${(targetT * 100).toFixed(0)} %) - next tick continues` })
        return { log, done: false, deferred: true }
      }
    }

    if (req.mode === 'emergency') {
      const s2 = await ports.status()
      const usdtDebtAmt = s2.debts.find((d) => d.symbol === 'USDT')?.amount ?? 0
      if (usdtDebtAmt > 0.05) {
        const bankNow = (await ports.bankRaw(USDC)) / 1e6
        const usdcBank = noWalletUsdc() ? Math.min(proceedsUsdc, bankNow) : bankNow
        let need = Math.max(usdtDebtAmt * 1.006, 1.05)
        if (usdcBank < need) {
          if (outOfTimeForRound()) {
            push({ step: 'time', info: 'time budget before the USDT withdraw - next tick' })
            return { log, done: false, deferred: true }
          }
          const stepMax = Math.max(0, safeStep(s2.collateralUsd, s2.debtUsd, s2.injLiqLtv, s2.injAllowableLtv, cfg))
          let w = Math.min((need - usdcBank + 2) / (1 - fee - slip), stepMax)
          if (w < 5 && stepMax >= 5) w = 5
          if (w < 5) throw new Error('USDT repayment: no safe withdraw step')
          const injQty = w / s2.injPrice
          const injB = await ports.bankRaw('inj')
          pendingWithdraw = { qty: injQty, injBefore: injB }
          const rw = await withdrawInj(injQty, s2)
          pendingWithdraw = null
          unsoldWithdrawn += injQty
          push({ step: 'usdt withdraw', txHash: rw.txHash, info: `${injQty.toFixed(3)} INJ withdrawn for the USDT repayment` })
          unsoldWithdrawn = Math.max(0, unsoldWithdrawn + Math.min(await ports.waitForFill('inj', injB, injQty * 0.99 * 1e18, 30_000), injQty * 1e18) / 1e18 - injQty)
          const book1 = await ports.book('INJ/USDC')
          const beforeU = await ports.bankRaw(USDC)
          const ws = worstSell(book1, injQty, slip)
          const rs = await ports.spotMarketOrder('INJ/USDC', 'sell', injQty, ws)
          push({ step: 'usdt sell-inj', txHash: rs.txHash, info: 'INJ -> USDC for the USDT repayment' })
          const gU = await ports.waitForFill(USDC, beforeU, Math.max(0, need - usdcBank) * 0.97 * 1e6)
          unsoldWithdrawn = Math.max(0, unsoldWithdrawn - Math.min(injQty, gU / 1e6 / ws))
          proceedsUsdc += gU / 1e6
          const bankAfter = (await ports.bankRaw(USDC)) / 1e6
          need = Math.min(need, noWalletUsdc() ? Math.min(proceedsUsdc, bankAfter) : bankAfter)
        }
        if (outOfTime()) {
          push({ step: 'time', info: 'time budget before the USDT repayment - next tick' })
          return { log, done: false, deferred: true }
        }
        const book = await ports.book('USDC/USDT')
        const beforeT = await ports.bankRaw(USDT)
        const r4 = await ports.spotMarketOrder('USDC/USDT', 'sell', need, worstSell(book, need, slip))
        push({ step: 'usdt swap', txHash: r4.txHash, info: `${need.toFixed(2)} USDC -> USDT` })
        const gainedT = await ports.waitForFill(USDT, beforeT, usdtDebtAmt * 1e6 * 0.99)
        const repayT = Math.min(gainedT, Math.ceil(usdtDebtAmt * 1e6 * 1.0005))
        const r5 = await ports.repay(USDT, Math.floor(repayT).toString())
        push({ step: 'usdt repay', txHash: r5.txHash, info: `${(repayT / 1e6).toFixed(2)} USDT repaid` })
      }
      if (req.sellAllInj) {
        const keep = req.keepInj ?? 0
        const s3 = await ports.status()
        const injColl = s3.collateral.find((c) => c.symbol === 'INJ')
        if (s3.debtUsd >= 0.05 && s3.debtUsd < 1 && !noWalletUsdc()) {
          try {
            await repayFromWallet(s3.debtUsd * 1.01, 'dust repay')
          } catch (e) {
            push({ step: 'dust repay', info: 'not possible: ' + String(e).slice(0, 80) })
          }
        }
        const s3b = s3.debtUsd >= 0.05 ? await ports.status() : s3
        if (s3b.debtUsd >= 0.05) {
          push({ step: 'note', info: `remaining debt $${s3b.debtUsd.toFixed(2)} - next tick keeps repaying` })
        } else {
          if (injColl && injColl.amount > keep + 0.2) {
            if (outOfTimeForRound()) {
              push({ step: 'time', info: 'time budget before the final withdraw - next tick' })
              return { log, done: false, deferred: true }
            }
            await checkpoint()
            const injB = await ports.bankRaw('inj')
            const qty = injColl.amount * 0.9999
            pendingWithdraw = { qty, injBefore: injB }
            const rw = await withdrawInj(qty, s3)
            pendingWithdraw = null
            unsoldWithdrawn += qty
            push({ step: 'final withdraw', txHash: rw.txHash, info: `${injColl.amount.toFixed(3)} INJ withdrawn` })
            unsoldWithdrawn = Math.max(0, unsoldWithdrawn + Math.min(await ports.waitForFill('inj', injB, injColl.amount * 0.99 * 1e18, 30_000), injColl.amount * 1e18) / 1e18 - qty)
          }
          const injBank = (await ports.bankRaw('inj')) / 1e18
          let sellable = injBank - GAS - keep
          if (noWalletInj()) sellable = Math.min(sellable, unsoldWithdrawn)
          if (sellable > 0.05) {
            const injBeforeSell = injBank
            const sold = await sellWalletInj(sellable, slip, 'final sell', s3b.injPrice * kOf(s3b) * 0.95)
            const injAfterSell = (await ports.bankRaw('inj')) / 1e18
            unsoldWithdrawn = Math.max(0, unsoldWithdrawn - Math.max(0, injBeforeSell - injAfterSell))
            proceedsUsdc += sold / 1e6
            const left = injAfterSell - GAS - keep
            push({ step: 'final', info: `${(sold / 1e6).toFixed(2)} USDC realised${left > 0.05 ? ` - ${left.toFixed(3)} INJ still unsold (next tick continues)` : ''}` })
          }
        }
      }
    }

    const final = await ports.status()
    push({ step: 'result', info: `health ${final.health.toFixed(3)} | LTV ${(final.ltv * 100).toFixed(1)} % | debt $${final.debtUsd.toFixed(2)}` })
    return { log, done: true }
  } catch (e) {
    if (e instanceof StoppedError) {
      push({ step: 'STOP', info: String(e).slice(0, 200) })
      return { log, done: false, deferred: true }
    }
    push({ step: 'ERROR', info: String(e).slice(0, 300) })
    // Best-effort cleanup so that no run ends with withdrawn, unsold INJ.
    try {
      if (pendingWithdraw && isUnclear(e)) {
        try {
          const arrived = ((await ports.bankRaw('inj')) - pendingWithdraw.injBefore) / 1e18
          const credit = Math.max(0, Math.min(arrived, pendingWithdraw.qty))
          if (credit >= 0.05) {
            unsoldWithdrawn += credit
            push({ step: 'cleanup', info: `withdraw response lost, but ${credit.toFixed(3)} INJ arrived - will be sold` })
          }
        } catch {
          /* ignore */
        }
        pendingWithdraw = null
      }
      if ((req.mode === 'down' || req.mode === 'emergency') && !outOfTime()) {
        let injBank = (await ports.bankRaw('inj')) / 1e18
        if (unsoldWithdrawn >= 0.05 && injBank - GAS - (req.keepInj ?? 0) < unsoldWithdrawn * 0.9) {
          try {
            injBank = Math.max(injBank, (await ports.waitForFill('inj', 0, (unsoldWithdrawn * 0.9 + GAS) * 1e18, 20_000)) / 1e18)
          } catch {
            /* ignore */
          }
        }
        const sellable = Math.min(injBank - GAS - (req.keepInj ?? 0), unsoldWithdrawn)
        if (sellable >= 0.05) {
          const injBefore = injBank
          const sold = await sellWalletInj(sellable, Math.min(cfg.slipMax, slip * 2), 'cleanup sell', 0)
          const injAfter = (await ports.bankRaw('inj')) / 1e18
          unsoldWithdrawn = Math.max(0, unsoldWithdrawn - Math.max(0, injBefore - injAfter))
          proceedsUsdc += sold / 1e6
        }
        const sd = await ports.status()
        const needCl = req.mode === 'emergency' ? sd.debtUsd : Math.max(0, sd.debtUsd - targetT * sd.collateralUsd * kOf(sd))
        const budget = Math.min(proceedsUsdc + (noWalletUsdc() ? 0 : Math.max(0, needCl)), req.mode === 'emergency' ? sd.debtUsd : Math.max(0, needCl))
        if (sd.debtUsd > 0.5 && budget > 1) {
          const paid = await repayFromWallet(Math.min(sd.debtUsd, budget), 'cleanup repay')
          proceedsUsdc = Math.max(0, proceedsUsdc - paid)
        }
      }
      if (req.mode === 'up') await returnExcessUsdc()
    } catch (e2) {
      push({ step: 'cleanup', info: 'not possible: ' + String(e2).slice(0, 120) })
    }
    return { log, done: false }
  }
}

/** Idle-time cleanup: deposit orphaned wallet INJ (from an earlier partial abort) as collateral. Only ever raises health. */
export async function depositOrphanInj(ports: ExecPorts, cfg: ExecutionConfig = DEFAULT_EXECUTION): Promise<{ deposited: number; log: ExecLogEntry[] }> {
  const log: ExecLogEntry[] = []
  const injBank = (await ports.bankRaw('inj')) / 1e18
  const orphan = injBank - cfg.gasReserveInj - 0.5
  if (orphan < 1) return { deposited: 0, log }
  const r = await ports.deposit('inj', injToRaw(orphan))
  const e = { step: 'cleanup', txHash: r.txHash, info: `${orphan.toFixed(3)} orphaned wallet INJ deposited as collateral` }
  log.push(e)
  ports.log(e)
  return { deposited: orphan, log }
}
