# Risks

Read this before you copy the strategy. None of these risks is solved by code, including this code.

## 1. You can lose everything

A leveraged long position on a volatile token has a liquidation price. From the default target band (LTV 40 %) the INJ price has to fall about 50 % before liquidation; from the repay trigger (LTV 56 %) about 30 %. INJ has moved that much in days. In the backtest, roughly 60 % of all 12-month windows since 2020 end with less than 20 % of the starting equity, and the loop beats simply holding the same INJ in only about a fifth of the windows. The upside is concentrated in one historical bull run. See [STRATEGY.md](STRATEGY.md#backtest-honesty).

## 2. Flash crashes are faster than you

The strategy's repay rule needs you (or, in the author's private setup, a bot) to act. A 30 % candle in minutes leaves no time to withdraw, sell and repay in rounds. Neptune's liquidators are automated; you are not. Keep the band conservative and keep a USDC reserve in your wallet: repaying from wallet stablecoins is the only action that works when the oracle is stale, and it needs no INJ sale.

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

## 8. What this project is not

- Not an automated bot. It does not watch your position while you sleep.
- Not a signal service. The rules are mechanical and public; there is no forecast in them.
- Not audited. It is a small, tested, open-source tool built by one person.
- Not financial advice. Nobody involved is a licensed advisor.
