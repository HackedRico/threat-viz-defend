import time

import pytest

from app.domain.masking import file_policy, is_secret_file, mask_secrets, skip_reason


@pytest.mark.parametrize(
    ("path", "reason"),
    [
        (".env", "may hold credentials"),
        ("config/.env.production", "may hold credentials"),
        ("deploy/server.pem", "may hold credentials"),
        ("gcp-service-account.json", "may hold credentials"),
        ("infra/prod.tfvars", "may hold credentials"),
        ("web/node_modules/react/index.js", "vendored or generated folder"),
        ("package-lock.json", "dependency lockfile"),
        ("docs/diagram.png", "binary or generated file"),
        ("static/app.min.js", "binary or generated file"),
    ],
)
def test_skipped_files(path: str, reason: str) -> None:
    assert skip_reason(path) == reason


@pytest.mark.parametrize("path", [".env.example", "README.md", "src/secrets.py", "docker-compose.yml", "api/main.go"])
def test_readable_files(path: str) -> None:
    assert skip_reason(path) is None


def test_windows_paths_are_understood() -> None:
    assert is_secret_file("C:\\repo\\.env")
    assert skip_reason("repo\\node_modules\\x.js") == "vendored or generated folder"


@pytest.mark.parametrize(
    ("text", "kept"),
    [
        ('OPENAI_API_KEY="sk-proj-abcdefghijklmnopqrstuvwxyz0123"', "OPENAI_API_KEY="),
        ("password: hunter2hunter2", "password: "),
        ('"clientSecret": "0123456789abcdef"', '"clientSecret": "'),
        ("postgres://admin:s3cretpass@db.internal:5432/app", "postgres://admin:"),
        ("Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "Bearer "),
        ("key = AKIAABCDEFGHIJKLMNOP", "key = "),
        ("https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXX", "hooks.slack.com/services/"),
    ],
)
def test_mask_secrets_redacts_values_and_keeps_names(text: str, kept: str) -> None:
    masked = mask_secrets(text)
    assert masked.count >= 1
    assert kept in masked.text
    assert "[redacted]" in masked.text


def test_mask_secrets_removes_private_key_blocks() -> None:
    pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
    assert mask_secrets(f"key:\n{pem}\n").text == "key:\n[private key removed]\n"


def test_mask_secrets_leaves_ordinary_code_alone() -> None:
    code = "def token_count(text):\n    return len(text.split())\n"
    assert mask_secrets(code).text == code


def test_mask_secrets_is_idempotent() -> None:
    once = mask_secrets("api_key = abcdefghijklmnop").text
    assert mask_secrets(once).text == once


def test_mask_secrets_stays_fast_on_hostile_input() -> None:
    hostile = "-----BEGIN RSA PRIVATE KEY-----" + " " * 50_000 + "token" + "a" * 50_000 + "://" + ":" * 50_000
    started = time.perf_counter()
    mask_secrets(hostile)
    assert time.perf_counter() - started < 1.0


def test_file_policy_lists_what_the_browser_skips() -> None:
    policy = file_policy()
    assert ".env" in policy["secretNames"]  # type: ignore[operator]
    assert "node_modules" in policy["ignoredDirs"]  # type: ignore[operator]
    assert policy["maxFileBytes"] == 200_000
