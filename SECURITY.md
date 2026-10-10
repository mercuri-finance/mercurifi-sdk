# Security

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. The report is visible only to
the maintainers until a fix is released and disclosed. Please do not open a public issue for anything that could be
exploited, and never post a private key, an API key or an RPC URL with a key in it, in a report or anywhere else.

Include the package and version (`@mercurifi/sdk` or `mercurifi`), the function, the chain (testnet 5042002, mainnet
5042 or a local chain), a transaction hash or a minimal script that shows the behaviour, and what you think the impact
is. You will get an acknowledgement within 48 hours and updates as the fix moves.

## Supported versions

The latest beta of each package. Fixes ship as a new version through the release workflows; a published version is
never replaced.

## Scope

The TypeScript package in `packages/typescript`, the Python package in `packages/python`, the address books and code
hashes they carry, and the release workflows in `.github/workflows`. In particular:

- anything that makes the SDK sign or send a transaction other than the one the caller asked for, or skip a check it
  documents (network, address book, runtime code hash, slippage, caps);
- a key, an API key or a keyed RPC URL reaching an error, a log line, a serialised object or the network;
- a published file whose provenance does not match this repository and its workflows.

Out of scope: the contracts, which are in
[mercuri-agent-contracts](https://github.com/mercuri-finance/mercuri-agent-contracts/blob/main/SECURITY.md) and have
their own policy; the web app, the API and the hosting; and losses inside the caps an owner set for a key that was
stolen from the owner's own systems, which the security model bounds rather than prevents.

## Trust

The threat model, what the caps do and do not protect, and who else holds power over an account are in
[docs/security-model.md](docs/security-model.md). How to check that a package came from this repository is in
[docs/verify-provenance.md](docs/verify-provenance.md).
