# Releasing

## Approvals

Each publish needs its own explicit owner approval. Publish only from the release workflows, under the project's own GitHub identity (`mercurifinance`), never from a laptop.

## Steps

1. The owner creates the GitHub repository under the `mercuri-finance` organisation and pushes as `mercurifinance`.
2. The owner creates the npm org `mercurifi` and configures the trusted publisher for `@mercurifi/sdk` (repository, workflow `release-npm.yml`, environment `npm-release`).
3. The owner configures the PyPI pending publisher for `mercurifi` (repository, workflow `release-pypi.yml`, environment `pypi-release`).
4. Bump the versions in `package.json`, `src/version.ts`, `pyproject.toml` and `_version.py`.
5. Record the factory addresses and code hashes in both address books, only from an owner-approved deployment record.
6. Run CI.
7. Dispatch the release workflows; the environment needs owner approval.
8. Verify provenance per [verify-provenance.md](verify-provenance.md).

## Open point

npm may require the package to exist before a trusted publisher can be configured. If so, the first publish is a manual, owner-run placeholder publish with a short-lived granular token and 2FA. Decide this with the owner at publish time.
