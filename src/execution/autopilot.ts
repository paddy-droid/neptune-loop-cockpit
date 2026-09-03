/**
 * One autopilot tick: read -> decide -> guard -> execute -> report.
 *
 * Runtime-agnostic: the browser runner and the Node runner both call `runTick()` with their own
 * ports, persistence and alert sinks. The tick itself is stateless apart from the small
 * `TickState` the caller keeps (last buy time, continue-down flag, param-change lock, price samples).
 */
import type { Status } from '../chain/neptune'
import type { Trend } from '../market/trend'
import { decide, type Decision } from '../strategy/policy'
import type { StrategyConfig } from '../strategy/types'
import { buyCooldownGuard, buyHoldGuard, PriceHistory } from './guards'
import { depositOrphanInj, executeLoop } from './engine'
import { DEFAULT_EXECUTION, type ExecLogEntry, type ExecPorts, type ExecutionConfig } from './types'

export interface AutopilotConfig {
  /** Master switch. */
  enabled: boolean
  /** Slippage tolerance for market orders, percent (1.0). */
  slippagePct: number
  /** Warn when wallet USDC reserve is below this (300). */
  reserveMinUsd: number
  /** Health thresholds for alerts. */
  healthWarn: number
  healthCrit: number
  /** Minutes the add threshold must hold (15) and cooldown between buys (30). */
  buyHoldMin: number
  buyCooldownMin: number
}

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  enabled: false,
  slippagePct: 1.0,
  reserveMinUsd: 300,
  healthWarn: 1.3,
  healthCrit: 1.15,
  buyHoldMin: 15,
  buyCooldownMin: 30,
}

export interface TickState {
  lastBuyAtMs: number | null
  /** Set when a reduce run was deferred; the next tick continues even if the LTV dropped below the trigger. */
  continueDown: boolean
  /** Adding is blocked until this time after a detected protocol parameter change. */
  paramChangeLockUntilMs: number | null
  lastFingerprint: string | null
  prices: PriceHistory
}

export function newTickState(): TickState {
  return { lastBuyAtMs: null, continueDown: false, paramChangeLockUntilMs: null, lastFingerprint: null, prices: new PriceHistory() }
}

export type AlertLevel = 'info' | 'warn' | 'urgent'
export interface Alert {
  key: string
  level: AlertLevel
  title: string
  body: string
}

export interface TickInputs {
  ports: ExecPorts
  strategy: StrategyConfig
  autopilot: AutopilotConfig
  execution?: ExecutionConfig
  state: TickState
  /** Paused by the user: no adding, no cleanup; reduce/exit still run (but do not touch wallet funds). */
  paused: boolean
  trend: Trend | null
  /** Optional: price ~holdMin minutes ago from 1-minute candles (null -> fall back to recorded samples). */
  priceThen?: number | null
  /** Optional protocol fingerprint (code ids + params) to detect governance changes. */
  fingerprint?: string | null
}

export interface TickResult {
  status: Status
  decision: Decision
  executed: boolean
  execStatus: 'done' | 'deferred' | 'failed' | null
  log: ExecLogEntry[]
  alerts: Alert[]
  durationMs: number
}

const statusLine = (s: Status) => `health ${s.health.toFixed(3)} | INJ $${s.injPrice.toFixed(3)} | liq $${s.liqPrice.toFixed(3)} | debt $${s.debtUsd.toFixed(0)} | LTV ${(s.ltv * 100).toFixed(1)} %`

export async function runTick(inp: TickInputs): Promise<TickResult> {
  const { ports, strategy, autopilot, state } = inp
  const exec = inp.execution ?? DEFAULT_EXECUTION
  const t0 = ports.now()
  const alerts: Alert[] = []
  const alert = (key: string, level: AlertLevel, title: string, body: string) => alerts.push({ key, level, title, body })
  let log: ExecLogEntry[] = []

  let s = await ports.status()
  state.prices.record(t0, s.injPrice)
  const d = decide(s, inp.trend, strategy, t0)

  if (s.address !== ports.address) {
    alert('addr-mismatch', 'urgent', 'ADDRESS MISMATCH - stopped', `status ${s.address} vs signer ${ports.address}`)
    return { status: s, decision: d, executed: false, execStatus: null, log, alerts, durationMs: ports.now() - t0 }
  }
  if (d.dataError) alert('dataerror', 'urgent', d.action === 'none' ? 'DATA ERROR - no action' : 'DATA ERROR - protective repay on exchange price', `${d.dataError}\n${d.reason}\n${statusLine(s)}`)
  if (d.warn === 'oracle-gap') alert('oracle-gap', 'warn', 'Oracle > 15 % above the exchange', `${d.reason}\n${statusLine(s)}`)
  if (d.warn === 'usdt') alert('usdt', 'urgent', 'Cannot repay - debt is not USDC', `${d.reason}\n${statusLine(s)}`)
  if (d.rung.exit && d.action === 'none' && /Exit waits/.test(d.reason)) alert('exit-wait', 'urgent', 'EXIT waits for confirmation', `${d.reason}\n${statusLine(s)}`)
  if (s.debtUsd > 100 && s.equityUsd < 1500) alert('equity-low', 'urgent', 'Equity below $1,500', `Neptune liquidates accounts below ~$1,000 net collateral COMPLETELY. Consider closing the loop.\n${statusLine(s)}`)
  if (Math.abs(s.injLiqLtv - 0.8) > 0.005) alert('liqltv', 'urgent', 'Neptune parameter changed', `INJ liquidation LTV is now ${s.injLiqLtv} (base 0.80) - thresholds scaled, adding blocked. Review the ladder!`)

  // Continue a deferred reduce even if the LTV is now just below the trigger (but still well above the target).
  if (d.action === 'none' && !d.dataError && d.mode !== 'off' && state.continueDown && s.ltv > d.effective.repayTargetLtv + 0.03) {
    d.action = 'down'
    d.targetLtv = d.effective.repayTargetLtv
    d.reason = `continuing the deferred reduce: LTV ${(s.ltv * 100).toFixed(1)} % > target ${(d.effective.repayTargetLtv * 100).toFixed(0)} % + 3`
  }

  // Protocol fingerprint: a change means governance migrated or reparametrised something -> block adding for 24 h.
  if (inp.fingerprint) {
    if (state.lastFingerprint && state.lastFingerprint !== inp.fingerprint) {
      state.paramChangeLockUntilMs = t0 + 86_400_000
      alert('fingerprint', 'urgent', 'Neptune changed (code/parameters)', `The contract fingerprint changed - adding leverage is blocked for 24 h. Check Neptune announcements.\n${statusLine(s)}`)
    }
    state.lastFingerprint = inp.fingerprint
  }
  if (d.action === 'up' && state.paramChangeLockUntilMs && t0 < state.paramChangeLockUntilMs) {
    d.action = 'none'
    d.reason = `adding blocked: Neptune parameters/code changed recently (24 h) | ${d.reason}`
  }

  if (inp.paused && d.action === 'up') {
    d.action = 'none'
    d.reason = `PAUSED | adding suspended: ${d.reason}`
  }
  const injCollNow = s.collateral.find((c) => c.symbol === 'INJ')?.amount ?? 0
  if (inp.paused && d.action === 'exit' && s.debtUsd <= 1 && injCollNow <= 1.25) {
    d.action = 'none'
    d.reason = 'exit done - remaining wallet INJ stay put (paused)'
  }

  if (d.action === 'up') {
    const cd = buyCooldownGuard(state.lastBuyAtMs, t0, autopilot.buyCooldownMin)
    if (!cd.ok) {
      d.action = 'none'
      d.reason = cd.reason
    } else {
      const priceThen = inp.priceThen ?? state.prices.priceBefore(t0, autopilot.buyHoldMin)
      const hold = buyHoldGuard(s.ltv, d.rung.buyTriggerLtv ?? 1, s.injPrice, priceThen, autopilot.buyHoldMin)
      if (!hold.ok) {
        d.action = 'none'
        d.reason = hold.reason
      }
    }
  }
  if (!autopilot.enabled && d.action !== 'none') {
    d.reason = `autopilot disabled - would ${d.action}: ${d.reason}`
    d.action = 'none'
  }

  // Idle cleanup: orphaned wallet INJ back into collateral.
  const walletInj = s.bank.find((b) => b.symbol === 'INJ')?.amount ?? 0
  if (autopilot.enabled && d.action === 'none' && d.mode !== 'off' && !inp.paused && !d.dataError && walletInj > 2.0) {
    try {
      const r = await depositOrphanInj(ports, exec)
      if (r.deposited > 0) {
        log = r.log
        alert('cleanup-ok', 'info', 'Autopilot: cleaned up', r.log.map((e) => e.info).join('\n'))
        s = await ports.status()
      }
    } catch (e) {
      alert('cleanup-fail', 'warn', 'Cleanup failed', String(e).slice(0, 200))
    }
  }

  let executed = false
  let execStatus: TickResult['execStatus'] = null
  if (d.action !== 'none') {
    alert(`start-${d.action}`, 'info', 'Autopilot starts', d.reason)
    const marketOk = d.action === 'up' ? true : await ports.spotMarketActive('INJ/USDC')
    const walletOnly = d.action !== 'up' && (s.oracleAgeSec > 3000 || !marketOk)
    if (walletOnly) alert('wallet-only', 'urgent', 'Only wallet USDC can repay', `${!marketOk ? 'Helix INJ/USDC is not active' : `oracle ${Math.round(s.oracleAgeSec / 60)} min old (contract limit 60)`} - no withdraw/sale possible. Put USDC into the wallet.\n${statusLine(s)}`)
    const common = { walletOnly, slippagePct: autopilot.slippagePct, noWalletInj: inp.paused, noWalletUsdc: inp.paused, startedAt: t0, refPrice: d.refPrice }
    const res = await executeLoop(
      d.action === 'exit' ? { mode: 'emergency', sellAllInj: true, keepInj: 1, ...common } : { mode: d.action, targetLtv: d.targetLtv, ...common },
      ports,
      exec,
    )
    log = [...log, ...res.log]
    executed = true
    execStatus = res.done ? 'done' : res.deferred ? 'deferred' : 'failed'
    state.continueDown = d.action === 'down' && !!res.deferred
    if (d.action === 'up' && res.log.some((e) => /buy$/.test(e.step) && e.txHash)) state.lastBuyAtMs = t0
    s = await ports.status()
    const lastInfo = res.log[res.log.length - 1]?.info ?? ''
    if (res.done) alert('done', 'info', 'Autopilot done', `${lastInfo}\n${statusLine(s)}`)
    else if (res.deferred) alert('deferred', 'info', 'Autopilot: deferred', `${lastInfo}\n${statusLine(s)}`)
    else alert('aborted', 'urgent', 'Autopilot ABORTED', `${lastInfo}\n${statusLine(s)}`)
  } else {
    state.continueDown = false
  }

  const walletUsdc = s.bank.find((b) => b.symbol === 'USDC')?.amount ?? 0
  const walletInjNow = s.bank.find((b) => b.symbol === 'INJ')?.amount ?? 0
  if (walletInjNow < 0.4) alert('gas', 'warn', 'Gas reserve low', `wallet ${walletInjNow.toFixed(3)} INJ (< 0.4) - without gas there is no auto-repay. Top up INJ.`)
  if (s.debtUsd > 100 && walletUsdc < autopilot.reserveMinUsd) alert('reserve', 'info', 'USDC reserve missing', `wallet ${walletUsdc.toFixed(0)} USDC (< ${autopilot.reserveMinUsd}). Reserve-first repayment has nothing to repay with; INJ would be sold at the low.`)
  if (!Number.isFinite(s.health) || (s.debtUsd > 1 && s.health < autopilot.healthCrit)) alert('crit', 'urgent', 'Neptune CRITICAL - liquidation risk', `${statusLine(s)}\n${d.reason}`)
  else if (s.debtUsd > 1 && s.health < autopilot.healthWarn && d.action === 'none') alert('warn', 'warn', 'Neptune warning - health low', statusLine(s))

  return { status: s, decision: d, executed, execStatus, log, alerts, durationMs: ports.now() - t0 }
}

/** Throttle helper for alert sinks: returns true when `key` may fire again (per-key interval in seconds). */
export class AlertThrottle {
  private last = new Map<string, number>()
  constructor(private readonly intervals: Record<string, number>, private readonly defaultSec = 900) {}
  allow(key: string, nowMs: number): boolean {
    const base = key.replace(/^start-.*/, 'start')
    const iv = (this.intervals[key] ?? this.intervals[base] ?? this.defaultSec) * 1000
    const prev = this.last.get(key) ?? 0
    if (nowMs - prev < iv) return false
    this.last.set(key, nowMs)
    return true
  }
}

export const DEFAULT_ALERT_INTERVALS: Record<string, number> = {
  crit: 300,
  warn: 3600,
  dataerror: 900,
  'oracle-gap': 3600,
  usdt: 3600,
  'exit-wait': 1800,
  'equity-low': 21600,
  liqltv: 3600,
  fingerprint: 21600,
  start: 1800,
  done: 600,
  deferred: 1800,
  aborted: 900,
  'wallet-only': 900,
  gas: 3600,
  reserve: 21600,
  'cleanup-ok': 3600,
  'cleanup-fail': 900,
  'addr-mismatch': 3600,
}
