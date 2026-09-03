/**
 * Real-chain implementation of `ExecPorts`: Neptune reads via the LCD, order books via the
 * indexer, transactions via a `Signer`. Runs in the browser and in Node.
 */
import {
  IndexerGrpcSpotApi,
  MsgCreateSpotMarketOrder,
  MsgExecuteContractCompat,
  getDefaultSubaccountId,
  spotPriceToChainPriceToFixed,
  spotQuantityToChainQuantityToFixed,
  type Msgs,
} from '@injectivelabs/sdk-ts'
import type { LcdClient } from '../chain/lcd'
import { getStatus, type Status } from '../chain/neptune'
import { ASSETS, NEPTUNE_CONTRACTS } from '../config/chain'
import { INDEXER_HOSTS, SPOT_MARKETS, withDeadline } from './markets'
import { quoteFromLevels, roundPriceToTick, roundQtyToTick } from './orderbook'
import type { Signer } from './signer'
import type { BookQuote, ExecLogEntry, ExecPorts, SpotMarketKey, TxResult } from './types'

export interface ChainPortsOptions {
  lcd: LcdClient
  signer: Signer
  accountIndex?: number
  log?: (e: ExecLogEntry) => void
  shouldStop?: () => Promise<boolean> | boolean
  indexerHosts?: readonly string[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Bank balance in base units with two attempts; never returns 0 silently on read errors. */
export async function bankRaw(lcd: LcdClient, address: string, denom: string): Promise<number> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const d = await lcd.json<any>(`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`, 5000)
      if (!d || typeof d !== 'object' || !d.balance || typeof d.balance.amount !== 'string') throw new Error('LCD bank: unexpected response')
      const v = parseFloat(d.balance.amount)
      if (!Number.isFinite(v) || v < 0) throw new Error('LCD bank: invalid amount')
      return v
    } catch (e) {
      lastErr = e
      await sleep(800 * attempt)
    }
  }
  throw new Error(`bank balance unreadable (${denom.slice(0, 12)}): ${String(lastErr).slice(0, 80)}`)
}

export async function fetchBook(market: SpotMarketKey, hosts: readonly string[] = INDEXER_HOSTS): Promise<BookQuote> {
  const m = SPOT_MARKETS[market]
  let res: { buys?: { price: string; quantity: string }[]; sells?: { price: string; quantity: string }[] } | null = null
  let lastErr: unknown = null
  for (const host of hosts) {
    try {
      res = await withDeadline(new IndexerGrpcSpotApi(host).fetchOrderbookV2(m.marketId), 10_000, 'order book ' + host.split('//')[1].split('.')[0])
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (!res) throw new Error(`order book unreadable (${hosts.length} hosts): ${String(lastErr).slice(0, 100)}`)
  const scale = 10 ** (m.baseDecimals - m.quoteDecimals)
  const lvl = (o: { price: string; quantity: string }) => ({ p: Number(o.price) * scale, q: Number(o.quantity) / 10 ** m.baseDecimals })
  return quoteFromLevels((res.buys ?? []).map(lvl), (res.sells ?? []).map(lvl), market)
}

export async function spotMarketActive(lcd: LcdClient, market: SpotMarketKey): Promise<boolean> {
  try {
    const j = await lcd.json<any>(`/injective/exchange/v1beta1/spot/markets/${SPOT_MARKETS[market].marketId}`, 8000)
    const st = JSON.stringify(j).match(/"(?:market_)?status":"([A-Za-z_]+)"/)?.[1]
    return !st || /active/i.test(st)
  } catch {
    return true // fail-open: the order rejection catches a halted market
  }
}

/** Build the Neptune market-contract execute message (sender = owner; funds come from the owner's account). */
export function neptuneExecMsg(sender: string, msg: object, funds?: { denom: string; amount: string }[]): Msgs {
  return MsgExecuteContractCompat.fromJSON({ sender, contractAddress: NEPTUNE_CONTRACTS.market, msg: msg as Record<string, unknown>, funds: funds ?? [] })
}

/** Build a Helix spot market order for the owner's default subaccount, rounded to the market's ticks. */
export function spotOrderMsg(owner: string, market: SpotMarketKey, side: 'buy' | 'sell', baseQty: number, worstPrice: number): { msg: Msgs; qty: number; price: number } {
  const m = SPOT_MARKETS[market]
  const qty = roundQtyToTick(baseQty, m.minQty)
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('quantity below market minimum or invalid')
  const price = roundPriceToTick(worstPrice, m.priceTick, side)
  if (!Number.isFinite(price) || price <= 0) throw new Error('worst price invalid')
  const msg = MsgCreateSpotMarketOrder.fromJSON({
    marketId: m.marketId,
    subaccountId: getDefaultSubaccountId(owner),
    injectiveAddress: owner,
    orderType: side === 'buy' ? 1 : 2,
    price: spotPriceToChainPriceToFixed({ value: price, baseDecimals: m.baseDecimals, quoteDecimals: m.quoteDecimals }),
    quantity: spotQuantityToChainQuantityToFixed({ value: qty, baseDecimals: m.baseDecimals }),
    feeRecipient: owner,
  })
  return { msg, qty, price }
}

export function createChainPorts(opts: ChainPortsOptions): ExecPorts {
  const { lcd, signer } = opts
  const owner = signer.ownerAddress
  const accountIndex = opts.accountIndex ?? 0
  const hosts = opts.indexerHosts ?? INDEXER_HOSTS
  const log = opts.log ?? (() => {})
  const denomOf = (symbolOrDenom: string) => ASSETS[symbolOrDenom]?.denom ?? symbolOrDenom
  const send = (msg: Msgs, label: string): Promise<TxResult> => signer.send([msg], label)

  return {
    address: owner,
    status: (): Promise<Status> => getStatus(lcd, owner, accountIndex),
    bankRaw: (denom) => bankRaw(lcd, owner, denomOf(denom)),
    book: (market) => fetchBook(market, hosts),
    spotMarketActive: (market) => spotMarketActive(lcd, market),
    withdrawCollateral: (denom, shares) =>
      send(neptuneExecMsg(owner, { withdraw_collateral: { account_index: accountIndex, asset_info: { native_token: { denom: denomOf(denom) } }, shares } }), 'withdraw'),
    repay: (denom, amountRaw) => send(neptuneExecMsg(owner, { return: { account_index: accountIndex } }, [{ denom: denomOf(denom), amount: amountRaw }]), 'repay'),
    borrow: (denom, amountRaw) =>
      send(neptuneExecMsg(owner, { borrow: { account_index: accountIndex, amount: amountRaw, asset_info: { native_token: { denom: denomOf(denom) } } } }), 'borrow'),
    deposit: (denom, amountRaw) => send(neptuneExecMsg(owner, { deposit_collateral: { account_index: accountIndex } }, [{ denom: denomOf(denom), amount: amountRaw }]), 'deposit'),
    spotMarketOrder: async (market, side, baseQty, worstPrice) => {
      const { msg } = spotOrderMsg(owner, market, side, baseQty, worstPrice)
      return send(msg, `${side} ${market}`)
    },
    waitForFill: async (denom, before, minDelta, timeoutMs = 15_000) => {
      const d = denomOf(denom)
      const start = Date.now()
      let delta = 0
      while (Date.now() - start < timeoutMs) {
        await sleep(1200)
        let now: number
        try {
          const j = await lcd.json<any>(`/cosmos/bank/v1beta1/balances/${owner}/by_denom?denom=${encodeURIComponent(d)}`, 5000)
          now = parseFloat(j?.balance?.amount)
          if (!Number.isFinite(now)) continue
        } catch {
          continue
        }
        delta = now - before
        if (delta >= minDelta) return delta
      }
      if (delta >= minDelta * 0.1) return delta
      throw new Error(`fill timeout: ${d.slice(0, 12)} grew less than expected`)
    },
    now: () => Date.now(),
    shouldStop: async () => (opts.shouldStop ? !!(await opts.shouldStop()) : false),
    log,
  }
}
