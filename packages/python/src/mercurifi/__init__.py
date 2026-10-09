"""Mercurifi Agent Accounts SDK."""
from ._version import __version__
from .redact import install_log_redaction

# Installed at import so any httpx client in the process (the SDK's own or an API client built later) is covered.
install_log_redaction()

__all__ = ["__version__"]
