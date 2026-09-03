import { describe, expect, it } from 'vitest'
import { AlertThrottle, DEFAULT_AUTOPILOT, newTickState, runTick } from '../src/execution/autopilot'
import { DEFAULT_STRATEGY } from '../src/strategy/types'
import { MockChain, ports } from './mockChain'
import { trendOk } from './fixtures'

const strategy = DEFAULT_STRATEGY
const enabled = { ...DEFAULT_AUTOPILOT, enabled: true }

describe('runTick', () => {
  it('disabled autopilot never executes, but reports what it would do', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6 }) // LTV 0.60 -> reduce
    const r = await runTick({ ports: ports(chain), strategy, autopilot: DEFAULT_AUTOPILOT, state: newTickState(), paused: false, trend: trendOk({ lastClose: 6, sma: 5 }) })
    expect(r.executed).toBe(false)
    expect(r.decision.action).toBe('none')
    expect(r.decision.reason).toMatch(/would down/)
    expect(chain.txlog.length).toBe(0)
  })

  it('enabled: LTV above the trigger -> reduce is executed and lands at the target', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6 })
    const r = await runTick({ ports: ports(chain), strategy, autopilot: enabled, state: newTickState(), paused: false, trend: trendOk({ lastClose: 6, sma: 5, prevClose: 6, prevSma: 5 }) })
    expect(r.executed).toBe(true)
    expect(r.execStatus).toBe('done')
    expect(Math.abs(chain.ltv() - 0.48)).toBeLessThan(0.01)
    expect(r.alerts.some((a) => a.key === 'done')).toBe(true)
  })

  it('reduce runs even when paused, but wallet funds are not used', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6, walletUsdc: 5000 })
    const r = await runTick({ ports: ports(chain), strategy, autopilot: enabled, state: newTickState(), paused: true, trend: trendOk({ lastClose: 6, sma: 5, prevClose: 6, prevSma: 5 }) })
    expect(r.executed).toBe(true)
    expect(chain.state.walletUsdc).toBeGreaterThanOrEqual(4999)
    expect(chain.txlog.some((t) => t.type === 'withdraw_collateral')).toBe(true)
  })

  it('add leverage: blocked while paused, by cooldown, and by the hold check', async () => {
    const mk = () => new MockChain({ injColl: 1000, debtUsdc: 1800, oraclePrice: 6 }) // LTV 0.30 -> add
    const trend = trendOk({ lastClose: 6, sma: 5, prevClose: 6, prevSma: 5 })
    const paused = await runTick({ ports: ports(mk()), strategy, autopilot: enabled, state: newTickState(), paused: true, trend })
    expect(paused.executed).toBe(false)
    expect(paused.decision.reason).toMatch(/PAUSED/)

    const st = newTickState()
    st.lastBuyAtMs = Date.now() - 5 * 60_000
    const cd = await runTick({ ports: ports(mk()), strategy, autopilot: enabled, state: st, paused: false, trend, priceThen: 5.9 })
    expect(cd.executed).toBe(false)
    expect(cd.decision.reason).toMatch(/cooldown/)

    // price 15 min ago was 5.0 -> LTV then 0.36 = at the trigger -> not held long enough
    const hold = await runTick({ ports: ports(mk()), strategy, autopilot: enabled, state: newTickState(), paused: false, trend, priceThen: 5.0 })
    expect(hold.executed).toBe(false)
    expect(hold.decision.reason).toMatch(/hold check/)
  })

  it('add leverage executes when guards pass, records the buy time', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 1800, oraclePrice: 6 })
    const st = newTickState()
    const r = await runTick({ ports: ports(chain), strategy, autopilot: enabled, state: st, paused: false, trend: trendOk({ lastClose: 6, sma: 5, prevClose: 6, prevSma: 5 }), priceThen: 5.95 })
    expect(r.executed).toBe(true)
    expect(r.execStatus).toBe('done')
    expect(st.lastBuyAtMs).not.toBeNull()
    expect(Math.abs(chain.ltv() - 0.4)).toBeLessThan(0.01)
  })

  it('protocol fingerprint change blocks adding for 24 h and alerts', async () => {
    const st = newTickState()
    st.lastFingerprint = 'fp1|old'
    const chain = new MockChain({ injColl: 1000, debtUsdc: 1800, oraclePrice: 6 })
    const r = await runTick({ ports: ports(chain), strategy, autopilot: enabled, state: st, paused: false, trend: trendOk({ lastClose: 6, sma: 5, prevClose: 6, prevSma: 5 }), priceThen: 5.95, fingerprint: 'fp1|new' })
    expect(r.executed).toBe(false)
    expect(r.decision.reason).toMatch(/parameters\/code changed/)
    expect(r.alerts.some((a) => a.key === 'fingerprint')).toBe(true)
    expect(st.paramChangeLockUntilMs).toBeGreaterThan(chain.now())
  })

  it('idle tick deposits orphaned wallet INJ', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 2700, oraclePrice: 6, walletInj: 12 })
    const r = await runTick({ ports: ports(chain), strategy, autopilot: enabled, state: newTickState(), paused: false, trend: trendOk({ lastClose: 6, sma: 5, prevClose: 6, prevSma: 5 }) })
    expect(r.executed).toBe(false)
    expect(chain.txlog.map((t) => t.type)).toEqual(['deposit_collateral'])
    expect(chain.state.walletInj).toBeLessThan(2)
  })

  it('stale oracle -> data error alert, nothing executed', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6, oracleAgeSec: 900 })
    const r = await runTick({ ports: ports(chain), strategy, autopilot: enabled, state: newTickState(), paused: false, trend: null })
    expect(r.executed).toBe(false)
    expect(r.alerts.some((a) => a.key === 'dataerror')).toBe(true)
    expect(chain.txlog.length).toBe(0)
  })

  it('address mismatch stops everything', async () => {
    const chain = new MockChain({ injColl: 1000, debtUsdc: 3600, oraclePrice: 6 })
    const p = { ...ports(chain), address: 'inj1someoneelse' }
    const r = await runTick({ ports: p, strategy, autopilot: enabled, state: newTickState(), paused: false, trend: null })
    expect(r.executed).toBe(false)
    expect(r.alerts[0].key).toBe('addr-mismatch')
  })

  it('exit rung with confirmation -> full exit executed', async () => {
    const chain = new MockChain({ injColl: 500, debtUsdc: 1200, oraclePrice: 80, bid: 79.9, ask: 80.1, depthNearUsd: 100_000 })
    const r = await runTick({ ports: ports(chain), strategy, autopilot: enabled, state: newTickState(), paused: false, trend: trendOk({ lastClose: 80.5, sma: 40, prevClose: 79, prevSma: 40 }) })
    expect(r.decision.action).toBe('exit')
    expect(r.executed).toBe(true)
    expect(chain.state.debtUsdc).toBeLessThan(0.05)
    expect(chain.state.injColl).toBeLessThan(0.3)
  })
})

describe('AlertThrottle', () => {
  it('rate-limits per key', () => {
    const t = new AlertThrottle({ crit: 300 }, 900)
    const now = 1_000_000
    expect(t.allow('crit', now)).toBe(true)
    expect(t.allow('crit', now + 100_000)).toBe(false)
    expect(t.allow('crit', now + 301_000)).toBe(true)
    expect(t.allow('start-down', now)).toBe(true)
    expect(t.allow('start-down', now + 1000)).toBe(false)
  })
})
