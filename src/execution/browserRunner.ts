/**
 * Browser autopilot runner: one tick per interval while the tab is open, single-tab guarantee via
 * the Web Locks API, state and log in localStorage, alerts via the Notification API and an
 * optional webhook (ntfy-compatible: POST body + Title header).
 */
import type { LcdClient } from '../chain/lcd'
import { getTrend } from '../market/trend'
import type { StrategyConfig } from '../strategy/types'
import { AlertThrottle, DEFAULT_ALERT_INTERVALS, newTickState, runTick, type Alert, type AutopilotConfig, type TickResult, type TickState } from './autopilot'
import { PriceHistory, priceMinutesAgo } from './guards'
import type { ExecLogEntry } from './types'
import type { Signer } from './signer'

export interface RunnerLogEntry {
  ts: string
  kind: 'tick' | 'step' | 'alert' | 'error' | 'info'
  text: string
  txHash?: string
  action?: string
}

export interface PersistedRunnerState {
  lastBuyAtMs: number | null
  continueDown: boolean
  paramChangeLockUntilMs: number | null
  lastFingerprint: string | null
  log: RunnerLogEntry[]
}

export interface RunnerOptions {
  lcd: LcdClient
  owner: string
  intervalMs: number
  getStrategy: () => StrategyConfig
  getAutopilot: () => AutopilotConfig
  getPaused: () => boolean
  /** Creates the signer when the first transaction is due (Keplr popup or session key). */
  getSigner: () => Promise<Signer>
  webhookUrl?: () => string | undefined
  browserNotifications?: () => boolean
  onChange?: () => void
}

const STATE_KEY = (owner: string) => `nlc.autopilot.state.v1:${owner}`
const MAX_LOG = 300

export function loadRunnerState(owner: string): PersistedRunnerState {
  try {
    const raw = localStorage.getItem(STATE_KEY(owner))
    if (raw) return { log: [], lastBuyAtMs: null, continueDown: false, paramChangeLockUntilMs: null, lastFingerprint: null, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { lastBuyAtMs: null, continueDown: false, paramChangeLockUntilMs: null, lastFingerprint: null, log: [] }
}
function saveRunnerState(owner: string, s: PersistedRunnerState) {
  try {
    localStorage.setItem(STATE_KEY(owner), JSON.stringify({ ...s, log: s.log.slice(-MAX_LOG) }))
  } catch {
    /* ignore */
  }
}

export class BrowserRunner {
  running = false
  ticking = false
  lastTick: TickResult | null = null
  lastError: string | null = null
  nextTickAt: number | null = null
  readonly persisted: PersistedRunnerState
  private tickState: TickState
  private timer: ReturnType<typeof setTimeout> | null = null
  private lockRelease: (() => void) | null = null
  private throttle = new AlertThrottle(DEFAULT_ALERT_INTERVALS)
  private lastFingerprintAt = 0
  private fingerprint: string | null = null
  private stopRequested = false
  private portsModule: typeof import('./sdk') | null = null

  constructor(private readonly opts: RunnerOptions) {
    this.persisted = loadRunnerState(opts.owner)
    this.tickState = { ...newTickState(), lastBuyAtMs: this.persisted.lastBuyAtMs, continueDown: this.persisted.continueDown, paramChangeLockUntilMs: this.persisted.paramChangeLockUntilMs, lastFingerprint: this.persisted.lastFingerprint, prices: new PriceHistory() }
  }

  get log(): RunnerLogEntry[] {
    return this.persisted.log
  }

  private push(e: Omit<RunnerLogEntry, 'ts'>) {
    this.persisted.log.push({ ts: new Date().toISOString(), ...e })
    if (this.persisted.log.length > MAX_LOG) this.persisted.log.splice(0, this.persisted.log.length - MAX_LOG)
    saveRunnerState(this.opts.owner, this.persisted)
    this.opts.onChange?.()
  }

  /** Acquire the per-owner lock (another tab running = refuse), then schedule ticks. */
  async start(): Promise<void> {
    if (this.running) return
    this.stopRequested = false
    const name = `nlc-autopilot-${this.opts.owner}`
    if (typeof navigator !== 'undefined' && navigator.locks) {
      const acquired = await new Promise<boolean>((resolve) => {
        void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false)
            return
          }
          resolve(true)
          return new Promise<void>((release) => {
            this.lockRelease = release
          })
        })
      })
      if (!acquired) throw new Error('The autopilot is already running for this address in another tab. Only one tab may run it.')
    }
    this.running = true
    this.push({ kind: 'info', text: 'autopilot runner started' })
    this.schedule(500)
  }

  stop(): void {
    this.stopRequested = true
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.nextTickAt = null
    if (this.lockRelease) {
      this.lockRelease()
      this.lockRelease = null
    }
    this.push({ kind: 'info', text: 'autopilot runner stopped' })
  }

  private schedule(ms: number) {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.nextTickAt = Date.now() + ms
    this.timer = setTimeout(() => void this.tick(), ms)
    this.opts.onChange?.()
  }

  /** Run one tick now (also used by the "Tick now" button). */
  async tick(): Promise<TickResult | null> {
    if (this.ticking) return null
    this.ticking = true
    this.opts.onChange?.()
    const autopilot = this.opts.getAutopilot()
    try {
      const sdk = (this.portsModule ??= await import('./sdk'))
      const strategy = this.opts.getStrategy()
      const now = Date.now()
      if (now - this.lastFingerprintAt > 10 * 60_000) {
        this.fingerprint = await sdk.protocolFingerprint(this.opts.lcd)
        this.lastFingerprintAt = now
      }
      const [trend, priceThen] = await Promise.all([
        getTrend({ smaDays: strategy.trendFilter.smaDays, panicPct: strategy.trendFilter.panicPct }),
        priceMinutesAgo(autopilot.buyHoldMin).catch(() => null),
      ])
      // The signer is created lazily: in Keplr mode this is where the extension gets involved; the
      // read-only parts of the tick never need it. We wrap it so a tick that ends in "none" never
      // touches the wallet at all.
      let signer: Signer | null = null
      const lazySigner = async () => (signer ??= await this.opts.getSigner())
      const ports = sdk.createChainPorts({
        lcd: this.opts.lcd,
        signer: {
          ownerAddress: this.opts.owner,
          signerAddress: this.opts.owner,
          send: async (msgs, label) => (await lazySigner()).send(msgs, label),
        },
        shouldStop: () => this.stopRequested || this.opts.getPaused(),
        log: (e: ExecLogEntry) => this.push({ kind: 'step', text: `${e.step}: ${e.info}`, txHash: e.txHash }),
      })
      const result = await runTick({ ports, strategy, autopilot, state: this.tickState, paused: this.opts.getPaused(), trend, priceThen, fingerprint: this.fingerprint })
      this.lastTick = result
      this.lastError = null
      this.persisted.lastBuyAtMs = this.tickState.lastBuyAtMs
      this.persisted.continueDown = this.tickState.continueDown
      this.persisted.paramChangeLockUntilMs = this.tickState.paramChangeLockUntilMs
      this.persisted.lastFingerprint = this.tickState.lastFingerprint
      this.push({ kind: 'tick', action: result.decision.action, text: `${result.decision.action.toUpperCase()} · ${result.decision.reason.slice(0, 200)} · health ${result.status.health.toFixed(3)} LTV ${(result.status.ltv * 100).toFixed(1)} %${result.execStatus ? ` · ${result.execStatus}` : ''}` })
      for (const a of result.alerts) if (this.throttle.allow(a.key, Date.now())) void this.emitAlert(a)
      return result
    } catch (e) {
      this.lastError = String((e as Error)?.message ?? e)
      this.push({ kind: 'error', text: this.lastError })
      if (this.throttle.allow('monitor-error', Date.now())) void this.emitAlert({ key: 'monitor-error', level: 'warn', title: 'Autopilot tick failed', body: this.lastError })
      return null
    } finally {
      this.ticking = false
      // after an execution, look again soon (the next round may be due); otherwise wait the full interval
      const soon = this.lastTick?.executed && this.lastTick.execStatus === 'deferred'
      this.schedule(soon ? Math.min(this.opts.intervalMs, 20_000) : this.opts.intervalMs)
    }
  }

  private async emitAlert(a: Alert) {
    this.push({ kind: 'alert', text: `[${a.level}] ${a.title}: ${a.body.split('\n')[0]}` })
    if (this.opts.browserNotifications?.() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(a.title, { body: a.body.slice(0, 200) })
      } catch {
        /* ignore */
      }
    }
    const url = this.opts.webhookUrl?.()
    if (url && /^https?:\/\//.test(url)) {
      try {
        await fetch(url, { method: 'POST', headers: { Title: a.title.replace(/[^\x20-\x7e]/g, ''), Priority: a.level === 'urgent' ? 'urgent' : a.level === 'warn' ? 'high' : 'default' }, body: a.body, signal: AbortSignal.timeout(8000) })
      } catch {
        this.push({ kind: 'error', text: 'webhook alert failed' })
      }
    }
  }
}
