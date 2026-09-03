/**
 * Order-book maths (pure). The fetch lives in chainPorts.ts; this file turns raw levels into a
 * BookQuote and computes worst-case prices for market orders.
 */
import type { BookQuote } from './types'

export interface Level {
  /** Human price (quote per base). */
  p: number
  /** Human base quantity. */
  q: number
}

/** Build a quote from bid/ask levels sorted best-first. Throws on empty or invalid levels. */
export function quoteFromLevels(buys: Level[], sells: Level[], market: string): BookQuote {
  for (const l of [...buys, ...sells]) {
    if (!Number.isFinite(l.p) || l.p <= 0 || !Number.isFinite(l.q) || l.q < 0) throw new Error(`Order book level invalid (${market})`)
  }
  if (!buys.length || !sells.length) throw new Error(`Order book ${market} is empty`)
  const vwap = (side: Level[]) => (baseQty: number) => {
    let rest = baseQty
    let cost = 0
    for (const { p, q } of side) {
      const take = Math.min(rest, q)
      cost += take * p
      rest -= take
      if (rest <= 1e-12) return cost / baseQty
    }
    return null
  }
  const depth = (side: Level[]) => side.reduce((s, { p, q }) => s + p * q, 0)
  const near = (side: Level[], ref: number, lower: boolean) =>
    side.filter(({ p }) => (lower ? p >= ref * 0.98 : p <= ref * 1.02)).reduce((s, { p, q }) => s + p * q, 0)
  return {
    bestBid: buys[0].p,
    bestAsk: sells[0].p,
    spreadPct: ((sells[0].p - buys[0].p) / ((sells[0].p + buys[0].p) / 2)) * 100,
    vwapBuy: vwap(sells),
    vwapSell: vwap(buys),
    depthBidUsd: depth(buys),
    depthAskUsd: depth(sells),
    depthBidNearUsd: near(buys, buys[0].p, true),
    depthAskNearUsd: near(sells, sells[0].p, false),
  }
}

/**
 * Worst price with double protection: relative to the VWAP of the quantity (slippage) AND never
 * further than 3× slippage from the best price (a thin or spoofed book must not legitimise deep fills).
 */
export function worstSell(book: BookQuote, qty: number, slip: number): number {
  const v = book.vwapSell(qty) ?? book.bestBid
  return Math.max(v * (1 - slip), book.bestBid * (1 - 3 * slip))
}
export function worstBuy(book: BookQuote, qty: number, slip: number): number {
  const v = book.vwapBuy(qty) ?? book.bestAsk
  return Math.min(v * (1 + slip), book.bestAsk * (1 + 3 * slip))
}

/** Round a quantity DOWN to the market's quantity tick, via decimal strings (float products break chain validation). */
export function roundQtyToTick(baseQty: number, minQty: number): number {
  const dec = Math.round(-Math.log10(minQty))
  return parseFloat((Math.floor(baseQty / minQty + 1e-9) * minQty).toFixed(dec))
}

/** Round a price to the tick: buys round UP (more permissive limit), sells round DOWN. */
export function roundPriceToTick(price: number, priceTick: number, side: 'buy' | 'sell'): number {
  const dec = Math.round(-Math.log10(priceTick))
  const scaled = price * 10 ** dec
  const raw = side === 'buy' ? Math.ceil(scaled - 1e-9) : Math.floor(scaled + 1e-9)
  return parseFloat((raw / 10 ** dec).toFixed(dec))
}
