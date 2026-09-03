import { useEffect, useMemo, useState } from 'react'
import { isInjAddress, LINKS } from '../config/chain'
import { decide } from '../strategy/policy'
import { buildPlan, computeTriggers } from '../strategy/planner'
import { connectWallet, detectWallets, onWalletAccountChange, type WalletAccount, type WalletKind } from '../wallet/keplr'
import { useCockpitData, useLcdHosts, useRememberedAddress, useStrategyConfig } from './hooks'
import { fmtAge, shortAddr } from './format'
import { PositionCard } from './components/PositionCard'
import { DecisionCard } from './components/DecisionCard'
import { TriggersCard } from './components/TriggersCard'
import { LadderCard } from './components/LadderCard'
import { TrendCard } from './components/TrendCard'
import { RatesCard } from './components/RatesCard'
import { SettingsPanel } from './components/SettingsPanel'
import { AutopilotPanel } from './components/AutopilotPanel'

type Source = { kind: 'wallet'; account: WalletAccount } | { kind: 'watch'; address: string } | { kind: 'demo' } | null

export function App() {
  const [cfg, saveCfg, resetCfg] = useStrategyConfig()
  const [lcdHosts, saveLcdHosts] = useLcdHosts()
  const [remembered, rememberAddress] = useRememberedAddress()
  const [source, setSource] = useState<Source>(() => {
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search)
      if (q.get('demo') === '1') return { kind: 'demo' }
      const a = q.get('address')
      if (a && isInjAddress(a)) return { kind: 'watch', address: a }
    }
    return remembered && isInjAddress(remembered) ? { kind: 'watch', address: remembered } : null
  })
  const [watchInput, setWatchInput] = useState(remembered)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [now, setNow] = useState(Date.now())
  const wallets = useMemo(() => detectWallets(), [])

  const address = source?.kind === 'wallet' ? source.account.address : source?.kind === 'watch' ? source.address : source?.kind === 'demo' ? 'demo' : null
  const data = useCockpitData(address, cfg, lcdHosts)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (source?.kind !== 'wallet') return
    return onWalletAccountChange(() => {
      void connectWallet(source.account.kind).then((acc) => setSource({ kind: 'wallet', account: acc })).catch(() => setSource(null))
    })
  }, [source])

  const decision = useMemo(() => (data.status ? decide(data.status, data.trend, cfg) : null), [data.status, data.trend, cfg])
  const plan = useMemo(() => (data.status && decision ? buildPlan(data.status, decision, cfg) : null), [data.status, decision, cfg])
  const triggers = useMemo(() => (data.status && decision ? computeTriggers(data.status, decision, cfg) : null), [data.status, decision, cfg])

  async function connect(kind: WalletKind) {
    setWalletError(null)
    try {
      const acc = await connectWallet(kind)
      setSource({ kind: 'wallet', account: acc })
    } catch (e) {
      setWalletError(String((e as Error)?.message ?? e))
    }
  }
  function watch() {
    const a = watchInput.trim()
    if (!isInjAddress(a)) {
      setWalletError('That is not a valid Injective address (inj1… with 42 characters).')
      return
    }
    setWalletError(null)
    rememberAddress(a)
    setSource({ kind: 'watch', address: a })
  }
  function disconnect() {
    setSource(null)
    rememberAddress('')
    setWatchInput('')
  }

  const ageSec = data.lastUpdated ? Math.max(0, (Math.max(now, data.lastUpdated) - data.lastUpdated) / 1000) : null
  const stale = ageSec !== null && ageSec > 150

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="./favicon.svg" alt="" width={28} height={28} />
          <div>
            <h1>Neptune Loop Cockpit</h1>
            <p className="tagline">Strategy cockpit and autopilot for the INJ loop on Neptune Finance · Injective mainnet</p>
          </div>
        </div>
        <div className="topbar-right">
          {source && (
            <span className={`pill ${stale ? 'warn' : 'ok'}`} title={data.lcdHost ? `LCD: ${data.lcdHost}` : ''}>
              {data.loading ? 'updating…' : ageSec !== null ? `updated ${fmtAge(ageSec)} ago` : 'no data yet'}
            </span>
          )}
          <button className="btn ghost" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>
            {showSettings ? 'Close settings' : 'Settings'}
          </button>
        </div>
      </header>

      {!source && (
        <section className="card hero">
          <h2>Connect or watch</h2>
          <p>
            Connecting a wallet reveals your address and unlocks the optional autopilot; nothing is signed until you start it. Everything else is public chain data.
            You can also paste any Injective address and watch its loop, or open the demo.
          </p>
          <div className="connect-row">
            {wallets.includes('keplr') ? (
              <button className="btn primary" onClick={() => connect('keplr')}>Connect Keplr</button>
            ) : (
              <a className="btn primary" href={LINKS.keplr} target="_blank" rel="noreferrer">Install Keplr</a>
            )}
            {wallets.includes('leap') && <button className="btn" onClick={() => connect('leap')}>Connect Leap</button>}
          </div>
          <div className="connect-row">
            <input
              className="input"
              placeholder="inj1… (watch-only)"
              value={watchInput}
              onChange={(e) => setWatchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && watch()}
              spellCheck={false}
              autoCapitalize="off"
            />
            <button className="btn" onClick={watch}>Watch address</button>
            <button className="btn ghost" onClick={() => setSource({ kind: 'demo' })}>Open demo</button>
          </div>
          {walletError && <p className="error">{walletError}</p>}
          <p className="muted small">
            Not financial advice. A leveraged loop can lose everything. Read <a href="https://github.com/paddy-droid/neptune-loop-cockpit/blob/main/docs/RISKS.md" target="_blank" rel="noreferrer">docs/RISKS.md</a> before you copy anyone's strategy.
          </p>
        </section>
      )}

      {source && (
        <section className="addrbar">
          <span className="muted">
            {source.kind === 'wallet' ? `${source.account.kind === 'leap' ? 'Leap' : 'Keplr'} · ${source.account.name}` : source.kind === 'watch' ? 'Watching' : 'Demo data (synthetic)'}
          </span>
          {source.kind !== 'demo' && (
            <a className="mono" href={LINKS.explorerAddress(address!)} target="_blank" rel="noreferrer" title={address!}>
              {shortAddr(address!)}
            </a>
          )}
          <button className="btn ghost small" onClick={data.refresh} disabled={data.loading}>Refresh</button>
          <button className="btn ghost small" onClick={disconnect}>Disconnect</button>
        </section>
      )}

      {showSettings && <SettingsPanel cfg={cfg} onSave={saveCfg} onReset={resetCfg} lcdHosts={lcdHosts} onLcdHosts={saveLcdHosts} onClose={() => setShowSettings(false)} />}

      {data.error && (
        <section className="card danger">
          <h2>Could not load data</h2>
          <p className="mono small">{data.error}</p>
          <p className="muted small">All configured LCD hosts failed or the address has never touched Neptune. Try again, or set another LCD host in the settings.</p>
        </section>
      )}

      {data.status && decision && plan && triggers && (
        <main className="grid">
          <DecisionCard decision={decision} plan={plan} status={data.status} />
          {source?.kind === 'wallet' ? (
            <AutopilotPanel owner={source.account.address} walletKind={source.account.kind} lcdHosts={lcdHosts} strategy={cfg} />
          ) : source?.kind === 'watch' && typeof location !== 'undefined' && new URLSearchParams(location.search).get('panel') === '1' ? (
            // Preview of the autopilot panel without a wallet (?panel=1): signing cannot work here.
            <AutopilotPanel owner={source.address} walletKind="keplr" lcdHosts={lcdHosts} strategy={cfg} />
          ) : (
            <section className="card span2 muted small">
              <strong>Autopilot:</strong> connect a wallet (Keplr or Leap) to let this page execute the strategy for you, either with a confirmation popup per step or with a limited session key. Watch-only and demo modes never sign anything.
            </section>
          )}
          <PositionCard status={data.status} decision={decision} cfg={cfg} />
          <TriggersCard status={data.status} decision={decision} triggers={triggers} />
          <TrendCard trend={data.trend} decision={decision} cfg={cfg} />
          <LadderCard cfg={cfg} decision={decision} status={data.status} />
          <RatesCard status={data.status} decision={decision} cfg={cfg} />
        </main>
      )}

      <footer className="footer muted small">
        <span>
          Strategy: <strong>{cfg.name}</strong> · mode <strong>{cfg.mode}</strong>
        </span>
        <span>
          <a href="https://github.com/paddy-droid/neptune-loop-cockpit" target="_blank" rel="noreferrer">Source on GitHub</a> · MIT · no backend, no stored owner keys · not financial advice
        </span>
      </footer>
    </div>
  )
}
