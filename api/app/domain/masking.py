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
        ".envrc",
        "kubeconfig",
        "credentials",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
    }
)
_SECRET_EXTENSIONS = frozenset(
    {"pem", "key", "p12", "pfx", "jks", "keystore", "tfstate", "tfvars", "ovpn", "kdbx", "ppk", "gpg", "asc"}
)
# Files whose name alone is harmless but whose folder makes them credential stores.
_SECRET_PATHS = frozenset({(".kube", "config"), (".docker", "config.json")})
# `.env.example` and friends document variable names without values, which says a lot about architecture.
_SAFE_ENV_SUFFIXES = frozenset({"example", "sample", "template", "dist", "defaults"})
_SECRET_WORDS_PATTERN = r"secret|credential|service-?account"  # noqa: S105
_SECRET_WORDS = re.compile(_SECRET_WORDS_PATTERN)
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

# Every repeat has an upper bound, so each match attempt costs a fixed amount however hostile
# the text, and masking stays linear in its length. There are no nested quantifiers. Private key blocks are
# found by `_mask_key_blocks` with a forward-only scan instead of a lazy span.
_KEY_BEGIN = re.compile(r"-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----")
_KEY_END = "-----END "
_KEY_SPAN = 12_000
# Matches start at the secret word itself, so the scan never retries a name prefix at every
# position; any prefix, as in `OPENAI_API_KEY`, stays in the text untouched.
_SECRET_WORD = r"(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|credential)"  # noqa: S105
_ASSIGNMENT = re.compile(
    rf"({_SECRET_WORD}[A-Za-z0-9_.-]{{0,40}})"
    r"([\"']?\s{0,3}[:=]\s{0,3}[\"']?)"
    r"(?!\[)([^\s\"'`,;#]{8,500})",
    re.IGNORECASE,
)
# A quoted value may hold spaces or be short, as in DB_PASSWORD="Summer 2024!".
_QUOTED_ASSIGNMENT = re.compile(
    rf"({_SECRET_WORD}[A-Za-z0-9_.-]{{0,40}}[\"']?\s{{0,3}}[:=]\s{{0,3}})(\"[^\"\n\[]{{1,200}}\"|'[^'\n\[]{{1,200}}')",
    re.IGNORECASE,
)
# Values that carry credentials under names the assignment pattern does not know.
_LABELLED = re.compile(
    r"((?:client-key-data|client-certificate-data|token-data)\s{0,3}:\s{0,3}[\"']?"
    r"|\"auth\"\s{0,3}:\s{0,3}\""
    r"|AccountKey=|SharedAccessKey=)"
    r"([A-Za-z0-9+/=_-]{8,4000})"
)
_BASIC = re.compile(r"\b(Basic\s{1,3})([A-Za-z0-9+/=]{8,2000})")
_URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.-]{1,20}://[^\s:/@]{1,64}:)([^\s@/]{1,256})(@)", re.IGNORECASE)
_BEARER = re.compile(r"\b(Bearer\s{1,3})([A-Za-z0-9._~+/=-]{16,4000})")
_WEBHOOK = re.compile(r"(hooks\.slack\.com/services/|discord(?:app)?\.com/api/webhooks/)[A-Za-z0-9/_-]{16,300}")
_KNOWN_KEYS = re.compile(
    r"\b(?:"
    r"sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,300}"
    r"|[sr]k_(?:live|test)_[A-Za-z0-9]{16,300}"
    r"|sk_[A-Za-z0-9]{32,300}"
    r"|AKIA[0-9A-Z]{16}"
    r"|AIza[0-9A-Za-z_-]{35}"
    r"|gh[pousr]_[A-Za-z0-9]{36,300}"
    r"|github_pat_[A-Za-z0-9_]{40,300}"
    r"|xox[abprs]-[A-Za-z0-9-]{10,300}"
    r"|SG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,100}"
    r"|tvd_[A-Za-z0-9_-]{20,300}"
    r"|glpat-[A-Za-z0-9_-]{20,300}"
    r"|npm_[A-Za-z0-9]{36,300}"
    r"|eyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,20000}\.[A-Za-z0-9_-]{10,2000}"
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
    if is_secret_file(name) or (len(parts) > 1 and (parts[-2].lower(), name) in _SECRET_PATHS):
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
        # A name matching this pattern with a config extension counts as a credential file.
        "secretWordsPattern": _SECRET_WORDS_PATTERN,
        "configExtensions": sorted(_CONFIG_EXTENSIONS),
        "ignoredDirs": sorted(_IGNORED_DIRS),
        "lockfiles": sorted(_LOCKFILES),
        "binaryExtensions": sorted(_BINARY_EXTENSIONS),
        "maxFileBytes": MAX_FILE_BYTES,
        "maxUploadBytes": MAX_UPLOAD_BYTES,
        "maxFiles": MAX_FILES,
        "secretPaths": sorted(f"{folder}/{name}" for folder, name in _SECRET_PATHS),
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

    out, blocks = _mask_key_blocks(text)
    count += blocks
    out = replace(_QUOTED_ASSIGNMENT, rf'\1"{REDACTED}"', out)
    out = replace(_ASSIGNMENT, rf"\1\2{REDACTED}", out)
    out = replace(_LABELLED, rf"\1{REDACTED}", out)
    out = replace(_BASIC, rf"\1{REDACTED}", out)
    out = replace(_URL_PASSWORD, rf"\1{REDACTED}\3", out)
    out = replace(_BEARER, rf"\1{REDACTED}", out)
    out = replace(_WEBHOOK, rf"\1{REDACTED}", out)
    out = replace(_KNOWN_KEYS, REDACTED, out)
    return Masked(out, count)


def _mask_key_blocks(text: str) -> tuple[str, int]:
    """Replace private key blocks, searching forward once so repeated markers cost linear time."""
    parts: list[str] = []
    count = 0
    position = 0
    # The next END marker at or after `searched_from`, found once and reused by every BEGIN before it.
    next_end, searched_from = -1, -1
    for begin in _KEY_BEGIN.finditer(text):
        if begin.start() < position:
            continue  # inside a block already removed
        # Search again only when the cached END lies behind us; a failed search means none remain.
        if searched_from == -1 or (next_end != -1 and next_end < begin.end()):
            searched_from = begin.end()
            next_end = text.find(_KEY_END, searched_from)
        if next_end != -1 and next_end - begin.end() <= _KEY_SPAN:
            close = text.find("-----", next_end + len(_KEY_END), next_end + len(_KEY_END) + 80)
            stop = close + 5 if close != -1 else next_end + len(_KEY_END)
        else:
            # With no END marker in range, remove the marker line so the key's first bytes still go.
            newline = text.find("\n", begin.end(), begin.end() + _KEY_SPAN)
            stop = newline if newline != -1 else min(len(text), begin.end() + _KEY_SPAN)
        parts += [text[position : begin.start()], "[private key removed]"]
        position = stop
        count += 1
    parts.append(text[position:])
    return "".join(parts), count
