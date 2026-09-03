# Roadmap

Principle: the read-only core stays read-only. Anything that signs transactions lives behind an explicit opt-in and never in the default build.

## Done (0.1.0)

- Keplr / Leap address-only connection, watch-only mode, demo mode
- Neptune status reader with LCD failover
- Strategy engine: ladder, band, SMA trend filter with hysteresis and panic band, rate guard, pool guard, liquidation-LTV scaling, oracle/plausibility checks, exchange-price reference
- Planner: amounts, wallet-first repay, withdraw rounds, LTV/health after, next-event prices
- Editable strategy JSON with validation, stored locally
- CLI (`npm run status`), backtest (`npm run backtest`), 60+ unit tests, CI, GitHub Pages deploy
- Documentation: strategy, architecture, contracts, risks, manual execution, FAQ

## Next

- **Price alerts without a backend.** Browser notifications while the tab is open ("repay trigger within 5 %"). No push service, no server.
- **Position history.** Store a daily snapshot of LTV/health/equity in localStorage and draw it; optional CSV export.
- **Multi-collateral awareness.** Today the math assumes INJ-only collateral; other collateral is shown but the plausibility check switches to warn-only. A weighted-LTV version would remove that limitation.
- **More rungs presets.** Ship two or three alternative ladders (conservative / default / aggressive) as importable JSON, each with its backtest table.
- **Backtest UI.** Run the simulator in the browser with the currently edited config and show the window table next to the settings.

## Deliberately not planned

- **Automated execution in this repository.** The author's private system does that with a hot key, a mutex, a watchdog, alerting and nine audit rounds. Reproducing it "as a feature" without that surrounding discipline would hand users a footgun. If a signing mode ever lands, it will be a separate package, opt-in, simulate-first, with a mandatory confirmation of every message and its own threat model.
- **Any server component.** No accounts, no stored addresses, no analytics.
- **Parameter tuning by backtest.** The independent-observation count is too small; see STRATEGY.md.
