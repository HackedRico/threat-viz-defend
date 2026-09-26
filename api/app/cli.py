import argparse
import os
import sys
from collections.abc import Sequence

from sqlalchemy import func, select

from app.config import load_settings
from app.db import Database
from app.tables import BoardRow, LoginSessionRow, UsageRow, UserRow

# =============================================================================
# Module Overview
# =============================================================================
# Admin commands for the people running an event, from a shell on the server:
# `python -m app.cli users`, `disable <name>`, `enable <name>`, `delete <name>`
# and `stats`. There is no admin page on purpose: a command line on the host
# is an admin surface attackers cannot reach from the web.


def main(argv: Sequence[str] | None = None) -> int:
    """Run one admin command and return the exit code."""
    parser = argparse.ArgumentParser(prog="python -m app.cli", description="Manage accounts on this deployment.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("users", help="list accounts")
    for name, text in (("disable", "block an account and sign it out"), ("enable", "unblock an account")):
        cmd = sub.add_parser(name, help=text)
        cmd.add_argument("username")
    delete = sub.add_parser("delete", help="delete an account and everything it owns")
    delete.add_argument("username")
    delete.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    sub.add_parser("stats", help="counts of accounts, boards and model calls")
    args = parser.parse_args(argv)

    db = Database(load_settings(os.environ).database_url)
    db.create_tables()
    with db.session() as session:
        if args.command == "users":
            for row in session.scalars(select(UserRow).order_by(UserRow.created_at)):
                state = "disabled" if row.disabled else "active"
                print(f"{row.username:<24} {state:<9} joined {row.created_at:%Y-%m-%d %H:%M} UTC")
            return 0
        if args.command == "stats":
            for label, model in (("accounts", UserRow), ("boards", BoardRow), ("usage records", UsageRow)):
                print(f"{label}: {session.scalar(select(func.count()).select_from(model))}")
            return 0
        user = session.scalar(select(UserRow).where(UserRow.username == args.username.lower()))
        if user is None:
            print(f"No account named {args.username}.", file=sys.stderr)
            return 1
        if args.command == "disable":
            user.disabled = True
            for login in session.scalars(select(LoginSessionRow).where(LoginSessionRow.user_id == user.id)):
                session.delete(login)
            print(f"Disabled {user.username} and signed out every session.")
        elif args.command == "enable":
            user.disabled = False
            print(f"Enabled {user.username}.")
        elif args.command == "delete":
            if not args.yes and input(f"Delete {user.username} and all their boards? Type the name: ") != user.username:
                print("Nothing deleted.")
                return 1
            session.delete(user)
            print(f"Deleted {user.username}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
