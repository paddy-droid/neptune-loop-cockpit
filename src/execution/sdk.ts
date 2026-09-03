/**
 * Lazy-loaded SDK bundle. The read-only cockpit never imports the Injective SDK; the autopilot
 * panel loads this module on demand (`await import('./sdk')`) so the default page stays small.
 */
import { ChainId } from '@injectivelabs/ts-types'
import { Network } from '@injectivelabs/networks'
import { Wallet } from '@injectivelabs/wallet-base'
import { MsgBroadcaster } from '@injectivelabs/wallet-core'
import { WalletStrategy } from '@injectivelabs/wallet-strategy'
import type { Msgs } from '@injectivelabs/sdk-ts'
import type { LcdClient } from '../chain/lcd'
import type { WalletKind } from '../wallet/keplr'
import { SessionSigner, WalletSigner, sessionFromHex, type Signer } from './signer'

export { createChainPorts } from './chainPorts'
export { SessionSigner, WalletSigner, generateSessionKey, sessionFromHex } from './signer'
export { buildGrantMsgs, buildRevokeMsgs, fetchGrantStatus, loadStoredSession, storeSession, clearStoredSession } from './session'
export { protocolFingerprint } from './fingerprint'
export type { Signer } from './signer'

let strategyCache: { kind: WalletKind; strategy: WalletStrategy; broadcaster: MsgBroadcaster } | null = null

/** Wallet-extension broadcaster (Keplr / Leap) for the owner's own signatures. */
export async function walletBroadcaster(kind: WalletKind): Promise<{ strategy: WalletStrategy; broadcaster: MsgBroadcaster; address: string }> {
  if (!strategyCache || strategyCache.kind !== kind) {
    const strategy = new WalletStrategy({ chainId: ChainId.Mainnet, wallet: kind === 'leap' ? Wallet.Leap : Wallet.Keplr, strategies: {} } as never)
    await strategy.setWallet(kind === 'leap' ? Wallet.Leap : Wallet.Keplr)
    const broadcaster = new MsgBroadcaster({ walletStrategy: strategy, network: Network.Mainnet, simulateTx: true, txTimeout: 60 })
    strategyCache = { kind, strategy, broadcaster }
  }
  const addresses = await strategyCache.strategy.getAddresses()
  if (!addresses.length) throw new Error('wallet returned no address')
  return { strategy: strategyCache.strategy, broadcaster: strategyCache.broadcaster, address: addresses[0] }
}

/** Sign one transaction with the owner's wallet (used for grants / revokes). */
export async function signWithWallet(kind: WalletKind, owner: string, msgs: Msgs[]): Promise<{ txHash: string }> {
  const { broadcaster, address } = await walletBroadcaster(kind)
  if (address !== owner) throw new Error(`wallet account is ${address.slice(0, 12)}…, expected ${owner.slice(0, 12)}… - switch the account in the extension`)
  const res = await broadcaster.broadcastV2({ msgs, injectiveAddress: owner })
  return { txHash: res.txHash }
}

export async function makeWalletSigner(lcd: LcdClient, kind: WalletKind, owner: string): Promise<Signer> {
  const { broadcaster, address } = await walletBroadcaster(kind)
  if (address !== owner) throw new Error(`wallet account is ${address.slice(0, 12)}…, expected ${owner.slice(0, 12)}…`)
  return new WalletSigner(lcd, owner, broadcaster)
}

export function makeSessionSigner(lcd: LcdClient, owner: string, privateKeyHex: string): Signer {
  return new SessionSigner({ lcd, ownerAddress: owner, session: sessionFromHex(privateKeyHex), useFeegrant: true })
}
