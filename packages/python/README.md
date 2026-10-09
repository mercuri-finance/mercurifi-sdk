# mercurifi

Python SDK for Mercurifi Agent Accounts. See the repository README.

## Logging and secrets

RPC provider URLs usually carry an API key in the path, and `httpx` logs request URLs at INFO (`httpcore` at DEBUG).
When the SDK creates an RPC client it installs one idempotent redacting `logging.Filter` on the `httpx` and
`httpcore` loggers that replaces every URL in a log record with its host. Your log levels, handlers and formatters are
not changed. Errors raised by the SDK also show the host only.

## Untrusted text and Unicode data

Contract-supplied revert reasons (and, later, token names and descriptions) are made inert by one sanitiser that mirrors the TypeScript SDK. It depends on Unicode data: character categories come from your Python's `unicodedata` and the pictograph table is built in, so a character assigned in a newer Unicode release than your interpreter knows can be treated differently from the TypeScript SDK. The shared vectors in `fixtures/vectors/` arbitrate. This is output hygiene, not a security boundary: the account caps are the real control.

## Handling agent keys

An agent key can move money within the account's caps, so treat it like any server secret. The SDK never transmits,
logs or persists a key, and a signer prints and pickles as an address only. What the SDK cannot control is your process.

- Read the key at the call site and pass it straight in: `signer = local_key(os.environ["AGENT_KEY"])`. Do not keep it in
  a long-lived variable, a config object or a cache, and never log it or capture it in a message, metric or trace.
- Build a `LocalKeySigner` only through `local_key`; the class does not take a key string itself.
- `generate_agent_key()` returns a key whose secret is read only by `export_private_key()`. Call that once, store the
  value in your secret manager, and drop the object.
- Turn off local-variable capture in error reporters in any process that holds an agent key: Sentry
  `include_local_variables=False`, loguru `diagnose=False`, and no rich or `better_exceptions` tracebacks with locals.
  The SDK clears the key from its own frames before raising, but a frame of yours that holds the key would be shipped.
- Prefer a KMS or HSM signer (`kms_signer`) where you can: the key then never enters the process.
- Use one agent key per process. Two processes sharing a key race for nonces; the account allows several agent keys.
