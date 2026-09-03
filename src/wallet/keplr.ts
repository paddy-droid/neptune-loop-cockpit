/**
 * Wallet connection - address only.
 *
 * The cockpit asks the wallet extension for exactly one thing: the bech32
 * address of the selected account on Injective. It never requests a signer,
 * never builds a transaction and never sees a key. Keplr and Leap expose the
 * same API surface for this, so both are supported.
 *
 * If you do not want to connect a wallet at all, use watch-only mode and paste
 * any `inj1...` address.
 */
import { CHAIN_ID, isInjAddress } from '../config/chain'

export type WalletKind = 'keplr' | 'leap'

interface KeplrLike {
  enable(chainId: string): Promise<void>
  getKey(chainId: string): Promise<{ bech32Address: string; name: string; isNanoLedger?: boolean }>
}

declare global {
  interface Window {
    keplr?: KeplrLike
    leap?: KeplrLike
  }
}

export interface WalletAccount {
  kind: WalletKind
  address: string
  name: string
}

export function detectWallets(): WalletKind[] {
  if (typeof window === 'undefined') return []
  const out: WalletKind[] = []
  if (window.keplr) out.push('keplr')
  if (window.leap) out.push('leap')
  return out
}

export async function connectWallet(kind: WalletKind): Promise<WalletAccount> {
  const w = kind === 'leap' ? window.leap : window.keplr
  if (!w) throw new Error(`${kind === 'leap' ? 'Leap' : 'Keplr'} extension not found. Install it or use watch-only mode.`)
  await w.enable(CHAIN_ID)
  const key = await w.getKey(CHAIN_ID)
  if (!isInjAddress(key.bech32Address)) throw new Error(`Wallet returned an unexpected address: ${key.bech32Address}`)
  return { kind, address: key.bech32Address, name: key.name }
}

/** Fires when the user switches accounts in the extension. Returns an unsubscribe function. */
export function onWalletAccountChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('keplr_keystorechange', handler)
  window.addEventListener('leap_keystorechange', handler)
  return () => {
    window.removeEventListener('keplr_keystorechange', handler)
    window.removeEventListener('leap_keystorechange', handler)
  }
}
