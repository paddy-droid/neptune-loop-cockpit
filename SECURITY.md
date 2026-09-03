# Security

## Scope

A static web page, a CLI and an optional headless runner. There is no backend. The page never stores or asks for your wallet's private key or seed. The realistic attack surface:

- a modified hosted copy that shows wrong recommendations or asks your wallet to sign something else,
- a leaked **session key** (browser storage or the runner's key file),
- a dependency or build-chain compromise,
- a bug in the strategy or execution maths that leads to a bad trade.

## What the wallet is asked

- Read-only use: `enable('injective-1')` and `getKey('injective-1')`, nothing else.
- Autopilot in confirm mode: one signature per transaction, each shown by your wallet with its messages.
- Session mode: **one** grant transaction containing three messages (`MsgGrant` with `ContractExecutionAuthorization` for the Neptune market contract and four message keys, `MsgGrant` with `CreateSpotMarketOrderAuthz` for two Helix markets, `MsgGrantAllowance` of 0.5 INJ), and later one revoke transaction. If any build of this page asks you to sign a `MsgSend`, a generic authorization for *any* message type, or a grant to an address you did not create, reject it.

## Session key threat model

- The session key never holds funds. It signs `MsgExec`; the messages inside execute as you, limited by the grants, and expire with them.
- If it leaks, an attacker can operate your loop within those limits until expiry or revoke: de-lever you at a bad price, or sell your withdrawn INJ into USDC that stays in *your* wallet. They cannot transfer anything out, stake, vote, or touch other contracts.
- Defaults reduce exposure: `sessionStorage` (dies with the tab) unless you opt into `localStorage`, short expiries offered first, call limit, revoke button, grants displayed live from the chain.
- The headless runner's key file has the same power as the browser key. Treat it like a wallet key for the duration of the grant (`chmod 600`, no repositories, no chats).

## Verifying a hosted copy

```bash
git clone https://github.com/paddy-droid/neptune-loop-cockpit.git
cd neptune-loop-cockpit && npm ci && npm run build
```

Compare the JavaScript served by the host with `dist/assets/*.js`. The build is deterministic for a given lockfile and Node major version.

## Reporting

Open a GitHub issue for anything that is not exploitable against users (math bugs, wrong docs). For anything that could mislead users or move funds (a way to make the page show a wrong LTV, a path that signs more than documented, a supply-chain concern), use GitHub's private vulnerability reporting on this repository or contact the maintainer through <https://github.com/paddy-droid>. You will get a reply within a few days.

## Dependencies

Runtime: `react`, `react-dom`, and for the autopilot chunk `@injectivelabs/sdk-ts`, `wallet-core`, `wallet-strategy`, `wallet-base`, `networks`, `utils`, `ts-types`, `core-proto-ts-v2`. Build / test: `vite`, `typescript`, `vitest`, `tsx`. `npm audit` runs in CI as an informational step. The Injective packages are pinned to one version line in `package.json`.
