/**
 * Read-only Neptune Finance account status via the Injective LCD.
 *
 * Nothing in this module needs a key. It performs seven CosmWasm smart queries
 * plus one bank-balance query and folds them into a single `Status` object.
 *
 * The fetch part (`fetchRawStatus`) and the pure parse part (`buildStatus`) are
 * separated so the parser can be unit-tested with recorded fixtures.
 *
 * Query reference: docs/NEPTUNE-CONTRACTS.md
 */
import { ASSETS, NEPTUNE_CONTRACTS, SYMBOL_BY_DENOM } from '../config/chain'
import type { LcdClient } from './lcd'

// ---------- contract response shapes (only the fields we use) ----------

export type AssetInfo = { native_token?: { denom: string }; token?: { contract_addr: string } }
export type OraclePrice = { price: string; time_last_updated?: string }
export type PoolAccount = { principal: string; shares: string }
export type UserAccount = {
  debt_pool_accounts: [AssetInfo, PoolAccount][]
  collateral_pool_accounts: [AssetInfo, PoolAccount][]
}
export type MarketInfo = {
  debt_pool: { balance: string; shares: string }
  lending_principal?: string
}
export type CollateralInfo = {
  collateral_pool?: { balance: string; shares: string }
  collateral_details?: { liquidation_ltv?: string; allowable_ltv?: string }
}

export interface RawStatus {
  /** `get_account_health` (querier) – decimal string, 1.0 = liquidation threshold. */
  health: string
  /** `get_prices` (oracle). */
  prices: [AssetInfo, OraclePrice][]
  /** `get_user_accounts` (market). Neptune supports sub-accounts; index 0 is the default. */
  accounts: [number, UserAccount][]
  /** `get_all_markets` (market). */
  markets: [AssetInfo, MarketInfo][]
  /** `get_all_collaterals` (market). */
  collaterals: [AssetInfo, CollateralInfo][]
  /** `get_all_lending_rates` (interest model) – APR as decimal string. */
  lendRates: [AssetInfo, string][]
  /** `get_all_borrow_rates` (interest model) – APR as decimal string. */
  borrowRates: [AssetInfo, string][]
  /** `/cosmos/bank/v1beta1/balances/{addr}`. */
  bank: { balances?: { denom: string; amount: string }[] }
}

// ---------- normalised status ----------

export interface Position {
  symbol: string
  denom: string
  /** Human units (e.g. 12.5 INJ). */
  amount: number
  usd: number
}

export interface Status {
  time: string
  address: string
  accountIndex: number
  /** Neptune account health. < 1.0 = liquidatable. 0 when there is no debt. */
  health: number
  /** INJ oracle price in USD (0 when unavailable). */
  injPrice: number
  /** INJ price at which health reaches 1.0 (only meaningful for INJ-only collateral + stable debt). */
  liqPrice: number
  collateral: Position[]
  debts: Position[]
  collateralUsd: number
  debtUsd: number
  equityUsd: number
  /** debt / collateral (0..1). */
  ltv: number
  rates: { symbol: string; lend: number; borrow: number }[]
  /** Wallet (bank module) balances of the known assets. */
  bank: Position[]
  /** Seconds since the INJ oracle price was last updated (-1 = unknown). */
  oracleAgeSec: number
  /** Liquidation LTV of INJ collateral from the contract (0.80 at the time of writing). */
  injLiqLtv: number
  /** Max LTV the contract allows after a withdraw/borrow (0.78 at the time of writing). */
  injAllowableLtv: number
  /** USDC pool: borrowed / lent (0 = unknown). Borrowing halts near 0.95. */
  usdcUtilization: number
  /** USDC still available to borrow from the pool (USD). 0 = unknown. */
  usdcPoolFreeUsd: number
  /** Total USDC lent to the pool (USD). 0 = unknown. */
  usdcPoolLentUsd: number
  /**
   * Raw share bookkeeping per collateral denom (exact decimal strings from the contract).
   * Needed to build a withdraw message, which takes SHARES, not amounts. Never convert these
   * through Number(): values above 1e21 turn into exponent notation and break the math.
   */
  collateralShares: Record<string, { shares: string; poolBalance: string; poolShares: string }>
}

const denomOf = (a: AssetInfo): string => a.native_token?.denom ?? a.token?.contract_addr ?? '?'

/** The querier answers HTTP 500 "Account not found" for addresses that never used Neptune - that is an empty position, not an error. */
const isAccountNotFound = (e: unknown) => /account not found/i.test(String((e as Error)?.message ?? e))

/** All raw queries in parallel. */
export async function fetchRawStatus(lcd: LcdClient, address: string, accountIndex = 0): Promise<RawStatus> {
  const assets = Object.values(ASSETS).map((a) => ({ native_token: { denom: a.denom } }))
  const [health, prices, accounts, markets, collaterals, lendRates, borrowRates, bank] = await Promise.all([
    lcd.smartQuery<string>(NEPTUNE_CONTRACTS.querier, { get_account_health: { addr: address, account_index: accountIndex } }).catch((e) => {
      if (isAccountNotFound(e)) return '0'
      throw e
    }),
    lcd.smartQuery<[AssetInfo, OraclePrice][]>(NEPTUNE_CONTRACTS.oracle, { get_prices: { assets } }),
    lcd.smartQuery<[number, UserAccount][]>(NEPTUNE_CONTRACTS.market, { get_user_accounts: { addr: address } }),
    lcd.smartQuery<[AssetInfo, MarketInfo][]>(NEPTUNE_CONTRACTS.market, { get_all_markets: {} }),
    lcd.smartQuery<[AssetInfo, CollateralInfo][]>(NEPTUNE_CONTRACTS.market, { get_all_collaterals: {} }),
    lcd.smartQuery<[AssetInfo, string][]>(NEPTUNE_CONTRACTS.interest, { get_all_lending_rates: {} }),
    lcd.smartQuery<[AssetInfo, string][]>(NEPTUNE_CONTRACTS.interest, { get_all_borrow_rates: {} }),
    lcd.json<RawStatus['bank']>(`/cosmos/bank/v1beta1/balances/${address}?pagination.limit=1000`, 10_000),
  ])
  return { health, prices, accounts, markets, collaterals, lendRates, borrowRates, bank }
}

/** Pure: fold raw contract responses into a Status. `nowMs` is injectable for tests. */
export function buildStatus(raw: RawStatus, address: string, accountIndex = 0, nowMs = Date.now()): Status {
  const priceByDenom: Record<string, number> = {}
  let injOracleTsNs = 0
  for (const [asset, p] of raw.prices) {
    const d = denomOf(asset)
    priceByDenom[d] = parseFloat(p.price)
    if (d === 'inj' && p.time_last_updated) injOracleTsNs = Number(p.time_last_updated)
  }
  const oracleAgeSec = injOracleTsNs > 0 ? Math.max(0, nowMs / 1000 - injOracleTsNs / 1e9) : -1

  const debtPools: Record<string, { balance: number; shares: number }> = {}
  let usdcUtilization = 0
  let usdcPoolFreeUsd = 0
  let usdcPoolLentUsd = 0
  for (const [asset, m] of raw.markets) {
    const d = denomOf(asset)
    debtPools[d] = { balance: parseFloat(m.debt_pool.balance), shares: parseFloat(m.debt_pool.shares) }
    if (d === ASSETS.USDC.denom && m.lending_principal) {
      const lent = parseFloat(m.lending_principal)
      const borrowed = parseFloat(m.debt_pool.balance)
      if (lent > 0 && Number.isFinite(borrowed)) {
        usdcUtilization = borrowed / lent
        usdcPoolLentUsd = lent / 10 ** ASSETS.USDC.decimals
        usdcPoolFreeUsd = Math.max(0, (lent - borrowed) / 10 ** ASSETS.USDC.decimals)
      }
    }
  }

  const collPools: Record<string, { balance: number; shares: number; rawBalance: string; rawShares: string }> = {}
  let injLiqLtv = 0.8
  let injAllowableLtv = 0.78
  for (const [asset, c] of raw.collaterals) {
    const d = denomOf(asset)
    if (d === 'inj') {
      const liq = parseFloat(c.collateral_details?.liquidation_ltv ?? '')
      if (Number.isFinite(liq) && liq > 0) injLiqLtv = liq
      const allow = parseFloat(c.collateral_details?.allowable_ltv ?? '')
      if (Number.isFinite(allow) && allow > 0) injAllowableLtv = allow
    }
    if (c.collateral_pool) collPools[d] = { balance: parseFloat(c.collateral_pool.balance), shares: parseFloat(c.collateral_pool.shares), rawBalance: String(c.collateral_pool.balance), rawShares: String(c.collateral_pool.shares) }
  }

  const acct = raw.accounts.find(([idx]) => idx === accountIndex)?.[1]
  const collateral: Position[] = []
  const debts: Position[] = []
  const collateralShares: Status['collateralShares'] = {}
  if (acct) {
    for (const [asset, entry] of acct.collateral_pool_accounts) {
      const denom = denomOf(asset)
      const symbol = SYMBOL_BY_DENOM[denom] ?? denom.slice(0, 12)
      const decimals = ASSETS[symbol]?.decimals ?? 6
      const pool = collPools[denom]
      const shares = parseFloat(entry.shares)
      const rawAmount = pool && pool.shares > 0 ? (shares * pool.balance) / pool.shares : parseFloat(entry.principal)
      const amount = rawAmount / 10 ** decimals
      if (amount > 1e-9) collateral.push({ symbol, denom, amount, usd: amount * (priceByDenom[denom] ?? 0) })
      collateralShares[denom] = { shares: entry.shares, poolBalance: pool ? pool.rawBalance : entry.principal, poolShares: pool ? pool.rawShares : entry.shares }
    }
    for (const [asset, entry] of acct.debt_pool_accounts) {
      const denom = denomOf(asset)
      const symbol = SYMBOL_BY_DENOM[denom] ?? denom.slice(0, 12)
      const decimals = ASSETS[symbol]?.decimals ?? 6
      const pool = debtPools[denom]
      const shares = parseFloat(entry.shares)
      const rawAmount = pool && pool.shares > 0 ? (shares * pool.balance) / pool.shares : parseFloat(entry.principal)
      const amount = rawAmount / 10 ** decimals
      const usd = amount * (priceByDenom[denom] ?? 1)
      if (usd > 0.01) debts.push({ symbol, denom, amount, usd })
    }
  }

  const collateralUsd = collateral.reduce((s, p) => s + p.usd, 0)
  const debtUsd = debts.reduce((s, p) => s + p.usd, 0)
  const injPriceRaw = priceByDenom['inj']
  const injPrice = Number.isFinite(injPriceRaw) && injPriceRaw > 0 ? injPriceRaw : 0
  const health = parseFloat(raw.health)
  // INJ-only collateral + stable debt: health scales linearly with the INJ price.
  const liqPrice = debtUsd > 0 && health > 0 ? injPrice / health : 0

  const borrowByDenom: Record<string, number> = {}
  for (const [asset, r] of raw.borrowRates) borrowByDenom[denomOf(asset)] = parseFloat(r)
  const rates: Status['rates'] = []
  for (const [asset, r] of raw.lendRates) {
    const denom = denomOf(asset)
    const symbol = SYMBOL_BY_DENOM[denom]
    if (symbol) rates.push({ symbol, lend: parseFloat(r), borrow: borrowByDenom[denom] ?? 0 })
  }

  const bank: Position[] = []
  for (const b of raw.bank.balances ?? []) {
    const symbol = SYMBOL_BY_DENOM[b.denom]
    if (!symbol) continue
    const amount = parseFloat(b.amount) / 10 ** ASSETS[symbol].decimals
    bank.push({ symbol, denom: b.denom, amount, usd: amount * (priceByDenom[b.denom] ?? 1) })
  }

  return {
    time: new Date(nowMs).toISOString(),
    address,
    accountIndex,
    health,
    injPrice,
    liqPrice,
    collateral,
    debts,
    collateralUsd,
    debtUsd,
    equityUsd: collateralUsd - debtUsd,
    ltv: collateralUsd > 0 ? debtUsd / collateralUsd : 0,
    rates,
    bank,
    oracleAgeSec,
    injLiqLtv,
    injAllowableLtv,
    usdcUtilization,
    usdcPoolFreeUsd,
    usdcPoolLentUsd,
    collateralShares,
  }
}

/** Convenience: fetch + build. */
export async function getStatus(lcd: LcdClient, address: string, accountIndex = 0): Promise<Status> {
  const raw = await fetchRawStatus(lcd, address, accountIndex)
  return buildStatus(raw, address, accountIndex)
}
