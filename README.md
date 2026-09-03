# Neptune Loop Cockpit

**A read-only strategy cockpit for the INJ collateral loop on [Neptune Finance](https://nept.finance) (Injective).**
Connect Keplr or Leap, or paste any `inj1…` address, and the page shows the position's health, LTV and liquidation price, runs the loop strategy's rulebook against it, and tells you the next move with concrete amounts. It never asks for a signature.

- **No keys, no backend, no transactions.** A static web page. The wallet only reveals your address; every number comes from public chain data read in your browser.
- **A documented, back-testable strategy.** Price ladder, health band, SMA trend filter, interest-rate guard, pool-capacity guard and data-plausibility checks, all in one pure function ([`src/strategy/policy.ts`](src/strategy/policy.ts)) with 60+ unit tests.
- **Concrete plans, not vague signals.** "Repay $612: withdraw 121 INJ, sell on Helix, repay" with the resulting LTV and health, plus the prices at which the next step triggers.
- **Your parameters.** The whole strategy is one JSON object you can edit in the UI, store locally, and back-test with the included simulator.
- **Honest about the odds.** The documentation says where the strategy loses and why the backtest has ~5 independent observations. Read [docs/RISKS.md](docs/RISKS.md) first.

---

## What the loop is

You deposit INJ as collateral on Neptune, borrow USDC against it, buy more INJ with the USDC and deposit that too. The result is a leveraged long INJ position (leverage = 1 / (1 − LTV); at the default target LTV 40 % that is 1.67×). Interest on the USDC debt is the running cost; a fast enough crash liquidates you.

The strategy keeps the LTV inside a band, de-levers when the price falls, adds leverage when it rises (only below $25, only in an uptrend), steps the leverage down through a price ladder above $25 and exits fully above $75. Full write-up: [docs/STRATEGY.md](docs/STRATEGY.md).

## Quick start

**Use it:** open the hosted page (GitHub Pages) at `https://paddy-droid.github.io/neptune-loop-cockpit/` — or run it yourself:

```bash
git clone https://github.com/paddy-droid/neptune-loop-cockpit.git
cd neptune-loop-cockpit
npm install
npm run dev          # http://localhost:5173
```

Then connect Keplr/Leap, paste an address, or click **Open demo** (synthetic data, no network calls).
Deep links: `?address=inj1…` opens watch-only mode, `?demo=1` opens the demo.

**Command line** (same numbers, no browser):

```bash
npm run status -- inj1yourAddress
npm run status -- inj1yourAddress --json
```

**Back-test the default ladder** against INJ history since 2020:

```bash
npm run backtest             # named windows (bull / sideways / bear), variants side by side
npm run backtest -- --rolling # every 12-month window, summary statistics
npm run backtest:fetch       # refresh backtest/data/inj_daily.json from Binance
```

## What you see

| Card | Content |
|---|---|
| **Decision** | HOLD / REDUCE LEVERAGE / ADD LEVERAGE / EXIT / DATA ERROR with the reason, the amounts (USD, INJ, wallet share, withdraw rounds), LTV/health after, and a step-by-step checklist with links to the Neptune app and Helix. |
| **Position** | Health, LTV, effective LTV, leverage, equity, collateral, debt, liquidation price, oracle age, interest per day, wallet gas/reserve. |
| **What happens next** | The INJ prices at which the next reduce/add/rung/exit/liquidation events sit, and how far they are from here. |
| **Trend filter** | 60-day sparkline with SMA, live price vs SMA, last daily close vs SMA, filter state and why. |
| **Price ladder** | All rungs with trigger/target LTVs and their health equivalents, current rung highlighted, effective thresholds after filters. |
| **Rates & pool** | Lend/borrow APRs, rate-guard state, USDC pool utilisation and free liquidity (the hard cap on how far a loop can scale). |
| **Settings** | The strategy JSON, LCD hosts. Stored in your browser only. |

## How it works

```
browser ──► Injective LCD (REST) ──► Neptune contracts (CosmWasm smart queries)
        ──► Binance / CoinGecko (daily candles for the SMA)
        ──► decide()  ──► buildPlan() + computeTriggers()  ──► UI
```

Everything runs client-side. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the exact contract queries in [docs/NEPTUNE-CONTRACTS.md](docs/NEPTUNE-CONTRACTS.md).

## Executing a step

The cockpit tells you *what* to do. You do it yourself in the Neptune app and on Helix, with your own wallet, one signature at a time. [docs/MANUAL-EXECUTION.md](docs/MANUAL-EXECUTION.md) walks through each action (repay, add, exit) with the checks to make before and after. Automated execution is deliberately out of scope for this project; see [docs/ROADMAP.md](docs/ROADMAP.md).

## Project layout

```
src/config      chain constants (contracts, assets, LCD hosts)
src/chain       LCD client with failover, Neptune status reader (fetch + pure parser)
src/market      daily candles + trend filter (pure computeTrend)
src/strategy    types + defaults, decide(), planner (amounts, rounds, triggers)
src/wallet      Keplr / Leap address-only connection
src/ui          React app (no UI library)
backtest        no-look-ahead simulator, runner, data
scripts         status-cli.ts
tests           vitest unit tests
docs            strategy, architecture, contracts, risks, manual execution, roadmap, FAQ
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # production build to dist/
```

CI runs typecheck, tests and build on every push and pull request; `main` is deployed to GitHub Pages by the `pages` workflow. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md).

## Status and disclaimer

Version 0.1.0. Built from the author's private, automated "Neptune Leitstand" that has run this strategy live since August 2026; this repository contains the strategy and the read-only cockpit, not the automation. The default parameters are the author's live parameters as of September 2026 and will not be tuned to look better in the backtest (see [docs/STRATEGY.md](docs/STRATEGY.md#backtest-honesty) for why that would be noise-fitting).

**This is not financial advice.** A leveraged loop on a volatile asset can lose everything, and has done so in most historical 12-month windows. Neptune Finance is a third-party protocol with its own smart-contract, oracle and governance risk. Use amounts whose total loss would not hurt you. The authors accept no liability. License: [MIT](LICENSE).
