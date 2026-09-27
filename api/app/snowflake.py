from collections.abc import Sequence
from dataclasses import dataclass

import httpx

from app.domain.findings import Finding

# =============================================================================
# Module Overview
# =============================================================================
# Sends one board's threats to the user's own Snowflake account through the SQL
# API (`/api/v2/statements`) with a programmatic access token, so no Snowflake SDK
# is needed. The token lives only for the request; nothing here is stored.

TABLE = "threat_findings"

_CREATE = (
    "CREATE TABLE IF NOT EXISTS threat_findings ("
    "board_id STRING, threat_id STRING, title STRING, stride STRING, severity STRING, element_kind STRING, "
    "crosses_boundary BOOLEAN, touches_ai BOOLEAN, touches_sensitive BOOLEAN, refs STRING, "
    "analyzed_at TIMESTAMP_TZ)"
)
_CLEAR = "DELETE FROM threat_findings WHERE board_id = ?"
_INSERT = "INSERT INTO threat_findings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
_COLUMNS: tuple[tuple[str, str], ...] = (
    ("board_id", "TEXT"),
    ("threat_id", "TEXT"),
    ("title", "TEXT"),
    ("stride", "TEXT"),
    ("severity", "TEXT"),
    ("element_kind", "TEXT"),
    ("crosses_boundary", "BOOLEAN"),
    ("touches_ai", "BOOLEAN"),
    ("touches_sensitive", "BOOLEAN"),
    ("refs", "TEXT"),
    ("analyzed_at", "TIMESTAMP_TZ"),
)


class SnowflakeError(Exception):
    """Snowflake refused a statement or could not be reached."""


@dataclass(frozen=True)
class SnowflakeTarget:
    """Where the findings go. `SnowflakeExportIn` has already checked every name's shape."""

    account: str
    token: str
    warehouse: str
    database: str
    schema: str

    @property
    def url(self) -> str:
        """The SQL API endpoint; the account is a bare identifier, so the host is always Snowflake's."""
        return f"https://{self.account}.snowflakecomputing.com/api/v2/statements"


def push_board(target: SnowflakeTarget, board_id: str, rows: Sequence[Finding], client: httpx.Client) -> None:
    """Replace this board's rows in `threat_findings`, creating the table the first time."""
    _run(target, client, _CREATE, None)
    _run(target, client, _CLEAR, {"1": {"type": "TEXT", "value": board_id}})
    if not rows:
        return
    bindings: dict[str, object] = {
        str(index): {"type": kind, "value": [_bind(getattr(row, name)) for row in rows]}
        for index, (name, kind) in enumerate(_COLUMNS, start=1)
    }
    _run(target, client, _INSERT, bindings)


def _bind(value: object) -> str:
    """Render one value the way the SQL API takes bindings: always as a string."""
    if isinstance(value, bool):
        return "true" if value else "false"
    isoformat = getattr(value, "isoformat", None)
    return str(isoformat()) if callable(isoformat) else str(value)


def _run(target: SnowflakeTarget, client: httpx.Client, statement: str, bindings: dict[str, object] | None) -> None:
    """Run one statement, turning any failure into a `SnowflakeError` the user can act on."""
    body: dict[str, object] = {
        "statement": statement,
        "timeout": 60,
        "warehouse": target.warehouse,
        "database": target.database,
        "schema": target.schema,
    }
    if bindings is not None:
        body["bindings"] = bindings
    headers = {
        "Authorization": f"Bearer {target.token}",
        "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
        "Accept": "application/json",
    }
    try:
        response = client.post(target.url, json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise SnowflakeError("Could not reach Snowflake. Check the account identifier.") from exc
    if response.status_code == 401:
        raise SnowflakeError("Snowflake rejected the token. Check it has not expired.")
    if response.status_code >= 400:
        try:
            message = str(response.json().get("message", ""))
        except ValueError:
            message = ""
        raise SnowflakeError(f"Snowflake returned {response.status_code}. {message[:200]}".strip())
