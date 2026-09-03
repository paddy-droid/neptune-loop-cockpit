# Roadmap

Principle: read-only by default, execution only behind an explicit start with an acknowledgement, and never a stored owner key.

## Done

**0.1.0** — read-only cockpit: Keplr / Leap address-only connection, watch-only and demo modes, Neptune status reader with LCD failover, strategy engine (ladder, band, SMA trend filter with hysteresis and panic band, rate guard, pool guard, liquidation-LTV scaling, oracle / plausibility checks, exchange-price reference), planner (amounts, wallet-first repay, withdraw rounds, next-event prices), editable strategy JSON, CLI, backtest, tests, CI, GitHub Pages, documentation.

**0.2.0** — autopilot: execution engine ported from the production system (rounds under an interim-LTV cap, reserve-first, depth-sized orders with worst-price protection, fill verification, unclear-outcome protocol, cleanup), tick orchestration with guards and alerts, two signing modes (wallet confirm / session key with scoped authz + feegrant), browser runner with single-tab lock, headless Node runner, fault-injection mock chain with 40+ execution tests.

## Next

- **Live acceptance log.** Document the first real executions (author's account, small target) with tx hashes in `docs/ACCEPTANCE.md`, then lift the "not yet with real transactions by anyone but the author" note.
- **Price alerts without a backend.** Browser notifications while the tab is open ("reduce trigger within 5 %"), independent of the autopilot.
- **Position history.** Daily snapshot of LTV / health / equity in localStorage with a chart; CSV export.
- **Multi-collateral awareness.** Weighted-LTV maths so that mixed collateral is handled instead of warned about.
- **Ladder presets.** Conservative / default / aggressive ladders as importable JSON, each with its backtest table.
- **Backtest UI.** Run the simulator in the browser with the currently edited config.
- **Runner packaging.** A Dockerfile and a `systemd` unit for the headless runner; health endpoint for dead-man checks.
- **Trade-history cooldown.** Read the account's own Helix trades for the cooldown guard instead of local state (survives restarts).

## Deliberately not planned

- **Any server component.** No accounts, no stored addresses, no analytics, no relay.
- **Storing the owner's key anywhere.** The only key the app ever holds is a session key with expiring, scoped grants.
- **Parameter tuning by backtest.** The independent-observation count is too small; see STRATEGY.md.
- **Limit-order or derivative permissions in the session grant.** Market orders on two spot markets are all the loop needs.
