import { describe, expect, it } from 'vitest'
import { buildStatus, getStatus, type RawStatus } from '../src/chain/neptune'
import { ASSETS, NEPTUNE_CONTRACTS, isInjAddress } from '../src/config/chain'
import { LcdClient, toBase64 } from '../src/chain/lcd'
import { ADDR } from './fixtures'

const inj = { native_token: { denom: 'inj' } }
const usdc = { native_token: { denom: ASSETS.USDC.denom } }
const nowMs = Date.parse('2026-09-03T12:00:00Z')

/** Shaped like the real contract responses (values invented). */
function raw(): RawStatus {
  return {
    health: '1.6',
    prices: [
      [inj, { price: '5.000000000000000000', time_last_updated: String((nowMs / 1000 - 30) * 1e9) }],
      [usdc, { price: '1.000000000000000000' }],
    ],
    accounts: [[0, {
      collateral_pool_accounts: [[inj, { principal: '2000000000000000000000', shares: '1000' }]],
      debt_pool_accounts: [[usdc, { principal: '4000000000', shares: '500' }]],
    }]],
    markets: [[usdc, { debt_pool: { balance: '5000000000', shares: '625' }, lending_principal: '10000000000' }]],
    collaterals: [[inj, { collateral_pool: { balance: '4000000000000000000000', shares: '2000' }, collateral_details: { liquidation_ltv: '0.8', allowable_ltv: '0.78' } }]],
    lendRates: [[usdc, '0.09'], [inj, '0.02']],
    borrowRates: [[usdc, '0.16'], [inj, '0.06']],
    bank: { balances: [{ denom: 'inj', amount: '1500000000000000000' }, { denom: ASSETS.USDC.denom, amount: '250000000' }, { denom: 'factory/unknown', amount: '1' }] },
  }
}

describe('buildStatus', () => {
  it('folds shares into amounts and computes the derived numbers', () => {
    const s = buildStatus(raw(), ADDR, 0, nowMs)
    // collateral: 1000 shares of 2000 => half of 4000 INJ = 2000 INJ
    expect(s.collateral[0].amount).toBeCloseTo(2000, 6)
    expect(s.collateralUsd).toBeCloseTo(10_000, 6)
    // debt: 500 shares of 625 => 0.8 * 5000 USDC = 4000
    expect(s.debts[0].amount).toBeCloseTo(4000, 6)
    expect(s.ltv).toBeCloseTo(0.4, 9)
    expect(s.health).toBe(1.6)
    expect(s.liqPrice).toBeCloseTo(5 / 1.6, 9)
    expect(s.equityUsd).toBeCloseTo(6000, 6)
    expect(s.oracleAgeSec).toBeCloseTo(30, 1)
    expect(s.injLiqLtv).toBe(0.8)
    expect(s.injAllowableLtv).toBe(0.78)
    expect(s.usdcUtilization).toBeCloseTo(0.5, 9)
    expect(s.usdcPoolFreeUsd).toBeCloseTo(5000, 6)
    expect(s.usdcPoolLentUsd).toBeCloseTo(10_000, 6)
    expect(s.rates.find((r) => r.symbol === 'USDC')).toEqual({ symbol: 'USDC', lend: 0.09, borrow: 0.16 })
    expect(s.bank.map((b) => b.symbol).sort()).toEqual(['INJ', 'USDC'])
    expect(s.bank.find((b) => b.symbol === 'USDC')?.amount).toBe(250)
  })

  it('fresh address: health query "Account not found" becomes an empty position', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes(NEPTUNE_CONTRACTS.querier)) return new Response('{"code":2,"message":"Neptune Querier Error - Account not found"}', { status: 500 })
      if (u.includes('/cosmos/bank/')) return new Response(JSON.stringify({ balances: [] }), { status: 200 })
      if (u.includes(NEPTUNE_CONTRACTS.oracle)) return new Response(JSON.stringify({ data: raw().prices }), { status: 200 })
      if (u.includes(NEPTUNE_CONTRACTS.interest)) return new Response(JSON.stringify({ data: raw().lendRates }), { status: 200 })
      // market contract: user accounts -> [], markets / collaterals from the fixture
      const q = decodeURIComponent(u.split('/smart/')[1] ?? '')
      const msg = Buffer.from(q, 'base64').toString('utf8')
      if (msg.includes('get_user_accounts')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      if (msg.includes('get_all_markets')) return new Response(JSON.stringify({ data: raw().markets }), { status: 200 })
      return new Response(JSON.stringify({ data: raw().collaterals }), { status: 200 })
    }) as unknown as typeof fetch
    const lcd = new LcdClient({ hosts: ['https://a.example'], fetchImpl })
    const s = await getStatus(lcd, ADDR)
    expect(s.health).toBe(0)
    expect(s.debtUsd).toBe(0)
    expect(s.collateral).toEqual([])
    expect(s.injPrice).toBe(5)
  })

  it('unknown address / no account -> empty position, no crash', () => {
    const r = raw()
    r.accounts = []
    r.health = '0'
    const s = buildStatus(r, ADDR, 0, nowMs)
    expect(s.collateral).toEqual([])
    expect(s.debtUsd).toBe(0)
    expect(s.ltv).toBe(0)
  })

  it('missing oracle timestamp -> oracleAgeSec -1', () => {
    const r = raw()
    r.prices[0][1] = { price: '5' }
    expect(buildStatus(r, ADDR, 0, nowMs).oracleAgeSec).toBe(-1)
  })
})

describe('lcd client', () => {
  it('fails over to the next host and remembers the failure', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url)
      calls.push(u)
      if (u.startsWith('https://bad')) throw new Error('boom')
      return new Response(JSON.stringify({ data: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const lcd = new LcdClient({ hosts: ['https://bad.example', 'https://good.example'], fetchImpl })
    const r = await lcd.smartQuery<string>('inj1contract', { q: {} })
    expect(r).toBe('ok')
    expect(calls.length).toBe(2)
    expect(lcd.lastHost).toBe('https://good.example')
    // second call skips the penalised host
    await lcd.smartQuery('inj1contract', { q: {} })
    expect(calls.length).toBe(3)
    expect(calls[2].startsWith('https://good')).toBe(true)
  })

  it('a contract-level HTTP 500 is thrown immediately and does NOT penalise the host', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response('{"code":2,"message":"Neptune Querier Error - Account not found"}', { status: 500, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const lcd = new LcdClient({ hosts: ['https://a.example', 'https://b.example'], fetchImpl })
    await expect(lcd.smartQuery('inj1contract', { q: {} })).rejects.toThrow(/Account not found/)
    expect(calls).toBe(1) // no failover for an application error
    expect(Object.keys(lcd.hostState()).length).toBe(0) // no penalty
  })

  it('throws LcdError when all hosts fail', async () => {
    const fetchImpl = (async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    const lcd = new LcdClient({ hosts: ['https://a.example'], fetchImpl })
    await expect(lcd.json('/x')).rejects.toThrow(/LCD hosts failed/)
  })

  it('base64 encodes query messages', () => {
    expect(toBase64('{"a":1}')).toBe(Buffer.from('{"a":1}').toString('base64'))
  })
})

describe('address validation', () => {
  it('accepts a well-formed inj address and rejects junk', () => {
    expect(isInjAddress(ADDR)).toBe(true)
    expect(isInjAddress('inj1short')).toBe(false)
    expect(isInjAddress('cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')).toBe(false)
  })
})
