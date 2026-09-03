// Refresh backtest/data/inj_daily.json from Binance daily klines (INJUSDT).
// Usage: node backtest/fetch-daily.mjs
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, 'data', 'inj_daily.json')
const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
const byDate = new Map(existing.map((d) => [d.t, d]))

let start = Date.UTC(2020, 9, 20) // Binance listing Oct 2020
if (existing.length) start = Date.parse(existing[existing.length - 1].t) - 3 * 86_400_000
const hosts = ['https://api.binance.com', 'https://data-api.binance.vision']
let total = 0
while (true) {
  let rows = null
  for (const h of hosts) {
    try {
      const res = await fetch(`${h}/api/v3/klines?symbol=INJUSDT&interval=1d&limit=1000&startTime=${start}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      rows = await res.json()
      break
    } catch (e) {
      console.warn(`${h}: ${e}`)
    }
  }
  if (!rows) throw new Error('no Binance host reachable')
  if (!rows.length) break
  for (const k of rows) {
    const t = new Date(k[0]).toISOString().slice(0, 10)
    byDate.set(t, { t, o: +k[1], h: +k[2], l: +k[3], c: +k[4] })
    total++
  }
  const lastOpen = rows[rows.length - 1][0]
  if (rows.length < 1000) break
  start = lastOpen + 86_400_000
}
const out = [...byDate.values()].sort((a, b) => (a.t < b.t ? -1 : 1))
// drop the running (incomplete) day
const today = new Date().toISOString().slice(0, 10)
const final = out.filter((d) => d.t < today)
writeFileSync(file, JSON.stringify(final))
console.log(`wrote ${final.length} days (${final[0].t} .. ${final[final.length - 1].t}), fetched ${total} rows`)
