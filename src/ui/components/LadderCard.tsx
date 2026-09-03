import type { Status } from '../../chain/neptune'
import { healthFromLtv } from '../../strategy/planner'
import type { Decision } from '../../strategy/policy'
import type { StrategyConfig } from '../../strategy/types'
import { fmtPct } from '../format'

export function LadderCard({ cfg, decision: d, status: s }: { cfg: StrategyConfig; decision: Decision; status: Status }) {
  const liq = s.injLiqLtv > 0 ? s.injLiqLtv : 0.8
  return (
    <section className="card">
      <h2>Price ladder</h2>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>INJ up to</th>
              <th>Rung</th>
              <th className="num">Reduce above → to</th>
              <th className="num">Add below → to</th>
            </tr>
          </thead>
          <tbody>
            {cfg.ladder.map((r) => {
              const active = r === d.rung
              return (
                <tr key={r.label} className={active ? 'active' : ''}>
                  <td className="num">{Number.isFinite(r.upTo) ? `$${r.upTo}` : '∞'}</td>
                  <td>{r.label}{active && <span className="pill small ok">now</span>}</td>
                  <td className="num">
                    {r.exit ? 'sell everything' : (
                      <>
                        {fmtPct(r.repayTriggerLtv, 0)} → {fmtPct(r.repayTargetLtv, 0)}
                        <div className="muted small">health {healthFromLtv(r.repayTriggerLtv, liq).toFixed(2)} → {healthFromLtv(r.repayTargetLtv, liq).toFixed(2)}</div>
                      </>
                    )}
                  </td>
                  <td className="num">
                    {r.buyTriggerLtv && r.buyLtv ? (
                      <>
                        {fmtPct(r.buyTriggerLtv, 0)} → {fmtPct(r.buyLtv, 0)}
                        <div className="muted small">health {healthFromLtv(r.buyTriggerLtv, liq).toFixed(2)} → {healthFromLtv(r.buyLtv, liq).toFixed(2)}</div>
                      </>
                    ) : '–'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Effective thresholds right now (after trend filter, rate guard and liquidation-LTV scaling): reduce above {fmtPct(d.effective.repayTriggerLtv)} → {fmtPct(d.effective.repayTargetLtv)}
        {d.effective.buyTriggerLtv ? `, add below ${fmtPct(d.effective.buyTriggerLtv)} → ${fmtPct(d.effective.buyLtv ?? 0)}` : ', adding paused'}.
        {(d.trend.ltvCap || d.rate.ltvCap) && ` LTV cap ${fmtPct(d.trend.ltvCap ?? d.rate.ltvCap ?? 0, 0)} active.`}
      </p>
    </section>
  )
}
