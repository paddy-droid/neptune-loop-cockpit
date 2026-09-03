# The strategy

This document is the reference for what the cockpit recommends and why. The code that implements it is [`src/strategy/policy.ts`](../src/strategy/policy.ts) (decision) and [`src/strategy/planner.ts`](../src/strategy/planner.ts) (amounts). If this document and the code disagree, the code is what runs; open an issue.

## 1. The position

- **Collateral:** INJ deposited on Neptune Finance.
- **Debt:** USDC borrowed against it.
- **Loop:** borrowed USDC is used to buy more INJ, which is deposited as well. Repeating this raises the loan-to-value ratio (LTV = debt / collateral value).

Key identities for INJ-only collateral and stablecoin debt (liquidation LTV `L` = 0.80 today, read from the contract):

| Quantity | Formula | Example at LTV 40 % |
|---|---|---|
| Health | `L / LTV` | 2.00 |
| Leverage | `1 / (1 − LTV)` | 1.67× |
| Liquidation price | `P × LTV / L` = `P / health` | −50 % from here |
| Price at which an LTV `x` is reached | `debt / (x × INJ)` | – |

Liquidation happens at health < 1.0. Accounts with net collateral below Neptune's partial-liquidation threshold (~$1,000) are liquidated completely.

## 2. The rulebook

### 2.1 Price ladder

The INJ oracle price selects a rung. Each rung has a **reduce** trigger/target; only the first rung (the *loop zone*) also has an **add** trigger/target.

| INJ price | Rung | Reduce leverage above LTV → to | Add leverage below LTV → to |
|---|---|---|---|
| ≤ $25 | Loop zone | 56 % → 48 % (health 1.43 → 1.67) | 36 % → 40 % (health 2.22 → 2.00) |
| $25–30 | Secure I | 57 % → 53 % | – |
| $30–36 | Secure II | 49 % → 45 % | – |
| $36–44 | Secure III | 40 % → 36 % | – |
| $44–52 | Half the debt | 28 % → 24 % | – |
| $52–62 | Secure IV | 18 % → 14 % | – |
| $62–75 | Pre-exit | 10 % → 6 % | – |
| > $75 | EXIT | sell everything into USDC | – |

The dollar rungs are the author's choice for a $6 INJ entry in 2026 (roughly 4×, 5×, 6×, 7×, 9×, 10×, 12× the entry). If you enter at a different level, scale them; the ladder is just a JSON array.

Why this shape:

- **Below $25** the loop is allowed to compound: when the price rises, LTV falls, and once it drops below 36 % the strategy borrows again up to 40 %. That is what turns a 1.7× position into the "×^1.9" convexity you see in the backtest.
- **Above $25** the strategy stops adding and steps the maximum LTV down rung by rung. Each reduce step sells INJ into strength and repays debt, so a reversal from the top hurts less. By $62–75 the debt is nearly gone.
- **The exit** needs the oracle *and* an exchange price above $75 with fresh data. A single oracle print above the mark never triggers a full sale.

### 2.2 The band ("Band E")

The loop-zone band is asymmetric on purpose: add at 36 → 40 %, reduce at 56 → 48 %. From the target (40 %) the price can fall 50 % before liquidation and 29 % before the first reduce step is due. A tighter band compounds a little faster in a bull run and gets liquidated by a single bad day; a wider band wastes the bull. In the backtest the reduce trigger is *return-neutral* within a wide range (0.46–0.68 gives 2.96×–3.37× mean), so its only job is crash buffer. That flat landscape is why the parameters are not sensitive and why tuning them is pointless (see §4).

### 2.3 Trend filter (SMA-50)

Rule: if the last **completed** daily close is below the 50-day simple moving average, or the live price is more than 5 % below it (panic band), then

- no adding, and
- the LTV is capped at 50 %: above 54 % the strategy reduces to 50 % (or to the rung target if that is lower).

Adding resumes only when both the last daily close and the live price are above the SMA (hysteresis: at most one state change per day, so a price oscillating around the line does not cause churn).

If no price history is available at all, the strategy never adds (fail-safe) and the reduce rules stay as in the ladder.

In the backtest the filter costs about 2 % of bull-run return and improves the median; its value is the cap, which turns "−80 % and liquidated" into "−80 % and alive" in the worst windows (lowest health seen with cap 50 %: 1.15; without any cap the same window reaches liquidation territory).

### 2.4 Interest-rate guard

Neptune's USDC borrow rate is set by a PID controller on utilisation and has moved between ~10 % and >30 % APR within weeks. Rules:

- USDC borrow APR ≥ 25 %: no adding.
- ≥ 35 %: de-lever to the 50 % cap (same mechanics as the trend cap).

### 2.5 Pool-capacity guard

USDC pool utilisation ≥ 85 %: no adding. Above that, the rate curve gets steep and borrowing halts near 95 %. The planner additionally caps an "add" plan to the free liquidity in the pool.

### 2.6 Data checks (before any recommendation)

- Any NaN in price, health, collateral, debt or LTV → DATA ERROR.
- Oracle price 0 or missing → DATA ERROR.
- With ≥ 95 % INJ collateral, `health × LTV` must equal the contract's liquidation LTV within 0.03; otherwise DATA ERROR (oracle gap, unknown collateral, or a parameter change).
- Oracle older than 10 minutes → DATA ERROR, with one exception: if a *fresh* exchange price (< 3 min) shows the LTV above the reduce trigger, the recommendation is a **protective reduce** using the exchange price. The contract still values the collateral at the stale (higher) oracle price, so a repay now is both possible and right.
- Liquidation LTV changed from 0.80 → every threshold is scaled by `new / 0.80` and adding is blocked until the ladder is reviewed.
- Debt in USDT/AUSD instead of USDC → warning only; the plan assumes USDC.

### 2.7 Exchange price as reference

If a fresh exchange price is more than 0.5 % below the oracle, the reduce trigger is evaluated with the higher "effective LTV" (`ltv × oracle / exchange`, capped at +15 %). The planner also uses the lower price for amounts. Rationale: in a crash the oracle lags, and the market is where you will actually sell.

### 2.8 Modes

- `full`: everything above.
- `repay-only`: never add, all reduce/exit rules active. Use this if you want the safety net without the compounding.
- `off`: no recommendations.

## 3. What the planner adds

Given a decision, the planner computes:

- **Reduce:** repay `x = (debt − t·coll) / (1 − t)` USD to reach target `t`. Wallet USDC first (needs no INJ sale and works with a stale oracle). The rest via withdraw → sell → repay, in rounds if a single withdraw would push the interim LTV above 70 % (the contract refuses above 78 %). INJ to sell includes a 1 % cost assumption.
- **Add:** borrow `x = (t·coll − debt) / (1 − t)` USD, buy `x/P` INJ (minus 1 %), deposit. Capped to the pool's free liquidity.
- **Exit:** repay everything (wallet USDC first), withdraw and sell the rest, keep ~1.5 INJ for gas.
- **Triggers:** the INJ prices at which the reduce trigger, the add trigger, the next rung, the exit and the liquidation are reached, assuming the position does not change.

## 4. Backtest honesty

The repository ships a simulator (`npm run backtest`) and the INJ daily history since Binance listing (Oct 2020). Results for the default configuration, rolling 12-month windows, starting from a generic position of 1,000 INJ collateral and $2,700 debt (LTV ≈ 45 %) with every window rescaled to INJ = $5.93 (equity ≈ $3,200), 16 % APR, 1 % trade cost, run on 2026-09-03:

| Statistic | Loop (default) | Hold the same equity in INJ, no leverage |
|---|---|---|
| Windows | 1,711 | 1,711 |
| Mean multiple | 3.29× | 2.49× |
| Median multiple | 0.09× | 0.54× |
| Windows ending with < 20 % of the equity | 61 % | – |
| Simulated liquidations | 0 | – |
| Loop beats the unleveraged hold | 23 % of windows | – |
| Bull windows (INJ ≥ 3× in 12 months): share / loop mean / loop median | 24 % / 12.7× / 6.9× | – |
| Modest-bull windows (INJ 1.3–3×): loop mean / median / share below 1× | 1.58× / 1.67× / 44 % | – |
| Down windows (INJ < 1×): loop median / hold median | 0.03× / 0.36× | – |

The multiples are scale-free: a position ten times larger produces the same table until the USDC pool's free liquidity becomes the limit.

Read that table as follows:

1. **The loop is a lottery ticket with a positive mean.** All of the advantage over holding sits in the arithmetic mean and comes from the bull windows. In the median window it loses ~90 % of the equity; holding loses ~45 %.
2. **The bull windows are one event.** Consecutive windows overlap by 364 of 365 days. There are about five independent 12-month observations in the data and every bull window is a slice of the same 2022→2024 move. The standard error on "24 % of windows are bull windows" is on the order of ±19 percentage points.
3. **Do not tune parameters with this.** Roughly thirty free parameters against five observations: any "improvement" from moving a trigger by two points is fitted noise. The simulator is useful for two questions only — *what order of magnitude?* and *does the strategy fall apart when a parameter moves?* (it does not: the landscape is flat, and no parameter has its optimum exactly at the live value).
4. **Zero simulated liquidations is not zero real liquidations.** The simulator assumes you act at every intraday step. A human acting once a day would have been liquidated in several windows. Read [RISKS.md](RISKS.md).
5. **Costs matter less than path.** Removing interest and slippage from the simulation barely changes the medians; the loss in flat and down markets is volatility drag plus the cap, not fees.

The named windows (`npm run backtest` without flags) show the same picture in detail: the 2021 and 2023 bull runs end in an exit at roughly 35× the starting equity; sideways ends near zero; both bear windows end at zero equity but alive.

## 5. Where the defaults came from

The author runs this strategy live with an automated executor (private) since August 2026 and arrived at "Band E" after ten internal audit rounds with independent reviewers. The parameters in this repository are those live parameters, unchanged. They will be updated here only when the live strategy changes for a reason that is not "the backtest said so".

## 6. Changing it

Edit the JSON in the cockpit's settings (validated: rungs ascending, targets not above triggers, add target below reduce target), or edit `DEFAULT_STRATEGY` in `src/strategy/types.ts` and run the tests. Put your ladder into `backtest/run.ts` to see its shape across the windows. Then re-read §4.
