import json
import sys

from app.analysis.analyst import DemoAnalyst
from app.config import Settings
from app.jobs import InlineJobs
from app.main import create_app

# =============================================================================
# Module Overview
# =============================================================================
# Prints the OpenAPI schema, from which `web/` generates its TypeScript types:
# `uv run python -m app.openapi > ../web/openapi.json`. It builds the app with
# an in-memory database and no model, so it needs no configuration.


def main() -> None:
    """Write the OpenAPI schema as indented, key-sorted JSON to stdout."""
    app = create_app(Settings(database_url="sqlite://", static_dir=None), analyst=DemoAnalyst(), jobs=InlineJobs())
    json.dump(app.openapi(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
