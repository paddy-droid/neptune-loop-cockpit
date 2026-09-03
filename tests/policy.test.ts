import { describe, expect, it } from 'vitest'
import { decide } from '../src/strategy/policy'
import { DEFAULT_STRATEGY, type StrategyConfig } from '../src/strategy/types'
import { statusAt, trendOk, trendStale } from './fixtures'

const cfg = DEFAULT_STRATEGY

describe('decide - band E ladder (loop zone)', () => {
  it('LTV 0.35 -> add leverage up to 0.40', () => {
    const d = decide(statusAt(0.35), trendOk(), cfg)
    expect(d.action).toBe('up')
    expect(d.targetLtv).toBe(0.4)
  })
  it('LTV 0.37 -> none (above add trigger 0.36)', () => {
    expect(decide(statusAt(0.37), trendOk(), cfg).action).toBe('none')
  })
  it('LTV 0.488 -> none (inside the band)', () => {
    const d = decide(statusAt(0.488), trendOk(), cfg)
    expect(d.action).toBe('none')
    expect(d.reason).toMatch(/inside the band/)
  })
  it('LTV 0.559 with exchange = oracle -> none (below repay trigger 0.56)', () => {
    expect(decide(statusAt(0.559), trendOk({ lastClose: 5.58 }), cfg).action).toBe('none')
  })
  it('LTV 0.565 -> reduce to 0.48', () => {
    const d = decide(statusAt(0.565), trendOk({ lastClose: 5.58 }), cfg)
    expect(d.action).toBe('down')
    expect(d.targetLtv).toBe(0.48)
  })
  it('effective thresholds without any filter', () => {
    const d = decide(statusAt(0.45), trendOk(), cfg)
    expect(d.effective).toEqual({ repayTriggerLtv: 0.56, repayTargetLtv: 0.48, buyTriggerLtv: 0.36, buyLtv: 0.4 })
  })
})

describe('decide - trend filter', () => {
  it('filter active, LTV 0.55 -> reduce (trigger becomes the cap trigger 0.54, target stays the stricter 0.48)', () => {
    const d = decide(statusAt(0.55), trendOk({ filterActive: true, prevClose: 4.7, sma: 4.8, lastClose: 5.58 }), cfg)
    expect(d.action).toBe('down')
    expect(d.targetLtv).toBe(0.48)
    expect(d.effective.repayTriggerLtv).toBe(0.54)
    expect(d.trend.ltvCap).toBe(0.5)
  })
  it('filter active in an upper rung with a looser target -> target is capped at 0.50', () => {
    const d = decide(statusAt(0.56, { price: 28 }), trendOk({ filterActive: true, prevClose: 27, sma: 29, lastClose: 28 }), cfg)
    expect(d.rung.label).toBe('Secure I') // rung target 0.53 > cap 0.50
    expect(d.action).toBe('down')
    expect(d.targetLtv).toBe(0.5)
  })
  it('filter active, LTV 0.52 -> none, adding blocked', () => {
    const d = decide(statusAt(0.52), trendOk({ filterActive: true, prevClose: 4.7, sma: 5.6, lastClose: 5.58 }), cfg)
    expect(d.action).toBe('none')
    expect(d.trend.buyBlocked).toBe(true)
    expect(d.effective.buyTriggerLtv).toBeNull()
  })
  it('live price below SMA but daily close above (hysteresis) -> no adding, reason given', () => {
    const d = decide(statusAt(0.3), trendOk({ lastClose: 4.7, sma: 4.8 }), cfg)
    expect(d.action).toBe('none')
    expect(d.trend.buyBlocked).toBe(true)
    expect(d.trend.noBuyWhy).toMatch(/hysteresis/)
  })
  it('no price history at all -> never add (fail-safe), repay rules unchanged', () => {
    const d = decide(statusAt(0.3), null, cfg)
    expect(d.action).toBe('none')
    expect(d.trend.noBuyWhy).toMatch(/no price history/)
    expect(d.effective.repayTriggerLtv).toBe(0.56)
  })
  it('filter disabled in config -> adding allowed even below SMA', () => {
    const off: StrategyConfig = { ...cfg, trendFilter: { ...cfg.trendFilter, enabled: false } }
    const d = decide(statusAt(0.3), trendOk({ filterActive: true, lastClose: 4.7, sma: 4.8 }), off)
    expect(d.action).toBe('up')
  })
})

describe('decide - guards', () => {
  it('USDC borrow APR 26 % -> no adding', () => {
    const d = decide(statusAt(0.3, { rates: [{ symbol: 'USDC', lend: 0.2, borrow: 0.26 }] }), trendOk(), cfg)
    expect(d.action).toBe('none')
    expect(d.rate.buyBlocked).toBe(true)
  })
  it('USDC borrow APR 36 % -> de-lever (cap trigger 0.54, target the stricter of rung 0.48 and cap 0.50)', () => {
    const d = decide(statusAt(0.55, { rates: [{ symbol: 'USDC', lend: 0.3, borrow: 0.36 }] }), trendOk({ lastClose: 5.58 }), cfg)
    expect(d.action).toBe('down')
    expect(d.targetLtv).toBe(0.48)
    expect(d.effective.repayTriggerLtv).toBe(0.54)
    expect(d.rate.ltvCap).toBe(0.5)
  })
  it('pool 90 % utilised -> no adding', () => {
    const d = decide(statusAt(0.3, { usdcUtilization: 0.9 }), trendOk(), cfg)
    expect(d.action).toBe('none')
    expect(d.trend.noBuyWhy).toMatch(/pool/)
  })
  it('liquidation LTV changed to 0.75 -> thresholds scale, adding blocked', () => {
    const s = statusAt(0.488, { injLiqLtv: 0.75 })
    s.health = 0.75 / 0.488
    const d = decide(s, trendOk(), cfg)
    expect(d.effective.repayTriggerLtv).toBeCloseTo((0.56 * 0.75) / 0.8, 6)
    expect(d.effective.buyTriggerLtv).toBeNull()
    expect(d.trend.noBuyWhy).toMatch(/liquidation LTV/)
  })
  it('mode repay-only never adds', () => {
    const d = decide(statusAt(0.3), trendOk(), { ...cfg, mode: 'repay-only' })
    expect(d.action).toBe('none')
    expect(d.effective.buyLtv).toBeNull()
  })
  it('mode off does nothing', () => {
    expect(decide(statusAt(0.7), trendOk(), { ...cfg, mode: 'off' }).action).toBe('none')
  })
})

describe('decide - data errors', () => {
  it('NaN health -> dataError, no action', () => {
    const d = decide(statusAt(0.5, { health: NaN }), trendOk(), cfg)
    expect(d.action).toBe('none')
    expect(d.dataError).toBeTruthy()
  })
  it('oracle price 0 -> dataError', () => {
    expect(decide(statusAt(0.5, { injPrice: 0 }), trendOk(), cfg).dataError).toMatch(/oracle/)
  })
  it('missing oracle timestamp -> dataError', () => {
    expect(decide(statusAt(0.5, { oracleAgeSec: -1 }), trendOk(), cfg).dataError).toMatch(/timestamp/)
  })
  it('health x ltv far from liquidation LTV -> dataError', () => {
    const s = statusAt(0.5)
    s.health = 2.5 // should be 1.6
    expect(decide(s, trendOk(), cfg).dataError).toMatch(/collateral factor/)
  })
  it('stale oracle + fresh exchange 20 % lower above trigger -> protective repay with refPrice', () => {
    const s = statusAt(0.55, { oracleAgeSec: 700 })
    const d = decide(s, trendOk({ lastClose: 4.46 }), cfg)
    expect(d.action).toBe('down')
    expect(d.refPrice).toBe(4.46)
    expect(d.dataError).toMatch(/stale/)
  })
  it('stale oracle + stale exchange data -> no action', () => {
    const s = statusAt(0.55, { oracleAgeSec: 700 })
    const d = decide(s, trendStale({ lastClose: 4.46 }), cfg)
    expect(d.action).toBe('none')
    expect(d.dataError).toBeTruthy()
  })
})

describe('decide - exchange price below oracle', () => {
  it('LTV 0.56 with exchange 12 % lower -> reduce, refPrice set', () => {
    const d = decide(statusAt(0.56), trendOk({ lastClose: 4.91 }), cfg)
    expect(d.action).toBe('down')
    expect(d.refPrice).toBe(4.91)
    expect(d.ltvEff).toBeGreaterThan(0.56)
  })
  it('same with stale exchange data -> none, no refPrice', () => {
    const d = decide(statusAt(0.56), trendStale({ lastClose: 4.91 }), cfg)
    expect(d.action).toBe('none')
    expect(d.refPrice).toBeUndefined()
  })
  it('exchange more than 15 % below oracle -> oracle-gap warning', () => {
    const d = decide(statusAt(0.4), trendOk({ lastClose: 4.5 }), cfg)
    expect(d.warn).toBe('oracle-gap')
  })
})

describe('decide - debt asset and exit', () => {
  it('USDT-only debt above trigger -> warn usdt, no action', () => {
    const s = statusAt(0.65)
    s.debts = [{ symbol: 'USDT', denom: 't', amount: s.debtUsd, usd: s.debtUsd }]
    const d = decide(s, trendOk(), cfg)
    expect(d.action).toBe('none')
    expect(d.warn).toBe('usdt')
  })
  it('no debt -> none', () => {
    expect(decide(statusAt(0), trendOk(), cfg).reason).toMatch(/No debt/)
  })
  it('INJ $78 with fresh exchange confirmation -> exit', () => {
    const d = decide(statusAt(0.035, { price: 78 }), trendOk({ lastClose: 79 }), cfg)
    expect(d.action).toBe('exit')
  })
  it('INJ $78 with 20 min old confirmation -> waits', () => {
    const d = decide(statusAt(0.035, { price: 78 }), trendStale({ lastClose: 79 }), cfg)
    expect(d.action).toBe('none')
    expect(d.reason).toMatch(/Exit waits/)
  })
  it('INJ $78 oracle, exchange $70 -> waits (no single-print exit)', () => {
    expect(decide(statusAt(0.035, { price: 78 }), trendOk({ lastClose: 70 }), cfg).reason).toMatch(/Exit waits/)
  })
  it('INJ $78 without price data -> waits', () => {
    expect(decide(statusAt(0.035, { price: 78 }), null, cfg).reason).toMatch(/Exit waits/)
  })
})

describe('decide - upper rungs', () => {
  it('INJ $33 (Secure II) LTV 0.50 -> reduce to 0.45', () => {
    const d = decide(statusAt(0.5, { price: 33 }), trendOk({ lastClose: 33, sma: 20, prevClose: 32, prevSma: 20 }), cfg)
    expect(d.rung.label).toBe('Secure II')
    expect(d.action).toBe('down')
    expect(d.targetLtv).toBe(0.45)
  })
  it('INJ $33 LTV 0.30 -> none, no adding outside the loop zone', () => {
    const d = decide(statusAt(0.3, { price: 33 }), trendOk({ lastClose: 33, sma: 20, prevClose: 32, prevSma: 20 }), cfg)
    expect(d.action).toBe('none')
    expect(d.effective.buyLtv).toBeNull()
  })
})
