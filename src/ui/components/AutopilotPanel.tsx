import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LcdClient } from '../../chain/lcd'
import { LINKS } from '../../config/chain'
import { BrowserRunner, type RunnerLogEntry } from '../../execution/browserRunner'
import type { GrantStatus, StoredSession } from '../../execution/session'
import type { StrategyConfig } from '../../strategy/types'
import type { WalletKind } from '../../wallet/keplr'
import { isPaused, loadPause, loadSettings, savePause, saveSettings, type AutopilotSettings, type PauseState } from '../autopilotStore'
import { fmtAge, shortAddr } from '../format'

type Sdk = typeof import('../../execution/sdk')
const loadSdk = (): Promise<Sdk> => import('../../execution/sdk')

const runners = new Map<string, BrowserRunner>()

export function AutopilotPanel({ owner, walletKind, lcdHosts, strategy }: { owner: string; walletKind: WalletKind; lcdHosts: string[]; strategy: StrategyConfig }) {
  const [settings, setSettingsState] = useState<AutopilotSettings>(() => loadSettings(owner))
  const [pause, setPauseState] = useState<PauseState>(() => loadPause(owner))
  const [session, setSession] = useState<StoredSession | null>(null)
  const [grants, setGrants] = useState<GrantStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'muted'; text: string } | null>(null)
  const [exportedKey, setExportedKey] = useState<string | null>(null)
  const [externalAddr, setExternalAddr] = useState('')
  const [, force] = useState(0)
  const rerender = useCallback(() => force((n) => n + 1), [])
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const pauseRef = useRef(pause)
  pauseRef.current = pause
  const strategyRef = useRef(strategy)
  strategyRef.current = strategy
  const lcd = useMemo(() => new LcdClient({ hosts: lcdHosts }), [lcdHosts])
  const runner = runners.get(owner) ?? null

  const setSettings = (patch: Partial<AutopilotSettings> | ((s: AutopilotSettings) => AutopilotSettings)) => {
    setSettingsState((prev) => {
      const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch }
      saveSettings(owner, next)
      return next
    })
  }
  const setPause = (p: PauseState) => {
    savePause(owner, p)
    setPauseState(p)
  }

  // Load the stored session key and its grants once.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const sdk = await loadSdk()
      const s = sdk.loadStoredSession()
      if (cancelled) return
      if (s && s.owner === owner) {
        setSession(s)
        setGrants(await sdk.fetchGrantStatus(lcd, owner, s.address))
      } else setSession(null)
    })()
    return () => {
      cancelled = true
    }
  }, [owner, lcd])

  // Tick the countdown display.
  useEffect(() => {
    const id = setInterval(rerender, 1000)
    return () => clearInterval(id)
  }, [rerender])

  const refreshGrants = async (addr = session?.address) => {
    if (!addr) return
    const sdk = await loadSdk()
    setGrants(await sdk.fetchGrantStatus(lcd, owner, addr))
  }

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label)
    setMsg(null)
    try {
      const t = await fn()
      if (t) setMsg({ tone: 'ok', text: t })
    } catch (e) {
      setMsg({ tone: 'error', text: String((e as Error)?.message ?? e).slice(0, 300) })
    } finally {
      setBusy(null)
    }
  }

  const createSession = () =>
    run('create', async () => {
      const sdk = await loadSdk()
      const k = sdk.generateSessionKey()
      const s: StoredSession = { privateKeyHex: k.privateKeyHex, address: k.address, owner, createdAt: new Date().toISOString() }
      sdk.storeSession(s, settings.persistSession)
      setSession(s)
      setGrants(await sdk.fetchGrantStatus(lcd, owner, s.address))
      return `session key created: ${k.address}. Now grant it permissions.`
    })
  const useExternal = () =>
    run('external', async () => {
      const addr = externalAddr.trim()
      if (!/^inj1[02-9ac-hj-np-z]{38}$/.test(addr)) throw new Error('not a valid inj1 address')
      const sdk = await loadSdk()
      const s: StoredSession = { privateKeyHex: '', address: addr, owner, createdAt: new Date().toISOString() }
      sdk.storeSession(s, true)
      setSession(s)
      setGrants(await sdk.fetchGrantStatus(lcd, owner, addr))
      return 'external session address set. Grant it permissions, then run the headless runner with its key file.'
    })
  const grant = (days: number) =>
    run('grant', async () => {
      if (!session) throw new Error('no session')
      const sdk = await loadSdk()
      const msgs = sdk.buildGrantMsgs({ owner, grantee: session.address, expirySeconds: days * 86400, maxCalls: 1000, gasAllowanceInj: 0.5 })
      const r = await sdk.signWithWallet(walletKind, owner, msgs)
      await new Promise((res) => setTimeout(res, 2500))
      await refreshGrants()
      return `grants created for ${days} day${days > 1 ? 's' : ''} (tx ${r.txHash.slice(0, 12)}…)`
    })
  const revoke = () =>
    run('revoke', async () => {
      if (!session) throw new Error('no session')
      const sdk = await loadSdk()
      const r = await sdk.signWithWallet(walletKind, owner, sdk.buildRevokeMsgs(owner, session.address))
      await new Promise((res) => setTimeout(res, 2500))
      await refreshGrants()
      return `grants revoked (tx ${r.txHash.slice(0, 12)}…)`
    })
  const forgetSession = () =>
    run('forget', async () => {
      const sdk = await loadSdk()
      sdk.clearStoredSession()
      setSession(null)
      setGrants(null)
      setExportedKey(null)
      return 'session key removed from this browser. Revoke its grants on-chain if you have not already.'
    })

  const getSigner = useCallback(async () => {
    const sdk = await loadSdk()
    const s = settingsRef.current
    if (s.signing === 'session') {
      const stored = sdk.loadStoredSession()
      if (!stored || stored.owner !== owner || !stored.privateKeyHex) throw new Error('session mode needs a session key stored in this browser')
      const g = await sdk.fetchGrantStatus(lcd, owner, stored.address)
      if (!g.complete) throw new Error('session grants incomplete or expired - grant again')
      return sdk.makeSessionSigner(lcd, owner, stored.privateKeyHex)
    }
    return sdk.makeWalletSigner(lcd, walletKind, owner)
  }, [owner, walletKind, lcd])

  const start = () =>
    run('start', async () => {
      if (!settings.acknowledged) throw new Error('read and tick the acknowledgement first')
      if (settings.signing === 'session') {
        if (!session?.privateKeyHex) throw new Error('session mode needs a session key created in this browser (or switch to "confirm each transaction")')
        const sdk = await loadSdk()
        const g = await sdk.fetchGrantStatus(lcd, owner, session.address)
        setGrants(g)
        if (!g.complete) throw new Error('session grants incomplete or expired - grant first')
      }
      if (settings.browserNotifications && typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission()
      let r = runners.get(owner)
      if (!r) {
        r = new BrowserRunner({
          lcd,
          owner,
          intervalMs: Math.max(20, settings.intervalSec) * 1000,
          getStrategy: () => strategyRef.current,
          getAutopilot: () => ({ ...settingsRef.current.config, enabled: true }),
          getPaused: () => isPaused(pauseRef.current),
          getSigner,
          webhookUrl: () => settingsRef.current.webhookUrl,
          browserNotifications: () => settingsRef.current.browserNotifications,
          onChange: rerender,
        })
        runners.set(owner, r)
      }
      await r.start()
      setSettings({ config: { ...settings.config, enabled: true } })
      return 'autopilot running in this tab'
    })
  const stop = (reason = 'stopped by user') =>
    run('stop', async () => {
      runners.get(owner)?.stop()
      runners.delete(owner)
      setSettings({ config: { ...settings.config, enabled: false } })
      return reason
    })
  const running = !!runner?.running
  const paused = isPaused(pause)
  const nextIn = runner?.nextTickAt ? Math.max(0, Math.round((runner.nextTickAt - Date.now()) / 1000)) : null
  const log: RunnerLogEntry[] = runner ? [...runner.log].reverse().slice(0, 40) : []
  const sessionExternal = !!session && !session.privateKeyHex

  return (
    <section className="card span2 autopilot">
      <div className="decision-head">
        <h2>Autopilot</h2>
        <span className={`pill ${running ? (paused ? 'warn' : 'ok') : 'neutral'}`}>{running ? (paused ? 'RUNNING · PAUSED' : 'RUNNING') : 'OFF'}</span>
        {running && nextIn !== null && <span className="muted small">{runner?.ticking ? 'tick in progress…' : `next tick in ${nextIn} s`}</span>}
      </div>
      <p className="muted small">
        When enabled, this tab runs the strategy every {settings.intervalSec} s and executes reduce / add / exit steps for <span className="mono">{shortAddr(owner)}</span>. It only works while this tab is open; for 24/7 operation use the headless runner with a session key (see <a href="https://github.com/paddy-droid/neptune-loop-cockpit/blob/main/docs/AUTOPILOT.md" target="_blank" rel="noreferrer">docs/AUTOPILOT.md</a>).
      </p>

      <div className="ap-grid">
        <div className="ap-col">
          <label className="label">Signing</label>
          <label className="radio"><input type="radio" checked={settings.signing === 'confirm'} disabled={running} onChange={() => setSettings({ signing: 'confirm' })} /> Confirm each transaction in {walletKind === 'leap' ? 'Leap' : 'Keplr'} (popup per step; you must be present)</label>
          <label className="radio"><input type="radio" checked={settings.signing === 'session'} disabled={running} onChange={() => setSettings({ signing: 'session' })} /> Session key with limited grants (no popups while the tab is open)</label>

          <label className="label">Session key</label>
          {!session && (
            <div className="connect-row">
              <button className="btn" onClick={createSession} disabled={!!busy}>Create session key</button>
              <label className="radio small"><input type="checkbox" checked={settings.persistSession} onChange={(e) => setSettings({ persistSession: e.target.checked })} /> keep it after the tab closes (localStorage)</label>
            </div>
          )}
          {!session && (
            <div className="connect-row">
              <input className="input" placeholder="inj1… address of a headless-runner key" value={externalAddr} onChange={(e) => setExternalAddr(e.target.value)} spellCheck={false} />
              <button className="btn ghost small" onClick={useExternal} disabled={!!busy}>Use existing session address</button>
            </div>
          )}
          {session && (
            <div className="session-box">
              <div><span className="k">Session address</span> <span className="mono small">{session.address}</span> {sessionExternal && <span className="pill small neutral">external key</span>}</div>
              <div className="grants">
                <GrantRow label="Neptune contract (4 messages)" g={grants?.wasm} />
                <GrantRow label="Helix market orders (2 markets)" g={grants?.spot} />
                <GrantRow label="Gas allowance (feegrant)" g={grants?.feegrant ? { ok: grants.feegrant.ok, expiration: grants.feegrant.expiration, detail: grants.feegrant.remainingInj !== null ? `${grants.feegrant.remainingInj.toFixed(3)} INJ left` : '' } : undefined} />
                {grants && <div className="muted small">{grants.complete ? `complete · expires ${grants.expiresAt ? new Date(grants.expiresAt).toLocaleString() : '?'}` : 'incomplete - grant below'}</div>}
              </div>
              <div className="connect-row">
                <button className="btn primary small" onClick={() => grant(1)} disabled={!!busy || running}>Grant 1 day</button>
                <button className="btn primary small" onClick={() => grant(7)} disabled={!!busy || running}>Grant 7 days</button>
                <button className="btn small" onClick={() => grant(30)} disabled={!!busy || running}>Grant 30 days</button>
                <button className="btn ghost small" onClick={revoke} disabled={!!busy || running}>Revoke</button>
                <button className="btn ghost small" onClick={() => refreshGrants()} disabled={!!busy}>Refresh</button>
              </div>
              <div className="connect-row">
                {!sessionExternal && <button className="btn ghost small" onClick={() => setExportedKey(exportedKey ? null : session.privateKeyHex)} disabled={running}>{exportedKey ? 'Hide key' : 'Export for the headless runner'}</button>}
                <button className="btn ghost small" onClick={forgetSession} disabled={!!busy || running}>Forget session key</button>
              </div>
              {exportedKey && (
                <div>
                  <p className="error small">This hex key can do everything the grants allow until they expire. Store it like a wallet key; never paste it anywhere but the runner's key file.</p>
                  <textarea className="textarea mono" rows={2} readOnly value={exportedKey} onFocus={(e) => e.currentTarget.select()} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="ap-col">
          <label className="label">Settings</label>
          <div className="kv-grid">
            <div><span className="k">Tick interval (s)</span><input className="input small" type="number" min={20} value={settings.intervalSec} disabled={running} onChange={(e) => setSettings({ intervalSec: Math.max(20, parseInt(e.target.value) || 60) })} /></div>
            <div><span className="k">Slippage tolerance (%)</span><input className="input small" type="number" min={0.1} max={3} step={0.1} value={settings.config.slippagePct} onChange={(e) => setSettings((s) => ({ ...s, config: { ...s.config, slippagePct: Math.min(3, Math.max(0.1, parseFloat(e.target.value) || 1)) } }))} /></div>
            <div><span className="k">Reserve warning below (USDC)</span><input className="input small" type="number" min={0} value={settings.config.reserveMinUsd} onChange={(e) => setSettings((s) => ({ ...s, config: { ...s.config, reserveMinUsd: Math.max(0, parseFloat(e.target.value) || 0) } }))} /></div>
            <div><span className="k">Webhook (ntfy-style POST)</span><input className="input small" placeholder="https://ntfy.sh/your-topic" value={settings.webhookUrl} onChange={(e) => setSettings({ webhookUrl: e.target.value.trim() })} /></div>
          </div>
          <label className="radio small"><input type="checkbox" checked={settings.browserNotifications} onChange={(e) => setSettings({ browserNotifications: e.target.checked })} /> browser notifications for alerts</label>

          <label className="label">Acknowledgement</label>
          <label className="radio small ack">
            <input type="checkbox" checked={settings.acknowledged} disabled={running} onChange={(e) => setSettings({ acknowledged: e.target.checked })} />
            I understand that this software will sign transactions that move my funds, that a leveraged loop can lose everything, that the strategy has no forecast in it, and that nobody but me is responsible for what it does.
          </label>

          <label className="label">Controls</label>
          <div className="connect-row">
            {!running ? (
              <button className="btn primary" onClick={start} disabled={!!busy || !settings.acknowledged}>Start autopilot</button>
            ) : (
              <button className="btn" onClick={() => stop()} disabled={!!busy}>Stop autopilot</button>
            )}
            <button className="btn ghost small" onClick={() => runner?.tick()} disabled={!running || !!runner?.ticking}>Tick now</button>
            <button className="btn ghost small danger" onClick={() => { void stop('EMERGENCY STOP - autopilot disabled'); setPause({ until: Date.now() + 24 * 3_600_000, reason: 'emergency stop' }) }} disabled={!!busy}>Emergency stop</button>
          </div>
          <div className="connect-row">
            <span className="muted small">Pause (no adding, no cleanup; reduce / exit keep running but never use wallet funds):</span>
            {paused ? (
              <>
                <span className="pill small warn">paused {fmtAge((pause.until! - Date.now()) / 1000)} left · {pause.reason}</span>
                <button className="btn ghost small" onClick={() => setPause({ until: null, reason: '' })}>Resume</button>
              </>
            ) : (
              <>
                <button className="btn ghost small" onClick={() => setPause({ until: Date.now() + 3_600_000, reason: '1 h' })}>1 h</button>
                <button className="btn ghost small" onClick={() => setPause({ until: Date.now() + 24 * 3_600_000, reason: '24 h' })}>24 h</button>
                <button className="btn ghost small" onClick={() => setPause({ until: Date.now() + 7 * 24 * 3_600_000, reason: '7 days' })}>7 days</button>
              </>
            )}
          </div>
          {msg && <p className={msg.tone === 'ok' ? 'ok' : msg.tone === 'error' ? 'error' : 'muted'}>{msg.text}</p>}
          {busy && <p className="muted small">working: {busy}…</p>}
          {runner?.lastError && <p className="error small">last tick error: {runner.lastError}</p>}
        </div>
      </div>

      {log.length > 0 && (
        <div className="ap-log">
          <label className="label">Log (this browser, last 40)</label>
          <ul className="log">
            {log.map((e, i) => (
              <li key={i} className={e.kind}>
                <span className="mono muted small">{e.ts.slice(11, 19)}</span> {e.text}
                {e.txHash && /^[0-9A-Fa-f]{64}$/.test(e.txHash) && <a className="chip" href={LINKS.explorerTx(e.txHash)} target="_blank" rel="noreferrer">tx ↗</a>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function GrantRow({ label, g }: { label: string; g?: { ok: boolean; expiration: string | null; detail?: string } }) {
  return (
    <div className="grant-row">
      <span className={`pill small ${g ? (g.ok ? 'ok' : 'danger') : 'neutral'}`}>{g ? (g.ok ? 'ok' : 'missing') : '…'}</span> {label}
      {g?.detail && <span className="muted small"> · {g.detail}</span>}
    </div>
  )
}
