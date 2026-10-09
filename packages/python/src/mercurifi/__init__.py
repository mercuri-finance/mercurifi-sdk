"""Mercurifi Agent Accounts SDK. Read docs/security-model.md: agent keys can lose money within your caps."""
from . import errors
from ._version import __version__
from .agent import AgentClient, ImageUpload
from .build_verify import verify_built_owner_tx, verify_built_tx
from .client import AsyncClient, create_client
from .networks import MAINNET, TESTNET, local_network
from .owner import AccountManager, FirstAgent, OwnerClient
from .policy import DEFAULT_POLICY, ChainPolicy
from .redact import install_log_redaction
from .revert import ContractRevertError, TxRevertedError, decode_revert
from .safe_view import wrap_untrusted
from .signers import generate_agent_key, kms_signer, local_key
from .stream import open_stream
from .sync import Client

# Installed at import so any httpx client in the process (the SDK's own or an API client built later) is covered.
install_log_redaction()

__all__ = [
    "AccountManager", "AgentClient", "AsyncClient", "ChainPolicy", "Client", "ContractRevertError", "DEFAULT_POLICY", "FirstAgent",
    "ImageUpload", "MAINNET", "OwnerClient", "TESTNET", "TxRevertedError", "__version__", "create_client", "decode_revert", "errors",
    "generate_agent_key", "kms_signer", "local_key", "local_network", "open_stream", "verify_built_owner_tx", "verify_built_tx", "wrap_untrusted",
]
