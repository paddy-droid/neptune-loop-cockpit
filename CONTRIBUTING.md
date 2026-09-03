# Contributing

Thanks for looking. Small, well-tested changes are the easiest to merge.

## Ground rules

1. **The default build stays read-only.** No signing, no transaction building, no wallet permissions beyond the address. PRs that add execution will be closed with a pointer to [docs/ROADMAP.md](docs/ROADMAP.md).
2. **No backend, no telemetry, no third-party scripts.**
3. **Strategy changes need a backtest and a paragraph of reasoning.** Default parameters are not tuned to the backtest (see [docs/STRATEGY.md](docs/STRATEGY.md#backtest-honesty)); a PR that only "improves the numbers" is noise-fitting and will not be merged. New guards, new data checks and bug fixes in the math are welcome.
4. **Pure core.** Anything under `src/strategy`, `src/market/trend.ts (computeTrend)` and `src/chain/neptune.ts (buildStatus)` must stay side-effect free and unit-tested.

## Workflow

```bash
npm install
npm run typecheck
npm test
npm run build
```

- Branch from `main`, open a pull request. CI must be green.
- Keep formatting consistent with the existing code (2 spaces, no semicolons, single quotes). No formatter is enforced yet.
- Write comments for *why*, not *what*. The code base is meant to be read by people who want to verify the strategy.
- Update the docs when behaviour changes. `docs/STRATEGY.md` is the reference for rules, `docs/NEPTUNE-CONTRACTS.md` for anything on-chain.
- Add a line to `CHANGELOG.md` under *Unreleased*.

## Reporting bugs

Use the issue template. Include the address you looked at only if it is not yours or you do not mind it being public; a screenshot of the Position card and the decision reason is usually enough. Never paste seed phrases, private keys or wallet exports anywhere.

## Security issues

See [SECURITY.md](SECURITY.md).
