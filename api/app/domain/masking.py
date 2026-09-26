import re
from dataclasses import dataclass
from pathlib import PurePosixPath

# =============================================================================
# Module Overview
# =============================================================================
# What never reaches a model or the database. `skip_reason` names files that are
# never read: credential stores, lockfiles, vendored folders and binaries. The
# browser gets the same lists from `file_policy`, so it skips them before upload.
# `mask_secrets` replaces credential-shaped values in any text that is kept.

MAX_FILE_BYTES = 200_000
MAX_UPLOAD_BYTES = 1_500_000
MAX_FILES = 400

_SECRET_NAMES = frozenset(
    {
        ".env",
        ".npmrc",
        ".pypirc",
        ".netrc",
        ".git-credentials",
        ".htpasswd",
        ".pgpass",
        ".dockercfg",
        "credentials",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
    }
)
_SECRET_EXTENSIONS = frozenset({"pem", "key", "p12", "pfx", "jks", "keystore", "tfstate", "tfvars", "ovpn", "kdbx"})
# `.env.example` and friends document variable names without values, which says a lot about architecture.
_SAFE_ENV_SUFFIXES = frozenset({"example", "sample", "template", "dist", "defaults"})
_SECRET_WORDS = re.compile(r"secret|credential|service-?account")
_CONFIG_EXTENSIONS = frozenset({"json", "yaml", "yml", "toml", "txt", "ini", "xml", "cfg", "conf"})

_IGNORED_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "bower_components",
        "vendor",
        ".venv",
        "venv",
        "env",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "dist",
        "build",
        "out",
        "target",
        ".next",
        ".nuxt",
        ".svelte-kit",
        ".turbo",
        ".cache",
        "coverage",
        ".terraform",
        ".idea",
        ".vscode",
        ".gradle",
        "Pods",
        "DerivedData",
    }
)
_LOCKFILES = frozenset(
    {
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        "bun.lock",
        "poetry.lock",
        "pipfile.lock",
        "uv.lock",
        "cargo.lock",
        "go.sum",
        "composer.lock",
        "gemfile.lock",
        "packages.lock.json",
    }
)
_BINARY_EXTENSIONS = frozenset(
    {
        "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "psd", "svg",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar",
        "mp3", "mp4", "mov", "avi", "wav", "flac", "ogg", "webm",
        "woff", "woff2", "ttf", "otf", "eot",
        "exe", "dll", "so", "dylib", "a", "o", "class", "jar", "war", "pyc", "wasm", "bin",
        "db", "sqlite", "sqlite3", "parquet", "pkl", "pt", "onnx", "h5", "npy",
        "map", "lock",
    }
)  # fmt: skip

# Every pattern is linear: no nested quantifiers, and every repeat that precedes more
# pattern is bounded, so a hostile upload cannot make masking slow.
_PRIVATE_KEY = re.compile(
    r"-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,12000}?-----END [A-Z ]{0,40}PRIVATE KEY-----"
)
_ASSIGNMENT = re.compile(
    r"\b([A-Za-z0-9_.-]{0,40}?(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|credential)"
    r"[A-Za-z0-9_.-]{0,40})"
    r"([\"']?\s{0,3}[:=]\s{0,3}[\"']?)"
    r"(?!\[)([^\s\"'`,;#]{8,})",
    re.IGNORECASE,
)
_URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.-]{1,20}://[^\s:/@]{1,64}:)([^\s@/]{1,256})(@)", re.IGNORECASE)
_BEARER = re.compile(r"\b(Bearer\s{1,3})([A-Za-z0-9._~+/=-]{16,})")
_WEBHOOK = re.compile(r"(hooks\.slack\.com/services/|discord(?:app)?\.com/api/webhooks/)[A-Za-z0-9/_-]{16,}")
_KNOWN_KEYS = re.compile(
    r"\b(?:"
    r"sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}"
    r"|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}"
    r"|sk_[A-Za-z0-9]{32,}"
    r"|AKIA[0-9A-Z]{16}"
    r"|AIza[0-9A-Za-z_-]{35}"
    r"|gh[pousr]_[A-Za-z0-9]{36,}"
    r"|github_pat_[A-Za-z0-9_]{40,}"
    r"|xox[abprs]-[A-Za-z0-9-]{10,}"
    r"|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"
    r"|tvd_[A-Za-z0-9_-]{20,}"
    r"|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
    r")"
)

REDACTED = "[redacted]"


# =============================================================================
# Which files are read at all
# =============================================================================


def skip_reason(path: str) -> str | None:
    """Say why a file is never read, or return `None` when it may be read."""
    parts = [part for part in PurePosixPath(path.replace("\\", "/")).parts if part not in ("", "/", ".")]
    if not parts:
        return "empty path"
    name = parts[-1].lower()
    if any(part in _IGNORED_DIRS for part in parts[:-1]):
        return "vendored or generated folder"
    if is_secret_file(name):
        return "may hold credentials"
    if name in _LOCKFILES:
        return "dependency lockfile"
    if _extension(name) in _BINARY_EXTENSIONS or name.endswith(".min.js"):
        return "binary or generated file"
    return None


def is_secret_file(path: str) -> bool:
    """True for files that usually hold credentials: env files, private keys, credential stores."""
    name = PurePosixPath(path.replace("\\", "/")).name.lower()
    if name == ".env" or (name.startswith(".env.") and name[5:] not in _SAFE_ENV_SUFFIXES):
        return True
    if name in _SECRET_NAMES or _extension(name) in _SECRET_EXTENSIONS:
        return True
    return bool(_SECRET_WORDS.search(name)) and _extension(name) in _CONFIG_EXTENSIONS


def file_policy() -> dict[str, object]:
    """The skip lists and size caps, for the browser to apply before it uploads anything."""
    return {
        "secretNames": sorted(_SECRET_NAMES),
        "secretExtensions": sorted(_SECRET_EXTENSIONS),
        "safeEnvSuffixes": sorted(_SAFE_ENV_SUFFIXES),
        "ignoredDirs": sorted(_IGNORED_DIRS),
        "lockfiles": sorted(_LOCKFILES),
        "binaryExtensions": sorted(_BINARY_EXTENSIONS),
        "maxFileBytes": MAX_FILE_BYTES,
        "maxUploadBytes": MAX_UPLOAD_BYTES,
        "maxFiles": MAX_FILES,
    }


def _extension(name: str) -> str:
    """The lowercase extension of a file name, or `''` when it has none."""
    return name.rsplit(".", 1)[-1].lower() if "." in name.strip(".") else ""


# =============================================================================
# Masking values inside text that is kept
# =============================================================================


@dataclass(frozen=True)
class Masked:
    """Text with credential-shaped values replaced, and how many were replaced."""

    text: str
    count: int


def mask_secrets(text: str) -> Masked:
    """Replace private keys, credential assignments, URL passwords, bearer tokens and known key formats."""
    count = 0

    def replace(pattern: re.Pattern[str], template: str, source: str) -> str:
        nonlocal count
        result, replaced = pattern.subn(template, source)
        count += replaced
        return result

    out = replace(_PRIVATE_KEY, "[private key removed]", text)
    out = replace(_ASSIGNMENT, rf"\1\2{REDACTED}", out)
    out = replace(_URL_PASSWORD, rf"\1{REDACTED}\3", out)
    out = replace(_BEARER, rf"\1{REDACTED}", out)
    out = replace(_WEBHOOK, rf"\1{REDACTED}", out)
    out = replace(_KNOWN_KEYS, REDACTED, out)
    return Masked(out, count)
