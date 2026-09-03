# Neptune Finance: contracts and queries used

All addresses are Injective mainnet (`injective-1`) and come from the official docs at <https://docs.nept.finance/develop/contracts>. Cross-check on <https://injscan.com> before you trust a fork of this repository.

| Contract | Address | Used for |
|---|---|---|
| Market | `inj1nc7gjkf2mhp34a6gquhurg8qahnw5kxs5u3s4u` | user accounts (collateral/debt shares), all markets (debt pools, lending principal), all collaterals (pool balances, liquidation/allowable LTV) |
| Querier | `inj1kfjff5f0xjy7gece36watkqtscpycv666tqq7t` | account health |
| Oracle | `inj1u6cclz0qh5tep9m2qayry9k97dm46pnlqf8nre` | prices with timestamps |
| Interest model | `inj1ftech0pdjrjawltgejlmpx57cyhsz6frdx2dhq` | lend / borrow APRs |

The cockpit never calls the Token, Flashloan or nToken contracts and never sends a transaction.

## How a query is made

CosmWasm smart queries go through the LCD REST endpoint:

```
GET {lcd}/cosmwasm/wasm/v1/contract/{contract}/smart/{base64(json)}
```

Example (lending rates), which you can paste into a browser:

```
https://sentry.lcd.injective.network/cosmwasm/wasm/v1/contract/inj1ftech0pdjrjawltgejlmpx57cyhsz6frdx2dhq/smart/eyJnZXRfYWxsX2xlbmRpbmdfcmF0ZXMiOnt9fQ==
```

The response is `{ "data": <contract JSON> }`.

## Queries

### Account health (querier)

```json
{ "get_account_health": { "addr": "inj1…", "account_index": 0 } }
```
Returns a decimal string, e.g. `"1.852341"`. `1.0` = liquidation threshold. Neptune supports several sub-accounts per address; the cockpit uses index 0.

### Prices (oracle)

```json
{ "get_prices": { "assets": [ { "native_token": { "denom": "inj" } }, { "native_token": { "denom": "erc20:0xa00C…" } } ] } }
```
Returns `[[asset_info, { "price": "5.049…", "time_last_updated": "<unix ns>" }], …]`. The INJ timestamp drives the "oracle age" check. Pyth pushes roughly every 60 s; the cockpit treats > 600 s as stale (configurable). Neptune itself refuses withdraw/borrow once the oracle is older than 60 minutes.

### User accounts (market)

```json
{ "get_user_accounts": { "addr": "inj1…" } }
```
Returns `[[account_index, { "collateral_pool_accounts": [[asset_info, { "principal", "shares" }]], "debt_pool_accounts": [[asset_info, { "principal", "shares" }]] }]]`.

Positions are stored as **pool shares**. Amount = `shares × pool_balance / pool_shares` where the pool figures come from the two queries below. `principal` alone is stale (it ignores accrued interest / yield).

### All markets (market)

```json
{ "get_all_markets": {} }
```
Per asset: `debt_pool: { balance, shares }` and `lending_principal`. USDC utilisation = `debt_pool.balance / lending_principal`; free liquidity = `lending_principal − debt_pool.balance`. Borrowing halts near 95 % utilisation, and the PID rate model gets steep above ~85–88 %.

### All collaterals (market)

```json
{ "get_all_collaterals": {} }
```
Per asset: `collateral_pool: { balance, shares }` and `collateral_details: { liquidation_ltv, allowable_ltv, … }`. INJ: liquidation LTV 0.80, allowable (withdraw/borrow) LTV 0.78 at the time of writing. The cockpit reads both from the contract instead of hard-coding them and scales every threshold if the liquidation LTV changes.

### Rates (interest model)

```json
{ "get_all_lending_rates": {} }
{ "get_all_borrow_rates": {} }
```
Return `[[asset_info, "0.1043…"], …]` (APR as decimal).

### Bank balances (Cosmos SDK)

```
GET {lcd}/cosmos/bank/v1beta1/balances/{addr}?pagination.limit=1000
```
Used for wallet INJ (gas) and USDC/USDT (reserve).

## Assets

| Symbol | Denom | Decimals |
|---|---|---|
| INJ | `inj` | 18 |
| USDC | `erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a` | 6 |
| USDT | `peggy0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 |
| AUSD | `factory/inj1n636d9gzrqggdk66n2f97th0x8yuhfrtx520e7/ausd` | 6 |

Unknown denoms in a position are still counted (with a truncated denom as symbol); unknown denoms in the bank are ignored.

## Protocol facts that shape the strategy

Verified on-chain by the author in August 2026; re-verify before relying on them.

- **Health formula:** weighted collateral value / debt value. Liquidation at health < 1.0, first-come-first-serve, dynamic discount from `min_discount` up to `max_discount` (INJ up to ~10.5 %).
- **Partial vs full liquidation:** accounts with net collateral below `partial_liquidation_threshold` (~$1,000) are liquidated in full. Small loops therefore get no "partial" mercy.
- **Oracle validity:** prices older than 60 minutes block withdraw and borrow inside the contract. Repaying from wallet stablecoins keeps working. That is why the planner prefers wallet USDC.
- **Interest model:** PID controller on utilisation. Rates can jump within hours when the pool tightens; the rate guard exists for that.
- **Governance:** the protocol is upgradeable by a multisig (2-of-4 without timelock as of August 2026). A parameter change (e.g. a lower liquidation LTV) is detected by the cockpit through the contract values it reads every refresh, not by watching governance.
- **Pool size:** the USDC lending pool is small (tens of thousands of dollars free at the time of writing). It caps how far anyone can scale this loop; the cockpit shows the free amount and caps "add leverage" plans to it.
