import type { Status } from '../../chain/neptune'
import { LINKS } from '../../config/chain'
import type { ActionPlan } from '../../strategy/planner'
import type { Decision } from '../../strategy/policy'
import { fmtHealth, fmtPct, fmtUsd, fmtNum } from '../format'

const TONE: Record<ActionPlan['kind'], string> = {
  hold: 'ok',
  blocked: 'neutral',
  repay: 'warn',
  add: 'info',
  exit: 'info',
  'data-error': 'danger',
}
const TITLE: Record<ActionPlan['kind'], string> = {
  hold: 'HOLD',
  blocked: 'HOLD',
  repay: 'REDUCE LEVERAGE',
  add: 'ADD LEVERAGE',
  exit: 'EXIT',
  'data-error': 'DATA ERROR',
}

export function DecisionCard({ decision, plan, status }: { decision: Decision; plan: ActionPlan; status: Status }) {
  const n = plan.numbers
  const showNumbers = plan.kind === 'repay' || plan.kind === 'add' || plan.kind === 'exit'
  return (
    <section className={`card span2 decision ${TONE[plan.kind]}`}>
      <div className="decision-head">
        <span className={`badge ${TONE[plan.kind]}`}>{TITLE[plan.kind]}</span>
        <h2>{plan.headline}</h2>
      </div>
      <p className="reason">{plan.summary}</p>
      {decision.dataError && <p className="error">Data error: {decision.dataError}. Do not act on stale or implausible data.</p>}

      {showNumbers && (
        <div className="kv-grid">
          <div><span className="k">{plan.kind === 'add' ? 'Borrow' : 'Repay'}</span><span className="v num">{fmtUsd(n.usd)}</span></div>
          <div><span className="k">{plan.kind === 'add' ? 'Buy' : 'Sell'} INJ</span><span className="v num">{fmtNum(n.inj, n.inj >= 100 ? 0 : 2)}</span></div>
          {n.fromWalletUsd > 0.5 && <div><span className="k">of which from wallet USDC</span><span className="v num">{fmtUsd(n.fromWalletUsd)}</span></div>}
          {n.rounds > 1 && <div><span className="k">Withdraw rounds</span><span className="v num">{n.rounds}</span></div>}
          <div><span className="k">LTV after</span><span className="v num">{fmtPct(n.ltvAfter)}</span></div>
          <div><span className="k">Health after</span><span className="v num">{fmtHealth(n.healthAfter)}</span></div>
          <div><span className="k">Leverage</span><span className="v num">{fmtNum(n.leverageBefore, 2)}× → {fmtNum(n.leverageAfter, 2)}×</span></div>
        </div>
      )}

      <ol className="steps">
        {plan.steps.map((s, i) => (
          <li key={i}>
            <div className="step-title">
              {s.title}
              {s.where === 'neptune' && <a className="chip" href={LINKS.neptuneApp} target="_blank" rel="noreferrer">Neptune app ↗</a>}
              {s.where === 'helix' && <a className="chip" href={LINKS.helixSpotInjUsdc} target="_blank" rel="noreferrer">Helix INJ/USDC ↗</a>}
            </div>
            <div className="muted small">{s.detail}</div>
          </li>
        ))}
      </ol>

      {plan.warnings.length > 0 && (
        <ul className="warnings">
          {plan.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {decision.refPrice !== undefined && (
        <p className="muted small">
          Exchange price ${decision.refPrice.toFixed(3)} is below the oracle ${status.injPrice.toFixed(3)}. The plan uses the exchange price.
        </p>
      )}
      <p className="muted small">
        Without the autopilot you execute every step yourself in your own wallet. With it, the same steps run as separate, verified transactions that you either confirm one by one or delegate to a scoped session key.
      </p>
    </section>
  )
}
