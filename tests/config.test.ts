import { describe, expect, it } from 'vitest'
import { DEFAULT_STRATEGY, parseStrategy, serializeStrategy, validateStrategy } from '../src/strategy/types'

describe('strategy config', () => {
  it('default config is valid', () => {
    expect(validateStrategy(DEFAULT_STRATEGY)).toEqual([])
  })
  it('round-trips through JSON (Infinity survives)', () => {
    const json = serializeStrategy(DEFAULT_STRATEGY)
    expect(json).not.toMatch(/Infinity/)
    const back = parseStrategy(json)
    expect(back.ladder[back.ladder.length - 1].upTo).toBe(Infinity)
    expect(back).toEqual(DEFAULT_STRATEGY)
  })
  it('rejects an oscillating band (buyLtv >= repayTargetLtv)', () => {
    const bad = { ...DEFAULT_STRATEGY, ladder: DEFAULT_STRATEGY.ladder.map((r, i) => (i === 0 ? { ...r, buyLtv: 0.5, buyTriggerLtv: 0.45 } : r)) }
    expect(validateStrategy(bad).join(' ')).toMatch(/oscillates/)
  })
  it('rejects unsorted rungs and bad modes', () => {
    const bad = { ...DEFAULT_STRATEGY, mode: 'yolo', ladder: [DEFAULT_STRATEGY.ladder[1], DEFAULT_STRATEGY.ladder[0]] }
    const errs = validateStrategy(bad)
    expect(errs.some((e) => /greater than the previous/.test(e))).toBe(true)
    expect(errs.some((e) => /mode/.test(e))).toBe(true)
  })
})
