# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-03

Autopilot.

### Added
- Execution engine (`src/execution/engine.ts`) ported from the author's production executor: reduce / add / exit as verified rounds under an interim-LTV cap (70 %, small steps up to 77 %), reserve-first repayment, depth-sized market orders with VWAP-based worst prices, fill verification with partial-fill handling, clear-rejection retry vs unclear-outcome wait, lost-withdraw reconciliation, cleanup on failure, time budget, cooperative stop.
- Tick orchestration (`src/execution/autopilot.ts`): guards (buy cooldown, hold check), continue-deferred-reduce, protocol fingerprint lock, pause semantics, idle orphan-INJ cleanup, throttled alerts.
- Signers: wallet confirm mode (Keplr / Leap via `@injectivelabs/wallet-core`) and session mode (`MsgExec` signed by a browser-generated key, gas via feegrant); sequence-mismatch retry and sequence-proof for unclear broadcasts.
- Session grants: `ContractExecutionAuthorization` scoped to the Neptune market contract and four message keys with a call limit, `CreateSpotMarketOrderAuthz` for INJ/USDC and USDC/USDT, `BasicAllowance` 0.5 INJ; one grant transaction, one revoke transaction, live grant status from the LCD.
- Browser runner with Web Locks single-tab guarantee, localStorage state and log, browser notifications and ntfy-style webhook alerts; Autopilot panel in the UI.
- Headless runner `npm run autopilot` (+ `npm run session` key generator) with `--dry-run`, `--once`, `--webhook`, `--strategy`, `--state`.
- Fault-injection mock chain and 51 new tests (engine scenarios, tick orchestration, grants, order-book maths).
- `docs/AUTOPILOT.md`; README, SECURITY, RISKS, FAQ, ROADMAP, CONTRIBUTING updated.

### Changed
- `Status` now carries the raw collateral share figures needed to build withdraw messages.
- The Injective SDK is loaded lazily; the read-only page stays a ~290 kB bundle.

## [0.1.0] - 2026-09-03

First public release.

### Added
- Read-only cockpit: Keplr / Leap address-only connection, watch-only mode (`?address=`), demo mode (`?demo=1`).
- Neptune Finance status reader over the Injective LCD with three-host failover (collateral, debt, health, oracle age, liquidation/allowable LTV, USDC pool utilisation and free liquidity, wallet balances).
- Strategy engine ported from the author's live system: price ladder (default "Band E"), health band, SMA-50 trend filter with hysteresis and 5 % panic band, USDC rate guard (25 % / 35 %), pool-capacity guard (85 %), liquidation-LTV scaling, oracle-staleness and collateral-factor plausibility checks, exchange-price reference for the repay trigger, exchange confirmation for the exit.
- Planner: repay / add / exit amounts in USD and INJ, wallet-first repay, withdraw rounds under the interim LTV cap, LTV / health / leverage after, next-event prices (reduce, add, next rung, exit, liquidation).
- Editable strategy JSON with validation, persisted in localStorage; LCD host override.
- CLI `npm run status -- inj1…` (text or `--json`).
- Backtest: no-look-ahead intraday simulator, named windows and rolling 12-month statistics, Binance data refresh script.
- 60+ vitest unit tests, GitHub Actions CI (typecheck, test, build) and GitHub Pages deployment.
- Documentation: README (EN + DE summary), STRATEGY, ARCHITECTURE, NEPTUNE-CONTRACTS, RISKS, MANUAL-EXECUTION, ROADMAP, FAQ, CONTRIBUTING, SECURITY.

[Unreleased]: https://github.com/paddy-droid/neptune-loop-cockpit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/paddy-droid/neptune-loop-cockpit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/paddy-droid/neptune-loop-cockpit/releases/tag/v0.1.0
