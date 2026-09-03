/**
 * Command-line status: the same numbers the web cockpit shows, for any address.
 *
 *   npm run status -- inj1yourAddress...
 *   npm run status -- inj1yourAddress... --json
 *
 * Read-only. Needs Node >= 20 (global fetch).
 */
import { LcdClient } from '../src/chain/lcd'
import { getStatus } from '../src/chain/neptune'
import { DEFAULT_LCD_HOSTS, isInjAddress } from '../src/config/chain'
import { getTrend } from '../src/market/trend'
import { buildPlan, computeTriggers } from '../src/strategy/planner'
import { decide } from '../src/strategy/policy'
import { DEFAULT_STRATEGY } from '../src/strategy/types'

const args = process.argv.slice(2)
const address = args.find((a) => a.startsWith('inj1'))
const asJson = args.includes('--json')
if (!address || !isInjAddress(address)) {
  console.error('usage: npm run status -- inj1<address> [--json]')
  process.exit(2)
}

const cfg = DEFAULT_STRATEGY
const lcd = new LcdClient({ hosts: DEFAULT_LCD_HOSTS })
const [status, trend] = await Promise.all([getStatus(lcd, address), getTrend({ smaDays: cfg.trendFilter.smaDays, panicPct: cfg.trendFilter.panicPct })])
const decision = decide(status, trend, cfg)
const plan = buildPlan(status, decision, cfg)
const triggers = computeTriggers(status, decision, cfg)

if (asJson) {
  console.log(JSON.stringify({ status, trend, decision, plan, triggers }, (_k, v) => (v === Infinity ? 'Infinity' : v), 2))
} else {
  const pct = (v: number) => `${(v * 100).toFixed(1)} %`
  console.log(`Address     ${address}  (LCD ${lcd.lastHost})`)
  console.log(`INJ oracle  $${status.injPrice.toFixed(3)}  (${Math.round(status.oracleAgeSec)} s old)   exchange $${trend ? trend.lastClose.toFixed(3) : 'n/a'}  SMA${cfg.trendFilter.smaDays} $${trend ? trend.sma.toFixed(3) : 'n/a'}`)
  console.log(`Collateral  $${status.collateralUsd.toFixed(0)}   Debt $${status.debtUsd.toFixed(0)}   Equity $${status.equityUsd.toFixed(0)}`)
  console.log(`LTV ${pct(status.ltv)}   Health ${status.debtUsd < 1 ? 'inf' : status.health.toFixed(3)}   Liquidation $${status.liqPrice.toFixed(3)}`)
  console.log(`Rung "${decision.rung.label}"   effective reduce > ${pct(decision.effective.repayTriggerLtv)} -> ${pct(decision.effective.repayTargetLtv)}   add < ${decision.effective.buyTriggerLtv ? pct(decision.effective.buyTriggerLtv) + ' -> ' + pct(decision.effective.buyLtv ?? 0) : 'paused'}`)
  console.log(`Trend       ${decision.trend.active ? 'ACTIVE' : 'inactive'} - ${decision.trend.why}${decision.trend.buyBlocked ? `   (no adding: ${decision.trend.noBuyWhy})` : ''}`)
  console.log(`Rates       ${decision.rate.why}   pool ${status.usdcUtilization ? pct(status.usdcUtilization) : 'n/a'} utilised, $${status.usdcPoolFreeUsd.toFixed(0)} free`)
  console.log(`\n>>> ${plan.headline}`)
  console.log(`    ${plan.summary}`)
  plan.steps.forEach((s, i) => console.log(`    ${i + 1}. ${s.title}\n       ${s.detail}`))
  plan.warnings.forEach((w) => console.log(`    ! ${w}`))
  console.log(`\nNext: reduce at $${triggers.repayAtPrice?.toFixed(2) ?? '-'}, add at $${triggers.buyAtPrice?.toFixed(2) ?? '-'}, next rung at $${triggers.nextRungPrice ?? '-'}, liquidation at $${triggers.liqPrice.toFixed(2)}`)
}
