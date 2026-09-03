# Backtest

```bash
npm run backtest              # named windows, six variants side by side
npm run backtest -- --rolling # every 12-month window since Oct 2020
npm run backtest:fetch        # refresh data/inj_daily.json from Binance (INJUSDT, 1d)
```

## What the simulator does

`sim.ts` walks each day as an intraday path (open → nearer extreme → farther extreme → close) in 24 steps and applies the ladder at every step: repay above the trigger, add below the add trigger (at most once per quarter day), exit on the exit rung. The trend filter uses the SMA of **completed** days only, with the same hysteresis and 5 % panic band as the live policy. Interest accrues daily at a flat APR (16 % default), every trade costs 1 %.

Windows are rescaled so the first live day equals the last price in the data set; that makes the ladder's dollar rungs comparable across years.

## What it does not do

- No oracle staleness, no pool capacity, no rate guard (the APR is constant).
- No liquidation mechanics beyond "LTV ≥ 0.80 = total loss".
- No slippage curve; the cost is flat.
- It is a **strategy-shape** test, not a forecast.

## Reading the output

`216k / DD 56% / EXIT / minH 1.383` means: final equity $216k, max drawdown 56 %, the strategy exited above $75, and the lowest health along the way was 1.383. `LIQ` means liquidated.

Before you compare variants, read `docs/STRATEGY.md#backtest-honesty`: the rolling windows overlap by 364 of 365 days, there are about five independent observations and exactly one independent bull run in the data. The simulator answers "does the strategy fall apart if a parameter moves?" (no) and "what order of magnitude?" — not "is 0.48 better than 0.50".

## Data

`data/inj_daily.json`: `[{ t: 'YYYY-MM-DD', o, h, l, c }, …]`, Binance INJUSDT daily candles from listing (2020-10-21). The file is committed for reproducibility; refresh it with the fetch script.
