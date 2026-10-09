# mercurifi

Python SDK for Mercurifi Agent Accounts. See the repository README.

## Logging and secrets

RPC provider URLs usually carry an API key in the path, and `httpx` logs request URLs at INFO (`httpcore` at DEBUG).
When the SDK creates an RPC client it installs one idempotent redacting `logging.Filter` on the `httpx` and
`httpcore` loggers that replaces every URL in a log record with its host. Your log levels, handlers and formatters are
not changed. Errors raised by the SDK also show the host only.
