/**
 * In-memory chain implementing ExecPorts: Neptune account (INJ collateral, USDC/USDT debt),
 * a wallet, a two-sided Helix book with configurable depth, and fault injection.
 * No network, no keys. A port of the author's fault-injection harness mock.
 */
import type { Status } from '../src/chain/neptune'
import { ASSETS } from '../src/config/chain'
import { quoteFromLevels } from '../src/execution/orderbook'
import { UnclearTxError, type BookQuote, type ExecLogEntry, type ExecPorts, type SpotMarketKey } from '../src/execution/types'
import { ADDR } from './fixtures'

export interface ChainState {
  injColl: number
  debtUsdc: number
  debtUsdt: number
  walletInj: number
  walletUsdc: number
  walletUsdt: number
  oraclePrice: number
  bid: number
  ask: number
  /** USD depth within 2 % on each side. */
  depthNearUsd: number
  liqLtv: number
  allowable: number
  poolBalance: bigint
  poolShares: bigint
  takerFee: number
  oracleAgeSec: number
  marketActive: boolean
}

export interface Faults {
  /** Fraction of a spot order that fills (1 = full). */
  fillRatio: number
  /** Throw on the next N spot orders; `execute` = the order still executes on-chain (lost response). */
  spotThrow: null | { msg: string; execute: boolean; times: number; unclear?: boolean }
  /** Throw on the next N withdraws; `execute` = the withdraw still lands. */
  withdrawThrow: null | { msg: string; execute: boolean; times: number; unclear?: boolean }
  borrowReject: boolean
  bankThrow: boolean
  /** Stop flag returned by shouldStop() from call number N on. */
  stopAfterChecks: number | null
  /** Advance the mock clock by this many ms per status() call (time-budget tests). */
  msPerStatus: number
}

export interface TxRec {
  n: number
  type: string
  detail: string
  after: string
}

export class MockChain {
  readonly address = ADDR
  state: ChainState
  faults: Faults
  txlog: TxRec[] = []
  log: ExecLogEntry[] = []
  calls = { status: 0, bank: 0, book: 0, spot: 0, exec: 0, fill: 0, stop: 0 }
  private clock = 1_700_000_000_000
  private readonly gasPerTx = 0.0002

  constructor(state: Partial<ChainState> = {}, faults: Partial<Faults> = {}) {
    this.state = {
      injColl: 1000,
      debtUsdc: 3000,
      debtUsdt: 0,
      walletInj: 1.9,
      walletUsdc: 0,
      walletUsdt: 0,
      oraclePrice: 6,
      bid: 5.99,
      ask: 6.01,
      depthNearUsd: 20_000,
      liqLtv: 0.8,
      allowable: 0.78,
      poolBalance: 5_000_000n * 10n ** 18n,
      poolShares: 4_900_000n * 10n ** 18n,
      takerFee: 0.001,
      oracleAgeSec: 5,
      marketActive: true,
      ...state,
    }
    this.faults = { fillRatio: 1, spotThrow: null, withdrawThrow: null, borrowReject: false, bankThrow: false, stopAfterChecks: null, msPerStatus: 0, ...faults }
  }

  ltv(): number {
    const c = this.state.injColl * this.state.oraclePrice
    return c > 0 ? (this.state.debtUsdc + this.state.debtUsdt) / c : 0
  }
  snap(): string {
    const s = this.state
    return `coll ${s.injColl.toFixed(3)} INJ | debt ${s.debtUsdc.toFixed(2)} USDC + ${s.debtUsdt.toFixed(2)} USDT | wallet ${s.walletInj.toFixed(3)} INJ / ${s.walletUsdc.toFixed(2)} USDC / ${s.walletUsdt.toFixed(4)} USDT | LTV ${this.ltv().toFixed(4)}`
  }
  private tx(type: string, detail: string) {
    this.state.walletInj -= this.gasPerTx
    const n = this.txlog.length + 1
    this.txlog.push({ n, type, detail, after: this.snap() })
    return { txHash: `mock-tx-${n}` }
  }
  private userShares(): bigint {
    return (BigInt(Math.round(this.state.injColl * 1e6)) * 10n ** 12n * this.state.poolShares) / this.state.poolBalance
  }

  async status(): Promise<Status> {
    this.calls.status++
    this.clock += this.faults.msPerStatus
    const s = this.state
    const price = s.oraclePrice
    const collateralUsd = s.injColl * price
    const debts: Status['debts'] = []
    if (s.debtUsdc > 0.01) debts.push({ symbol: 'USDC', denom: ASSETS.USDC.denom, amount: s.debtUsdc, usd: s.debtUsdc })
    if (s.debtUsdt > 0.01) debts.push({ symbol: 'USDT', denom: ASSETS.USDT.denom, amount: s.debtUsdt, usd: s.debtUsdt })
    const debtUsd = debts.reduce((a, d) => a + d.usd, 0)
    const l = collateralUsd > 0 ? debtUsd / collateralUsd : 0
    const health = debtUsd > 0 ? s.liqLtv / l : 99
    return {
      time: new Date(this.clock).toISOString(),
      address: ADDR,
      accountIndex: 0,
      health,
      injPrice: price,
      liqPrice: debtUsd > 0 ? price / health : 0,
      collateral: s.injColl > 1e-9 ? [{ symbol: 'INJ', denom: 'inj', amount: s.injColl, usd: collateralUsd }] : [],
      debts,
      collateralUsd,
      debtUsd,
      equityUsd: collateralUsd - debtUsd,
      ltv: l,
      rates: [{ symbol: 'USDC', lend: 0.08, borrow: 0.17 }],
      bank: [
        { symbol: 'INJ', denom: 'inj', amount: s.walletInj, usd: s.walletInj * price },
        { symbol: 'USDC', denom: ASSETS.USDC.denom, amount: s.walletUsdc, usd: s.walletUsdc },
        { symbol: 'USDT', denom: ASSETS.USDT.denom, amount: s.walletUsdt, usd: s.walletUsdt },
      ],
      oracleAgeSec: s.oracleAgeSec,
      injLiqLtv: s.liqLtv,
      injAllowableLtv: s.allowable,
      usdcUtilization: 0.7,
      usdcPoolFreeUsd: 50_000,
      usdcPoolLentUsd: 200_000,
      collateralShares: { inj: { shares: this.userShares().toString(), poolBalance: s.poolBalance.toString(), poolShares: s.poolShares.toString() } },
    }
  }

  private rawBalance(denom: string): number {
    const s = this.state
    if (denom === 'inj' || denom === 'INJ') return Math.floor(s.walletInj * 1e6) * 1e12
    if (denom === ASSETS.USDC.denom || denom === 'USDC') return Math.floor(s.walletUsdc * 1e6)
    if (denom === ASSETS.USDT.denom || denom === 'USDT') return Math.floor(s.walletUsdt * 1e6)
    return 0
  }
  async bankRaw(denom: string): Promise<number> {
    this.calls.bank++
    if (this.faults.bankThrow) throw new Error('bank balance unreadable (mock): LCD down')
    return this.rawBalance(denom)
  }
  async book(market: SpotMarketKey): Promise<BookQuote> {
    this.calls.book++
    const s = this.state
    const bid = market === 'INJ/USDC' ? s.bid : 0.9995
    const ask = market === 'INJ/USDC' ? s.ask : 1.0005
    const depth = market === 'INJ/USDC' ? s.depthNearUsd : 500_000
    // one level per side holding the full near depth, plus a far level
    return quoteFromLevels(
      [{ p: bid, q: depth / bid }, { p: bid * 0.9, q: depth / bid }],
      [{ p: ask, q: depth / ask }, { p: ask * 1.1, q: depth / ask }],
      market,
    )
  }
  async spotMarketActive(): Promise<boolean> {
    return this.state.marketActive
  }
  async withdrawCollateral(_denom: string, shares: string): Promise<{ txHash: string }> {
    this.calls.exec++
    const s = this.state
    const sharesBig = BigInt(shares)
    const rawInj = (sharesBig * s.poolBalance) / s.poolShares
    const inj = Number(rawInj / 10n ** 12n) / 1e6
    const run = () => {
      const ltvAfter = (s.debtUsdc + s.debtUsdt) / ((s.injColl - inj) * s.oraclePrice)
      if (ltvAfter > s.allowable) throw new Error(`chain: withdraw rejected - LTV after ${ltvAfter.toFixed(3)} > allowable ${s.allowable}`)
      if (inj > s.injColl + 1e-9) throw new Error('chain: withdraw exceeds collateral')
      s.injColl -= inj
      s.walletInj += inj
      return this.tx('withdraw_collateral', `${inj.toFixed(3)} INJ`)
    }
    const f = this.faults.withdrawThrow
    if (f && f.times > 0) {
      f.times--
      if (f.execute) run()
      throw f.unclear ? new UnclearTxError(f.msg) : new Error(f.msg)
    }
    return run()
  }
  async repay(denom: string, amountRaw: string): Promise<{ txHash: string }> {
    this.calls.exec++
    const s = this.state
    const amt = Number(amountRaw) / 1e6
    if (denom === ASSETS.USDC.denom || denom === 'USDC') {
      if (s.walletUsdc + 1e-9 < amt) throw new Error('chain: insufficient USDC to repay')
      const pay = Math.min(amt, s.debtUsdc)
      s.walletUsdc -= amt
      s.walletUsdc += amt - pay // contract refunds the excess
      s.debtUsdc -= pay
      return this.tx('return USDC', `${pay.toFixed(2)}`)
    }
    if (s.walletUsdt + 1e-9 < amt) throw new Error('chain: insufficient USDT to repay')
    const pay = Math.min(amt, s.debtUsdt)
    s.walletUsdt -= pay
    s.debtUsdt -= pay
    return this.tx('return USDT', `${pay.toFixed(2)}`)
  }
  async borrow(_denom: string, amountRaw: string): Promise<{ txHash: string }> {
    this.calls.exec++
    if (this.faults.borrowReject) throw new Error('chain: borrow rejected (pool)')
    const s = this.state
    const amt = Number(amountRaw) / 1e6
    const ltvAfter = (s.debtUsdc + s.debtUsdt + amt) / (s.injColl * s.oraclePrice)
    if (ltvAfter > s.allowable) throw new Error('chain: borrow rejected - LTV above allowable')
    s.debtUsdc += amt
    s.walletUsdc += amt
    return this.tx('borrow USDC', `${amt.toFixed(2)}`)
  }
  async deposit(_denom: string, amountRaw: string): Promise<{ txHash: string }> {
    this.calls.exec++
    const s = this.state
    const inj = Number(BigInt(amountRaw) / 10n ** 12n) / 1e6
    if (s.walletInj + 1e-9 < inj) throw new Error('chain: insufficient INJ to deposit')
    s.walletInj -= inj
    s.injColl += inj
    return this.tx('deposit_collateral', `${inj.toFixed(3)} INJ`)
  }
  async spotMarketOrder(market: SpotMarketKey, side: 'buy' | 'sell', baseQty: number, worstPrice: number): Promise<{ txHash: string }> {
    this.calls.spot++
    const s = this.state
    const tick = market === 'INJ/USDC' ? 0.001 : 0.01
    const qty = Math.floor(baseQty / tick + 1e-9) * tick
    if (!(qty > 0)) throw new Error('quantity below market minimum or invalid')
    const execute = () => {
      if (market === 'INJ/USDC') {
        if (qty * (side === 'sell' ? s.bid : s.ask) < 1) throw new Error('chain: order notional below min_notional 1 USDC')
        if (side === 'sell') {
          if (s.bid < worstPrice) throw new Error('chain: sell rejected - no liquidity above worst price')
          if (s.walletInj < qty) throw new Error(`chain: insufficient INJ (${s.walletInj.toFixed(3)} < ${qty.toFixed(3)})`)
          const filled = qty * this.faults.fillRatio
          s.walletInj -= filled
          s.walletUsdc += filled * s.bid * (1 - s.takerFee)
          return this.tx('spot SELL INJ/USDC', `${qty.toFixed(3)} @worst ${worstPrice.toFixed(3)} filled ${filled.toFixed(3)}`)
        }
        const reserve = qty * worstPrice * (1 + s.takerFee)
        if (s.walletUsdc < reserve) throw new Error(`chain: insufficient USDC for buy (${s.walletUsdc.toFixed(2)} < ${reserve.toFixed(2)})`)
        if (s.ask > worstPrice) throw new Error('chain: buy rejected - no liquidity below worst price')
        const filled = qty * this.faults.fillRatio
        s.walletUsdc -= filled * s.ask * (1 + s.takerFee)
        s.walletInj += filled
        return this.tx('spot BUY INJ/USDC', `${qty.toFixed(3)} @worst ${worstPrice.toFixed(3)} filled ${filled.toFixed(3)}`)
      }
      if (side !== 'sell') throw new Error('mock: only USDC/USDT sell supported')
      if (qty < 1) throw new Error('chain: order notional below min_notional 1 USDC')
      if (s.walletUsdc < qty) throw new Error('chain: insufficient USDC for swap')
      s.walletUsdc -= qty
      const got = qty * 0.9995 * (1 - s.takerFee)
      s.walletUsdt += got
      return this.tx('spot SELL USDC/USDT', `${qty.toFixed(4)} -> ${got.toFixed(4)} USDT`)
    }
    const f = this.faults.spotThrow
    if (f && f.times > 0) {
      f.times--
      if (f.execute) execute()
      throw f.unclear ? new UnclearTxError(f.msg) : new Error(f.msg)
    }
    return execute()
  }
  async waitForFill(denom: string, before: number, minDelta: number, _timeoutMs = 15_000): Promise<number> {
    this.calls.fill++
    const delta = this.rawBalance(denom) - before
    if (delta >= minDelta) return delta
    if (delta >= minDelta * 0.1) return delta
    throw new Error(`fill timeout: ${denom.slice(0, 12)} grew less than expected`)
  }
  now(): number {
    return this.clock
  }
  advance(ms: number) {
    this.clock += ms
  }
  async shouldStop(): Promise<boolean> {
    this.calls.stop++
    return this.faults.stopAfterChecks !== null && this.calls.stop >= this.faults.stopAfterChecks
  }
  logEntry = (e: ExecLogEntry) => {
    this.log.push(e)
  }
}

/** ExecPorts adapter around the mock. */
export function ports(chain: MockChain): ExecPorts {
  return {
    address: chain.address,
    status: () => chain.status(),
    bankRaw: (d) => chain.bankRaw(d),
    book: (m) => chain.book(m),
    spotMarketActive: () => chain.spotMarketActive(),
    withdrawCollateral: (d, s) => chain.withdrawCollateral(d, s),
    repay: (d, a) => chain.repay(d, a),
    borrow: (d, a) => chain.borrow(d, a),
    deposit: (d, a) => chain.deposit(d, a),
    spotMarketOrder: (m, side, q, w) => chain.spotMarketOrder(m, side, q, w),
    waitForFill: (d, b, m, t) => chain.waitForFill(d, b, m, t),
    now: () => chain.now(),
    shouldStop: () => chain.shouldStop(),
    log: (e) => chain.logEntry(e),
  }
}
