import { describe, expect, it } from 'vitest'
import { buildGrantMsgs, buildRevokeMsgs, NEPTUNE_MESSAGE_KEYS, SPOT_MARKET_ORDER_AUTHZ_TYPE, WASM_EXEC_TYPE } from '../src/execution/session'
import { generateSessionKey, sessionFromHex } from '../src/execution/signer'
import { neptuneExecMsg, spotOrderMsg } from '../src/execution/chainPorts'
import { NEPTUNE_CONTRACTS } from '../src/config/chain'
import { SPOT_MARKETS } from '../src/execution/markets'

// The SDK validates bech32 checksums, so use a freshly generated (throw-away) address as the owner.
const ADDR = generateSessionKey().address

describe('session key', () => {
  it('generates a valid key and restores it from hex', () => {
    const k = generateSessionKey()
    expect(k.address).toMatch(/^inj1[02-9ac-hj-np-z]{38}$/)
    expect(sessionFromHex(k.privateKeyHex).address).toBe(k.address)
  })
})

describe('grant messages', () => {
  const owner = ADDR
  const grantee = generateSessionKey().address

  it('builds exactly three grants: scoped wasm authz, spot market authz, feegrant', () => {
    const msgs = buildGrantMsgs({ owner, grantee, expirySeconds: 7 * 86400, maxCalls: 500, gasAllowanceInj: 0.5 })
    expect(msgs.length).toBe(3)
    const protos = msgs.map((m) => m.toDirectSign())
    expect(protos[0].type).toBe('/cosmos.authz.v1beta1.MsgGrant')
    expect(protos[1].type).toBe('/cosmos.authz.v1beta1.MsgGrant')
    expect(protos[2].type).toBe('/cosmos.feegrant.v1beta1.MsgGrantAllowance')

    const wasm = msgs[0].toData() as any
    expect(wasm.grant.authorization.typeUrl).toBe('/cosmwasm.wasm.v1.ContractExecutionAuthorization')
    const spot = msgs[1].toData() as any
    expect(spot.grant.authorization.typeUrl).toBe(SPOT_MARKET_ORDER_AUTHZ_TYPE)
    const fee = msgs[2].toData() as any
    expect(fee.allowance.typeUrl).toBe('/cosmos.feegrant.v1beta1.BasicAllowance')
  })

  it('wasm grant is scoped to the Neptune market contract and the four loop message keys', () => {
    const msgs = buildGrantMsgs({ owner, grantee, expirySeconds: 86400 })
    const amino = (msgs[0] as any).toAmino?.() ?? (msgs[0] as any).toJSON?.()
    const text = JSON.stringify(amino ?? msgs[0].toData())
    expect(text).toContain(NEPTUNE_CONTRACTS.market)
    for (const k of NEPTUNE_MESSAGE_KEYS) expect(text).toContain(k)
  })

  it('revoke messages cover both authz grants and the fee allowance', () => {
    const msgs = buildRevokeMsgs(owner, grantee)
    const protos = msgs.map((m) => m.toDirectSign())
    expect(protos.map((p) => p.type)).toEqual(['/cosmos.authz.v1beta1.MsgRevoke', '/cosmos.authz.v1beta1.MsgRevoke', '/cosmos.feegrant.v1beta1.MsgRevokeAllowance'])
    const text = JSON.stringify(msgs.map((m) => m.toData()))
    expect(text).toContain(WASM_EXEC_TYPE)
    expect(text).toContain('/injective.exchange.v1beta1.MsgCreateSpotMarketOrder')
  })
})

describe('message builders', () => {
  it('neptune execute message carries sender, contract and funds', () => {
    const m = neptuneExecMsg(ADDR, { return: { account_index: 0 } }, [{ denom: 'inj', amount: '1' }])
    const d = m.toData() as any
    expect(d.sender).toBe(ADDR)
    expect(d.contract).toBe(NEPTUNE_CONTRACTS.market)
    expect(JSON.stringify(d)).toContain('return')
  })
  it('spot order rounds to ticks and encodes chain price/quantity', () => {
    const { msg, qty, price } = spotOrderMsg(ADDR, 'INJ/USDC', 'sell', 12.34567, 5.4321)
    expect(qty).toBe(12.345)
    expect(price).toBe(5.432) // sells round down
    const d = msg.toData() as any
    expect(d.order.marketId).toBe(SPOT_MARKETS['INJ/USDC'].marketId)
    expect(d.order.orderType).toBe(2)
    // chain price = human * 10^(quote-base) = 5.432e-12, encoded as an 18-decimal integer string (5.432e-12 * 1e18)
    expect(String(d.order.orderInfo.price)).toBe('5432000')
    const buy = spotOrderMsg(ADDR, 'INJ/USDC', 'buy', 1, 5.4321)
    expect(buy.price).toBe(5.433) // buys round up
    expect(() => spotOrderMsg(ADDR, 'INJ/USDC', 'sell', 0.0001, 5)).toThrow(/minimum/)
  })
})
