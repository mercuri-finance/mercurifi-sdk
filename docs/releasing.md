# Releasing

## Approvals

Each publish needs its own explicit owner approval. Publish only from the release workflows, under the project's own GitHub identity (`mercurifinance`), never from a laptop.

## Steps

1. The owner creates the GitHub repository under the `mercuri-finance` organisation and pushes as `mercurifinance`.
2. **Before anything dispatches a release workflow**, the owner creates the `npm-release` and `pypi-release` environments with required reviewers (the owner) and a deployment branch rule limited to `main`. A workflow that references an environment which does not exist yet makes GitHub create it on the first run **with no protection rules**, so that first run would publish without approval.
3. The owner creates the npm org `mercurifi` and configures the trusted publisher for `@mercurifi/sdk`: repository `mercuri-finance/<repo>`, workflow `release-npm.yml`, **environment `npm-release`**. Binding the environment means an OIDC token from any other job or environment is refused by npm.
4. The owner configures the PyPI pending publisher for `mercurifi`: repository, workflow `release-pypi.yml`, **environment `pypi-release`**.
5. Bump the versions in `package.json`, `src/version.ts`, `pyproject.toml` and `_version.py` (the smoke tests fail if they differ).
6. Record the factory addresses and code hashes in both address books, only from an owner-approved deployment record.
7. Run CI.
8. Dispatch the release workflows. The `build` job runs without approval and without an OIDC token; the `publish` job waits for the environment's approval, then only downloads the build's artifact and publishes it.
9. Verify provenance per [verify-provenance.md](verify-provenance.md).

## Open point

npm may require the package to exist before a trusted publisher can be configured. If so, the first publish is a manual, owner-run placeholder publish with a short-lived granular token and 2FA. Decide this with the owner at publish time.

## Accepted advisories

| Advisory | Package | Tree | Why accepted | Revisit |
|---|---|---|---|---|
| GHSA-82fw-gwwq-j7x9 | `@vitest/mocker` (via `vitest` 3.2.7) | dev only; not in the published package | the fix needs vitest 4.x, a major upgrade of the test runner; nothing in it reaches users, and CI never runs untrusted code under it | at the vitest 4 upgrade, and before every release |

CI and the npm release workflow run `npm audit --omit=dev --audit-level=high`, so any advisory in the runtime tree (viem and its dependencies) fails the build. A dev-tree advisory is added here, with a reason and a revisit point, or fixed.

## CI and release configuration (inert)

The workflows under `.github/workflows/` are written but have never run: there is no remote, `release-npm.yml` and `release-pypi.yml` trigger only on `workflow_dispatch`, and each publish job sits behind a GitHub environment (`npm-release`, `pypi-release`) that must require owner approval, plus a guard on the organisation, `github.actor` and `github.triggering_actor`. Publishing uses npm trusted publishing with provenance and PyPI Trusted Publishing with attestations, so no long-lived token is stored anywhere.

Each release workflow has two jobs:

- `build` (`contents: read`, no environment, no OIDC token) installs, audits, checks, tests and builds, runs the smoke tests online, writes the SBOM, and uploads the exact artifact: the `npm pack` tarball, or the wheel and sdist (built with `--build-constraints build-constraints.txt --require-hashes`, then gated by `scripts/smoke_wheel.py <wheel> --sdist <sdist>`: RECORD may list only `mercurifi/**` and its dist-info, no `.pth` or `*.data/`, every hash must match, the sdist must rebuild into the identical wheel, and the installed `mercurifi.__version__` must equal `pyproject.toml`).
- `publish` (`id-token: write` only, the environment, `needs: build`) downloads that artifact and runs `npm publish <tarball>.tgz --provenance --access public --tag latest --ignore-scripts` or the pinned PyPI publish action; it never checks out the source. No dev tooling, install step or cache ever runs while the OIDC token exists.

`node scripts/check-workflows.mjs` (also run in CI) is a dependency-free backstop to `zizmor`, the primary audit. Before parsing, every workflow file must contain only printable ASCII, spaces and `\n`: CRLF is refused by name, and so is any other character (a lone `\r`, NEL, U+2028/U+2029, NBSP, zero-width characters, a BOM, tabs), since YAML treats some of them as line breaks the gate would not see. A backslash anywhere is refused too: inside a double-quoted key, an escape such as `"p\x65rmissions"` spells `permissions` to YAML but not to the gate. It then reads a strict YAML subset and refuses anything outside it rather than guessing: a plain or quoted scalar continued on deeper-indented lines (so `run: npm publish x` followed by `  ; curl …`, or an `if:` followed by `  || true`), a quote or a flow collection (`{`, `[`) that does not close on its line, anchors, aliases, tags, merge keys, duplicate keys, a key that differs from a workflow key or permission scope only by case (`Permissions:`), a top-level key other than `name`, `run-name`, `on`, `permissions`, `concurrency` and `jobs` (so no top-level `env` or `defaults`), and `jobs`, a job or a `permissions` entry written in flow style (`permissions: {}` is the one exception). On top of that it fails on an action not pinned to a 40-hex commit SHA, `pull_request_target`, a top-level `permissions` block that is not exactly `contents: read`, any `write` scope other than `id-token`, `id-token: write` anywhere but a release workflow's publish job, untrusted event text, `head_ref` or inputs in an expression, a checkout that keeps credentials, a release environment on any job but the publish job, a release job without its own permissions, and any release trigger other than `workflow_dispatch`. A publish job (the one holding `id-token: write`) must have `needs`, the environment, `runs-on: ubuntu-latest`, and an `if:` that is exactly the three guard clauses joined by `&&` (organisation, `github.actor`, `github.triggering_actor`; in any order, nothing else, so no `always()`, `success()` or `${{ }}` wrapper); may use only the job keys `name`, `needs`, `if`, `runs-on`, `timeout-minutes`, `environment`, `permissions`, `steps` and `concurrency` and the step keys `name`, `id`, `uses`, `with`, `run` and `timeout-minutes` (no `env`, `shell`, `container`, `services`, `defaults` or `strategy`); never checks out the source; may use only `actions/download-artifact` (inputs `name` and `path` only; `name` is required and must be exactly `npm-package` in `release-npm.yml` and `pypi-dist` in `release-pypi.yml`, since without it every artifact of the run is downloaded; so no `run-id`, `repository` or `github-token`; `path` must be relative to the workspace, without `..`, a leading `/` or `~`, or an expression), `actions/setup-node` (inputs `node-version` and `registry-url`, which must be exactly `https://registry.npmjs.org`; no `cache`) and `pypa/gh-action-pypi-publish` (inputs `packages-dir` and `attestations` only; `repository-url` is refused); and may run exactly one form of command, on one line: `npm publish <relative path>.tgz --provenance --access public --tag latest --ignore-scripts` (`--access public` because the package is scoped; `--tag latest` because npm 11 refuses a prerelease without an explicit tag, and `latest` must move off the `0.0.0` placeholder that reserved the name. Once a stable release exists, a later prerelease needs its own tag, which means editing this command and the gate together).

Hygiene notes (zizmor style):

- Third-party actions are pinned by SHA with the exact tag in a comment: `actions/checkout` v4.4.0, `actions/setup-node` v4.4.0 (both copied from the Launch web repository), `actions/upload-artifact` v4.6.2, `actions/download-artifact` v4.3.0 and `pypa/gh-action-pypi-publish` v1.14.2 (the first line that pins its own `actions/setup-python` by SHA, which the repository's SHA-pinning rule requires) (tag commits read with `git ls-remote`, dereferenced where the tag is annotated). Dependabot-style bumps are manual: re-resolve the SHA, then update the comment.
- CI runs the TypeScript suite on Node 22 (`.nvmrc`) and 24. The npm publish job uses Node 24 because trusted publishing needs npm 11.5.1 or later.
- The wheel smoke test is offline by default on a laptop (uv cache only) and online when `CI=true`; `MERCURIFI_SMOKE_ONLINE=1` or `0` overrides it, and the workflows set `1` explicitly. Every dependency it installs is hash-pinned either way.
- Build-backend dependencies are hash-pinned in `packages/python/build-constraints.txt` (hatchling 1.27.0 and its tree); regenerate it with the command in its header when `[build-system]` changes.
- Every checkout sets `persist-credentials: false`; no job needs write access to the repository.
- `id-token: write` appears only on the publish job of each release workflow, and no job in a release workflow uses a dependency cache.
- CI tools (`uv`, `zizmor`, `cyclonedx-bom`) install from `.github/ci-requirements.txt` with `--require-hashes --no-deps`. Regenerate it with the command in its header.
- Run steps use no `${{ }}` expressions from event data.
- Python lint is `ruff check` (CI and the release build). `ruff format` is deliberately **not** enforced: adopting it would reformat about 50 files (49 on 9 Oct) in one diff with no behaviour change, so it is left for a separate, owner-approved formatting commit. Do not add a `ruff format --check` step until that commit lands.

Before the first run, once the repository exists (checklist for the owner):

- [ ] Create the `npm-release` and `pypi-release` environments with required reviewers and a deployment branch rule **before the first dispatch** (a referenced environment that does not exist is auto-created without protection).
- [ ] Configure the npm trusted publisher (bound to environment `npm-release`) and the PyPI pending publisher (bound to `pypi-release`); see Steps above.
- [ ] Set `packages/typescript/package.json` `repository.url` to the GitHub repository before the first provenance publish (npm requires it to match the repository the provenance names, and refuses the publish otherwise).
- [ ] Re-resolve every pinned SHA against the new repository's allowed-actions policy; enable "require actions pinned to a full SHA".
- [ ] Confirm the `if:` guard (`mercuri-finance` / `mercurifinance`) matches the real organisation and publishing account.
- [ ] Run `zizmor` with a GitHub token (online audits such as impostor-commit and known-vulnerable-actions were skipped offline).
- [ ] Watch the first CI run: the wheel smoke test runs online there (`CI=true`) and installs every dependency from PyPI with hashes; it was exercised locally with an empty uv cache.
