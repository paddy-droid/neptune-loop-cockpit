/**
 * Mild buy filters for the autopilot. They only ever block ADDING leverage; reduce / exit are never held back.
 *
 * - Cooldown: no new buy within `cooldownMin` of the last own buy (from a caller-supplied timestamp,
 *   e.g. the runner's local log, or the account's trade history).
 * - Hold check: the add threshold must have been breached for at least `holdMin` minutes
 *   (LTV_then = LTV_now × P_now / P_then) - no chasing a single candle.
 */

export interface GuardResult {
  ok: boolean
  reason: string
}

export const BUY_COOLDOWN_MIN = 30
export const BUY_HOLD_MIN = 15

export function buyCooldownGuard(lastBuyAtMs: number | null, nowMs: number, cooldownMin = BUY_COOLDOWN_MIN): GuardResult {
  if (!lastBuyAtMs) return { ok: true, reason: 'no earlier buy' }
  const ageMin = (nowMs - lastBuyAtMs) / 60_000
  if (ageMin < cooldownMin) return { ok: false, reason: `buy cooldown: last buy ${ageMin.toFixed(0)} min ago (< ${cooldownMin})` }
  return { ok: true, reason: `last buy ${ageMin.toFixed(0)} min ago` }
}

/**
 * `priceThen` = price about `holdMin` minutes ago (from 1-minute candles or the runner's own price history).
 * Returns ok:false when the threshold was NOT yet breached at that price.
 */
export function buyHoldGuard(ltvNow: number, buyTriggerLtv: number, priceNow: number, priceThen: number | null, holdMin = BUY_HOLD_MIN): GuardResult {
  if (!(priceThen && priceThen > 0 && priceNow > 0)) return { ok: false, reason: 'no price history for the hold check - buy postponed to the next tick' }
  const ltvThen = ltvNow * (priceNow / priceThen)
  if (ltvThen >= buyTriggerLtv) {
    return { ok: false, reason: `hold check: threshold breached for less than ${holdMin} min (price ${holdMin} min ago: $${priceThen.toFixed(3)}) - no candle chasing` }
  }
  return { ok: true, reason: `move has held for >= ${holdMin} min` }
}

/** Fetch 1-minute candles from Binance (browser-safe). Returns the open of the oldest candle in the window, or null. */
export async function priceMinutesAgo(minutes: number, fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)): Promise<number | null> {
  for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
    try {
      const res = await fetchImpl(`${host}/api/v3/klines?symbol=INJUSDT&interval=1m&limit=${minutes + 1}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const k = (await res.json()) as string[][]
      if (Array.isArray(k) && k.length >= minutes) {
        const p = parseFloat(k[0][1])
        if (p > 0) return p
      }
    } catch {
      /* next host */
    }
  }
  return null
}

/** Ring buffer of (time, price) samples the runner records every tick - fallback for the hold check. */
export class PriceHistory {
  private samples: { t: number; p: number }[] = []
  constructor(private readonly keepMs = 2 * 3_600_000) {}
  record(t: number, p: number) {
    this.samples.push({ t, p })
    const cutoff = t - this.keepMs
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift()
  }
  /** Latest sample at or before `t - minutes` (null if none). */
  priceBefore(t: number, minutes: number): number | null {
    const cutoff = t - minutes * 60_000
    let best: { t: number; p: number } | null = null
    for (const s of this.samples) if (s.t <= cutoff) best = s
    return best?.p ?? null
  }
}
