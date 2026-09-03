export const fmtUsd = (v: number, digits = 0): string =>
  Number.isFinite(v) ? `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}` : '–'

export const fmtNum = (v: number, digits = 2): string =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–'

export const fmtPct = (v: number, digits = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(digits)} %` : '–')

export const fmtSignedPct = (v: number, digits = 1): string =>
  Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)} %` : '–'

export const fmtHealth = (v: number): string => (v === Infinity ? '∞' : Number.isFinite(v) ? v.toFixed(2) : '–')

export const fmtAge = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return 'unknown'
  if (sec < 90) return `${Math.round(sec)} s`
  if (sec < 5400) return `${Math.round(sec / 60)} min`
  return `${(sec / 3600).toFixed(1)} h`
}

export const shortAddr = (a: string): string => (a.length > 16 ? `${a.slice(0, 9)}…${a.slice(-6)}` : a)
