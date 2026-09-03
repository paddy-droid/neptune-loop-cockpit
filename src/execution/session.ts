/**
 * Session grants: what the owner authorises a session key to do, and nothing more.
 *
 * One transaction signed by the owner's wallet contains:
 *   1. authz  ContractExecutionAuthorization  -> only the Neptune market contract, only the four
 *                                               message keys the loop needs, at most `maxCalls` calls
 *   2. authz  CreateSpotMarketOrderAuthz      -> only market orders, only on the two Helix markets,
 *                                               only for the owner's default subaccount
 *   3. feegrant BasicAllowance                -> the session key may spend up to `gasAllowanceInj` of
 *                                               the owner's INJ on gas
 * All three expire at the same time. Revoking is one transaction with three messages.
 *
 * The session key itself never holds funds: every Neptune call and every order is executed
 * *as the owner* through MsgExec, and funds move only between the owner's wallet, the owner's
 * Neptune account and the owner's Helix subaccount.
 */
import { ContractExecutionAuthz, MsgGrant, MsgGrantAllowance, MsgGrantWithAuthorization, MsgRevoke, MsgRevokeAllowance, getDefaultSubaccountId, type Msgs } from '@injectivelabs/sdk-ts'
import { CreateSpotMarketOrderAuthz } from '@injectivelabs/core-proto-ts-v2/generated/injective/exchange/v1beta1/authz_pb'
import type { LcdClient } from '../chain/lcd'
import { NEPTUNE_CONTRACTS } from '../config/chain'
import { SPOT_MARKETS } from './markets'

export const WASM_EXEC_TYPE = '/cosmwasm.wasm.v1.MsgExecuteContract'
export const SPOT_MARKET_ORDER_TYPE = '/injective.exchange.v1beta1.MsgCreateSpotMarketOrder'
export const SPOT_MARKET_ORDER_AUTHZ_TYPE = '/injective.exchange.v1beta1.CreateSpotMarketOrderAuthz'
export const NEPTUNE_MESSAGE_KEYS = ['withdraw_collateral', 'return', 'borrow', 'deposit_collateral'] as const

export interface GrantOptions {
  owner: string
  grantee: string
  /** Seconds until all three grants expire (e.g. 7 days = 604800). */
  expirySeconds: number
  /** Max Neptune contract calls the session may make (a call ≈ one step; a busy week is a few hundred). */
  maxCalls?: number
  /** INJ the session may spend on gas via feegrant (0.5 INJ covers thousands of transactions). */
  gasAllowanceInj?: number
}

export function buildGrantMsgs(o: GrantOptions): Msgs[] {
  const expiration = Math.floor(Date.now() / 1000) + o.expirySeconds
  const wasm = MsgGrantWithAuthorization.fromJSON({
    granter: o.owner,
    grantee: o.grantee,
    expiryInSeconds: o.expirySeconds,
    authorization: ContractExecutionAuthz.fromJSON({
      contract: NEPTUNE_CONTRACTS.market,
      limit: { maxCalls: o.maxCalls ?? 1000 },
      filter: { acceptedMessagesKeys: [...NEPTUNE_MESSAGE_KEYS] },
    }),
  })
  const spotAuthz = CreateSpotMarketOrderAuthz.toBinary({
    subaccountId: getDefaultSubaccountId(o.owner),
    marketIds: [SPOT_MARKETS['INJ/USDC'].marketId, SPOT_MARKETS['USDC/USDT'].marketId],
  })
  const spot = MsgGrant.fromJSON({
    granter: o.owner,
    grantee: o.grantee,
    expiryInSeconds: o.expirySeconds,
    authorization: { typeUrl: SPOT_MARKET_ORDER_AUTHZ_TYPE, value: spotAuthz },
  })
  const gasInj = o.gasAllowanceInj ?? 0.5
  const fee = MsgGrantAllowance.fromJSON({
    granter: o.owner,
    grantee: o.grantee,
    allowance: { spendLimit: [{ denom: 'inj', amount: (BigInt(Math.round(gasInj * 1e6)) * 10n ** 12n).toString() }], expiration },
  })
  return [wasm, spot, fee]
}

export function buildRevokeMsgs(owner: string, grantee: string): Msgs[] {
  return [
    MsgRevoke.fromJSON({ granter: owner, grantee, messageType: WASM_EXEC_TYPE }),
    MsgRevoke.fromJSON({ granter: owner, grantee, messageType: SPOT_MARKET_ORDER_TYPE }),
    MsgRevokeAllowance.fromJSON({ granter: owner, grantee }),
  ]
}

export interface GrantStatus {
  wasm: { ok: boolean; expiration: string | null; detail: string }
  spot: { ok: boolean; expiration: string | null; detail: string }
  feegrant: { ok: boolean; expiration: string | null; remainingInj: number | null }
  /** All three present and not expired. */
  complete: boolean
  /** Earliest expiration of the three (ISO) or null. */
  expiresAt: string | null
}

/** Read the live grants from the chain (LCD). Works for any granter/grantee pair, read-only. */
export async function fetchGrantStatus(lcd: LcdClient, owner: string, grantee: string): Promise<GrantStatus> {
  const now = Date.now()
  const notExpired = (exp: string | null | undefined) => !exp || Date.parse(exp) > now
  let grants: any[] = []
  try {
    const j = await lcd.json<any>(`/cosmos/authz/v1beta1/grants?granter=${owner}&grantee=${grantee}&pagination.limit=50`, 8000)
    grants = j?.grants ?? []
  } catch {
    /* treated as none */
  }
  const find = (typeUrl: string, msgType?: string) =>
    grants.find((g) => g?.authorization?.['@type'] === typeUrl && (!msgType || g.authorization?.msg === msgType || g.authorization?.grants))
  const wasmG = find('/cosmwasm.wasm.v1.ContractExecutionAuthorization') ?? grants.find((g) => g?.authorization?.msg === WASM_EXEC_TYPE)
  const spotG = find(SPOT_MARKET_ORDER_AUTHZ_TYPE) ?? grants.find((g) => g?.authorization?.msg === SPOT_MARKET_ORDER_TYPE)
  const wasmContract = wasmG?.authorization?.grants?.[0]?.contract
  const wasm = {
    ok: !!wasmG && notExpired(wasmG.expiration) && (!wasmContract || wasmContract === NEPTUNE_CONTRACTS.market),
    expiration: wasmG?.expiration ?? null,
    detail: wasmG ? (wasmG.authorization?.grants ? `contract ${String(wasmContract).slice(0, 14)}…, keys ${JSON.stringify(wasmG.authorization.grants[0]?.filter?.keys ?? [])}` : 'generic (any contract!)') : 'missing',
  }
  const spot = {
    ok: !!spotG && notExpired(spotG.expiration),
    expiration: spotG?.expiration ?? null,
    detail: spotG ? (spotG.authorization?.market_ids ? `markets ${spotG.authorization.market_ids.length}` : 'generic') : 'missing',
  }
  let feegrant: GrantStatus['feegrant'] = { ok: false, expiration: null, remainingInj: null }
  try {
    const j = await lcd.json<any>(`/cosmos/feegrant/v1beta1/allowance/${owner}/${grantee}`, 8000)
    const a = j?.allowance?.allowance
    const exp = a?.expiration ?? null
    const inj = (a?.spend_limit ?? []).find((c: any) => c.denom === 'inj')
    feegrant = { ok: !!a && notExpired(exp), expiration: exp, remainingInj: inj ? parseFloat(inj.amount) / 1e18 : null }
  } catch {
    /* none */
  }
  const exps = [wasm.expiration, spot.expiration, feegrant.expiration].filter((x): x is string => !!x).sort()
  return { wasm, spot, feegrant, complete: wasm.ok && spot.ok && feegrant.ok, expiresAt: exps[0] ?? null }
}

/** Storage helpers for the browser: the session key lives in sessionStorage (dies with the tab) unless the user opts into localStorage. */
export const SESSION_KEY_STORAGE = 'nlc.session.v1'

export interface StoredSession {
  privateKeyHex: string
  address: string
  owner: string
  createdAt: string
}

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_STORAGE) ?? localStorage.getItem(SESSION_KEY_STORAGE)
    if (!raw) return null
    const s = JSON.parse(raw) as StoredSession
    return /^0x?[0-9a-fA-F]{64}$/.test(s.privateKeyHex) && /^inj1/.test(s.address) ? s : null
  } catch {
    return null
  }
}
export function storeSession(s: StoredSession, persistent: boolean) {
  try {
    const raw = JSON.stringify(s)
    if (persistent) {
      localStorage.setItem(SESSION_KEY_STORAGE, raw)
      sessionStorage.removeItem(SESSION_KEY_STORAGE)
    } else {
      sessionStorage.setItem(SESSION_KEY_STORAGE, raw)
      localStorage.removeItem(SESSION_KEY_STORAGE)
    }
  } catch {
    /* ignore */
  }
}
export function clearStoredSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY_STORAGE)
    localStorage.removeItem(SESSION_KEY_STORAGE)
  } catch {
    /* ignore */
  }
}
