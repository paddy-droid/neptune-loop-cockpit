/**
 * Backtest runner: prints the default ladder against historical INJ windows.
 *
 *   npm run backtest                 # named windows, variants side by side
 *   npm run backtest -- --rolling    # every 12-month window since 2020, summary statistics
 *
 * Read docs/STRATEGY.md#backtest-honesty before you draw conclusions: the windows overlap
 * almost completely, so there are only ~5 independent observations and ONE independent bull run.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULT_STRATEGY } from '../src/strategy/types'
import { holdResult, rescale, simulate, windowWithWarmup, type Day, type SimOptions } from './sim'

const here = dirname(fileURLToPath(import.meta.url))
const DATA: Day[] = JSON.parse(readFileSync(join(here, 'data', 'inj_daily.json'), 'utf8'))
const NOW = DATA[DATA.length - 1].c
const ladder = DEFAULT_STRATEGY.ladder
// Generic starting position: 1,000 INJ collateral, $2,700 debt (LTV ~45 % at the rescaled price). Not anyone's real position.
const startInj = 1000
const startDebt = 2700

const WINDOWS: [string, string, string][] = [
  ['2021 bull (Nov20 -> Apr21)', '2020-11-01', '2021-04-30'],
  ['2021 full (Nov20 -> Nov21)', '2020-11-01', '2021-11-15'],
  ['2023 bull 12M (Jan23 -> Dec23)', '2023-01-01', '2023-12-31'],
  ['2023 Q4 leg (Oct23 -> Mar24)', '2023-10-01', '2024-03-14'],
  ['Sideways (Apr23 -> Oct23)', '2023-04-17', '2023-10-15'],
  ['Bear (Mar24 -> Mar25)', '2024-03-14', '2025-03-14'],
  ['Bear, last 12M', '2025-08-25', '2026-08-25'],
  ['Cycle 22-24 (Jun22 -> Mar24)', '2022-06-01', '2024-03-14'],
]

const VARIANTS: Record<string, SimOptions | null> = {
  'Hold INJ (no leverage)': null,
  'No filter': { ladder },
  'No buying below SMA50': { ladder, trend: true, trendLtvCap: null },
  'Filter + cap 40 %': { ladder, trend: true, trendLtvCap: 0.4 },
  'Filter + cap 50 % (default)': { ladder, trend: true, trendLtvCap: 0.5 },
  'Repay-only': { ladder, mode: 'repay-only', trend: true, trendLtvCap: 0.5 },
}

function fmt(r: ReturnType<typeof simulate>): string {
  if (r.liquidated) return 'LIQ'
  return `${(r.equity / 1000).toFixed(0)}k / DD ${r.maxDrawdownPct}%${r.exited ? ' / EXIT' : ''} / minH ${r.minHealth}`
}

if (process.argv.includes('--rolling')) {
  const live = DATA.filter((d) => d.t >= '2020-10-21')
  const rows: { start: string; mult: number; loop: number; hold: number; liq: boolean; dd: number }[] = []
  for (let i = 60; i + 365 <= live.length; i += 1) {
    const from = live[i].t
    const to = live[i + 364].t
    const w = rescale(windowWithWarmup(DATA, from, to), NOW)
    const first = w.find((d) => !d.warm)!
    const last = w[w.length - 1]
    const r = simulate(w, { ladder, trend: true, trendLtvCap: 0.5, inj: startInj, debt: startDebt })
    const h = holdResult(w, startInj, startDebt)
    rows.push({ start: from, mult: last.c / first.c, loop: r.equity, hold: h.equity, liq: r.liquidated, dd: r.maxDrawdownPct })
  }
  const startEq = startInj * NOW - startDebt
  const m = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
  const med = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
  const mults = rows.map((r) => r.loop / startEq)
  const holdM = rows.map((r) => r.hold / startEq)
  console.log(`Rolling 12-month windows: ${rows.length} (start equity ${startEq.toFixed(0)} $ at INJ ${NOW.toFixed(2)} $)`)
  console.log(`Loop  mean ${m(mults).toFixed(2)}x  median ${med(mults).toFixed(2)}x  liquidations ${rows.filter((r) => r.liq).length}  total loss (<20 % left) ${(rows.filter((r) => r.loop < 0.2 * startEq).length / rows.length * 100).toFixed(0)} %`)
  console.log(`Hold  mean ${m(holdM).toFixed(2)}x  median ${med(holdM).toFixed(2)}x   (same equity held in INJ without leverage)`)
  console.log(`Loop beats unleveraged hold in ${(rows.filter((r) => r.loop > r.hold).length / rows.length * 100).toFixed(0)} % of windows`)
  const modest = rows.filter((r) => r.mult >= 1.3 && r.mult < 3)
  console.log(`Modest-bull windows (INJ 1.3x..3x): ${modest.length} -> loop mean ${modest.length ? m(modest.map((r) => r.loop / startEq)).toFixed(2) : '-'}x, median ${modest.length ? med(modest.map((r) => r.loop / startEq)).toFixed(2) : '-'}x, share below 1x ${modest.length ? (modest.filter((r) => r.loop < startEq).length / modest.length * 100).toFixed(0) : '-'} %`)
  const bear = rows.filter((r) => r.mult < 1)
  console.log(`Down windows (INJ < 1x): ${bear.length} -> loop median ${bear.length ? med(bear.map((r) => r.loop / startEq)).toFixed(2) : '-'}x, hold median ${bear.length ? med(bear.map((r) => r.hold / startEq)).toFixed(2) : '-'}x`)
  const bull = rows.filter((r) => r.mult >= 3)
  console.log(`Bull windows (INJ >= 3x): ${bull.length} -> loop mean ${bull.length ? m(bull.map((r) => r.loop / startEq)).toFixed(2) : '-'}x, median ${bull.length ? med(bull.map((r) => r.loop / startEq)).toFixed(2) : '-'}x`)
  console.log('\nCAVEAT: consecutive windows overlap by 364 of 365 days. Independent observations ~5, independent bull runs: 1 (2022/23).')
} else {
  const rows: Record<string, string>[] = []
  for (const [name, from, to] of WINDOWS) {
    const w = rescale(windowWithWarmup(DATA, from, to), NOW)
    if (!w.length) continue
    const first = w.find((d) => !d.warm)!
    const row: Record<string, string> = { window: name, 'INJ x': (w[w.length - 1].c / first.c).toFixed(1) }
    for (const [vn, opt] of Object.entries(VARIANTS)) {
      if (!opt) {
        const h = holdResult(w, startInj, startDebt)
        row[vn] = `${(h.equity / 1000).toFixed(0)}k / DD ${h.maxDrawdownPct}%`
      } else row[vn] = fmt(simulate(w, { ...opt, inj: startInj, debt: startDebt }))
    }
    rows.push(row)
  }
  console.log(`Start: ${startInj} INJ collateral, ${startDebt} $ debt, windows rescaled to INJ = ${NOW.toFixed(2)} $ (last data point ${DATA[DATA.length - 1].t}). APR 16 %, 1 % trade cost.`)
  console.table(rows)
  console.log('Read docs/STRATEGY.md before you trust any of this.')
}
