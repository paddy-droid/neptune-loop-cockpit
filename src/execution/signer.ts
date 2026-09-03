/**
 * Signers: who signs, and how the outcome of a broadcast is verified.
 *
 *   KeplrSigner    - the owner's wallet extension signs every transaction (popup per tx).
 *   SessionSigner  - a locally generated session key signs MsgExec on the owner's behalf using
 *                    the authz + feegrant grants the owner created once (no popups).
 *
 * Both share the same post-broadcast discipline (ported from the production executor):
 *   - "account sequence mismatch" = rejected at CheckTx, nothing sent: wait briefly and re-sign.
 *   - unclear outcome (timeout, lost response): NEVER re-send blindly. Watch the signer's account
 *     sequence until the block height passes the tx timeout: sequence rose = it landed; height
 *     passed with the same sequence = it definitely did not; otherwise report "unclear".
 */
import { MsgBroadcasterWithPk, MsgAuthzExec, PrivateKey, type Msgs } from '@injectivelabs/sdk-ts'
import { Network } from '@injectivelabs/networks'
import type { LcdClient } from '../chain/lcd'
import { UnclearTxError, type TxResult } from './types'

export interface Signer {
  /** Whose position is operated (the granter in session mode). */
  ownerAddress: string
  /** The account that signs (== ownerAddress for Keplr, the session key for sessions). */
  signerAddress: string
  send(msgs: Msgs[], label: string): Promise<TxResult>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function accountSequence(lcd: LcdClient, addr: string): Promise<number> {
  const j = await lcd.json<any>(`/cosmos/auth/v1beta1/accounts/${addr}`, 8000)
  const n = parseInt(String(j?.account?.base_account?.sequence ?? j?.account?.sequence ?? ''), 10)
  if (!Number.isFinite(n)) throw new Error('sequence unreadable')
  return n
}
export async function latestHeight(lcd: LcdClient): Promise<number> {
  const j = await lcd.json<any>('/cosmos/base/tendermint/v1beta1/blocks/latest', 8000)
  const h = parseInt(String(j?.block?.header?.height ?? ''), 10)
  if (!Number.isFinite(h)) throw new Error('height unreadable')
  return h
}

const SEQ_RE = /sequence mismatch|incorrect account sequence/i
const UNCLEAR_RE = /timeout|not included|not found|fetch failed|network|ECONN|socket|abort|502|503|504/i

/**
 * Run `broadcast()` with the sequence-mismatch retry and the unclear-outcome protocol.
 * `signerAddr` is the account whose sequence proves inclusion.
 */
export async function broadcastGuarded(lcd: LcdClient, signerAddr: string, broadcast: () => Promise<{ txHash: string }>): Promise<TxResult> {
  let seq0 = -1
  let h0 = -1
  try {
    ;[seq0, h0] = await Promise.all([accountSequence(lcd, signerAddr), latestHeight(lcd)])
  } catch {
    /* proceed without proof */
  }
  try {
    const r = await broadcast()
    return { txHash: r.txHash }
  } catch (e) {
    const err = String((e as Error)?.message ?? e)
    if (SEQ_RE.test(err)) {
      await sleep(1800)
      const r = await broadcast()
      return { txHash: r.txHash }
    }
    if (seq0 >= 0 && UNCLEAR_RE.test(err)) {
      const deadline = Date.now() + 60_000
      let proven = false
      while (Date.now() < deadline) {
        await sleep(3000)
        try {
          const [seq, h] = await Promise.all([accountSequence(lcd, signerAddr), latestHeight(lcd)])
          if (seq > seq0) return { txHash: 'late-included' }
          if (h > h0 + 62) {
            proven = true
            break
          }
        } catch {
          /* keep polling */
        }
      }
      if (proven) throw new Error(`tx definitely not landed (${err.slice(0, 80)}) - sequence unchanged`)
      throw new UnclearTxError(`tx outcome unclear (sequence poll timed out): ${err.slice(0, 80)}`)
    }
    throw e
  }
}

/** A session key held in memory. Generate with `generateSessionKey()`, restore with `sessionFromHex()`. */
export interface SessionKey {
  privateKeyHex: string
  address: string
}

export function generateSessionKey(): SessionKey {
  const { privateKey } = PrivateKey.generate()
  return { privateKeyHex: privateKey.toPrivateKeyHex(), address: privateKey.toBech32() }
}
export function sessionFromHex(hex: string): SessionKey {
  const pk = PrivateKey.fromHex(hex.trim())
  return { privateKeyHex: pk.toPrivateKeyHex(), address: pk.toBech32() }
}

export interface SessionSignerOptions {
  lcd: LcdClient
  ownerAddress: string
  session: SessionKey
  /** Pay gas through the owner's feegrant (default true). false = the session key pays from its own INJ. */
  useFeegrant?: boolean
  network?: Network
  endpoints?: { indexer: string; grpc: string; rest: string }
}

/** Signs MsgExec with the session key on behalf of the owner. */
export class SessionSigner implements Signer {
  readonly ownerAddress: string
  readonly signerAddress: string
  private readonly bc: MsgBroadcasterWithPk
  private readonly lcd: LcdClient
  private readonly useFeegrant: boolean

  constructor(opts: SessionSignerOptions) {
    this.ownerAddress = opts.ownerAddress
    this.signerAddress = opts.session.address
    this.lcd = opts.lcd
    this.useFeegrant = opts.useFeegrant ?? true
    this.bc = new MsgBroadcasterWithPk({
      privateKey: PrivateKey.fromHex(opts.session.privateKeyHex),
      network: opts.network ?? Network.Mainnet,
      endpoints: opts.endpoints,
      simulateTx: true,
      txTimeout: 60,
    })
  }

  async send(msgs: Msgs[], _label: string): Promise<TxResult> {
    const exec = MsgAuthzExec.fromJSON({ grantee: this.signerAddress, msgs })
    return broadcastGuarded(this.lcd, this.signerAddress, () =>
      this.bc.broadcast({ msgs: exec, gas: this.useFeegrant ? { granter: this.ownerAddress } : undefined }),
    )
  }

  /** Sign and broadcast plain messages from the session key itself (e.g. returning leftover gas INJ). */
  async sendOwn(msgs: Msgs[]): Promise<TxResult> {
    return broadcastGuarded(this.lcd, this.signerAddress, () => this.bc.broadcast({ msgs }))
  }
}

/** Any object with a `broadcast({msgs, injectiveAddress})` method - the wallet-core MsgBroadcaster fits. */
export interface WalletBroadcaster {
  broadcastV2(tx: { msgs: Msgs | Msgs[]; injectiveAddress?: string; memo?: string }): Promise<{ txHash: string }>
}

/** The owner's own wallet signs (Keplr / Leap popup per transaction). */
export class WalletSigner implements Signer {
  readonly ownerAddress: string
  readonly signerAddress: string
  constructor(private readonly lcd: LcdClient, address: string, private readonly broadcaster: WalletBroadcaster) {
    this.ownerAddress = address
    this.signerAddress = address
  }
  async send(msgs: Msgs[], _label: string): Promise<TxResult> {
    return broadcastGuarded(this.lcd, this.signerAddress, () => this.broadcaster.broadcastV2({ msgs, injectiveAddress: this.ownerAddress }))
  }
}
