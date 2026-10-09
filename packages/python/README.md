# mercurifi

Python SDK for Mercurifi Agent Accounts. See the repository README.

## Logging and secrets

RPC provider URLs usually carry an API key in the path, and `httpx` logs request URLs at INFO (`httpcore` at DEBUG).
When the SDK creates an RPC client it installs one idempotent redacting `logging.Filter` on the `httpx` and
`httpcore` loggers that replaces every URL in a log record with its host. Your log levels, handlers and formatters are
not changed. Errors raised by the SDK also show the host only.

## Untrusted text and Unicode data

Contract-supplied revert reasons (and, later, token names and descriptions) are made inert by one sanitiser that mirrors the TypeScript SDK. It depends on Unicode data: character categories come from your Python's `unicodedata` and the pictograph table is built in, so a character assigned in a newer Unicode release than your interpreter knows can be treated differently from the TypeScript SDK. The shared vectors in `fixtures/vectors/` arbitrate. This is output hygiene, not a security boundary: the account caps are the real control.
