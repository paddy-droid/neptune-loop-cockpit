import type { Trend } from '../../market/trend'
import type { Decision } from '../../strategy/policy'
import type { StrategyConfig } from '../../strategy/types'
import { fmtNum } from '../format'

function Sparkline({ closes, sma }: { closes: number[]; sma: number[] }) {
  const w = 320
  const h = 80
  const all = [...closes, ...sma.filter((v) => Number.isFinite(v))]
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || 1
  const x = (i: number) => (i / Math.max(1, closes.length - 1)) * w
  const y = (v: number) => h - ((v - min) / span) * (h - 6) - 3
  const path = (vals: number[]) => vals.map((v, i) => (Number.isFinite(v) ? `${i === 0 || !Number.isFinite(vals[i - 1]) ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}` : '')).join(' ')
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="60-day price and moving average">
      <path d={path(sma)} className="spark-sma" />
      <path d={path(closes)} className="spark-price" />
    </svg>
  )
}

export function TrendCard({ trend: t, decision: d, cfg }: { trend: Trend | null; decision: Decision; cfg: StrategyConfig }) {
  const n = cfg.trendFilter.smaDays
  if (!t) {
    return (
      <section className="card">
        <h2>Trend filter</h2>
        <p className="error">No price history available. Fail-safe: the strategy never adds leverage without it. Reduce-leverage rules stay as they are.</p>
      </section>
    )
  }
  const tone = !cfg.trendFilter.enabled ? 'neutral' : d.trend.active ? 'warn' : t.belowSma ? 'info' : 'ok'
  const label = !cfg.trendFilter.enabled ? 'filter disabled' : d.trend.active ? 'ACTIVE - no adding, LTV cap' : t.belowSma ? 'live below SMA - adding paused' : 'inactive - ladder as usual'
  return (
    <section className="card">
      <h2>
        Trend filter <span className={`pill ${tone}`}>{label}</span>
      </h2>
      <Sparkline closes={t.closes} sma={t.smaSeries} />
      <table className="table compact">
        <tbody>
          <tr><td>Exchange price ({t.source})</td><td className="num">${fmtNum(t.lastClose, 3)}</td></tr>
          <tr><td>SMA{n}</td><td className="num">${fmtNum(t.sma, 3)} <span className={`muted small`}>({t.distSmaPct >= 0 ? '+' : ''}{t.distSmaPct.toFixed(1)} %)</span></td></tr>
          <tr><td>Last daily close vs SMA{n}</td><td className="num">${fmtNum(t.prevClose, 3)} vs ${fmtNum(t.prevSma, 3)}</td></tr>
          <tr><td>24 h / 7 d / 30 d</td><td className="num">{t.change24hPct.toFixed(1)} % / {t.change7dPct.toFixed(1)} % / {t.change30dPct.toFixed(1)} %</td></tr>
          <tr><td>30-day range</td><td className="num">${fmtNum(t.low30d, 2)} – ${fmtNum(t.high30d, 2)}</td></tr>
        </tbody>
      </table>
      <p className="muted small">
        {t.filterWhy}. Rule: a daily close below the SMA{n} (or a live price more than {(cfg.trendFilter.panicPct * 100).toFixed(0)} % below it) blocks adding leverage and caps the LTV at {(cfg.trendFilter.ltvCap * 100).toFixed(0)} % (trigger {(cfg.trendFilter.ltvCapTrigger * 100).toFixed(0)} %). Adding resumes only when both the daily close and the live price are above the SMA.
      </p>
    </section>
  )
}
