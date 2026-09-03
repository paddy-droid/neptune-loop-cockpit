# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/paddy-droid/neptune-loop-cockpit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/paddy-droid/neptune-loop-cockpit/releases/tag/v0.1.0
