/**
 * Minimal Injective LCD (REST) client with host failover.
 *
 * Runs in the browser and in Node (>= 18). No dependencies.
 *
 * Failover rule: hosts are tried in order; a host that fails is skipped for
 * `penaltyMs` so a dead host does not cost a full timeout on every call.
 * If every host is penalised, all are tried anyway (better late than never).
 */

export interface LcdClientOptions {
  hosts: readonly string[]
  /** Skip a failed host for this long (ms). Default 45 s. */
  penaltyMs?: number
  /** Default per-request timeout (ms). Default 12 s. */
  timeoutMs?: number
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
}

/** Every host failed (network, timeout, 5xx gateway errors). */
export class LcdError extends Error {
  constructor(message: string, public readonly attempts: string[]) {
    super(message)
    this.name = 'LcdError'
  }
}

/**
 * The node answered, but the request itself failed (400/404/500 with a JSON error body, e.g. a
 * CosmWasm query that the contract rejected). Not a host problem: no failover, no penalty.
 */
export class LcdHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string, public readonly host: string) {
    super(`HTTP ${status} from ${host}: ${body.slice(0, 200)}`)
    this.name = 'LcdHttpError'
  }
}

/** Gateway-style statuses that mean "try the next host". */
const HOST_FAILURE_STATUS = new Set([429, 502, 503, 504])

export class LcdClient {
  readonly hosts: readonly string[]
  private readonly penaltyMs: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly blockedUntil = new Map<string, number>()
  /** Host that answered the last successful request (for the UI). */
  lastHost: string | null = null

  constructor(opts: LcdClientOptions) {
    if (!opts.hosts.length) throw new Error('LcdClient needs at least one host')
    this.hosts = opts.hosts.map((h) => h.replace(/\/+$/, ''))
    this.penaltyMs = opts.penaltyMs ?? 45_000
    this.timeoutMs = opts.timeoutMs ?? 12_000
    this.fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  }

  /** Current failover state (host -> blocked-until timestamp). */
  hostState(): Record<string, number> {
    return Object.fromEntries(this.blockedUntil)
  }

  /** GET `<host><path>` and parse JSON. Throws LcdError only when every host failed. */
  async json<T = unknown>(path: string, timeoutMs = this.timeoutMs): Promise<T> {
    const now = Date.now()
    const healthy = this.hosts.filter((h) => (this.blockedUntil.get(h) ?? 0) <= now)
    const candidates = healthy.length ? healthy : this.hosts
    const attempts: string[] = []
    for (const host of candidates) {
      try {
        const res = await this.fetchImpl(`${host}${path}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) {
          const body = (await res.text().catch(() => '')).slice(0, 400)
          if (!HOST_FAILURE_STATUS.has(res.status) && body.trim().startsWith('{')) {
            // application-level error: the host is fine, the request is not
            this.blockedUntil.delete(host)
            this.lastHost = host
            throw new LcdHttpError(res.status, body, host)
          }
          throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`)
        }
        this.blockedUntil.delete(host)
        this.lastHost = host
        return (await res.json()) as T
      } catch (e) {
        if (e instanceof LcdHttpError) throw e
        attempts.push(`${host}: ${String(e).slice(0, 100)}`)
        this.blockedUntil.set(host, Date.now() + this.penaltyMs)
      }
    }
    throw new LcdError(`All ${candidates.length} LCD hosts failed: ${attempts[attempts.length - 1] ?? ''}`, attempts)
  }

  /** CosmWasm smart query. `msg` is the JSON query object of the contract. */
  async smartQuery<T = unknown>(contract: string, msg: object, timeoutMs = 8_000): Promise<T> {
    const encoded = toBase64(JSON.stringify(msg))
    const body = await this.json<{ data: T }>(
      `/cosmwasm/wasm/v1/contract/${contract}/smart/${encodeURIComponent(encoded)}`,
      timeoutMs,
    )
    return body.data
  }
}

/** Base64 for ASCII/UTF-8 strings, works in browsers and Node without Buffer. */
export function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
