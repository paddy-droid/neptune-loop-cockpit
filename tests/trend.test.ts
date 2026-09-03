import { describe, expect, it } from 'vitest'
import { computeTrend, sma, type Candle } from '../src/market/trend'

const opts = { smaDays: 50, panicPct: 0.05 }
const mk = (closes: number[]): Candle[] => closes.map((c) => ({ close: c, high: c * 1.02, low: c * 0.98 }))

describe('trend', () => {
  it('sma basics', () => {
    expect(sma([1, 2, 3, 4], 2, 3)).toBe(3.5)
    expect(Number.isNaN(sma([1, 2, 3], 5, 2))).toBe(true)
  })

  it('needs enough candles', () => {
    expect(() => computeTrend(mk(Array(30).fill(5)), 'x', opts)).toThrow(/incomplete/)
  })

  it('uptrend: filter inactive, live above SMA', () => {
    const closes = Array.from({ length: 120 }, (_, i) => 3 + i * 0.03)
    const t = computeTrend(mk(closes), 'x', opts)
    expect(t.filterActive).toBe(false)
    expect(t.belowSma).toBe(false)
    expect(t.closes.length).toBe(60)
    expect(t.smaSeries.length).toBe(60)
    expect(t.filterWhy).toMatch(/above/)
  })

  it('hysteresis: last completed close below SMA activates the filter even if live is above', () => {
    const closes = Array.from({ length: 120 }, () => 5)
    closes[118] = 4.0 // yesterday closed far below
    closes[119] = 5.2 // live back above
    const t = computeTrend(mk(closes), 'x', opts)
    expect(t.filterActive).toBe(true)
    expect(t.filterWhy).toMatch(/daily close/)
  })

  it('panic band: live price 6 % below SMA activates immediately', () => {
    const closes = Array.from({ length: 120 }, () => 5)
    closes[119] = 5 * 0.93
    const t = computeTrend(mk(closes), 'x', opts)
    expect(t.filterActive).toBe(true)
    expect(t.filterWhy).toMatch(/live price/)
  })

  it('live slightly below SMA but yesterday above: filter inactive, belowSma true (hysteresis window)', () => {
    const closes = Array.from({ length: 120 }, () => 5)
    closes[119] = 4.9
    const t = computeTrend(mk(closes), 'x', opts)
    expect(t.filterActive).toBe(false)
    expect(t.belowSma).toBe(true)
  })
})
