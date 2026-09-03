# Executing a recommendation by hand

The cockpit produces one of five outcomes. This page explains what to do for each, with the checks that keep a manual execution from going wrong. Use it when you run without the autopilot, or as the fallback when the autopilot reports DATA ERROR or ABORTED (see [AUTOPILOT.md](AUTOPILOT.md)). You sign every transaction yourself in your wallet.

Apps used:

- **Neptune app** — <https://app.nept.finance> (deposit / withdraw collateral, borrow / repay)
- **Helix** — <https://helix.app/spot/inj-usdc> (INJ/USDC spot market)
- **Your wallet** — Keplr or Leap on Injective

Before every session:

1. Reload the cockpit and make sure the data is fresh (green pill in the header, oracle age under a few minutes).
2. Check the wallet has ≥ 0.5 INJ for gas (the Position card shows it).
3. Read the **warnings** in the decision card. An "oracle gap" or "oracle old" warning changes what you should do.

---

## HOLD

Nothing to do. Note the prices in **What happens next**: they tell you at which INJ price the next reduce or add is due. Set a price alert there if your exchange offers one.

## REDUCE LEVERAGE (repay)

Goal: bring the LTV from above the trigger down to the target (default 56 % → 48 %, or 54 % → cap 50 % / 48 % when the trend filter or the rate guard is active).

The card shows: **Repay $X**, of which **from wallet USDC $W**, **Sell N INJ**, **Withdraw rounds R**, LTV and health after.

1. **Repay from wallet USDC first** (if you hold any). Neptune app → your position → *Repay* USDC → enter $W → sign. This step works even when the oracle is stale. Verify the debt went down.
2. If more is needed: **Withdraw INJ** (Neptune app → *Withdraw collateral*). Take the amount from the first "Withdraw" step; the contract rejects a withdraw that would push the LTV above 78 %, the cockpit stays below 70 %. Verify the INJ arrived in your wallet.
3. **Sell the INJ for USDC on Helix.** Use a limit order at or slightly below the best bid; check the order-book depth in the ±2 % range. The plan assumes 1 % cost. Do not market-sell a large amount into a thin book. Verify the USDC balance.
4. **Repay USDC** on Neptune with the proceeds. Verify.
5. If the card said R > 1 rounds: reload the cockpit and repeat from step 2 with the new numbers until the decision says HOLD.
6. Final check: LTV and health match the "after" numbers within a percent.

Never leave withdrawn INJ sitting in the wallet unsold: it is no longer collateral, so your LTV is *higher* than before the withdraw until you repay.

## ADD LEVERAGE (borrow → buy → deposit)

Only shown below $25 in the loop zone, when the trend filter is inactive, the rate guard is calm and the pool has capacity. Goal: LTV from below the add trigger (36 %) up to the target (40 %).

The card shows **Borrow $X**, **Buy N INJ**, LTV/health after.

1. **Borrow USDC** on Neptune (app → *Borrow*). The interim LTV after borrowing is shown in the step; it must stay below 78 %. Verify the USDC arrived.
2. **Buy INJ on Helix** with a limit order not more than ~2 % above the oracle price shown in the Position card. In tranches if the book is thin.
3. **Deposit the INJ** as collateral on Neptune. Leave ≥ 0.5 INJ in the wallet.
4. Reload the cockpit: LTV ≈ 40 %, decision HOLD, and "What happens next" shows the new triggers.

If between step 1 and 3 the price moves a lot, stop and reload the cockpit before continuing. Borrowed USDC that is not yet converted is a *lower*-risk state than the target, not a problem.

## EXIT

Shown above $75 (default) when both the oracle and the exchange price confirm it. Goal: zero debt, zero collateral, everything in USDC.

1. Repay from wallet USDC if any.
2. Withdraw → sell → repay in rounds (the card shows how many) until the debt is zero. Above $75 the LTV is tiny, so one or two rounds suffice.
3. Withdraw the remaining collateral and sell all but ~1.5 INJ (gas).
4. Verify debt 0 and collateral 0 in the Neptune app.

What you do with the USDC afterwards (lend it, bridge it, hold it) is outside the strategy.

## DATA ERROR

Do nothing. The card says why (stale oracle, implausible collateral factor, missing price). Reload in a minute. If the error persists for more than an hour during a market move, the only safe action available is **repay from wallet USDC**: it needs no oracle and no withdraw.

---

## Checklist card (print it)

```
[ ] cockpit fresh, oracle age < 5 min, no DATA ERROR
[ ] wallet gas >= 0.5 INJ
[ ] action + amounts written down: ______________________
[ ] step 1 done + verified (balance / debt changed as expected)
[ ] step 2 done + verified
[ ] step 3 done + verified
[ ] reload cockpit: LTV ____ % health ____  decision HOLD?
```
