/**
 * Strategy configuration types and the default parameter set.
 *
 * The defaults are the "Band E" parameters the original author runs live since
 * 26 Aug 2026 (see docs/STRATEGY.md for the reasoning and the backtest evidence).
 * Everything is a plain object so it can be edited in the UI, stored in
 * localStorage, or replaced by your own JSON.
 */

export interface Rung {
  /** The rung applies while the INJ oracle price is <= upTo (USD). Use Infinity for the last rung. */
  upTo: number
  label: string
  /** Above this LTV: reduce leverage (sell INJ, repay). */
  repayTriggerLtv: number
  /** Repay down to this LTV. */
  repayTargetLtv: number
  /** Below this LTV (loop zone only): add leverage (borrow, buy INJ, deposit). */
  buyTriggerLtv?: number
  /** Add leverage up to this LTV. */
  buyLtv?: number
  /** Full exit rung: sell everything into stablecoins. */
  exit?: boolean
}

export type StrategyMode = 'full' | 'repay-only' | 'off'

export interface TrendFilterConfig {
  enabled: boolean
  /** Simple moving average length in days (50). */
  smaDays: number
  /** While the filter is active: LTV cap the strategy de-levers to. */
  ltvCap: number
  /** LTV above which de-levering to the cap is triggered. */
  ltvCapTrigger: number
  /** Live price more than this fraction below the SMA activates the filter immediately (0.05 = 5 %). */
  panicPct: number
}

export interface RateGuardConfig {
  /** USDC borrow APR at or above which no new leverage is added (0.25 = 25 %). */
  blockBuyApr: number
  /** USDC borrow APR at or above which the strategy de-levers to the trend cap (0.35 = 35 %). */
  deleverApr: number
}

export interface StrategyConfig {
  /** Free-text name shown in the UI. */
  name: string
  /** Price ladder, ascending by upTo. The last rung must have upTo = Infinity. */
  ladder: Rung[]
  mode: StrategyMode
  trendFilter: TrendFilterConfig
  rateGuard: RateGuardConfig
  /** USDC pool utilisation at or above which adding leverage is blocked (0.85). */
  poolTightUtilization: number
  /** Oracle price older than this (seconds) is treated as stale (600). */
  maxOracleAgeSec: number
  /** Market (exchange) price data older than this (seconds) is not used for comparisons (180). */
  marketFreshSec: number
  /** Assumed slippage + fees for one INJ trade, used by the planner (0.01 = 1 %). */
  tradeCostPct: number
  /** Interim LTV the planner allows during a withdraw-sell-repay round (0.70). */
  interimLtvCap: number
  /** INJ to keep in the wallet for gas (0.5). */
  gasReserveInj: number
}

export const DEFAULT_LADDER: Rung[] = [
  { upTo: 25, label: 'Loop zone', repayTriggerLtv: 0.56, repayTargetLtv: 0.48, buyTriggerLtv: 0.36, buyLtv: 0.4 },
  { upTo: 30, label: 'Secure I', repayTriggerLtv: 0.57, repayTargetLtv: 0.53 },
  { upTo: 36, label: 'Secure II', repayTriggerLtv: 0.49, repayTargetLtv: 0.45 },
  { upTo: 44, label: 'Secure III', repayTriggerLtv: 0.4, repayTargetLtv: 0.36 },
  { upTo: 52, label: 'Half the debt', repayTriggerLtv: 0.28, repayTargetLtv: 0.24 },
  { upTo: 62, label: 'Secure IV', repayTriggerLtv: 0.18, repayTargetLtv: 0.14 },
  { upTo: 75, label: 'Pre-exit', repayTriggerLtv: 0.1, repayTargetLtv: 0.06 },
  { upTo: Infinity, label: 'EXIT', repayTriggerLtv: 0, repayTargetLtv: 0, exit: true },
]

export const DEFAULT_STRATEGY: StrategyConfig = {
  name: 'Band E (default)',
  ladder: DEFAULT_LADDER,
  mode: 'full',
  trendFilter: { enabled: true, smaDays: 50, ltvCap: 0.5, ltvCapTrigger: 0.54, panicPct: 0.05 },
  rateGuard: { blockBuyApr: 0.25, deleverApr: 0.35 },
  poolTightUtilization: 0.85,
  maxOracleAgeSec: 600,
  marketFreshSec: 180,
  tradeCostPct: 0.01,
  interimLtvCap: 0.7,
  gasReserveInj: 0.5,
}

/** Validate a config coming from localStorage / user JSON. Returns a list of problems (empty = ok). */
export function validateStrategy(cfg: unknown): string[] {
  const errors: string[] = []
  const c = cfg as Partial<StrategyConfig> | null
  if (!c || typeof c !== 'object') return ['config is not an object']
  if (!Array.isArray(c.ladder) || c.ladder.length === 0) errors.push('ladder must be a non-empty array')
  else {
    let prev = 0
    c.ladder.forEach((r, i) => {
      if (typeof r.upTo !== 'number' || !(r.upTo > prev)) errors.push(`ladder[${i}].upTo must be a number greater than the previous rung (${prev})`)
      prev = r.upTo
      for (const k of ['repayTriggerLtv', 'repayTargetLtv'] as const) {
        const v = r[k]
        if (typeof v !== 'number' || v < 0 || v >= 1) errors.push(`ladder[${i}].${k} must be within [0, 1)`)
      }
      if (!r.exit && r.repayTargetLtv > r.repayTriggerLtv) errors.push(`ladder[${i}]: repayTargetLtv must be <= repayTriggerLtv`)
      if (r.buyLtv !== undefined || r.buyTriggerLtv !== undefined) {
        if (typeof r.buyLtv !== 'number' || typeof r.buyTriggerLtv !== 'number') errors.push(`ladder[${i}]: buyLtv and buyTriggerLtv must both be numbers`)
        else {
          if (r.buyTriggerLtv > r.buyLtv) errors.push(`ladder[${i}]: buyTriggerLtv must be <= buyLtv`)
          if (r.buyLtv >= r.repayTargetLtv) errors.push(`ladder[${i}]: buyLtv must be below repayTargetLtv (otherwise the strategy oscillates)`)
        }
      }
    })
    const last = c.ladder[c.ladder.length - 1]
    if (last && last.upTo !== Infinity && last.upTo !== null) errors.push('the last rung must have upTo = Infinity')
  }
  if (!['full', 'repay-only', 'off'].includes(String(c.mode))) errors.push('mode must be full | repay-only | off')
  const tf = c.trendFilter
  if (!tf || typeof tf !== 'object') errors.push('trendFilter missing')
  else {
    if (!(tf.smaDays >= 5 && tf.smaDays <= 400)) errors.push('trendFilter.smaDays must be 5..400')
    if (!(tf.ltvCap > 0 && tf.ltvCap < 1)) errors.push('trendFilter.ltvCap must be within (0, 1)')
    if (!(tf.ltvCapTrigger >= tf.ltvCap && tf.ltvCapTrigger < 1)) errors.push('trendFilter.ltvCapTrigger must be >= ltvCap and < 1')
    if (!(tf.panicPct >= 0 && tf.panicPct < 0.5)) errors.push('trendFilter.panicPct must be 0..0.5')
  }
  const rg = c.rateGuard
  if (!rg || typeof rg !== 'object') errors.push('rateGuard missing')
  else if (!(rg.blockBuyApr > 0 && rg.deleverApr >= rg.blockBuyApr)) errors.push('rateGuard: 0 < blockBuyApr <= deleverApr')
  for (const k of ['poolTightUtilization', 'tradeCostPct', 'interimLtvCap'] as const) {
    const v = c[k]
    if (typeof v !== 'number' || v < 0 || v >= 1) errors.push(`${k} must be within [0, 1)`)
  }
  if (typeof c.maxOracleAgeSec !== 'number' || c.maxOracleAgeSec < 30) errors.push('maxOracleAgeSec must be >= 30')
  if (typeof c.marketFreshSec !== 'number' || c.marketFreshSec < 30) errors.push('marketFreshSec must be >= 30')
  if (typeof c.gasReserveInj !== 'number' || c.gasReserveInj < 0) errors.push('gasReserveInj must be >= 0')
  return errors
}

/** JSON round-trip helper: Infinity is not valid JSON, so the last rung is stored as null and restored here. */
export function serializeStrategy(cfg: StrategyConfig): string {
  return JSON.stringify(cfg, (_k, v) => (v === Infinity ? null : v), 2)
}

export function parseStrategy(json: string): StrategyConfig {
  const obj = JSON.parse(json) as StrategyConfig
  if (Array.isArray(obj.ladder)) {
    obj.ladder = obj.ladder.map((r) => ({ ...r, upTo: r.upTo === null || r.upTo === undefined ? Infinity : r.upTo }))
  }
  const errors = validateStrategy(obj)
  if (errors.length) throw new Error('Invalid strategy config: ' + errors.join('; '))
  return obj
}
