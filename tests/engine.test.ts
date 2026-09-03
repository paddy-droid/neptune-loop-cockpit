import { describe, expect, it } from 'vitest'
import { depositOrphanInj, executeLoop, injAmountToShares, safeStep } from '../src/execution/engine'
import { DEFAULT_EXECUTION } from '../src/execution/types'
import { MockChain, ports } from './mockChain'

const withinPct = (a: number, b: number, pct: number) => Math.abs(a - b) <= Math.abs(b) * pct

describe('safeStep', () => {
  const C = 11_770
  it('LTV 0.60 -> capped at 0.70 interim', () => {
    expect(safeStep(C, 0.6 * C)).toBeCloseTo(C - (0.6 * C) / 0.7, 6)
  })
  it('LTV 0.689 -> still a step of >= 4 points', () => {
    expect(safeStep(C, 0.689 * C)).toBeGreaterThan(0.05 * C)
  })
  it('LTV 0.74 -> capped at 0.77', () => {
    expect(safeStep(C, 0.74 * C)).toBeCloseTo(C - (0.74 * C) / 0.77, 6)
  })
  it('LTV 0.775 -> no step', () => {
    expect(safeStep(C, 0.775 * C)).toBe(0)
  })
  it('scales with the liquidation LTV', () => {
    expect(safeStep(C, 0.5 * C, 0.75, 0.73)).toBeCloseTo(C - (0.5 * C) / ((0.7 * 0.75) / 0.8), 6)
  })
})

describe('share conversion', () => {
  it('converts INJ to shares with the pool ratio and rejects exponent notation', async () => {
    const chain = new MockChain()
    const s = await chain.status()
    const shares = BigInt(injAmountToShares(100, s))
    // 100 INJ * poolShares/poolBalance = 98 shares-INJ
    expect(Number(shares / 10n ** 12n) / 1e6).toBeCloseTo(98, 3)
    s.collateralShares.inj.poolBalance = '4.98e+24'
    expect(() => injAmountToShares(1, s)).toThrow(/exponent/)
  })
})

describe('executeLoop down', () => {
  it('reduces LTV 0.60 -> 0.48 in rounds under the interim cap, ends at the target', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6 }) // LTV 0.60
    const res = await executeLoop({ mode: 'down', targetLtv: 0.48 }, ports(chain))
    expect(res.done).toBe(true)
    expect(withinPct(chain.ltv(), 0.48, 0.02)).toBe(true)
    // withdraw -> sell -> repay pattern, no unsold INJ left over
    const types = chain.txlog.map((t) => t.type)
    expect(types[0]).toBe('withdraw_collateral')
    expect(types).toContain('spot SELL INJ/USDC')
    expect(types).toContain('return USDC')
    expect(chain.state.walletInj).toBeLessThan(2.2)
    // interim LTV never above the round cap (checked on each withdraw record)
    for (const t of chain.txlog.filter((x) => x.type === 'withdraw_collateral')) {
      const m = t.after.match(/LTV ([0-9.]+)/)
      expect(parseFloat(m![1])).toBeLessThanOrEqual(0.705)
    }
  })

  it('uses wallet USDC first (reserve-first) and sells no INJ when the reserve suffices', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6, walletUsdc: 2000 })
    const res = await executeLoop({ mode: 'down', targetLtv: 0.48 }, ports(chain))
    expect(res.done).toBe(true)
    expect(chain.txlog.map((t) => t.type)).toEqual(['return USDC'])
    expect(withinPct(chain.ltv(), 0.48, 0.02)).toBe(true)
  })

  it('does not touch wallet USDC when noWalletUsdc is set', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6, walletUsdc: 2000 })
    await executeLoop({ mode: 'down', targetLtv: 0.48, noWalletUsdc: true }, ports(chain))
    expect(chain.state.walletUsdc).toBeGreaterThanOrEqual(2000 - 1)
    expect(chain.txlog.some((t) => t.type === 'withdraw_collateral')).toBe(true)
  })

  it('handles a partial fill: sells the pile before withdrawing more, ends at target; idle cleanup re-deposits the rest', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6 }, { fillRatio: 0.6 })
    const res = await executeLoop({ mode: 'down', targetLtv: 0.48 }, ports(chain))
    expect(res.done || res.deferred).toBe(true)
    expect(chain.ltv()).toBeLessThan(0.5)
    // a partially filled last sale can leave INJ in the wallet; it never exceeds one round's withdraw
    expect(chain.state.walletInj).toBeLessThan(60)
    // the next idle tick deposits the orphan back as collateral (only ever raises health)
    const { deposited } = await depositOrphanInj(ports(chain))
    expect(deposited).toBeGreaterThan(0)
    expect(chain.state.walletInj).toBeLessThan(2.5)
  })

  it('unclear sell response: never a second sale, waits for the fill', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6 }, { spotThrow: { msg: 'timeout', execute: true, times: 1, unclear: true } })
    const res = await executeLoop({ mode: 'down', targetLtv: 0.48 }, ports(chain))
    expect(res.done).toBe(true)
    const sells = chain.txlog.filter((t) => t.type === 'spot SELL INJ/USDC')
    const withdraws = chain.txlog.filter((t) => t.type === 'withdraw_collateral')
    expect(sells.length).toBe(withdraws.length) // exactly one sale per withdraw
  })

  it('clear rejection of the sale -> one retry with a fresh book', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6 }, { spotThrow: { msg: 'chain: rejected', execute: false, times: 1 } })
    const res = await executeLoop({ mode: 'down', targetLtv: 0.48 }, ports(chain))
    expect(res.done).toBe(true)
    expect(chain.log.some((e) => /retry with a fresh book/.test(e.info))).toBe(true)
  })

  it('withdraw response lost but landed -> cleanup sells the arrived INJ and repays', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6 }, { withdrawThrow: { msg: 'timeout', execute: true, times: 1, unclear: true } })
    const res = await executeLoop({ mode: 'down', targetLtv: 0.48 }, ports(chain))
    expect(res.done).toBe(false)
    expect(chain.log.some((e) => /withdraw response lost, but .* INJ arrived/.test(e.info))).toBe(true)
    expect(chain.txlog.some((t) => t.type === 'spot SELL INJ/USDC')).toBe(true)
    expect(chain.state.walletInj).toBeLessThan(2.5)
    expect(chain.ltv()).toBeLessThan(0.6)
  })

  it('withdraw response lost and NOT landed -> nothing is sold', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6 }, { withdrawThrow: { msg: 'timeout', execute: false, times: 1, unclear: true } })
    await executeLoop({ mode: 'down', targetLtv: 0.48 }, ports(chain))
    expect(chain.txlog.filter((t) => t.type === 'spot SELL INJ/USDC').length).toBe(0)
  })

  it('walletOnly: repays from wallet USDC only, defers', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6, walletUsdc: 300 })
    const res = await executeLoop({ mode: 'down', targetLtv: 0.48, walletOnly: true }, ports(chain))
    expect(res.deferred).toBe(true)
    expect(chain.txlog.map((t) => t.type)).toEqual(['return USDC'])
    expect(chain.log.some((e) => /oracle expired/.test(e.info))).toBe(true)
  })

  it('stop requested mid-run: finishes the current round, then stops without touching wallet funds', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6, walletUsdc: 500 }, { stopAfterChecks: 2 })
    const res = await executeLoop({ mode: 'down', targetLtv: 0.40 }, ports(chain))
    expect(res.done || res.deferred).toBe(true)
    expect(chain.log.some((e) => e.step === 'stop')).toBe(true)
    // no withdrawn INJ left unsold
    expect(chain.state.walletInj).toBeLessThan(2.5)
  })

  it('time budget exhausted -> deferred, no unsold INJ', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6 }, { msPerStatus: 60_000 })
    const res = await executeLoop({ mode: 'down', targetLtv: 0.40 }, ports(chain))
    expect(res.deferred).toBe(true)
    expect(chain.state.walletInj).toBeLessThan(2.5)
  })

  it('LTV already near the contract limit: small steps, never a rejected withdraw', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 4500, oraclePrice: 6 }) // LTV 0.75
    const res = await executeLoop({ mode: 'down', targetLtv: 0.48 }, ports(chain))
    expect(res.done || res.deferred).toBe(true)
    expect(chain.log.some((e) => /rejected/.test(e.info))).toBe(false)
    expect(chain.ltv()).toBeLessThan(0.75)
  })

  it('exchange reference price below the oracle: repays deeper (valued at the lower price)', async () => {
    const a = new MockChain({ injColl: 1000, debtUsdc: 3300, oraclePrice: 6, bid: 5.99, ask: 6.01 })
    await executeLoop({ mode: 'down', targetLtv: 0.48 }, ports(a))
    const b = new MockChain({ injColl: 1000, debtUsdc: 3300, oraclePrice: 6, bid: 5.99, ask: 6.01 })
    await executeLoop({ mode: 'down', targetLtv: 0.48, refPrice: 5.4 }, ports(b))
    expect(b.state.debtUsdc).toBeLessThan(a.state.debtUsdc)
  })
})

describe('executeLoop up', () => {
  it('adds leverage 0.30 -> 0.40: borrow, buy, deposit; ends at the target', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 1800, oraclePrice: 6, walletUsdc: 250 })
    const res = await executeLoop({ mode: 'up', targetLtv: 0.4 }, ports(chain))
    expect(res.done).toBe(true)
    expect(withinPct(chain.ltv(), 0.4, 0.02)).toBe(true)
    const types = chain.txlog.map((t) => t.type)
    expect(types.slice(0, 3)).toEqual(['borrow USDC', 'spot BUY INJ/USDC', 'deposit_collateral'])
    // the reserve stays untouched
    expect(chain.state.walletUsdc).toBeGreaterThanOrEqual(250 - 5)
  })
  it('book far above the oracle -> buy postponed, nothing borrowed', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 1800, oraclePrice: 6, bid: 6.2, ask: 6.25 })
    const res = await executeLoop({ mode: 'up', targetLtv: 0.4 }, ports(chain))
    expect(res.deferred).toBe(true)
    expect(chain.txlog.length).toBe(0)
  })
  it('borrow rejected -> deferred, not failed', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 1800, oraclePrice: 6 }, { borrowReject: true })
    const res = await executeLoop({ mode: 'up', targetLtv: 0.4 }, ports(chain))
    expect(res.deferred).toBe(true)
  })
  it('partial buy fill: excess USDC is returned to the debt', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 1800, oraclePrice: 6 }, { fillRatio: 0.5 })
    const res = await executeLoop({ mode: 'up', targetLtv: 0.4 }, ports(chain))
    expect(res.done || res.deferred).toBe(true)
    // no idle borrowed USDC left in the wallet
    expect(chain.state.walletUsdc).toBeLessThan(10)
  })
  it('target above 0.70 is refused', async () => {
    const chain = new MockChain()
    const res = await executeLoop({ mode: 'up', targetLtv: 0.75 }, ports(chain))
    expect(res.done).toBe(false)
    expect(chain.txlog.length).toBe(0)
  })
})

describe('executeLoop emergency (exit)', () => {
  it('repays all debt and sells the rest into USDC, keeps gas + keepInj', async () => {
    const chain = new MockChain({ injColl: 500, debtUsdc: 1200, oraclePrice: 80, bid: 79.9, ask: 80.1, depthNearUsd: 100_000 })
    const res = await executeLoop({ mode: 'emergency', sellAllInj: true, keepInj: 1 }, ports(chain))
    expect(res.done).toBe(true)
    expect(chain.state.debtUsdc).toBeLessThan(0.05)
    expect(chain.state.injColl).toBeLessThan(0.3)
    expect(chain.state.walletInj).toBeGreaterThan(1.3)
    expect(chain.state.walletInj).toBeLessThan(1.7)
    expect(chain.state.walletUsdc).toBeGreaterThan(500 * 80 - 1200 - 1000)
  })
  it('USDT debt is rotated and repaid on exit', async () => {
    const chain = new MockChain({ injColl: 500, debtUsdc: 0, debtUsdt: 600, oraclePrice: 80, bid: 79.9, ask: 80.1, depthNearUsd: 100_000 })
    const res = await executeLoop({ mode: 'emergency', sellAllInj: false, keepInj: 1 }, ports(chain))
    expect(res.done).toBe(true)
    expect(chain.state.debtUsdt).toBeLessThan(0.05)
  })
})

describe('config', () => {
  it('default execution config is sane', () => {
    expect(DEFAULT_EXECUTION.roundLtvCap).toBeLessThan(DEFAULT_EXECUTION.stepLtvLimit)
    expect(DEFAULT_EXECUTION.stepLtvLimit).toBeLessThan(0.78)
  })
})
