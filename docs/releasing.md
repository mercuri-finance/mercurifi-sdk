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

## Accepted advisories

| Advisory | Package | Tree | Why accepted | Revisit |
|---|---|---|---|---|
| GHSA-82fw-gwwq-j7x9 | `@vitest/mocker` (via `vitest` 3.2.7) | dev only; not in the published package | the fix needs vitest 4.x, a major upgrade of the test runner; nothing in it reaches users, and CI never runs untrusted code under it | at the vitest 4 upgrade, and before every release |

CI and the npm release workflow run `npm audit --omit=dev --audit-level=high`, so any advisory in the runtime tree (viem and its dependencies) fails the build. A dev-tree advisory is added here, with a reason and a revisit point, or fixed.

## CI and release configuration (inert)

The workflows under `.github/workflows/` are written but have never run: there is no remote, `release-npm.yml` and `release-pypi.yml` trigger only on `workflow_dispatch`, and each publish job sits behind a GitHub environment (`npm-release`, `pypi-release`) that must require owner approval, plus an organisation and actor guard. Publishing uses npm trusted publishing with provenance and PyPI Trusted Publishing with attestations, so no long-lived token is stored anywhere.

`node scripts/check-workflows.mjs` (also run in CI) fails on an action not pinned to a 40-hex commit SHA, `pull_request_target`, a top-level `permissions` that is not exactly `contents: read`, `id-token: write` outside a release workflow, a checkout that keeps credentials, attacker-controlled event text in an expression, and any release trigger other than `workflow_dispatch`. `zizmor` (hash-pinned in `.github/ci-requirements.txt`) runs in CI at medium severity and above.

Hygiene notes (zizmor style):

- Third-party actions are pinned by SHA with the tag in a comment: `actions/checkout` v4, `actions/setup-node` v4 (both copied from the Launch web repository), `actions/upload-artifact` v4.6.2 and `pypa/gh-action-pypi-publish` v1.12.4 (dereferenced tag commits read with `git ls-remote`). Dependabot-style bumps are manual: re-resolve the SHA, then update the comment.
- Every checkout sets `persist-credentials: false`; no job needs write access to the repository.
- `id-token: write` appears only on the publish job of each release workflow.
- CI tools (`uv`, `zizmor`, `cyclonedx-bom`) install from `.github/ci-requirements.txt` with `--require-hashes --no-deps`. Regenerate it with the command in its header.
- Run steps use no `${{ }}` expressions from event data.

Before the first run, once the repository exists (checklist for the owner):

- [ ] Create the `npm-release` and `pypi-release` environments with required reviewers and a deployment branch rule.
- [ ] Configure the npm trusted publisher and the PyPI pending publisher (see Steps above).
- [ ] Re-resolve every pinned SHA against the new repository's allowed-actions policy; enable "require actions pinned to a full SHA".
- [ ] Confirm the `if:` guard (`mercuri-finance` / `mercurifinance`) matches the real organisation and publishing account.
- [ ] Run `zizmor` with a GitHub token (online audits such as impostor-commit and known-vulnerable-actions were skipped offline).
- [ ] Run `smoke:dist` on a runner with an empty cache: the wheel smoke test then installs from PyPI with `--require-hashes` (set `MERCURIFI_SMOKE_ONLINE=1`).
