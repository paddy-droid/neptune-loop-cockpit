/**
 * Protocol fingerprint: code ids of the four Neptune contracts + market params + INJ collateral
 * details + USDC market details. If it changes, governance migrated or reparametrised something;
 * the autopilot then blocks adding leverage for 24 h and alerts. null = incomplete (no comparison).
 */
import type { LcdClient } from '../chain/lcd'
import { ASSETS, NEPTUNE_CONTRACTS } from '../config/chain'

const denomOf = (a: any): string => a?.native_token?.denom ?? a?.token?.contract_addr ?? '?'

export async function protocolFingerprint(lcd: LcdClient): Promise<string | null> {
  try {
    const [codes, params, colls, mkts] = await Promise.all([
      Promise.all(Object.values(NEPTUNE_CONTRACTS).map((a) => lcd.json<any>(`/cosmwasm/wasm/v1/contract/${a}`, 8000).then((j) => String(j?.contract_info?.code_id ?? '')))),
      lcd.smartQuery<any>(NEPTUNE_CONTRACTS.market, { get_params: {} }),
      lcd.smartQuery<any>(NEPTUNE_CONTRACTS.market, { get_all_collaterals: {} }),
      lcd.smartQuery<any>(NEPTUNE_CONTRACTS.market, { get_all_markets: {} }),
    ])
    if (codes.some((c) => !c)) return null
    const inj = (colls as any[]).find(([a]) => denomOf(a) === 'inj')?.[1]
    const usdc = (mkts as any[]).find(([a]) => denomOf(a) === ASSETS.USDC.denom)?.[1]
    if (!inj || !usdc) return null
    const norm = (v: any): any => (Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v)
    return 'fp1|' + JSON.stringify(norm({ codes, params, inj: inj.collateral_details ?? null, usdc: usdc.market_asset_details ?? null }))
  } catch {
    return null
  }
}
