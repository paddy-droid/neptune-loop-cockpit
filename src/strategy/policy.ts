/**
 * The decision function of the loop strategy.
 *
 * `decide()` is pure and stateless: the recommendation follows ONLY from the
 * on-chain status (oracle price, position, pool state) plus public daily price
 * history (trend filter). No memory, no database, no side effects. That makes it
 * idempotent: calling it twice with the same inputs gives the same answer, and a
 * crash or a stale tab cannot leave "half a decision" behind.
 *
 * Health and LTV: with INJ-only collateral and stablecoin debt,
 *   health = liquidationLtv / ltv   (liquidationLtv is 0.80 today)
 *   LTV 0.56 = health 1.43 | 0.48 = 1.67 | 0.50 = 1.60 | 0.40 = 2.00 | 0.36 = 2.22
 *
 * Priority order of the checks (first hit wins):
 *   1. mode off                      -> none
 *   2. broken numbers (NaN)          -> none + dataError
 *   3. oracle price 0                -> none + dataError
 *   4. health*ltv != liquidationLtv  -> none + dataError (unknown collateral / oracle gap)
 *   5. oracle stale                  -> none + dataError (or protective repay if fresh market data says so)
 *   6. exit rung                     -> exit (only with a fresh market-price confirmation)
 *   7. no debt                       -> none
 *   8. LTV above repay trigger       -> down
 *   9. LTV below buy trigger         -> up (unless anything blocks buying)
 *  10. otherwise                     -> none ("inside the band")
 */
import type { Status } from '../chain/neptune'
import type { Trend } from '../market/trend'
import type { Rung, StrategyConfig, StrategyMode } from './types'

export type Action = 'none' | 'down' | 'up' | 'exit'

export interface TrendFilterState {
  available: boolean
  /** Filter is active (daily close below SMA, or live price in the panic band). */
  active: boolean
  why: string
  sma: number
  distSmaPct: number
  /** Effective LTV cap while active. */
  ltvCap: number | null
  /** Adding leverage is blocked (for any reason, not only the trend). */
  buyBlocked: boolean
  noBuyWhy?: string
}

export interface RateGuardState {
  borrowApr: number
  buyBlocked: boolean
  ltvCap: number | null
  why: string
}

export interface EffectiveThresholds {
  repayTriggerLtv: number
  repayTargetLtv: number
  buyTriggerLtv: number | null
  buyLtv: number | null
}

export interface Decision {
  action: Action
  targetLtv?: number
  reason: string
  rung: Rung
  mode: StrategyMode
  /** Thresholds AFTER trend filter, rate guard and liquidation-LTV scaling. */
  effective: EffectiveThresholds
  trend: TrendFilterState
  rate: RateGuardState
  /** Set when the inputs are implausible. Never act on a decision that carries a dataError. */
  dataError?: string
  /** Exchange price used as reference when it is fresh and below the oracle. */
  refPrice?: number
  /** Non-blocking hint: 'usdt' = debt is not USDC, 'oracle-gap' = exchange price >15 % below oracle. */
  warn?: 'usdt' | 'oracle-gap'
  /** Effective LTV used for the repay trigger (oracle LTV, or higher if the exchange price is lower). */
  ltvEff: number
}

const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)} %`

/** Market data younger than cfg.marketFreshSec. */
export function trendIsFresh(trend: Trend | null | undefined, cfg: StrategyConfig, nowMs = Date.now()): boolean {
  return !!trend?.ok && Number.isFinite(Date.parse(trend.fetchedAt)) && nowMs - Date.parse(trend.fetchedAt) < cfg.marketFreshSec * 1000
}

export function rungForPrice(ladder: Rung[], price: number): Rung {
  return ladder.find((r) => price <= r.upTo) ?? ladder[ladder.length - 1]
}

export function decide(s: Status, trend: Trend | null, cfg: StrategyConfig, nowMs = Date.now()): Decision {
  const mode = cfg.mode
  const P = s.injPrice
  const rung = rungForPrice(cfg.ladder, P)
  const fresh = trendIsFresh(trend, cfg, nowMs)
  const refPrice = fresh && trend!.lastClose > 0 && trend!.lastClose < P ? trend!.lastClose : undefined
  const oracleGap = refPrice !== undefined && refPrice / P < 1 / 1.15

  const tfCfg = cfg.trendFilter
  const useTrend = tfCfg.enabled && !!trend?.ok
  const active = useTrend && !!trend && trend.filterActive && !rung.exit
  const noTrendData = tfCfg.enabled && !trend?.ok
  const liveBelow = useTrend && !!trend && trend.lastClose < trend.sma
  const tf: TrendFilterState = {
    available: useTrend,
    active,
    why: trend?.filterWhy ?? 'no price history',
    sma: trend?.sma ?? 0,
    distSmaPct: trend?.distSmaPct ?? 0,
    ltvCap: active ? tfCfg.ltvCap : null,
    buyBlocked: active,
  }

  const borrowApr = s.rates.find((r) => r.symbol === 'USDC')?.borrow ?? 0
  const rateDelever = borrowApr >= cfg.rateGuard.deleverApr && !rung.exit
  const rateBlock = borrowApr >= cfg.rateGuard.blockBuyApr
  const rg: RateGuardState = {
    borrowApr,
    buyBlocked: rateBlock,
    ltvCap: rateDelever ? tfCfg.ltvCap : null,
    why: rateDelever
      ? `USDC borrow APR ${pct(borrowApr)} >= ${pct(cfg.rateGuard.deleverApr, 0)} - de-levering`
      : rateBlock
        ? `USDC borrow APR ${pct(borrowApr)} >= ${pct(cfg.rateGuard.blockBuyApr, 0)} - no new leverage`
        : `USDC borrow APR ${pct(borrowApr)} ok`,
  }

  // If Neptune changes the liquidation LTV (0.80 today) every threshold scales with it and buying is blocked.
  const liq = s.injLiqLtv > 0 ? s.injLiqLtv : 0.8
  const liqScale = Math.abs(liq - 0.8) > 0.005 ? liq / 0.8 : 1
  const capped = active || rateDelever
  const poolTight = s.usdcUtilization >= cfg.poolTightUtilization
  const noBuy = active || rateBlock || noTrendData || liveBelow || liqScale !== 1 || poolTight
  const repayTriggerLtv = (capped ? Math.min(rung.repayTriggerLtv, tfCfg.ltvCapTrigger) : rung.repayTriggerLtv) * liqScale
  const repayTargetLtv = (capped ? Math.min(rung.repayTargetLtv, tfCfg.ltvCap) : rung.repayTargetLtv) * liqScale
  tf.buyBlocked = noBuy
  tf.noBuyWhy = active
    ? tf.why
    : noTrendData
      ? 'no price history (fail-safe: never add leverage blind)'
      : liveBelow
        ? `live price below SMA${tfCfg.smaDays} (hysteresis)`
        : rateBlock
          ? rg.why
          : liqScale !== 1
            ? `Neptune liquidation LTV is ${liq} instead of 0.80 - re-check the ladder`
            : poolTight
              ? `USDC pool ${pct(s.usdcUtilization, 0)} utilised (rate curve steep, borrowing halts near 95 %)`
              : undefined
  const buyTriggerLtv = !noBuy && mode === 'full' && rung.buyTriggerLtv ? rung.buyTriggerLtv : null
  const buyLtv = !noBuy && mode === 'full' && rung.buyLtv ? rung.buyLtv : null
  const effective: EffectiveThresholds = { repayTriggerLtv, repayTargetLtv, buyTriggerLtv, buyLtv }

  const base = { rung, mode, effective, trend: tf, rate: rg, refPrice, warn: oracleGap ? ('oracle-gap' as const) : undefined, ltvEff: s.ltv }

  if (mode === 'off') return { action: 'none', reason: 'Strategy mode is OFF', ...base }

  for (const [k, v] of Object.entries({ injPrice: s.injPrice, health: s.health, collateralUsd: s.collateralUsd, debtUsd: s.debtUsd, ltv: s.ltv })) {
    if (!Number.isFinite(v)) return { action: 'none', reason: `DATA ERROR: ${k} is ${String(v)} - no action`, dataError: `${k} invalid`, ...base }
  }
  if (!(P > 0)) return { action: 'none', reason: 'DATA ERROR: oracle price is 0 or missing - no action', dataError: 'oracle price invalid', ...base }

  if (s.debtUsd >= 1) {
    if (!(s.collateralUsd > 0) || !(s.health > 0)) {
      return { action: 'none', reason: 'DATA ERROR: collateral or health is 0 while debt exists - no action', dataError: 'status incomplete', ...base }
    }
    // Plausibility: INJ-only collateral + stable debt => health * ltv == liquidation LTV.
    const injCollUsd = (s.collateral.find((c) => c.symbol === 'INJ')?.amount ?? 0) * P
    const injShare = s.collateralUsd > 0 ? injCollUsd / s.collateralUsd : 1
    const cf = s.health * s.ltv
    if (injShare >= 0.95 && Math.abs(cf - liq) > 0.03) {
      return { action: 'none', reason: `DATA ERROR: health x LTV = ${cf.toFixed(3)} instead of ${liq.toFixed(2)} (oracle gap or unknown collateral) - no action`, dataError: `collateral factor ${cf.toFixed(3)} instead of ${liq.toFixed(2)}`, ...base }
    }
    if (s.oracleAgeSec < 0) return { action: 'none', reason: 'DATA ERROR: oracle timestamp missing - no action', dataError: 'oracle timestamp missing', ...base }
    if (s.oracleAgeSec > cfg.maxOracleAgeSec) {
      // Stale oracle but FRESH exchange data clearly lower: the contract still values the collateral high,
      // so repaying now is possible and right. The planner then works with the exchange price.
      if (fresh && trend!.lastClose > 0) {
        const ltvMarket = s.ltv * (P / trend!.lastClose)
        if (ltvMarket > repayTriggerLtv) {
          return { action: 'down', targetLtv: repayTargetLtv, reason: `Oracle stale (${Math.round(s.oracleAgeSec / 60)} min) but exchange LTV ${pct(ltvMarket)} is above the limit - protective repay to ${pct(repayTargetLtv, 0)}`, dataError: `oracle stale (${Math.round(s.oracleAgeSec)} s)`, ...base, ltvEff: ltvMarket }
        }
      }
      return { action: 'none', reason: `DATA ERROR: oracle price is ${Math.round(s.oracleAgeSec / 60)} min old - no action`, dataError: `oracle stale (${Math.round(s.oracleAgeSec)} s)`, ...base }
    }
  }

  const injColl = s.collateral.find((c) => c.symbol === 'INJ')?.amount ?? 0
  const injWallet = s.bank.find((b) => b.symbol === 'INJ')?.amount ?? 0
  const exitPrice = cfg.ladder[cfg.ladder.indexOf(rung) - 1]?.upTo ?? 0

  if (rung.exit) {
    if (!trend?.ok) return { action: 'none', reason: `Exit waits: oracle $${P.toFixed(2)} is above $${exitPrice}, but there is no exchange confirmation (no price data)`, ...base }
    if (!fresh) return { action: 'none', reason: `Exit waits: oracle $${P.toFixed(2)} is above $${exitPrice}, but the exchange confirmation is ${Math.round((nowMs - Date.parse(trend.fetchedAt)) / 60000)} min old (max ${Math.round(cfg.marketFreshSec / 60)})`, ...base }
    if (trend.lastClose <= exitPrice) return { action: 'none', reason: `Exit waits: oracle $${P.toFixed(2)} is above $${exitPrice}, exchange $${trend.lastClose.toFixed(2)} is not - no single-print exit`, ...base }
    if (s.debtUsd > 1 || injColl > 1.25 || injWallet > 2.1) {
      return { action: 'exit', reason: `INJ $${P.toFixed(2)} is above the exit mark $${exitPrice} - full exit into stablecoins (keep ~${(1 + cfg.gasReserveInj).toFixed(1)} INJ for gas)`, ...base }
    }
    return { action: 'none', reason: 'Exit already done', ...base }
  }

  if (s.debtUsd < 1) return { action: 'none', reason: 'No debt - nothing to do', ...base }

  // Effective LTV for the repay trigger: if a fresh exchange price is below the oracle (oracle lags in a crash), the lower price counts (max +15 %).
  const ltvEff = fresh && trend!.lastClose > 0 && trend!.lastClose < P && s.ltv > repayTargetLtv + 0.005
    ? Math.min(s.ltv * (P / trend!.lastClose), s.ltv * 1.15)
    : s.ltv

  const usdcDebtUsd = s.debts.find((d) => d.symbol === 'USDC')?.usd ?? 0
  if (usdcDebtUsd < 0.5 && s.debtUsd >= 1 && ltvEff > repayTriggerLtv) {
    return { ...base, ltvEff, action: 'none', warn: 'usdt', reason: `LTV ${pct(s.ltv)} is above the limit, but the debt is not USDC (${s.debts.map((d) => d.symbol).join('/')}) - repay it in its own asset or rotate the debt to USDC first` }
  }
  if (ltvEff > repayTriggerLtv) {
    const why = capped && repayTriggerLtv < rung.repayTriggerLtv
      ? `${active ? 'Trend filter (' + tf.why + ')' : 'Rate guard (' + rg.why + ')'} - LTV ${pct(s.ltv)} is above the cap trigger ${pct(repayTriggerLtv, 0)} - reduce to ${pct(repayTargetLtv, 0)}`
      : `LTV ${pct(s.ltv)}${ltvEff > s.ltv + 0.002 ? ` (effective ${pct(ltvEff)} at the exchange price)` : ''} is above the limit ${pct(repayTriggerLtv)} (rung "${rung.label}") - reduce to ${pct(repayTargetLtv, 0)}`
    return { action: 'down', targetLtv: repayTargetLtv, reason: why, ...base, ltvEff }
  }

  if (mode === 'full' && rung.buyLtv && rung.buyTriggerLtv && s.ltv < rung.buyTriggerLtv) {
    if (noBuy) {
      return { action: 'none', reason: `Adding leverage is paused: ${tf.noBuyWhy}`, ...base, ltvEff }
    }
    return { action: 'up', targetLtv: rung.buyLtv, reason: `LTV ${pct(s.ltv)} is below the add threshold ${pct(rung.buyTriggerLtv)} - add leverage up to ${pct(rung.buyLtv, 0)}`, ...base, ltvEff }
  }

  const inBand = active ? `inside the band - trend filter active (${tf.why})` : rateBlock ? `inside the band - ${rg.why}` : 'inside the band - nothing to do'
  return { action: 'none', reason: inBand, ...base, ltvEff }
}
