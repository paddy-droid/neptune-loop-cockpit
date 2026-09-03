/**
 * Chain-level constants for Injective mainnet and the Neptune Finance protocol.
 *
 * Everything here is public information. Contract addresses are taken from the
 * official Neptune docs (https://docs.nept.finance/develop/contracts) and can be
 * cross-checked on https://injscan.com. If Neptune migrates a contract, update the
 * address here and in docs/NEPTUNE-CONTRACTS.md.
 */

export const CHAIN_ID = 'injective-1'

/** Public Injective LCD (REST) endpoints. The first that answers wins; failed hosts are skipped for a while. */
export const DEFAULT_LCD_HOSTS: readonly string[] = [
  'https://sentry.lcd.injective.network',
  'https://injective-rest.publicnode.com',
  'https://lcd.injective.network',
]

/** Neptune Finance core contracts on Injective mainnet. */
export const NEPTUNE_CONTRACTS = {
  /** Lending, borrowing, collateral, liquidations. */
  market: 'inj1nc7gjkf2mhp34a6gquhurg8qahnw5kxs5u3s4u',
  /** Aggregated read helper (account health etc.). */
  querier: 'inj1kfjff5f0xjy7gece36watkqtscpycv666tqq7t',
  /** Price oracle (Pyth / Ojo / on-chain feeds). */
  oracle: 'inj1u6cclz0qh5tep9m2qayry9k97dm46pnlqf8nre',
  /** PID interest-rate model. */
  interest: 'inj1ftech0pdjrjawltgejlmpx57cyhsz6frdx2dhq',
} as const

export interface AssetDef {
  denom: string
  decimals: number
  /** True for stablecoins (used to decide whether a debt is "USD-like"). */
  stable: boolean
}

/** Assets the cockpit understands. Unknown denoms are still shown, but without a symbol. */
export const ASSETS: Record<string, AssetDef> = {
  INJ: { denom: 'inj', decimals: 18, stable: false },
  USDC: { denom: 'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a', decimals: 6, stable: true },
  USDT: { denom: 'peggy0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, stable: true },
  AUSD: { denom: 'factory/inj1n636d9gzrqggdk66n2f97th0x8yuhfrtx520e7/ausd', decimals: 6, stable: true },
}

export const SYMBOL_BY_DENOM: Record<string, string> = Object.fromEntries(
  Object.entries(ASSETS).map(([symbol, a]) => [a.denom, symbol]),
)

/** External apps the action plan links to. The cockpit never calls these, it only shows links. */
export const LINKS = {
  neptuneApp: 'https://app.nept.finance',
  neptuneDocs: 'https://docs.nept.finance',
  helixSpotInjUsdc: 'https://helix.app/spot/inj-usdc',
  explorerAddress: (addr: string) => `https://injscan.com/account/${addr}`,
  explorerContract: (addr: string) => `https://injscan.com/contract/${addr}`,
  explorerTx: (hash: string) => `https://injscan.com/transaction/${hash}`,
  keplr: 'https://www.keplr.app',
  leap: 'https://www.leapwallet.io',
} as const

/** Bech32 Injective account address (20-byte payload => 38 data chars). */
export const INJ_ADDRESS_RE = /^inj1[02-9ac-hj-np-z]{38}$/

export function isInjAddress(s: string): boolean {
  return INJ_ADDRESS_RE.test(s.trim())
}
