import { describe, expect, it } from 'vitest'
import { decide } from '../src/strategy/policy'
import { buildPlan, computeTriggers, healthFromLtv, leverageFromLtv, priceAtLtv, repayRounds } from '../src/strategy/planner'
import { DEFAULT_STRATEGY } from '../src/strategy/types'
import { ASSETS } from '../src/config/chain'
import { statusAt, trendOk } from './fixtures'

const cfg = DEFAULT_STRATEGY

describe('planner math', () => {
  it('health / ltv / leverage identities', () => {
    expect(healthFromLtv(0.4)).toBeCloseTo(2, 6)
    expect(healthFromLtv(0.5, 0.75)).toBeCloseTo(1.5, 6)
    expect(leverageFromLtv(0.4)).toBeCloseTo(1.6667, 3)
    expect(priceAtLtv(0.56, 5000, 2000)).toBeCloseTo(5000 / (0.56 * 2000), 9)
    expect(priceAtLtv(null, 5000, 2000)).toBeNull()
  })

  it('repay plan lands exactly on the target LTV (no wallet USDC)', () => {
    const s = statusAt(0.6, { price: 5, inj: 2000, bank: [{ symbol: 'INJ', denom: ASSETS.INJ.denom, amount: 1, usd: 5 }] })
    const d = decide(s, trendOk({ lastClose: 5 }), cfg)
    expect(d.action).toBe('down')
    const p = buildPlan(s, d, cfg)
    expect(p.kind).toBe('repay')
    // x = (debt - t*coll) / (1 - t)
    const coll = 2000 * 5
    const x = (0.6 * coll - 0.48 * coll) / (1 - 0.48)
    expect(p.numbers.usd).toBeCloseTo(x, 6)
    // after selling x*(1+cost) worth of INJ and repaying x, LTV must be 0.48
    const debtAfter = 0.6 * coll - x
    const collAfter = coll - x * (1 + cfg.tradeCostPct)
    expect(p.numbers.ltvAfter).toBeCloseTo(debtAfter / collAfter, 9)
    expect(p.numbers.ltvAfter).toBeGreaterThan(0.48 - 0.01)
    expect(p.numbers.ltvAfter).toBeLessThan(0.48 + 0.01)
    expect(p.numbers.rounds).toBeGreaterThanOrEqual(1)
    expect(p.steps.some((st) => /Withdraw/.test(st.title))).toBe(true)
  })

  it('repay plan uses wallet USDC first', () => {
    const s = statusAt(0.6, { price: 5, inj: 2000, bank: [{ symbol: 'USDC', denom: ASSETS.USDC.denom, amount: 5000, usd: 5000 }] })
    const d = decide(s, trendOk({ lastClose: 5 }), cfg)
    const p = buildPlan(s, d, cfg)
    expect(p.numbers.fromWalletUsd).toBeCloseTo(p.numbers.usd, 6)
    expect(p.numbers.inj).toBe(0)
    expect(p.steps[0].title).toMatch(/from your wallet/)
  })

  it('add plan lands on the target LTV and respects pool liquidity', () => {
    const s = statusAt(0.3, { price: 5, inj: 2000 })
    const d = decide(s, trendOk({ lastClose: 5.1 }), cfg)
    expect(d.action).toBe('up')
    const p = buildPlan(s, d, cfg)
    expect(p.kind).toBe('add')
    const coll = 2000 * 5
    const x = (0.4 * coll - 0.3 * coll) / (1 - 0.4)
    expect(p.numbers.usd).toBeCloseTo(x, 6)
    expect(p.numbers.ltvAfter).toBeGreaterThan(0.39)
    expect(p.numbers.ltvAfter).toBeLessThan(0.41)

    const tight = statusAt(0.3, { price: 5, inj: 2000, usdcPoolFreeUsd: 500 })
    const p2 = buildPlan(tight, decide(tight, trendOk({ lastClose: 5.1 }), cfg), cfg)
    expect(p2.numbers.usd).toBe(500)
    expect(p2.warnings.some((w) => /pool/.test(w))).toBe(true)
  })

  it('exit plan', () => {
    const s = statusAt(0.035, { price: 78, inj: 2000 })
    const d = decide(s, trendOk({ lastClose: 79 }), cfg)
    const p = buildPlan(s, d, cfg)
    expect(p.kind).toBe('exit')
    expect(p.numbers.ltvAfter).toBe(0)
  })

  it('hold and blocked plans', () => {
    const inBand = buildPlan(statusAt(0.45), decide(statusAt(0.45), trendOk(), cfg), cfg)
    expect(inBand.kind).toBe('hold')
    const s = statusAt(0.3)
    const blocked = buildPlan(s, decide(s, trendOk({ lastClose: 4.7, sma: 4.8 }), cfg), cfg)
    expect(blocked.kind).toBe('blocked')
  })

  it('data error plan never recommends a trade', () => {
    const s = statusAt(0.5, { oracleAgeSec: 700 })
    const p = buildPlan(s, decide(s, null, cfg), cfg)
    expect(p.kind).toBe('data-error')
  })

  it('repayRounds respects the interim LTV cap', () => {
    // 2000 INJ at $5, debt 6000 (LTV 0.6). Cap 0.70: first round may withdraw 2000 - 6000/(0.7*5) = 285.7 INJ
    const r = repayRounds(2000, 6000, 5, 2500, 0.7, 0.78, 0.01)
    expect(r.perRoundInj[0]).toBeCloseTo(2000 - 6000 / (0.7 * 5), 6)
    expect(r.rounds).toBeGreaterThanOrEqual(2)
  })

  it('triggers: prices where repay / add / next rung happen', () => {
    const s = statusAt(0.45, { price: 5, inj: 2000 })
    const d = decide(s, trendOk({ lastClose: 5 }), cfg)
    const t = computeTriggers(s, d, cfg)
    const debt = 0.45 * 2000 * 5
    expect(t.repayAtPrice).toBeCloseTo(debt / (0.56 * 2000), 9)
    expect(t.buyAtPrice).toBeCloseTo(debt / (0.36 * 2000), 9)
    expect(t.nextRungPrice).toBe(25)
    expect(t.nextRungLabel).toBe('Secure I')
    expect(t.exitPrice).toBe(75)
    expect(t.repayDistPct).toBeLessThan(0)
    expect(t.liqDistPct).toBeLessThan(t.repayDistPct!)
  })
})
