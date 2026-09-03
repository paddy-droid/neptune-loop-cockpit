# FAQ

**Does connecting my wallet give this page control over my funds?**
No. It calls `enable()` and `getKey()` only, which reveal the address and the account name. There is no signer request. You can verify this in `src/wallet/keplr.ts` (40 lines). Watch-only mode does not talk to a wallet at all.

**Why does it need an exchange price when Neptune has an oracle?**
Two reasons. The SMA trend filter needs daily history, which the oracle does not provide. And in a crash the oracle can lag the market; the cockpit computes an "effective LTV" with the lower exchange price so the repay warning comes earlier, and it refuses a full exit on an oracle print that the exchange does not confirm.

**The page says DATA ERROR. Is my position in danger?**
Not necessarily. DATA ERROR means the inputs are not trustworthy (stale oracle, implausible health×LTV, missing price). The safe reaction is to not act on this page's numbers. Check the Neptune app directly. If you must reduce risk while the oracle is stale, repaying from wallet USDC always works.

**Why does the add trigger show "paused"?**
One of: trend filter active (daily close below the SMA), live price below the SMA (hysteresis), no price history, USDC borrow APR ≥ 25 %, pool utilisation ≥ 85 %, liquidation LTV changed, mode is `repay-only`, or the price is above $25 (no adding outside the loop zone). The reason is printed next to it.

**Can I use a different band or ladder?**
Yes. Settings → edit the JSON → Save. It is validated (rungs ascending, targets below triggers, add target below repay target so it cannot oscillate). Back-test it: copy your ladder into `backtest/run.ts` or import it there, and run `npm run backtest`. Do not expect the backtest to tell you which of two similar bands is "better"; it cannot, see STRATEGY.md.

**Why is my health different from Neptune's UI by a little?**
The cockpit reads the same contract, but the UI may refresh at a different moment and the oracle updates about once a minute. Differences of a percent are timing. Larger differences mean the account holds collateral or debt this tool does not price; check the Position card's asset list.

**Does it work for other collateral than INJ?**
It reads any collateral, but the strategy math (health = 0.8 / LTV, liquidation price, planner) assumes INJ-only collateral with stablecoin debt. With mixed collateral the plausibility check becomes warn-only and the plan's INJ amounts are approximations.

**Does it work on testnet?**
Not out of the box. Change `CHAIN_ID`, the LCD hosts and the contract addresses in `src/config/chain.ts`.

**Can I run it without the internet reaching Binance?**
The trend data falls back from Binance to its public mirror and then to CoinGecko. If all fail, the cockpit still shows the position and the repay rules but never recommends adding leverage.

**How do I host it myself?**
`npm run build`, upload `dist/` to any static host. No environment variables. For a sub-path, build with `BASE_PATH=/your-path/`.

**Is there a token, a fee, a referral link?**
No.

**Who built this and why is it free?**
The author runs this loop privately with an automated system and wanted the *strategy* to be inspectable, testable and usable by others without handing anyone keys. The automation stays private on purpose; see ROADMAP.md.
