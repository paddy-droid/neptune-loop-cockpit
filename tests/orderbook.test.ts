import { describe, expect, it } from 'vitest'
import { quoteFromLevels, roundPriceToTick, roundQtyToTick, worstBuy, worstSell } from '../src/execution/orderbook'

describe('order book maths', () => {
  const book = quoteFromLevels(
    [
      { p: 6.0, q: 100 },
      { p: 5.95, q: 200 },
      { p: 5.0, q: 1000 },
    ],
    [
      { p: 6.02, q: 100 },
      { p: 6.1, q: 200 },
      { p: 7.0, q: 1000 },
    ],
    'INJ/USDC',
  )
  it('best prices, spread, depth', () => {
    expect(book.bestBid).toBe(6)
    expect(book.bestAsk).toBe(6.02)
    expect(book.spreadPct).toBeCloseTo((0.02 / 6.01) * 100, 6)
    expect(book.depthBidUsd).toBeCloseTo(600 + 1190 + 5000, 6)
    // near depth: within 2 % of the best -> 5.0 level excluded, 7.0 excluded
    expect(book.depthBidNearUsd).toBeCloseTo(600 + 1190, 6)
    expect(book.depthAskNearUsd).toBeCloseTo(602 + 1220, 6)
  })
  it('vwap walks the levels and returns null when too thin', () => {
    expect(book.vwapSell(100)).toBeCloseTo(6, 9)
    expect(book.vwapSell(300)).toBeCloseTo((600 + 1190) / 300, 9)
    expect(book.vwapSell(5000)).toBeNull()
    expect(book.vwapBuy(150)).toBeCloseTo((602 + 305) / 150, 9)
  })
  it('worst prices respect both the VWAP slippage and the 3x best-price bound', () => {
    expect(worstSell(book, 100, 0.01)).toBeCloseTo(6 * 0.99, 9)
    // deep sale: vwap ~5.5 -> vwap*(1-slip) would be 5.45 but bound is best*(1-3%) = 5.82
    expect(worstSell(book, 1000, 0.01)).toBeCloseTo(6 * 0.97, 9)
    expect(worstBuy(book, 100, 0.01)).toBeCloseTo(6.02 * 1.01, 9)
  })
  it('tick rounding via decimal strings', () => {
    expect(roundQtyToTick(9892 * 0.0001, 0.0001)).toBe(0.9892) // float product 0.9892000000000001 must not break the tick
    expect(roundQtyToTick(1.23456, 0.001)).toBe(1.234)
    expect(roundPriceToTick(0.98925, 0.0001, 'sell')).toBe(0.9892)
    expect(roundPriceToTick(0.98925, 0.0001, 'buy')).toBe(0.9893)
    expect(roundPriceToTick(5.4321, 0.001, 'sell')).toBe(5.432)
  })
  it('rejects empty or invalid books', () => {
    expect(() => quoteFromLevels([], [{ p: 1, q: 1 }], 'x')).toThrow(/empty/)
    expect(() => quoteFromLevels([{ p: -1, q: 1 }], [{ p: 1, q: 1 }], 'x')).toThrow(/invalid/)
  })
})
