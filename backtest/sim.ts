/**
 * Loop-strategy simulator without look-ahead.
 *
 * Each day is walked as an intraday path open -> first extreme -> second extreme -> close
 * in STEPS sub-steps. The trend filter only knows the SMA of COMPLETED days (the SMA that was
 * known at yesterday's close), exactly like the live policy. Interest accrues daily, every
 * trade pays SLIP (slippage + fees).
 *
 * This is a port of the author's `sim_nolook.js`; the earlier `sim.js` family used the daily
 * close intraday (look-ahead) and overstated results - do not resurrect that.
 *
 * Simplifications versus live: no oracle staleness, no pool capacity limit, no rate guard
 * (interest is a constant APR), no cooldown other than one buy per quarter day.
 */
import type { Rung } from '../src/strategy/types'

export interface Day {
  t: string
  o: number
  h: number
  l: number
  c: number
  /** Warm-up day: only feeds the SMA, no trading. */
  warm?: boolean
}

export interface SimOptions {
  ladder: Rung[]
  mode?: 'full' | 'repay-only'
  /** Trend filter on/off. */
  trend?: boolean
  /** LTV cap while the trend filter is active (null = only "no buying"). */
  trendLtvCap?: number | null
  smaDays?: number
  panicPct?: number
  apr?: number
  slip?: number
  liqLtv?: number
  steps?: number
  inj?: number
  debt?: number
}

export interface SimResult {
  equity: number
  buys: number
  sells: number
  exited: boolean
  liquidated: boolean
  maxDrawdownPct: number
  minHealth: number
}

function intradayPath(d: Day, steps: number): number[] {
  const first = Math.abs(d.o - d.l) < Math.abs(d.o - d.h) ? [d.l, d.h] : [d.h, d.l]
  const pts = [d.o, first[0], first[1], d.c]
  const out: number[] = []
  const per = steps / 3
  for (let s = 0; s < 3; s++) for (let k = 0; k < per; k++) out.push(pts[s] + (pts[s + 1] - pts[s]) * (k / per))
  out.push(d.c)
  return out
}

export function simulate(days: Day[], o: SimOptions): SimResult {
  const L = o.ladder
  const mode = o.mode ?? 'full'
  const APR = o.apr ?? 0.16
  const SLIP = o.slip ?? 0.01
  const LIQ = o.liqLtv ?? 0.8
  const STEPS = o.steps ?? 24
  const n = o.smaDays ?? 50
  const panicPct = o.panicPct ?? 0.05
  let inj = o.inj ?? 1000
  let debt = o.debt ?? 2700
  let usdc = 0
  let buys = 0
  let sells = 0
  let exited = false
  let liquidated = false
  let maxEq = 0
  let maxDD = 0
  let minHealth = Infinity
  let lastBuy = -1e9
  let t = 0
  const closes: number[] = []
  const equity = (P: number) => inj * P - debt + usdc
  const rebalance = (P: number, target: number) => {
    const coll = inj * P
    const x = (debt - target * coll) / (1 - target)
    if (x > 0) {
      inj -= (x / P) * (1 + SLIP)
      debt -= x
      sells++
    } else {
      debt += -x
      inj += (-x / P) * (1 - SLIP)
      buys++
    }
  }
  for (const d of days) {
    if (!d.warm) debt *= 1 + APR / 365
    const smaPrev = closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : NaN
    const prevClose = closes[closes.length - 1]
    closes.push(d.c)
    if (d.warm || exited || liquidated) continue
    for (const P of intradayPath(d, STEPS)) {
      t++
      const ltv = debt / (inj * P)
      if (debt > 0) minHealth = Math.min(minHealth, LIQ / ltv)
      if (ltv >= LIQ) {
        liquidated = true
        inj = 0
        debt = 0
        break
      }
      const r = L.find((x) => P <= x.upTo) ?? L[L.length - 1]
      let rt = r.repayTriggerLtv
      let rg = r.repayTargetLtv
      let bt = r.buyTriggerLtv
      const bl = r.buyLtv
      const dailyBelow = Number.isFinite(smaPrev) && prevClose < smaPrev
      const panic = Number.isFinite(smaPrev) && P < smaPrev * (1 - panicPct)
      const active = !!o.trend && (dailyBelow || panic)
      if (o.trend && Number.isFinite(smaPrev) && (active || P < smaPrev)) bt = undefined
      if (active && o.trendLtvCap != null) {
        rt = Math.min(rt, o.trendLtvCap + 0.04)
        rg = Math.min(rg, o.trendLtvCap)
      }
      if (r.exit) {
        usdc += (inj - 1) * P * (1 - SLIP) - debt
        inj = 1
        debt = 0
        exited = true
        break
      }
      if (ltv > rt) {
        if (rg === 0) {
          inj -= (debt / P) * (1 + SLIP)
          debt = 0
          sells++
        } else rebalance(P, rg)
      } else if (mode === 'full' && bl && bt && ltv < bt && t - lastBuy >= STEPS / 4) {
        rebalance(P, bl)
        lastBuy = t
      }
    }
    const e = equity(d.c)
    if (e > maxEq) maxEq = e
    const dd = 1 - e / maxEq
    if (dd > maxDD) maxDD = dd
  }
  return { equity: Math.round(equity(days[days.length - 1].c)), buys, sells, exited, liquidated, maxDrawdownPct: Math.round(maxDD * 100), minHealth: Number.isFinite(minHealth) ? Math.round(minHealth * 1000) / 1000 : Infinity }
}

/**
 * Benchmark: hold the same starting EQUITY in INJ without leverage (no debt, no interest).
 * Starting equity = inj * P0 - debt, converted into INJ at the first live close.
 */
export function holdResult(days: Day[], inj = 1000, debt = 2700): { equity: number; maxDrawdownPct: number } {
  const live = days.filter((d) => !d.warm)
  const p0 = live[0].c
  const units = (inj * p0 - debt) / p0
  let dd = 0
  let mx = 0
  for (const d of live) {
    const e = units * d.c
    mx = Math.max(mx, e)
    dd = Math.max(dd, 1 - e / mx)
  }
  return { equity: Math.round(units * live[live.length - 1].c), maxDrawdownPct: Math.round(dd * 100) }
}

/** Slice a window and prepend up to 60 warm-up days for the SMA. */
export function windowWithWarmup(all: Day[], from: string, to: string, warm = 60): Day[] {
  const i = all.findIndex((d) => d.t >= from)
  if (i < 0) return []
  return all
    .slice(Math.max(0, i - warm))
    .filter((d) => d.t <= to)
    .map((d, k) => ({ ...d, warm: k < Math.min(warm, i) }))
}

/** Rescale a window so its first live close equals `to` (compare windows at today's price level). */
export function rescale(days: Day[], to: number): Day[] {
  const first = days.find((d) => !d.warm)
  if (!first) return days
  const f = to / first.c
  return days.map((d) => ({ t: d.t, warm: d.warm, o: d.o * f, h: d.h * f, l: d.l * f, c: d.c * f }))
}
