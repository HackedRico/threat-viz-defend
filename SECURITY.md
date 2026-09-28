# Security policy

ThreatViz Defend reads people's code and design docs and sends them to a model, so we take reports about it seriously.

## Supported versions

Only the latest commit on `main` gets security fixes. There are no release branches yet.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

1. Open the repository's **Security** tab and choose **Report a vulnerability**. This uses GitHub's private vulnerability reporting, so only the maintainers see the report.
2. If that button is missing, contact the maintainer, [@HackedRico](https://github.com/HackedRico), privately through the contact details on their GitHub profile, and ask for a private channel before you send details.

A good report includes:

- what an attacker can do, and what they need first, such as an account, a personal token or a crafted upload
- the steps to reproduce it, on a local run where you can
- the commit you tested against

We aim to answer within a week and to agree on a fix and a disclosure date with you. This is a volunteer project, so please allow time for a fix before you publish anything.

## Scope

In scope: the code in this repository, including the API, the web app, the coding agent hook and the MCP server.

Out of scope:

- The third-party services the app can call, such as model providers, ElevenLabs, Backboard, Snowflake and GitHub. Report their problems to them.
- Findings that need a malicious operator, since whoever runs the server can already read its database and keys.
- The known limits listed in [docs/security.md](docs/security.md#known-limits), unless you found a way around the mitigation described there.

When you test, use your own local run or your own deployment. Never test against other people's accounts, boards or data.

## How the app protects users

[docs/security.md](docs/security.md) describes every control, the data sent to third parties, our own threat model and the known limits.
