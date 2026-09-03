import type { Status } from '../../chain/neptune'
import type { Decision } from '../../strategy/policy'
import { leverageFromLtv } from '../../strategy/planner'
import type { StrategyConfig } from '../../strategy/types'
import { fmtAge, fmtHealth, fmtNum, fmtPct, fmtUsd } from '../format'

function healthTone(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return 'neutral'
  if (h < 1.15) return 'danger'
  if (h < 1.35) return 'warn'
  return 'ok'
}

export function PositionCard({ status: s, decision: d, cfg }: { status: Status; decision: Decision; cfg: StrategyConfig }) {
  const walletInj = s.bank.find((b) => b.symbol === 'INJ')?.amount ?? 0
  const walletUsdc = s.bank.find((b) => b.symbol === 'USDC')?.amount ?? 0
  const usdcApr = s.rates.find((r) => r.symbol === 'USDC')?.borrow ?? 0
  const dailyInterest = s.debts.reduce((sum, p) => sum + (p.usd * (s.rates.find((r) => r.symbol === p.symbol)?.borrow ?? usdcApr)) / 365, 0)
  const oracleTone = s.oracleAgeSec < 0 ? 'danger' : s.oracleAgeSec > cfg.maxOracleAgeSec ? 'danger' : s.oracleAgeSec > 180 ? 'warn' : 'ok'
  return (
    <section className="card">
      <h2>Position</h2>
      <div className="hero-numbers">
        <div className={`stat ${healthTone(s.health)}`}>
          <span className="k">Health</span>
          <span className="v num big">{s.debtUsd < 1 ? '∞' : fmtHealth(s.health)}</span>
          <span className="muted small">liquidation at 1.00</span>
        </div>
        <div className="stat">
          <span className="k">LTV</span>
          <span className="v num big">{fmtPct(s.ltv)}</span>
          <span className="muted small">effective {fmtPct(d.ltvEff)} · leverage {fmtNum(leverageFromLtv(s.ltv), 2)}×</span>
        </div>
        <div className="stat">
          <span className="k">Equity</span>
          <span className="v num big">{fmtUsd(s.equityUsd)}</span>
          <span className="muted small">collateral {fmtUsd(s.collateralUsd)} − debt {fmtUsd(s.debtUsd)}</span>
        </div>
      </div>
      <table className="table">
        <tbody>
          <tr><td>INJ oracle price</td><td className="num">${fmtNum(s.injPrice, 3)} <span className={`pill small ${oracleTone}`}>{s.oracleAgeSec < 0 ? 'no timestamp' : `${fmtAge(s.oracleAgeSec)} old`}</span></td></tr>
          <tr><td>Liquidation price</td><td className="num">{s.liqPrice > 0 ? `$${fmtNum(s.liqPrice, 3)}` : '–'}</td></tr>
          {s.collateral.map((c) => (
            <tr key={'c' + c.denom}><td>Collateral {c.symbol}</td><td className="num">{fmtNum(c.amount, c.symbol === 'INJ' ? 2 : 2)} · {fmtUsd(c.usd)}</td></tr>
          ))}
          {s.debts.map((p) => (
            <tr key={'d' + p.denom}><td>Debt {p.symbol}</td><td className="num">{fmtNum(p.amount, 2)} · {fmtUsd(p.usd)}</td></tr>
          ))}
          <tr><td>Interest per day</td><td className="num">{fmtUsd(dailyInterest, 2)} <span className="muted small">({fmtPct(usdcApr)} APR on USDC)</span></td></tr>
          <tr><td>Wallet INJ (gas)</td><td className="num">{fmtNum(walletInj, 3)} {walletInj < cfg.gasReserveInj && <span className="pill small warn">below {cfg.gasReserveInj}</span>}</td></tr>
          <tr><td>Wallet USDC (reserve)</td><td className="num">{fmtUsd(walletUsdc, 2)}</td></tr>
        </tbody>
      </table>
      <p className="muted small">Liquidation LTV {fmtPct(s.injLiqLtv, 0)} · withdraw/borrow limit {fmtPct(s.injAllowableLtv, 0)} (from the contract). Health = {fmtPct(s.injLiqLtv, 0)} ÷ LTV for INJ-only collateral.</p>
    </section>
  )
}
