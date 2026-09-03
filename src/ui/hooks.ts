import { useCallback, useEffect, useRef, useState } from 'react'
import { LcdClient } from '../chain/lcd'
import { getStatus, type Status } from '../chain/neptune'
import { getTrend, type Trend } from '../market/trend'
import { DEFAULT_LCD_HOSTS } from '../config/chain'
import { DEFAULT_STRATEGY, parseStrategy, serializeStrategy, type StrategyConfig } from '../strategy/types'
import { demoStatus, demoTrend } from '../demo/demo'

const STRATEGY_KEY = 'nlc.strategy.v1'
const LCD_KEY = 'nlc.lcdHosts.v1'
const ADDRESS_KEY = 'nlc.watchAddress.v1'

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private mode etc. */
  }
}

export function useStrategyConfig(): [StrategyConfig, (c: StrategyConfig) => void, () => void] {
  const [cfg, setCfg] = useState<StrategyConfig>(() => {
    const raw = readLocal(STRATEGY_KEY)
    if (raw) {
      try {
        return parseStrategy(raw)
      } catch {
        /* fall through to default */
      }
    }
    return DEFAULT_STRATEGY
  })
  const save = useCallback((c: StrategyConfig) => {
    setCfg(c)
    writeLocal(STRATEGY_KEY, serializeStrategy(c))
  }, [])
  const reset = useCallback(() => {
    setCfg(DEFAULT_STRATEGY)
    writeLocal(STRATEGY_KEY, null)
  }, [])
  return [cfg, save, reset]
}

export function useLcdHosts(): [string[], (h: string[]) => void] {
  const [hosts, setHosts] = useState<string[]>(() => {
    const raw = readLocal(LCD_KEY)
    if (raw) {
      try {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr) && arr.every((x) => typeof x === 'string' && /^https?:\/\//.test(x)) && arr.length) return arr
      } catch {
        /* ignore */
      }
    }
    return [...DEFAULT_LCD_HOSTS]
  })
  const save = useCallback((h: string[]) => {
    setHosts(h)
    writeLocal(LCD_KEY, JSON.stringify(h))
  }, [])
  return [hosts, save]
}

export function useRememberedAddress(): [string, (a: string) => void] {
  const [addr, setAddr] = useState<string>(() => readLocal(ADDRESS_KEY) ?? '')
  const save = useCallback((a: string) => {
    setAddr(a)
    writeLocal(ADDRESS_KEY, a || null)
  }, [])
  return [addr, save]
}

export interface CockpitData {
  status: Status | null
  trend: Trend | null
  error: string | null
  loading: boolean
  lastUpdated: number | null
  lcdHost: string | null
  refresh: () => void
}

/**
 * Loads status + trend for an address and refreshes every `intervalMs` while the tab is visible.
 * `address === 'demo'` serves synthetic data without any network call.
 */
export function useCockpitData(address: string | null, cfg: StrategyConfig, lcdHosts: string[], intervalMs = 60_000): CockpitData {
  const [status, setStatus] = useState<Status | null>(null)
  const [trend, setTrend] = useState<Trend | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const lcdRef = useRef<LcdClient | null>(null)
  const hostsKey = lcdHosts.join('|')

  useEffect(() => {
    lcdRef.current = new LcdClient({ hosts: lcdHosts })
  }, [hostsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!address) {
      setStatus(null)
      setTrend(null)
      setError(null)
      return
    }
    let cancelled = false
    const run = async () => {
      setLoading(true)
      try {
        if (address === 'demo') {
          setStatus(demoStatus())
          setTrend(demoTrend(cfg.trendFilter.smaDays, cfg.trendFilter.panicPct))
          setError(null)
        } else {
          const lcd = lcdRef.current ?? new LcdClient({ hosts: lcdHosts })
          const [s, t] = await Promise.all([
            getStatus(lcd, address),
            getTrend({ smaDays: cfg.trendFilter.smaDays, panicPct: cfg.trendFilter.panicPct }),
          ])
          if (cancelled) return
          setStatus(s)
          setTrend(t)
          setError(null)
        }
        setLastUpdated(Date.now())
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message ?? e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void run()
    }, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [address, tick, cfg.trendFilter.smaDays, cfg.trendFilter.panicPct, hostsKey, intervalMs]) // eslint-disable-line react-hooks/exhaustive-deps

  return { status, trend, error, loading, lastUpdated, lcdHost: lcdRef.current?.lastHost ?? null, refresh }
}
