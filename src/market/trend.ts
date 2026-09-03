/**
 * Daily price history + trend filter (SMA with hysteresis).
 *
 * Sources, tried in order (all allow browser requests):
 *   1. api.binance.com        INJUSDT daily klines
 *   2. data-api.binance.vision public mirror (Binance blocks some regions on the main host)
 *   3. api.coingecko.com      daily prices (close only, high/low approximated by close)
 *
 * `computeTrend()` is pure so it can be tested and reused by the backtest.
 */

export interface Candle {
  close: number
  high: number
  low: number
}

export interface Trend {
  ok: boolean
  source: string
  sma: number
  smaShort: number
  /** Latest exchange price (last candle close = live price). */
  lastClose: number
  belowSma: boolean
  /** Decisive for the policy: hysteresis over the last COMPLETED daily close, plus the panic band. */
  filterActive: boolean
  filterWhy: string
  prevClose: number
  prevSma: number
  distSmaPct: number
  change24hPct: number
  change7dPct: number
  change30dPct: number
  high30d: number
  low30d: number
  /** Last 60 closes, oldest first (sparkline). */
  closes: number[]
  /** SMA per day, same length as closes (NaN where not yet computable). */
  smaSeries: number[]
  fetchedAt: string
}

export interface TrendOptions {
  smaDays: number
  panicPct: number
}

async function fetchJson(url: string, timeoutMs = 8000, fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)): Promise<unknown> {
  const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** Load `need` daily candles (oldest first, last = running day). */
export async function fetchDailyCandles(need: number, fetchImpl?: typeof fetch): Promise<{ candles: Candle[]; source: string }> {
  const errors: string[] = []
  for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
    try {
      const k = (await fetchJson(`${host}/api/v3/klines?symbol=INJUSDT&interval=1d&limit=${need}`, 8000, fetchImpl)) as unknown[]
      if (!Array.isArray(k) || k.length < 10) throw new Error('too few candles')
      const candles = k.map((row) => {
        const r = row as string[]
        return { high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]) }
      })
      return { candles, source: host.replace('https://', '') }
    } catch (e) {
      errors.push(`${host}: ${String(e).slice(0, 60)}`)
    }
  }
  try {
    const j = (await fetchJson(`https://api.coingecko.com/api/v3/coins/injective-protocol/market_chart?vs_currency=usd&days=${need}&interval=daily`, 8000, fetchImpl)) as { prices?: [number, number][] }
    const prices = j?.prices ?? []
    // CoinGecko: one point per day at 00:00 UTC (= previous day's close) plus the current price as last point.
    const byDay = new Map<string, number>()
    for (const [ts, p] of prices) {
      const d = new Date(ts)
      const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() < 5
      const key = new Date(midnight ? ts - 86_400_000 : ts).toISOString().slice(0, 10)
      byDay.set(key, p)
    }
    const closes = [...byDay.values()].slice(-need)
    if (closes.length < 10) throw new Error('too few points')
    return { candles: closes.map((c) => ({ close: c, high: c, low: c })), source: 'coingecko' }
  } catch (e) {
    errors.push(`coingecko: ${String(e).slice(0, 60)}`)
  }
  throw new Error('Price history unavailable: ' + errors.join(' | '))
}

export function sma(values: number[], n: number, end: number): number {
  if (end + 1 < n || end >= values.length) return NaN
  let s = 0
  for (let i = end - n + 1; i <= end; i++) s += values[i]
  return s / n
}

/** Pure trend computation. `candles` oldest first, last candle = running day. */
export function computeTrend(candles: Candle[], source: string, opts: TrendOptions, fetchedAt = new Date().toISOString()): Trend {
  const n = opts.smaDays
  const closes = candles.map((c) => c.close)
  if (closes.length < n + 2 || closes.some((v) => !Number.isFinite(v) || v <= 0)) throw new Error(`Price history incomplete (need ${n + 2} candles, got ${closes.length})`)
  const last = closes.length - 1
  const smaNow = sma(closes, n, last)
  const smaShort = sma(closes, Math.min(20, n), last)
  const lastClose = closes[last]
  const pctChange = (a: number, b: number) => (b > 0 ? (a / b - 1) * 100 : 0)
  const tail = closes.slice(-60)
  const smaSeries = tail.map((_, i) => sma(closes, n, closes.length - tail.length + i))
  // Hysteresis: decide on the last COMPLETED day (once per day), so a price oscillating around the
  // line does not flip the filter several times a day. Exception: live price > panicPct below the SMA.
  const prevClose = closes[last - 1]
  const prevSma = sma(closes, n, last - 1)
  const dailyBelow = prevClose < prevSma
  const panic = lastClose < smaNow * (1 - opts.panicPct)
  if (![smaNow, prevSma, lastClose, prevClose].every((v) => Number.isFinite(v) && v > 0)) throw new Error('Price history incomplete (SMA is NaN)')
  const filterActive = dailyBelow || panic
  const filterWhy = panic
    ? `live price more than ${(opts.panicPct * 100).toFixed(0)} % below SMA${n}`
    : dailyBelow
      ? `daily close ${prevClose.toFixed(2)} below SMA${n} ${prevSma.toFixed(2)}`
      : `daily close ${prevClose.toFixed(2)} above SMA${n} ${prevSma.toFixed(2)}`
  const highs = candles.map((c) => c.high).slice(-30)
  const lows = candles.map((c) => c.low).slice(-30)
  return {
    ok: true,
    source,
    sma: smaNow,
    smaShort,
    lastClose,
    belowSma: lastClose < smaNow,
    filterActive,
    filterWhy,
    prevClose,
    prevSma,
    distSmaPct: pctChange(lastClose, smaNow),
    change24hPct: pctChange(lastClose, closes[last - 1]),
    change7dPct: last >= 7 ? pctChange(lastClose, closes[last - 7]) : 0,
    change30dPct: last >= 30 ? pctChange(lastClose, closes[last - 30]) : 0,
    high30d: Math.max(...highs),
    low30d: Math.min(...lows),
    closes: tail,
    smaSeries,
    fetchedAt,
  }
}

/** Fetch + compute. Never throws: returns null when no data is available (policy then never adds leverage). */
export async function getTrend(opts: TrendOptions, fetchImpl?: typeof fetch): Promise<Trend | null> {
  try {
    const { candles, source } = await fetchDailyCandles(opts.smaDays + 60, fetchImpl)
    return computeTrend(candles, source, opts)
  } catch {
    return null
  }
}
