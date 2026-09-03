import { useState } from 'react'
import { DEFAULT_LCD_HOSTS } from '../../config/chain'
import { parseStrategy, serializeStrategy, validateStrategy, type StrategyConfig } from '../../strategy/types'

export function SettingsPanel({ cfg, onSave, onReset, lcdHosts, onLcdHosts, onClose }: {
  cfg: StrategyConfig
  onSave: (c: StrategyConfig) => void
  onReset: () => void
  lcdHosts: string[]
  onLcdHosts: (h: string[]) => void
  onClose: () => void
}) {
  const [json, setJson] = useState(() => serializeStrategy(cfg))
  const [hosts, setHosts] = useState(lcdHosts.join('\n'))
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function save() {
    try {
      const parsed = parseStrategy(json)
      const errors = validateStrategy(parsed)
      if (errors.length) throw new Error(errors.join('; '))
      onSave(parsed)
      const h = hosts.split('\n').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s))
      onLcdHosts(h.length ? h : [...DEFAULT_LCD_HOSTS])
      setMsg({ tone: 'ok', text: 'Saved. Stored only in this browser (localStorage).' })
    } catch (e) {
      setMsg({ tone: 'error', text: String((e as Error)?.message ?? e) })
    }
  }
  function reset() {
    onReset()
    onLcdHosts([...DEFAULT_LCD_HOSTS])
    setHosts(DEFAULT_LCD_HOSTS.join('\n'))
    setMsg({ tone: 'ok', text: 'Defaults restored.' })
    setJson('')
    setTimeout(() => location.reload(), 300)
  }

  return (
    <section className="card settings">
      <div className="decision-head">
        <h2>Settings</h2>
        <button className="btn ghost small" onClick={onClose}>Close</button>
      </div>
      <p className="muted small">
        The strategy is a plain JSON object: price ladder, mode (<code>full</code> / <code>repay-only</code> / <code>off</code>), trend filter, rate guard and planner assumptions.
        The defaults are documented in <a href="https://github.com/paddy-droid/neptune-loop-cockpit/blob/main/docs/STRATEGY.md" target="_blank" rel="noreferrer">docs/STRATEGY.md</a>.
        Changing numbers here changes what this page recommends, nothing else. Back-test before you trust a change (<code>npm run backtest</code>).
      </p>
      <label className="label">Strategy JSON</label>
      <textarea className="textarea mono" rows={22} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
      <label className="label">LCD hosts (one per line, tried in order)</label>
      <textarea className="textarea mono" rows={4} value={hosts} onChange={(e) => setHosts(e.target.value)} spellCheck={false} />
      <div className="connect-row">
        <button className="btn primary" onClick={save}>Save</button>
        <button className="btn ghost" onClick={reset}>Reset to defaults</button>
        {msg && <span className={msg.tone === 'ok' ? 'ok' : 'error'}>{msg.text}</span>}
      </div>
    </section>
  )
}
