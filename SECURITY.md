# Security

## Scope

This project is a static web page and a CLI. It holds no secrets, has no backend and never signs anything. The realistic attack surface is:

- a modified hosted copy that shows wrong recommendations,
- a dependency or build-chain compromise,
- a bug in the strategy math that leads a user to a bad trade.

## Reporting

Please open a GitHub issue for anything that is **not** exploitable against users (math bugs, wrong docs). For anything that could mislead users at scale (e.g. a way to make the page show a wrong LTV for an address, a supply-chain concern), use GitHub's private vulnerability reporting on this repository or contact the maintainer through the profile at <https://github.com/paddy-droid>. You will get a reply within a few days.

## Verifying a hosted copy

```bash
git clone https://github.com/paddy-droid/neptune-loop-cockpit.git
cd neptune-loop-cockpit && npm ci && npm run build
```

Compare the JavaScript bundle served by the host with `dist/assets/*.js`. The build is deterministic for a given lockfile and Node major version.

## What the wallet is asked

Only `enable('injective-1')` and `getKey('injective-1')`. If any build of this page ever asks you to *sign* something, it is not this project's default build. Reject it.

## Dependencies

Runtime: `react`, `react-dom`. Build/test: `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `tsx`, type packages. `npm audit` runs in CI as an informational step.
