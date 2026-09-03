/**
 * Execution layer types. The engine talks to the world only through `ExecPorts`,
 * so the same code runs in the browser (Keplr or session key), in a Node runner
 * (session key) and in tests (in-memory mock chain).
 */
import type { Status } from '../chain/neptune'

export type SpotMarketKey = 'INJ/USDC' | 'USDC/USDT'

export interface BookQuote {
  bestBid: number
  bestAsk: number
  spreadPct: number
  /** VWAP for a base quantity walked through the levels; null = book too thin. */
  vwapBuy: (baseQty: number) => number | null
  vwapSell: (baseQty: number) => number | null
  depthBidUsd: number
  depthAskUsd: number
  /** Depth within 2 % of the best price only (far-away spoof/rest orders do not count). */
  depthBidNearUsd: number
  depthAskNearUsd: number
}

export interface TxResult {
  txHash: string
}

/** Thrown by a port when a transaction was sent but its outcome is unknown (timeout, lost response). */
export class UnclearTxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnclearTxError'
  }
}

/** Thrown by the engine when `shouldStop()` returns true mid-run. */
export class StoppedError extends Error {
  constructor(message = 'stopped') {
    super(message)
    this.name = 'StoppedError'
  }
}

export interface ExecPorts {
  /** Address whose position is managed (the granter in session mode). */
  address: string
  status(): Promise<Status>
  /** Bank balance in base units (INJ: 1e18, USDC/USDT: 1e6). Must throw on read errors, never return 0 silently. */
  bankRaw(denom: string): Promise<number>
  book(market: SpotMarketKey): Promise<BookQuote>
  spotMarketActive(market: SpotMarketKey): Promise<boolean>
  /** Withdraw collateral by SHARES (raw integer string). */
  withdrawCollateral(denom: string, shares: string): Promise<TxResult>
  repay(denom: string, amountRaw: string): Promise<TxResult>
  borrow(denom: string, amountRaw: string): Promise<TxResult>
  deposit(denom: string, amountRaw: string): Promise<TxResult>
  /** Market order; `baseQty` in human units, `worstPrice` is the limit the chain enforces. */
  spotMarketOrder(market: SpotMarketKey, side: 'buy' | 'sell', baseQty: number, worstPrice: number): Promise<TxResult>
  /** Poll the bank until `denom` grew by at least `minDelta` base units; returns the real delta (partial fills accepted ≥ 10 %). */
  waitForFill(denom: string, before: number, minDelta: number, timeoutMs?: number): Promise<number>
  now(): number
  /** Cooperative stop: checked at every round boundary. */
  shouldStop(): Promise<boolean>
  log(entry: ExecLogEntry): void
}

export interface ExecLogEntry {
  step: string
  txHash?: string
  info: string
}

export type LoopMode = 'up' | 'down' | 'emergency'

export interface LoopRequest {
  mode: LoopMode
  /** 0..0.70 for up/down. */
  targetLtv?: number
  /** Default 1.0 (%). Clamped to 0.1..3. */
  slippagePct?: number
  /** emergency: sell remaining INJ into USDC after the debt is gone. */
  sellAllInj?: boolean
  /** emergency/exit: INJ to keep in the wallet. */
  keepInj?: number
  /** Do not touch INJ that was already in the wallet (only what this run withdrew). */
  noWalletInj?: boolean
  /** Do not use wallet USDC as reserve-first repayment. */
  noWalletUsdc?: boolean
  /** Time budget starts here (ms epoch). Default: now. */
  startedAt?: number
  /** Exchange reference price below the oracle: valuations use the lower price. */
  refPrice?: number
  /** Oracle expired in the contract / market halted: only wallet USDC can repay. */
  walletOnly?: boolean
}

export interface ExecResult {
  log: ExecLogEntry[]
  done: boolean
  /** Stopped cleanly with work left (time budget, book too thin, paused) - the next tick continues. */
  deferred?: boolean
}

export interface ExecutionConfig {
  /** Interim LTV cap per withdraw round (0.70 = ~12.5 % price buffer while INJ sits unsold in the wallet). */
  roundLtvCap: number
  /** Small-step limit when the LTV is already above the round cap (never above allowable − 0.01). */
  stepLtvLimit: number
  /** Taker fee + buffer, in percent (0.15). */
  feePct: number
  /** Max share of the near-book depth per order (0.4). */
  depthShare: number
  /** INJ kept in the wallet for gas (0.5). */
  gasReserveInj: number
  maxRounds: number
  /** Stop starting new work after this many ms (230 s). */
  timeBudgetMs: number
  /** Do not start a new round with less than this much budget left (100 s). */
  roundMarginMs: number
  slipMin: number
  slipMax: number
}

export const DEFAULT_EXECUTION: ExecutionConfig = {
  roundLtvCap: 0.7,
  stepLtvLimit: 0.77,
  feePct: 0.15,
  depthShare: 0.4,
  gasReserveInj: 0.5,
  maxRounds: 12,
  timeBudgetMs: 230_000,
  roundMarginMs: 100_000,
  slipMin: 0.001,
  slipMax: 0.03,
}
