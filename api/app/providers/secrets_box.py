import base64
import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# =============================================================================
# Module Overview
# =============================================================================
# Encryption for the API keys users save. `SecretBox` seals a key with
# AES-256-GCM under a key derived from `APP_SECRET`, and binds each ciphertext
# to its owner, so a row copied onto another account will not decrypt. A
# database dump alone never reveals a key.

_NONCE_BYTES = 12


class SecretBox:
    """Seals and opens short secrets with one server key."""

    def __init__(self, app_secret: str) -> None:
        if len(app_secret) < 32:
            raise ValueError("`APP_SECRET` must be at least 32 characters.")
        # SHA-256 turns any long passphrase into exactly the 32 bytes AES-256 needs.
        self._aead = AESGCM(hashlib.sha256(app_secret.encode()).digest())

    def seal(self, plaintext: str, owner: str) -> str:
        """Encrypt `plaintext` for `owner`, returning URL-safe text to store."""
        nonce = os.urandom(_NONCE_BYTES)
        sealed = self._aead.encrypt(nonce, plaintext.encode(), owner.encode())
        return base64.urlsafe_b64encode(nonce + sealed).decode()

    def open(self, token: str, owner: str) -> str:
        """Decrypt what `seal` produced for `owner`, raising `ValueError` if it was tampered with or moved."""
        try:
            raw = base64.urlsafe_b64decode(token.encode())
            return self._aead.decrypt(raw[:_NONCE_BYTES], raw[_NONCE_BYTES:], owner.encode()).decode()
        except (InvalidTag, ValueError) as exc:
            raise ValueError("A saved API key could not be decrypted; save the provider again.") from exc
