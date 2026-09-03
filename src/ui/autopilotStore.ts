/**
 * Persistence for the autopilot panel (per owner address, localStorage only).
 */
import { DEFAULT_AUTOPILOT, type AutopilotConfig } from '../execution/autopilot'

export type SigningMode = 'confirm' | 'session'

export interface AutopilotSettings {
  config: AutopilotConfig
  signing: SigningMode
  intervalSec: number
  webhookUrl: string
  browserNotifications: boolean
  persistSession: boolean
  acknowledged: boolean
}

export const DEFAULT_SETTINGS: AutopilotSettings = {
  config: DEFAULT_AUTOPILOT,
  signing: 'confirm',
  intervalSec: 60,
  webhookUrl: '',
  browserNotifications: false,
  persistSession: false,
  acknowledged: false,
}

const SETTINGS_KEY = (owner: string) => `nlc.autopilot.settings.v1:${owner}`
const PAUSE_KEY = (owner: string) => `nlc.autopilot.pause.v1:${owner}`

export function loadSettings(owner: string): AutopilotSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY(owner))
    if (raw) {
      const s = JSON.parse(raw)
      return { ...DEFAULT_SETTINGS, ...s, config: { ...DEFAULT_AUTOPILOT, ...(s.config ?? {}), enabled: false } }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS
}
/** The `enabled` flag is never persisted: after a reload the autopilot is always off until the user starts it. */
export function saveSettings(owner: string, s: AutopilotSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY(owner), JSON.stringify({ ...s, config: { ...s.config, enabled: false } }))
  } catch {
    /* ignore */
  }
}

export interface PauseState {
  until: number | null
  reason: string
}
export function loadPause(owner: string): PauseState {
  try {
    const raw = localStorage.getItem(PAUSE_KEY(owner))
    if (raw) {
      const p = JSON.parse(raw) as PauseState
      if (p.until && p.until > Date.now()) return p
    }
  } catch {
    /* ignore */
  }
  return { until: null, reason: '' }
}
export function savePause(owner: string, p: PauseState) {
  try {
    if (p.until) localStorage.setItem(PAUSE_KEY(owner), JSON.stringify(p))
    else localStorage.removeItem(PAUSE_KEY(owner))
  } catch {
    /* ignore */
  }
}
export const isPaused = (p: PauseState) => !!p.until && p.until > Date.now()
