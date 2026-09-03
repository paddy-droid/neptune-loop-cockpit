import type { Status } from '../../chain/neptune'
import type { Decision } from '../../strategy/policy'
import type { StrategyConfig } from '../../strategy/types'
import { fmtPct, fmtUsd } from '../format'

export function RatesCard({ status: s, decision: d, cfg }: { status: Status; decision: Decision; cfg: StrategyConfig }) {
  const util = s.usdcUtilization
  const utilTone = util >= 0.95 ? 'danger' : util >= cfg.poolTightUtilization ? 'warn' : 'ok'
  const rateTone = d.rate.ltvCap ? 'danger' : d.rate.buyBlocked ? 'warn' : 'ok'
  return (
    <section className="card">
      <h2>Rates &amp; pool</h2>
      <table className="table compact">
        <thead>
          <tr><th>Asset</th><th className="num">Lend APR</th><th className="num">Borrow APR</th></tr>
        </thead>
        <tbody>
          {s.rates.map((r) => (
            <tr key={r.symbol}><td>{r.symbol}</td><td className="num">{fmtPct(r.lend)}</td><td className="num">{fmtPct(r.borrow)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="kv-grid">
        <div><span className="k">Rate guard</span><span className={`v ${rateTone}`}>{d.rate.why}</span></div>
        <div>
          <span className="k">USDC pool utilisation</span>
          <span className={`v num ${utilTone}`}>{util > 0 ? fmtPct(util) : 'unknown'}</span>
        </div>
        <div><span className="k">USDC left to borrow</span><span className="v num">{s.usdcPoolFreeUsd > 0 ? fmtUsd(s.usdcPoolFreeUsd) : 'unknown'}</span></div>
        <div><span className="k">USDC lent in total</span><span className="v num">{s.usdcPoolLentUsd > 0 ? fmtUsd(s.usdcPoolLentUsd) : 'unknown'}</span></div>
      </div>
      <p className="muted small">
        Neptune's PID rate model makes borrowing expensive fast above ~{fmtPct(cfg.poolTightUtilization, 0)} utilisation and halts it near 95 %. The strategy stops adding leverage at {fmtPct(cfg.rateGuard.blockBuyApr, 0)} APR and de-levers at {fmtPct(cfg.rateGuard.deleverApr, 0)}. A small pool also caps how far any loop can scale.
      </p>
    </section>
  )
}
