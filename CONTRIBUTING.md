# Contributing

This public repository owns the Mercurifi Agent Accounts SDKs: the TypeScript package (`@mercurifi/sdk`) and the Python
package (`mercurifi`), their tests, fixtures and release workflows. Only the maintainer can write to it: every branch
and tag is protected, and every change is reviewed by the code owner. Pull requests are reviewed, but merging one never
publishes a release; each release needs its own approval.

## What is welcome

- **Security reports**, privately, through **Security → Report a vulnerability**. See [`SECURITY.md`](SECURITY.md).
- **Issues** for anything else you find: a call that behaves differently from its documentation, a difference between
  the TypeScript and Python packages, an example that does not run, a link that does not resolve, an integration
  question. Include the package version, your Node or Python version and, for on-chain behaviour, a transaction hash.
  Never paste a private key, an API key or a keyed RPC URL.
- **Corrections to the documentation** are welcome as issues too; they are folded into the next update.

## What a change needs

- **Both languages.** The two packages expose the same operations with the same checks and the same errors. A change to
  one comes with the matching change to the other, and the shared vectors in `fixtures/` keep them honest.
- **Tests.** `cd packages/typescript && npm test && npm run typecheck`, and `cd packages/python && uv run pytest`. A
  change that touches transactions also passes the Anvil tier (see the README's Local development).
- **Formatting.** Prettier is the standard for TypeScript, JavaScript, Markdown and JSON (`.prettierrc.json`; code at 100 columns, examples and Markdown at 80). Run `npm run format` in `packages/typescript`; CI runs `npm run format:check`. Python uses `ruff format` at 100 columns (`uv run ruff format .` in `packages/python`; CI runs `--check`). In examples and README snippets, leave a blank line between statements so each step reads on its own.
- **No new runtime dependency** without a reason recorded in the pull request: the TypeScript package depends on viem
  only, the Python package on `eth-account`, `eth-abi`, `eth-utils` and `httpx`.
- **Workflows.** `node scripts/check-workflows.mjs` must pass; actions are pinned by commit, and the release jobs keep
  their single form (see [`docs/releasing.md`](docs/releasing.md)).

## Building

```sh
git clone https://github.com/mercuri-finance/mercurifi-sdk.git
cd mercurifi-sdk/packages/typescript && npm ci && npm run build && npm test
cd ../python && uv sync && uv run pytest
```
