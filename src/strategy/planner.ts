/**
 * Turns a Decision into concrete numbers and a human checklist.
 *
 * The planner does NOT execute anything. It tells you how much to repay or
 * borrow to land on the target LTV, how many INJ that is at the current price,
 * how many withdraw-sell-repay rounds the contract's interim LTV limit forces,
 * and at which INJ prices the next triggers sit.
 *
 * All formulas assume INJ-only collateral and stablecoin debt:
 *   ltv = debt / (inj * P)
 *   to reach target t by repaying x USD of debt with INJ sold at P:
 *     (debt - x) / (inj*P - x) = t   =>   x = (debt - t*inj*P) / (1 - t)
 *   to reach target t by borrowing x USD and buying INJ:
 *     (debt + x) / (inj*P + x) = t   =>   x = (t*inj*P - debt) / (1 - t)
 */
import type { Status } from '../chain/neptune'
import type { Decision } from './policy'
import type { StrategyConfig } from './types'

export interface PlanStep {
  title: string
  detail: string
  /** Where to do it. */
  where?: 'neptune' | 'helix' | 'wallet'
}

export interface ActionPlan {
  kind: 'hold' | 'repay' | 'add' | 'exit' | 'blocked' | 'data-error'
  headline: string
  summary: string
  steps: PlanStep[]
  warnings: string[]
  numbers: {
    /** USD of debt to repay (repay/exit) or to borrow (add). */
    usd: number
    /** INJ to sell (repay/exit) or to buy (add), including trade cost assumption. */
    inj: number
    /** Debt repaid directly from wallet stablecoins (repay only). */
    fromWalletUsd: number
    /** Withdraw-sell-repay rounds forced by the interim LTV cap (repay/exit). */
    rounds: number
    /** LTV / health after the plan. */
    ltvAfter: number
    healthAfter: number
    /** Leverage (collateral / equity) before and after. */
    leverageBefore: number
    leverageAfter: number
  }
}

export interface Triggers {
  /** INJ price at which the repay trigger is hit (price falls). null = no debt. */
  repayAtPrice: number | null
  /** INJ price at which the add trigger is hit (price rises). null = buying blocked / no loop rung. */
  buyAtPrice: number | null
  liqPrice: number
  nextRungPrice: number | null
  nextRungLabel: string | null
  exitPrice: number | null
  /** Distance of the current price to the repay trigger / liquidation, as fraction (negative = price must fall). */
  repayDistPct: number | null
  liqDistPct: number | null
}

export function healthFromLtv(ltv: number, liqLtv = 0.8): number {
  return ltv > 0 ? liqLtv / ltv : Infinity
}
export function ltvFromHealth(health: number, liqLtv = 0.8): number {
  return health > 0 ? liqLtv / health : 0
}
export function leverageFromLtv(ltv: number): number {
  return ltv < 1 ? 1 / (1 - ltv) : Infinity
}
/** INJ price at which the position reaches a given LTV. */
export function priceAtLtv(ltv: number | null, debtUsd: number, injAmount: number): number | null {
  return ltv && ltv > 0 && injAmount > 0 && debtUsd > 0 ? debtUsd / (ltv * injAmount) : null
}

export function computeTriggers(s: Status, d: Decision, cfg: StrategyConfig): Triggers {
  const inj = s.collateral.find((c) => c.symbol === 'INJ')?.amount ?? 0
  const idx = cfg.ladder.indexOf(d.rung)
  const next = Number.isFinite(d.rung.upTo) ? { price: d.rung.upTo, label: cfg.ladder[idx + 1]?.label ?? 'EXIT' } : null
  const exitIdx = cfg.ladder.findIndex((r) => r.exit)
  const exitPrice = exitIdx > 0 ? cfg.ladder[exitIdx - 1].upTo : null
  const repayAtPrice = priceAtLtv(d.effective.repayTriggerLtv, s.debtUsd, inj)
  const P = s.injPrice
  return {
    repayAtPrice,
    buyAtPrice: priceAtLtv(d.effective.buyTriggerLtv, s.debtUsd, inj),
    liqPrice: s.liqPrice,
    nextRungPrice: next?.price ?? null,
    nextRungLabel: next?.label ?? null,
    exitPrice,
    repayDistPct: repayAtPrice && P > 0 ? repayAtPrice / P - 1 : null,
    liqDistPct: s.liqPrice > 0 && P > 0 ? s.liqPrice / P - 1 : null,
  }
}

/**
 * How many withdraw -> sell -> repay rounds are needed to repay `usd` of debt when each
 * round may only push the interim LTV up to `interimCap` (never above the contract's allowable LTV).
 * Returns the number of rounds and the INJ withdrawn per round.
 */
export function repayRounds(injColl: number, debtUsd: number, price: number, usd: number, interimCap: number, allowableLtv: number, tradeCost: number): { rounds: number; perRoundInj: number[] } {
  const cap = Math.min(interimCap, allowableLtv - 0.01)
  let inj = injColl
  let debt = debtUsd
  let remaining = usd
  const perRoundInj: number[] = []
  for (let i = 0; i < 20 && remaining > 0.5; i++) {
    // max INJ we may withdraw so that debt / ((inj - w) * P) <= cap
    const maxW = Math.max(0, inj - debt / (cap * price))
    if (maxW <= 1e-9) break
    const needW = (remaining / price) * (1 + tradeCost)
    const w = Math.min(maxW, needW)
    const repaid = (w * price) / (1 + tradeCost)
    perRoundInj.push(w)
    inj -= w
    debt -= repaid
    remaining -= repaid
  }
  return { rounds: perRoundInj.length, perRoundInj }
}

export function buildPlan(s: Status, d: Decision, cfg: StrategyConfig): ActionPlan {
  const P = d.refPrice ?? s.injPrice
  const inj = s.collateral.find((c) => c.symbol === 'INJ')?.amount ?? 0
  const walletUsdc = s.bank.find((b) => b.symbol === 'USDC')?.amount ?? 0
  const walletInj = s.bank.find((b) => b.symbol === 'INJ')?.amount ?? 0
  const liq = s.injLiqLtv > 0 ? s.injLiqLtv : 0.8
  const coll = inj * P
  const debt = s.debtUsd
  const levBefore = leverageFromLtv(s.ltv)
  const cost = cfg.tradeCostPct
  const warnings: string[] = []
  if (d.warn === 'oracle-gap') warnings.push('Exchange price is more than 15 % below the oracle. The contract still values the collateral higher than the market does - act on the market price, not the oracle.')
  if (d.warn === 'usdt') warnings.push('Your debt is not USDC. The default plan assumes USDC debt; repay in the asset you borrowed.')
  if (walletInj < cfg.gasReserveInj) warnings.push(`Wallet holds only ${walletInj.toFixed(2)} INJ - keep at least ${cfg.gasReserveInj} INJ for gas or transactions will fail.`)
  if (s.oracleAgeSec > 60 * 50) warnings.push('Oracle price is older than 50 minutes. Neptune blocks withdraw/borrow when the oracle is older than 60 minutes; only repaying from wallet stablecoins keeps working.')

  const numbersBase = { usd: 0, inj: 0, fromWalletUsd: 0, rounds: 0, ltvAfter: s.ltv, healthAfter: s.health, leverageBefore: levBefore, leverageAfter: levBefore }

  if (d.dataError && d.action !== 'down') {
    return { kind: 'data-error', headline: 'Do nothing - the data is not trustworthy', summary: d.reason, steps: [{ title: 'Wait for clean data', detail: 'Reload in a minute. If the error persists, check the oracle age and whether Neptune changed the collateral parameters.' }], warnings, numbers: numbersBase }
  }

  if (d.action === 'down') {
    const t = d.targetLtv ?? d.effective.repayTargetLtv
    const x = Math.max(0, (debt - t * coll) / (1 - t))
    const fromWallet = Math.min(walletUsdc, x)
    const viaInj = Math.max(0, x - fromWallet)
    const injToSell = (viaInj / P) * (1 + cost)
    const { rounds, perRoundInj } = repayRounds(inj, debt - fromWallet, P, viaInj, cfg.interimLtvCap, s.injAllowableLtv, cost)
    const debtAfter = debt - x
    const collAfter = coll - viaInj * (1 + cost)
    const ltvAfter = collAfter > 0 ? debtAfter / collAfter : 0
    const steps: PlanStep[] = []
    if (fromWallet > 0.5) steps.push({ title: `Repay ${fmtUsd(fromWallet)} USDC from your wallet`, detail: 'Cheapest step: no INJ has to be sold. Neptune app -> your position -> Repay.', where: 'neptune' })
    if (viaInj > 0.5) {
      const w0 = perRoundInj[0] ?? injToSell
      steps.push({ title: `Withdraw ~${fmtInj(w0)} INJ collateral${rounds > 1 ? ` (round 1 of ${rounds})` : ''}`, detail: `Neptune only lets you withdraw while the interim LTV stays below ${(Math.min(cfg.interimLtvCap, s.injAllowableLtv - 0.01) * 100).toFixed(0)} % (contract limit ${(s.injAllowableLtv * 100).toFixed(0)} %). ${rounds > 1 ? `You need ${rounds} rounds of withdraw -> sell -> repay.` : ''}`, where: 'neptune' })
      steps.push({ title: `Sell ~${fmtInj(injToSell)} INJ for USDC on Helix`, detail: `Limit order at or slightly below the current bid. The plan assumes ${(cost * 100).toFixed(1)} % cost (slippage + fees). Never market-sell into a thin book.`, where: 'helix' })
      steps.push({ title: `Repay ${fmtUsd(viaInj)} USDC`, detail: 'Neptune app -> Repay. Check the new LTV before you stop.', where: 'neptune' })
    }
    steps.push({ title: `Verify: LTV ~${(ltvAfter * 100).toFixed(1)} %, health ~${healthFromLtv(ltvAfter, liq).toFixed(2)}`, detail: 'Reload this page. If the LTV is still above the trigger, repeat with the new numbers.' })
    return {
      kind: 'repay',
      headline: `Reduce leverage: repay ${fmtUsd(x)}`,
      summary: d.reason,
      steps,
      warnings,
      numbers: { usd: x, inj: injToSell, fromWalletUsd: fromWallet, rounds: viaInj > 0.5 ? Math.max(1, rounds) : 0, ltvAfter, healthAfter: healthFromLtv(ltvAfter, liq), leverageBefore: levBefore, leverageAfter: leverageFromLtv(ltvAfter) },
    }
  }

  if (d.action === 'up') {
    const t = d.targetLtv ?? d.effective.buyLtv ?? s.ltv
    let x = Math.max(0, (t * coll - debt) / (1 - t))
    if (s.usdcPoolFreeUsd > 0 && x > s.usdcPoolFreeUsd) {
      warnings.push(`The USDC pool only has ${fmtUsd(s.usdcPoolFreeUsd)} left to borrow. The plan is capped to that amount.`)
      x = s.usdcPoolFreeUsd
    }
    const injToBuy = (x / P) * (1 - cost)
    const debtAfter = debt + x
    const collAfter = coll + injToBuy * P
    const ltvAfter = collAfter > 0 ? debtAfter / collAfter : 0
    const steps: PlanStep[] = [
      { title: `Borrow ${fmtUsd(x)} USDC on Neptune`, detail: `Neptune app -> Borrow. Interim LTV after borrowing: ~${((debt + x) / coll * 100).toFixed(1)} % (must stay below ${(s.injAllowableLtv * 100).toFixed(0)} %).`, where: 'neptune' },
      { title: `Buy ~${fmtInj(injToBuy)} INJ with the USDC on Helix`, detail: `Limit order not more than ~2 % above the oracle price ($${s.injPrice.toFixed(2)}). If the book is thin, buy in tranches.`, where: 'helix' },
      { title: `Deposit the INJ as collateral`, detail: `Neptune app -> Deposit collateral. Keep ${cfg.gasReserveInj} INJ in the wallet for gas.`, where: 'neptune' },
      { title: `Verify: LTV ~${(ltvAfter * 100).toFixed(1)} %, health ~${healthFromLtv(ltvAfter, liq).toFixed(2)}`, detail: 'Reload this page. The next add trigger will show under "What happens next".' },
    ]
    return {
      kind: 'add',
      headline: `Add leverage: borrow ${fmtUsd(x)}`,
      summary: d.reason,
      steps,
      warnings,
      numbers: { usd: x, inj: injToBuy, fromWalletUsd: 0, rounds: 0, ltvAfter, healthAfter: healthFromLtv(ltvAfter, liq), leverageBefore: levBefore, leverageAfter: leverageFromLtv(ltvAfter) },
    }
  }

  if (d.action === 'exit') {
    const fromWallet = Math.min(walletUsdc, debt)
    const viaInj = Math.max(0, debt - fromWallet)
    const injToSellForDebt = (viaInj / P) * (1 + cost)
    const { rounds } = repayRounds(inj, debt, P, viaInj, cfg.interimLtvCap, s.injAllowableLtv, cost)
    const keep = 1 + cfg.gasReserveInj
    const steps: PlanStep[] = []
    if (fromWallet > 0.5) steps.push({ title: `Repay ${fmtUsd(fromWallet)} USDC from your wallet`, detail: 'No INJ sale needed for this part.', where: 'neptune' })
    if (viaInj > 0.5) {
      steps.push({ title: `Withdraw and sell ~${fmtInj(injToSellForDebt)} INJ, repay ${fmtUsd(viaInj)} USDC`, detail: `${rounds > 1 ? `${rounds} rounds of withdraw -> sell -> repay because of the interim LTV limit. ` : ''}After the debt is zero, the rest of the collateral can be withdrawn in one go.`, where: 'neptune' })
    }
    steps.push({ title: `Withdraw the remaining ~${fmtInj(Math.max(0, inj - injToSellForDebt))} INJ and sell all but ~${keep.toFixed(1)} INJ`, detail: 'The strategy ends in stablecoins. Keep a little INJ for gas.', where: 'helix' })
    steps.push({ title: 'Verify: debt 0, collateral 0, USDC in the wallet', detail: 'Consider moving the USDC off-chain or into the lending side of Neptune - that is outside this strategy.' })
    return {
      kind: 'exit',
      headline: 'Full exit: close the loop into stablecoins',
      summary: d.reason,
      steps,
      warnings,
      numbers: { usd: debt, inj: Math.max(0, inj - keep), fromWalletUsd: fromWallet, rounds: Math.max(1, rounds), ltvAfter: 0, healthAfter: Infinity, leverageBefore: levBefore, leverageAfter: 1 },
    }
  }

  // action === 'none'
  const blocked = debt >= 1 && d.trend.buyBlocked && d.effective.buyTriggerLtv === null && d.rung.buyLtv !== undefined && d.mode === 'full' && s.ltv < (d.rung.buyTriggerLtv ?? 0)
  return {
    kind: blocked ? 'blocked' : 'hold',
    headline: blocked ? 'Hold - adding leverage is paused' : debt < 1 ? 'Hold - no open loop' : 'Hold - inside the band',
    summary: d.reason,
    steps: blocked
      ? [{ title: 'Wait', detail: `Reason: ${d.trend.noBuyWhy ?? d.reason}. The ladder resumes automatically when the condition clears.` }]
      : debt < 1
        ? [{ title: 'No loop is open for this address', detail: 'Deposit INJ as collateral and borrow USDC on Neptune to start one - or use this page to watch someone else\'s loop.' }]
        : [{ title: 'Nothing to do', detail: 'Check back after a larger price move. The triggers below tell you at which price the next step is due.' }],
    warnings,
    numbers: numbersBase,
  }
}

export function fmtUsd(v: number): string {
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
export function fmtInj(v: number): string {
  return `${v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 0 : 2 })} INJ`
}
