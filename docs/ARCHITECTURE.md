# Architecture

## Design goals

1. **Nothing to trust but the code.** No backend, no API keys, no telemetry, no wallet permissions beyond "reveal address". Anyone can host the built `dist/` folder anywhere, or open `index.html` from a local `vite preview`.
2. **Pure core, thin shell.** Everything that decides something is a pure function of plain data (`decide`, `buildPlan`, `computeTriggers`, `computeTrend`, `buildStatus`). The React layer only fetches, stores and renders.
3. **Fail-safe defaults.** Missing price history → never add leverage. Implausible chain data → DATA ERROR, no recommendation. Stale oracle → no recommendation, except a protective reduce when fresh exchange data proves the position is over the limit.
4. **Same code in the browser, the CLI, the tests and the backtest.** One strategy implementation, four consumers.

## Data flow

```
                     ┌──────────────────────────────┐
  Keplr / Leap ─────►│ address only (wallet/keplr.ts)│
  or pasted address  └──────────────┬───────────────┘
                                    ▼
  ┌──────────────┐   7 smart queries + 1 bank query   ┌──────────────────────┐
  │ Injective LCD│◄────────────────────────────────────│ chain/neptune.ts     │
  │ (3 hosts,    │────────────────────────────────────►│ fetchRawStatus()     │
  │  failover)   │            RawStatus                │ buildStatus() (pure) │
  └──────────────┘                                     └──────────┬───────────┘
                                                                  │ Status
  ┌──────────────┐  daily klines                       ┌──────────▼───────────┐
  │ Binance /    │────────────────────────────────────►│ market/trend.ts      │
  │ CoinGecko    │                                     │ computeTrend() (pure)│
  └──────────────┘                                     └──────────┬───────────┘
                                                                  │ Trend | null
                                                       ┌──────────▼───────────┐
                                    StrategyConfig ───►│ strategy/policy.ts   │
                                    (localStorage)     │ decide() (pure)      │
                                                       └──────────┬───────────┘
                                                                  │ Decision
                                                       ┌──────────▼───────────┐
                                                       │ strategy/planner.ts  │
                                                       │ buildPlan(), triggers│
                                                       └──────────┬───────────┘
                                                                  ▼
                                                              ui/App.tsx
```

## Modules

| Path | Responsibility | Pure? |
|---|---|---|
| `src/config/chain.ts` | Chain id, LCD hosts, Neptune contract addresses, asset denoms/decimals, external links, address regex. | – |
| `src/chain/lcd.ts` | `LcdClient`: GET JSON with host failover and a 45 s penalty for failed hosts; `smartQuery()` base64-encodes CosmWasm queries. Injectable `fetch` for tests. | – |
| `src/chain/neptune.ts` | `fetchRawStatus()` runs the queries in parallel; `buildStatus()` converts pool shares to amounts, computes LTV/health/liquidation price, oracle age, USDC pool utilisation and free liquidity. | `buildStatus` ✔ |
| `src/market/trend.ts` | `fetchDailyCandles()` with three sources; `computeTrend()` computes SMA, hysteresis (last completed close) and the panic band. | `computeTrend` ✔ |
| `src/strategy/types.ts` | `StrategyConfig`, `Rung`, defaults ("Band E"), validation, JSON (de)serialisation with `Infinity` handling. | ✔ |
| `src/strategy/policy.ts` | `decide(status, trend, config)` → `Decision` (`none`/`down`/`up`/`exit`, target LTV, reason, effective thresholds, guards, data errors). | ✔ |
| `src/strategy/planner.ts` | `buildPlan()` (USD/INJ amounts, wallet-first repay, withdraw rounds under the interim LTV cap, LTV/health after) and `computeTriggers()` (prices of the next events). | ✔ |
| `src/wallet/keplr.ts` | `connectWallet(kind)` → `{address, name}`; listens for account switches. Supports Keplr and Leap (same API). | – |
| `src/demo/demo.ts` | Synthetic status and trend for the demo mode. | ✔ |
| `src/ui/*` | React components, `useCockpitData` (polling every 60 s while the tab is visible), localStorage hooks. | – |
| `backtest/sim.ts` | Intraday-path simulator without look-ahead, uses the same `Rung[]` type. | ✔ |
| `scripts/status-cli.ts` | Same pipeline on the command line. | – |

## Why the decision function is stateless

The original automated system ran this policy every five minutes from a serverless function that could be killed, retried or run twice in parallel. A stateless decision means every run starts from the chain's truth: there is no "I already did X" flag that could be wrong. The cockpit inherits that property: reloading the page is always safe, and two people looking at the same address see the same recommendation.

The two places where state *is* used are deliberately outside the decision:

- **Hysteresis in the trend filter** uses the last *completed* daily close, which is public data, not app state.
- **Strategy config** lives in `localStorage`; it is an input, not a memory of past actions.

## Health, LTV and the "collateral factor" check

Neptune defines `health = Σ(collateral_usd × liquidation_ltv) / debt_usd`. With INJ-only collateral that is `health = 0.80 / ltv`. `decide()` verifies `health × ltv ≈ liquidation_ltv` whenever ≥ 95 % of the collateral is INJ. A mismatch means the oracle returned something odd, Neptune changed a parameter, or the account holds collateral the app does not know; in all three cases the safe answer is "no recommendation".

## Interim LTV and withdraw rounds

To repay from collateral you must *withdraw* INJ first, which raises the LTV before it falls. Neptune refuses withdrawals that would push the LTV above `allowable_ltv` (0.78). The planner caps the interim LTV at `interimLtvCap` (0.70, configurable) and splits the repay into rounds if one withdraw is not enough. The number of rounds is shown in the decision card.

## Security posture

- The page requests only `enable(chainId)` and `getKey(chainId)` from the wallet. No `getOfflineSigner`, no `signAmino`, no `sendTx`.
- No third-party scripts. Dependencies: React and React DOM at runtime, Vite/TypeScript/vitest at build time.
- All network calls are plain GETs to public endpoints (LCD, Binance, CoinGecko). Nothing is sent that could identify you beyond your IP and the address you look up.
- Content is static; there is no server that could be compromised to serve a different strategy to you than to everyone else. Verify a hosted copy by building from source and comparing `dist/`.

## Hosting

- **GitHub Pages**: `.github/workflows/pages.yml` builds with `BASE_PATH=/neptune-loop-cockpit/` and deploys `dist/`.
- **Any static host** (Vercel, Netlify, S3, your own nginx): `npm run build`, upload `dist/`. No environment variables needed.
- **Local**: `npm run preview` after a build, or `npm run dev`.
