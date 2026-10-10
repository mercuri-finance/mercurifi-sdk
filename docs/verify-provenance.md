# Verifying a release

Every published version carries provenance from this repository's release workflows. Refuse any version whose provenance is missing or names another repository or workflow.

## npm

- In a project that depends on `@mercurifi/sdk`, run `npm audit signatures`.
- `npm view @mercurifi/sdk@<version> --json` shows `dist.attestations`.
- The provenance must name the SDK repository and the `release-npm.yml` workflow.

## PyPI

- Each file's "Provenance" on pypi.org must name the same repository and `release-pypi.yml`.
- To check it from the command line, use `pypi-attestations verify pypi`; see https://docs.pypi.org/attestations/.
