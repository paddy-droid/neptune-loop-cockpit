/**
 * Synthetic demo data so the UI can be explored without a wallet or a position.
 * Numbers are invented; they are shaped like a typical small loop.
 */
import type { Status } from '../chain/neptune'
import type { Trend } from '../market/trend'
import { computeTrend } from '../market/trend'
import { ASSETS } from '../config/chain'

export const DEMO_ADDRESS = 'inj1demo000000000000000000000000000000000'

export function demoStatus(nowMs = Date.now()): Status {
  const injPrice = 7.4
  const inj = 750
  const debt = 2300
  const collateralUsd = inj * injPrice
  const ltv = debt / collateralUsd
  const health = 0.8 / ltv
  return {
    time: new Date(nowMs).toISOString(),
    address: DEMO_ADDRESS,
    accountIndex: 0,
    health,
    injPrice,
    liqPrice: injPrice / health,
    collateral: [{ symbol: 'INJ', denom: ASSETS.INJ.denom, amount: inj, usd: collateralUsd }],
    debts: [{ symbol: 'USDC', denom: ASSETS.USDC.denom, amount: debt, usd: debt }],
    collateralUsd,
    debtUsd: debt,
    equityUsd: collateralUsd - debt,
    ltv,
    rates: [
      { symbol: 'INJ', lend: 0.021, borrow: 0.064 },
      { symbol: 'USDC', lend: 0.094, borrow: 0.168 },
      { symbol: 'USDT', lend: 0.071, borrow: 0.142 },
    ],
    bank: [
      { symbol: 'INJ', denom: ASSETS.INJ.denom, amount: 2.2, usd: 2.2 * injPrice },
      { symbol: 'USDC', denom: ASSETS.USDC.denom, amount: 180, usd: 180 },
    ],
    oracleAgeSec: 42,
    injLiqLtv: 0.8,
    injAllowableLtv: 0.78,
    usdcUtilization: 0.79,
    usdcPoolFreeUsd: 11_300,
    usdcPoolLentUsd: 58_500,
  }
}

export function demoTrend(smaDays = 50, panicPct = 0.05): Trend {
  // A gentle uptrend with some noise, deterministic.
  const closes: number[] = []
  let p = 4.2
  for (let i = 0; i < smaDays + 60; i++) {
    const wave = Math.sin(i / 9) * 0.12 + Math.cos(i / 23) * 0.2
    p = Math.max(1, p * (1 + 0.004 + wave * 0.02))
    closes.push(p)
  }
  const scale = 7.4 / closes[closes.length - 1]
  const candles = closes.map((c) => ({ close: c * scale, high: c * scale * 1.03, low: c * scale * 0.97 }))
  return computeTrend(candles, 'demo', { smaDays, panicPct })
}
