import type { Status } from '../../chain/neptune'
import type { Triggers } from '../../strategy/planner'
import type { Decision } from '../../strategy/policy'
import { fmtNum, fmtPct, fmtSignedPct } from '../format'

export function TriggersCard({ status: s, decision: d, triggers: t }: { status: Status; decision: Decision; triggers: Triggers }) {
  const P = s.injPrice
  const rows: { label: string; price: number | null; note: string; tone?: string }[] = [
    { label: 'Reduce leverage if INJ falls to', price: t.repayAtPrice, note: `LTV ${fmtPct(d.effective.repayTriggerLtv)} → target ${fmtPct(d.effective.repayTargetLtv, 0)}`, tone: 'warn' },
    { label: 'Add leverage if INJ rises to', price: t.buyAtPrice, note: d.effective.buyTriggerLtv ? `LTV ${fmtPct(d.effective.buyTriggerLtv)} → target ${fmtPct(d.effective.buyLtv ?? 0, 0)}` : `paused: ${d.trend.noBuyWhy ?? d.mode === 'full' ? d.trend.noBuyWhy ?? 'not in loop zone' : `mode ${d.mode}`}`, tone: 'info' },
    { label: 'Next ladder rung', price: t.nextRungPrice, note: t.nextRungLabel ? `→ "${t.nextRungLabel}"` : 'last rung' },
    { label: 'Full exit above', price: t.exitPrice, note: 'needs oracle AND exchange above this price' },
    { label: 'Liquidation', price: t.liqPrice > 0 ? t.liqPrice : null, note: 'health 1.00 - never let it get close', tone: 'danger' },
  ]
  return (
    <section className="card">
      <h2>What happens next</h2>
      <table className="table">
        <thead>
          <tr><th>Event</th><th className="num">INJ price</th><th className="num">from here</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>
                <div>{r.label}</div>
                <div className="muted small">{r.note}</div>
              </td>
              <td className="num">{r.price ? `$${fmtNum(r.price, 2)}` : '–'}</td>
              <td className={`num ${r.tone ?? ''}`}>{r.price && P > 0 ? fmtSignedPct(r.price / P - 1) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Prices assume the position does not change. Current rung: <strong>{d.rung.label}</strong>
        {Number.isFinite(d.rung.upTo) ? ` (up to $${d.rung.upTo})` : ''}.
      </p>
    </section>
  )
}
