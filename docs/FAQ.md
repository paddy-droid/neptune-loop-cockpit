# FAQ

**Does connecting my wallet give this page control over my funds?**
Not by itself. Connecting calls `enable()` and `getKey()` only, which reveal the address and the account name (`src/wallet/keplr.ts`, 40 lines). Only when you start the **autopilot** does the page ask your wallet to sign: either every transaction (confirm mode) or one grant transaction for a session key (session mode). Watch-only mode never talks to a wallet.

**How automated is the autopilot?**
Fully, within its rules: every tick it decides, guards and executes reduce / add / exit steps as separate transactions. In the browser it runs while the tab is open; the headless runner (`npm run autopilot`) runs 24/7 on any machine with Node. See docs/AUTOPILOT.md.

**What can the session key do?**
Call the Neptune market contract with `withdraw_collateral`, `return`, `borrow`, `deposit_collateral`; place market orders on Helix INJ/USDC and USDC/USDT for your default subaccount; pay gas from a 0.5 INJ allowance. All as you, all expiring together, revocable in one transaction. It cannot send funds anywhere, cannot touch other contracts or markets.

**Can I run the autopilot for someone else's address?**
No. The engine checks that the signer's account equals the position's address on every tick, and a session key only works with grants from that address.

**What if the autopilot dies during a reduce?**
Every step is verified against the bank balance and the engine cleans up after failures (sells withdrawn INJ, repays proceeds). If the process itself is killed mid-round, withdrawn INJ may sit in your wallet: the next tick sells it first ("pile") or, once the LTV is fine, deposits it back as collateral. Nothing is lost, but your LTV is briefly higher than it should be. Use a supervisor and a webhook.

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
The author runs this loop privately with an automated system and wanted the strategy and its executor to be inspectable, testable and usable by others without anyone handing over a wallet key. The session-key model is how that squares with automation.
