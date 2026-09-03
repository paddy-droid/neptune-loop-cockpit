import type { Status } from '../src/chain/neptune'
import type { Trend } from '../src/market/trend'
import { ASSETS } from '../src/config/chain'

/** Syntactically valid, deliberately meaningless address (inj1 + 38 bech32 chars). */
export const ADDR = 'inj1' + 'qqqqqqqqqq'.repeat(3) + 'qqqqqqqq'

/** Status with INJ-only collateral and USDC debt at a given LTV. */
export function statusAt(ltv: number, opts: Partial<Status> & { inj?: number; price?: number } = {}): Status {
  const price = opts.price ?? 5.58
  const inj = opts.inj ?? 2196
  const collateralUsd = inj * price
  const debtUsd = ltv * collateralUsd
  const liq = opts.injLiqLtv ?? 0.8
  const health = ltv > 0 ? liq / ltv : 0
  const base: Status = {
    time: new Date().toISOString(),
    address: ADDR,
    accountIndex: 0,
    health,
    injPrice: price,
    liqPrice: ltv > 0 ? price / health : 0,
    collateral: [{ symbol: 'INJ', denom: ASSETS.INJ.denom, amount: inj, usd: collateralUsd }],
    debts: debtUsd > 0 ? [{ symbol: 'USDC', denom: ASSETS.USDC.denom, amount: debtUsd, usd: debtUsd }] : [],
    collateralUsd,
    debtUsd,
    equityUsd: collateralUsd - debtUsd,
    ltv,
    rates: [{ symbol: 'USDC', lend: 0.08, borrow: 0.12 }],
    bank: [{ symbol: 'INJ', denom: ASSETS.INJ.denom, amount: 1, usd: price }],
    oracleAgeSec: 5,
    injLiqLtv: 0.8,
    injAllowableLtv: 0.78,
    usdcUtilization: 0.7,
    usdcPoolFreeUsd: 20_000,
    usdcPoolLentUsd: 60_000,
  }
  const { inj: _i, price: _p, ...rest } = opts
  return { ...base, ...rest }
}

export function trendOk(over: Partial<Trend> = {}): Trend {
  return {
    ok: true,
    source: 'test',
    sma: 4.8,
    smaShort: 5.2,
    lastClose: 5.55,
    belowSma: false,
    filterActive: false,
    filterWhy: 'daily close 5.69 above SMA50 4.82',
    prevClose: 5.69,
    prevSma: 4.82,
    distSmaPct: 15,
    change24hPct: 1,
    change7dPct: 3,
    change30dPct: 10,
    high30d: 6,
    low30d: 4.5,
    closes: [],
    smaSeries: [],
    fetchedAt: new Date().toISOString(),
    ...over,
  }
}

export function trendStale(over: Partial<Trend> = {}): Trend {
  return trendOk({ fetchedAt: new Date(Date.now() - 20 * 60_000).toISOString(), ...over })
}
