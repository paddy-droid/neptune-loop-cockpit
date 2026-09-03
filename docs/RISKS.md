# Risks

Read this before you copy the strategy. None of these risks is solved by code, including this code.

## 1. You can lose everything

A leveraged long position on a volatile token has a liquidation price. From the default target band (LTV 40 %) the INJ price has to fall about 50 % before liquidation; from the repay trigger (LTV 56 %) about 30 %. INJ has moved that much in days. In the backtest, roughly 60 % of all 12-month windows since 2020 end with less than 20 % of the starting equity, and the loop beats simply holding the same INJ in only about a fifth of the windows. The upside is concentrated in one historical bull run. See [STRATEGY.md](STRATEGY.md#backtest-honesty).

## 2. Flash crashes are faster than you

The strategy's repay rule needs someone to act: you by hand, or the autopilot within its tick interval. A 30 % candle in minutes leaves no time to withdraw, sell and repay in rounds, and a 60-second tick is already slow compared with Neptune's automated liquidators. Keep the band conservative and keep a USDC reserve in your wallet: repaying from wallet stablecoins is the only action that works when the oracle is stale, needs no INJ sale, and is the first thing the autopilot does.

## 3. Protocol risk (Neptune Finance)

- Smart-contract bugs. Audits reduce, not remove, this risk.
- Oracle failure or manipulation. The contract blocks withdraw/borrow after 60 minutes of oracle silence; liquidations and oracle updates can land in the same block.
- Governance: an upgradeable multisig without timelock can change parameters (liquidation LTV, interest curve) or migrate contracts at any time. The cockpit reads the live values and flags a changed liquidation LTV, but a change can hit before you look.
- Bridge risk on USDC (ERC-20 bridged) and on any stablecoin.
- Pool liquidity: the USDC pool is small. In a crash the pool can be fully utilised, which blocks *withdrawing lent USDC* — money you parked in the lend side is not a reserve. Only wallet balances are.

## 4. Market microstructure

- Helix INJ/USDC order-book depth is limited. Selling a few thousand INJ in one market order can cost several percent. The planner assumes 1 % cost; check the book and use limit orders.
- Exchange prices can trade far below the oracle in a crash; the cockpit shows the exchange price and computes the "effective LTV" with it, but the contract still uses the oracle.

## 5. Interest

USDC borrow APR on Neptune has ranged from ~10 % to well above 30 % within weeks. At 16 % APR and LTV 40 %, the loop needs INJ to rise about 6 % a year net of trading costs just to break even against holding. The rate guard stops adding leverage at 25 % and de-levers at 35 % by default.

## 6. Operational risk (yours)

- Wrong network, wrong asset, wrong amount. Every step in [MANUAL-EXECUTION.md](MANUAL-EXECUTION.md) has a "verify" line for a reason.
- Running out of gas INJ in the wallet. Keep ≥ 0.5 INJ; the cockpit warns.
- Trusting a hosted copy of this page that someone modified. Build from source or compare the bundle hash.
- Sharing your screen or address publicly: the address alone reveals your entire position to anyone with this tool.

## 7. Data risk

The page depends on public LCD nodes and public price APIs. Any of them can be down, slow, rate-limited or wrong. The cockpit fails closed (no "add" without price history, no recommendation on implausible data), but "no recommendation" during a crash is not protection. If you rely on this page to manage risk, you are relying on third-party infrastructure you do not control.

## 8. Autopilot risk

The autopilot removes the delay between a rule and a trade. It does not remove the risk in the rule, and it adds a few of its own:

- **It sells INJ into weakness by design.** The reduce rule exists to prevent liquidation; in a V-shaped crash it will have sold near the low. That is the price of the buffer, not a bug. If you cannot accept it, run `repay-only`? No — `repay-only` still sells on the way down. If you cannot accept it, do not run a leveraged loop.
- **Execution risk.** Thin order books, a halted market, a stale oracle, a dead LCD host. The engine sizes orders by depth, protects with worst prices, verifies fills and cleans up after failures, but a partially executed round with INJ sitting in the wallet for a minute is a normal event. Read the log.
- **Session key risk.** A leaked session key can operate your loop within the grants until expiry (see SECURITY.md). Use short expiries; revoke when in doubt.
- **Runner risk.** A browser tab goes to sleep; a VPS reboots; a webhook silently fails. A bot that died is worse than no bot, because you stopped watching. Use a dead-man alert on the webhook side.
- **Two runners on one address** (browser + headless, two tabs, two machines) fight over interim state. Run exactly one.
- **Your acknowledgement is real.** Ticking the box in the panel means you have read this file.

## 9. What this project is not

- Not a signal service. The rules are mechanical and public; there is no forecast in them.
- Not audited by a third party. It is a tested, open-source tool built by one person, ported from a system that went through internal audit rounds.
- Not a custodian. Nobody but you holds a key that can move your funds.
- Not financial advice. Nobody involved is a licensed advisor.
