/**
 * Helix spot markets the executor trades, and the indexer hosts it reads order books from.
 * Market ids are public and can be cross-checked at https://helix.app or via the LCD:
 *   GET {lcd}/injective/exchange/v1beta1/spot/markets/{marketId}
 */
import type { SpotMarketKey } from './types'
import { ASSETS } from '../config/chain'

export interface SpotMarketDef {
  marketId: string
  baseDenom: string
  quoteDenom: string
  baseDecimals: number
  quoteDecimals: number
  /** Minimum quantity tick in human units. */
  minQty: number
  /** Minimum price tick in human units. */
  priceTick: number
}

export const SPOT_MARKETS: Record<SpotMarketKey, SpotMarketDef> = {
  'INJ/USDC': {
    marketId: '0xa8c14f892f7f7d2516442220a05b652d5afee3f57a5495981dfad7c99ef78e84',
    baseDenom: 'inj',
    quoteDenom: ASSETS.USDC.denom,
    baseDecimals: 18,
    quoteDecimals: 6,
    minQty: 0.001,
    priceTick: 0.001,
  },
  'USDC/USDT': {
    marketId: '0x5efdcc4b3a949b3fc78c8c2055d1e46f8a6fe8130627012554047fb3a511345b',
    baseDenom: ASSETS.USDC.denom,
    quoteDenom: ASSETS.USDT.denom,
    baseDecimals: 6,
    quoteDecimals: 6,
    minQty: 0.01,
    priceTick: 0.0001,
  },
}

/** gRPC-web indexer hosts with failover (order books, trades). */
export const INDEXER_HOSTS: readonly string[] = [
  'https://sentry.exchange.grpc-web.injective.network',
  'https://k8s.global.mainnet.exchange.grpc-web.injective.network',
  'https://k8s.mainnet.staging.exchange.grpc-web.injective.network',
]

/** Sentry gRPC endpoint used for broadcasting (the SDK's mainnet default). */
export const DEFAULT_GRPC = 'https://sentry.chain.grpc-web.injective.network'

export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<T>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what}: timeout after ${ms} ms`)), ms)
  })
  return Promise.race([p.finally(() => t && clearTimeout(t)), timer])
}
