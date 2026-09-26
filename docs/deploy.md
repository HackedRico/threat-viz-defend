# Deploying ThreatViz Defend

This guide takes the app from the repo to `https://app.<domain>` and `https://api.<domain>` on DigitalOcean App Platform, with DNS at GoDaddy. Follow it top to bottom the first time. Every command runs from the repo root unless it says otherwise.

Throughout, `example.com` stands for your domain. Replace it everywhere, including in `.do/app.yaml`.

## What gets deployed

One App Platform app, defined in `.do/app.yaml`, with three components:

| Component | Kind | Serves | Cost |
| --- | --- | --- | --- |
| `api` | Service built from `Dockerfile` | `https://api.example.com` | the `apps-s-1vcpu-1gb` instance price, shown on the create screen |
| `web` | Static site built from `web/` | `https://app.example.com` | free |
| `db` | Dev Postgres 16 | the API only, through `DATABASE_URL` | $7 per month |

The dev database has no backups and no high availability. It is fine for a hackathon, not for data you cannot lose. App Platform disks are wiped on every deploy and restart, so the API never uses SQLite there.

The API creates its tables on startup. There is no separate migration step.

## Prerequisites and credits

- A DigitalOcean account with billing set up. If the team has promo credits, add the code under Billing > Promo code before you create anything, and check the credit covers the API instance and the $7 database for the event.
- Owner or admin access to the GitHub repo `HackedRico/threat-viz-defend`, so you can authorize the DigitalOcean GitHub app on it.
- The domain at GoDaddy, and a GoDaddy login that can edit its DNS.
- Optional: `doctl`, the DigitalOcean CLI. Install it with `brew install doctl`, then run `doctl auth init` and paste a personal access token from API > Tokens. The control panel can do everything below without it.
- Optional: a DigitalOcean model access key for the server's default model, and an ElevenLabs account for the voice coach and dictation. Both are covered below.

## 1. Prepare the spec

1. Open `.do/app.yaml`.
2. Replace `api.example.com` and `app.example.com` with your two hostnames. They appear under `domains`, under `ingress.rules`, in `PUBLIC_ORIGIN`, in `CORS_ORIGINS` and in the static site's `VITE_API_BASE_URL`.
3. Leave the `type: SECRET` entries without values. You set them in the control panel in step 3, so they never land in the public repo.
4. If you have `doctl`, check the file:

   ```sh
   doctl apps spec validate .do/app.yaml
   ```

   It prints the spec back when it is valid, or names the field that is wrong.

5. Commit and push the domain change to `main`. App Platform builds from GitHub, not from your laptop.

## 2. Create the app

Pick one of the two routes.

**Control panel.** Apps > Create App > choose GitHub, authorize the repo if asked, pick `HackedRico/threat-viz-defend` and branch `main`. On the next screen choose to edit the app spec, paste the contents of `.do/app.yaml`, and save. Review the three components, then create the app.

**doctl.**

```sh
doctl apps create --spec .do/app.yaml
doctl apps list   # note the app ID for later commands
```

Either way, App Platform starts a first deploy right away. That deploy fails, because `APP_SECRET` is not set yet and the API refuses to start in production without it. That is expected. The failure also sends a DEPLOYMENT_FAILED alert email, which confirms alerts work.

## 3. Set secrets

In the control panel: the app > Settings > the `api` component > Environment Variables > Edit. Fill in each value and tick Encrypt for each one marked secret.

| Variable | Value | Secret |
| --- | --- | --- |
| `APP_SECRET` | output of `python -c "import secrets; print(secrets.token_urlsafe(48))"` | yes |
| `INVITE_CODES` | one or more codes, comma separated, 6 characters or more each. Generate one with `python -c "import secrets; print(secrets.token_urlsafe(9))"` | yes |
| `LLM_API_KEY` | the model access key from "Model access key" below, or leave empty for demo mode | yes |
| `ELEVENLABS_API_KEY` | from "Voice coach and dictation" below, or leave empty to turn voice and dictation off | yes |
| `ELEVENLABS_AGENT_ID` | from "Voice coach and dictation" below, or leave empty | no |

Keep the scope of every secret at Run time. The default scope, Run and build time, passes the value into the Docker build as a build argument, where it can end up in build logs and image layers.

Keep a copy of `APP_SECRET` in the team's password manager. It encrypts the provider API keys users save in the app. If it changes, every saved key becomes unreadable and users have to enter theirs again.

The spec already sets the non-secret values:

| Variable | Value | Why |
| --- | --- | --- |
| `APP_ENV` | `production` | turns on production checks, secure cookies and HSTS, and hides the API docs |
| `PUBLIC_ORIGIN` | `https://api.example.com` | the API's own origin, also added to the allowed Host headers |
| `CORS_ORIGINS` | `https://app.example.com` | the frontend origin allowed to call the API with cookies |
| `COOKIE_SAMESITE` | `lax` | works because `app.` and `api.` share a parent domain |
| `TRUST_PROXY` | `true` | App Platform puts the real client IP in `do-connecting-ip`, which rate limits use |
| `DATABASE_URL` | `${db.DATABASE_URL}` | App Platform fills in the dev database's connection string |
| `LLM_BASE_URL`, `LLM_MODEL` | DigitalOcean serverless inference, `openai-gpt-oss-120b` | the server's default model |
| `BACKBOARD_BASE_URL` | `https://app.backboard.io/api` | for users who choose Backboard as their provider |
| `ELEVENLABS_STT_MODEL` | `scribe_v2` | the ElevenLabs Speech to Text model for dictation |
| `MAX_USERS`, `DAILY_MODEL_CALLS`, `DAILY_DICTATIONS` | `300`, `60`, `30` | budgets; `.env.example` lists the rest with their defaults |

`.env.example` at the repo root documents every variable the API reads.

Saving the environment variables starts a new deploy.

## 4. First deploy

1. Watch the deploy on the app's Activity tab, or run `doctl apps logs <app-id> api --type build --follow`.
2. The API builds from `Dockerfile` in a few minutes. The static site runs `npm ci` and `npm run build` in `web/` with `VITE_API_BASE_URL` baked in.
3. When the deploy is live, the app has a default hostname like `threatviz-defend-abc12.ondigitalocean.app`. It serves the static site. The API only answers on `api.example.com`, because it rejects Host headers it does not know. DNS comes next.

`deploy_on_push` is on for both components, so every push to `main` redeploys. CI in `.github/workflows/ci.yml` runs on the same push, but App Platform does not wait for it. Merge to `main` only when CI is green.

## 5. DNS at GoDaddy

App Platform shows the target for each custom domain under the app's Networking tab, in the Domains section. Older control panels show it under Settings > Domains. It is usually the app's default hostname, such as `threatviz-defend-abc12.ondigitalocean.app`.

For each of `api` and `app`:

1. Sign in at GoDaddy, open My Products > the domain > DNS.
2. Add New Record.
3. Type: CNAME.
4. Name: the prefix only, `api` or `app`. Not `api.example.com`.
5. Value: the hostname App Platform showed for that domain, without `https://` and without a trailing slash.
6. TTL: 1 hour, or the lowest GoDaddy offers while you are testing.
7. Save.

If GoDaddy refuses because a record with that name exists, edit or delete the old one first.

### The apex domain

`example.com` itself cannot be a CNAME. Pick one:

- **Forward it.** In GoDaddy, the domain > Forwarding > Add forwarding, destination `https://app.example.com`, type Permanent (301). Nothing changes in App Platform.
- **Serve the site on it.** Add `- domain: example.com` with `type: ALIAS` under `domains` in the spec, add an ingress rule matching `authority.exact: example.com` to the `web` component, and add `https://example.com` to `CORS_ORIGINS`. Then, in GoDaddy DNS, replace the existing `@` A record (usually the GoDaddy parked page) with two A records named `@`: `162.159.140.98` and `172.66.0.96`. These are App Platform's static ingress addresses; confirm them against what the Domains section shows for the apex.

### TLS

App Platform issues and renews certificates for every custom domain once its DNS points at the app. This usually takes a few minutes after DNS propagates and needs nothing from you. The domain shows as Active under Domains when it is done. If it stays pending for over an hour, you get a DOMAIN_FAILED alert.

**CAA records.** If the domain has any CAA records in GoDaddy DNS, certificates can only come from the authorities they list, and App Platform uses Let's Encrypt and Google Trust Services. Add two records: Type CAA, Name `@`, Flags `0`, Tag `issue`, Value `letsencrypt.org`, and the same with Value `pki.goog`. If the domain has no CAA records at all, skip this.

## 6. Verify

```sh
# DNS points at App Platform
dig +short CNAME api.example.com
dig +short CNAME app.example.com

# The API is up; expect {"ok":true}
curl -fsS https://api.example.com/api/health

# Public config; "demo_mode": false once LLM_API_KEY is set
curl -fsS https://api.example.com/api/config

# The frontend origin is allowed; expect an access-control-allow-origin header naming it
curl -sS -o /dev/null -D - -X OPTIONS https://api.example.com/api/config \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: GET" | grep -i access-control

# The site loads, and a client-side route falls back to index.html; expect 200 for both
curl -sS -o /dev/null -w "%{http_code}\n" https://app.example.com/
curl -sS -o /dev/null -w "%{http_code}\n" https://app.example.com/some/client/route

# HTTPS only: expect a redirect to https
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" http://api.example.com/api/health
```

Then, in a browser, open `https://app.example.com`, sign up with one of the invite codes, create a board, and run a quiz. Check the browser dev tools console for blocked requests.

## Model access key

The server's default model runs on DigitalOcean serverless inference, which speaks the OpenAI API.

1. In the control panel, open the AI platform section, then Serverless Inference > Model Access Keys > Create Access Key. Name it after the app, such as `threatviz-defend`.
2. Copy the key. It is shown once.
3. Check it works:

   ```sh
   curl -fsS https://inference.do-ai.run/v1/chat/completions \
     -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"model":"openai-gpt-oss-120b","messages":[{"role":"user","content":"Say ok"}],"max_tokens":20}'
   ```

4. Set it as `LLM_API_KEY` in the `api` component, encrypted. To use another model, change `LLM_MODEL`; `curl -fsS https://inference.do-ai.run/v1/models -H "Authorization: Bearer $KEY"` lists the names.

Usage bills to the DigitalOcean account. `DAILY_MODEL_CALLS`, `MODEL_CALLS_PER_MINUTE` and `GLOBAL_DAILY_MODEL_CALLS` cap how much of it users can spend. Users who save their own provider in the app spend their own key instead.

## Voice coach and dictation

Both run on one ElevenLabs API key, which stays on the API. Dictation, the mic beside **Ask**, needs only the key. The voice coach also needs an agent.

1. In ElevenLabs, create an API key. If the dashboard offers scopes, allow Speech to Text for dictation, plus what the agent script and conversation tokens need for the coach.
2. Set `ELEVENLABS_API_KEY` (encrypted) in the `api` component. After the deploy, `curl -fsS https://api.example.com/api/config` shows `"dictation_enabled": true`.
3. For the coach, create the agent with `scripts/elevenlabs_agent.py`. The voice teammate owns that script; its header explains how to run it and what it prints. Keep the agent ID it gives you.
4. Set `ELEVENLABS_AGENT_ID` (plain) in the `api` component. The config now also shows `"voice_enabled": true`.

Dictation needs no CSP or DNS change: the browser records a clip of up to a minute and posts it to the API as JSON, and the API calls ElevenLabs. Browsers only allow the microphone over https, which the custom domains already use. `DAILY_DICTATIONS` caps each user's clips per day; `0` turns dictation off while keeping the coach. `ELEVENLABS_STT_MODEL` picks the model, `scribe_v2` by default. If the API logs "ElevenLabs refused the key", the key lacks the Speech to Text permission.

## Admin tasks

The API ships an admin CLI. Run it inside the running container:

1. The app > Console tab > pick the `api` component.
2. The shell opens in `/app/api` with the production environment loaded.
3. Run the command you need:

   ```sh
   python -m app.cli users              # list accounts and whether each is active or disabled
   python -m app.cli stats              # counts of accounts, boards and model calls
   python -m app.cli create-user <name> # make an organizer account without an invite code; prompts for the password
   python -m app.cli disable <username> # block an account and sign it out
   python -m app.cli enable <username>  # unblock it
   python -m app.cli delete <username>  # delete an account and everything it owns; asks first, --yes skips that
   ```

The CLI talks to the same database through `DATABASE_URL`, so changes take effect right away. There is no admin page in the web app on purpose. `python -m app.cli --help` lists the commands.

## Rotating invite codes

1. The app > Settings > `api` > Environment Variables > `INVITE_CODES` > Edit.
2. Replace the value with the new codes, comma separated. Keep an old code in the list if people are still signing up with it.
3. Save. App Platform redeploys the API, and the new list applies once the deploy is live.

Existing accounts keep working. To close signups, set `INVITE_CODES` to an empty value. `MAX_USERS` caps signups regardless of codes.

## Logs

- Control panel: the app > Runtime Logs, pick `api`. Build and deploy logs are on the Activity tab.
- doctl:

  ```sh
  doctl apps logs <app-id> api --type run --follow
  doctl apps logs <app-id> api --type build
  doctl apps logs <app-id> api --type deploy
  ```

API log lines start with a level and a tag such as `[startup]` or `[config]`. A misconfigured variable stops startup with a message naming it.

## Changing the spec later

Do not re-apply `.do/app.yaml` from the repo to the running app. Its secrets have no values, so applying it can wipe the ones you set. Edit the live spec instead:

```sh
doctl apps spec get <app-id> > /tmp/threatviz-live.yaml
# edit /tmp/threatviz-live.yaml; secrets appear as EV[...] ciphertext and are kept as is
doctl apps update <app-id> --spec /tmp/threatviz-live.yaml
rm /tmp/threatviz-live.yaml
```

The control panel's Settings > App Spec editor does the same thing. Mirror any non-secret change back into `.do/app.yaml` so the repo stays accurate.

## Troubleshooting

- **The first deploy fails with a message about `APP_SECRET`.** Expected until step 3 is done.
- **The API deploy fails its health check.** Check the runtime logs. If requests to `/api/health` get `400 Invalid host header`, the health checker is sending a Host the API does not allow. Add that host to an `ALLOWED_HOSTS` variable on the `api` component, comma separated, and redeploy.
- **The static site build fails on a Node version error.** The App Platform Node buildpack picks its Node version from `engines.node` in `web/package.json`. CI builds with Node 24, so `"engines": { "node": "24.x" }` there matches it.
- **The site loads but every API call fails.** Check `VITE_API_BASE_URL` on the static site is `https://api.example.com` with no trailing slash, and that `CORS_ORIGINS` on the API is exactly the site's origin. Changing `VITE_API_BASE_URL` needs a rebuild of the static site, because it is baked in at build time.
- **Sign in works but the next request is signed out.** The cookie is not reaching the API. Both hosts must be subdomains of the same domain for `COOKIE_SAMESITE=lax`.

## Running it locally like production

`docker-compose.yml` runs Postgres 16 and one container that serves both the API and the built web app from `http://localhost:8080`, the same origin, using the `full` target of the `Dockerfile`.

```sh
cp .env.example .env    # set APP_SECRET, and LLM_API_KEY if you want a real model
docker compose up --build
curl -fsS http://localhost:8080/api/health
```

Keep `APP_ENV=development` in `.env` for this. Production mode requires an https `PUBLIC_ORIGIN` and secure cookies, which plain `http://localhost` does not give you. Postgres data lives in the `pgdata` volume; `docker compose down -v` deletes it.

To build the images by hand:

```sh
docker build -t threatviz-api .                  # API only, what App Platform builds
docker build --target full -t threatviz-full .   # API plus the web app
```

## Hosting the frontend elsewhere

The `web` static site component can be swapped for any static host, such as GoDaddy web hosting, Netlify or Vercel.

1. Build with the API's URL baked in:

   ```sh
   cd web
   npm ci
   VITE_API_BASE_URL=https://api.example.com npm run build
   ```

2. Upload the contents of `web/dist` to the host.
3. Send every unknown path to `index.html`, so client-side routes work on reload. On Netlify, add a `_redirects` file to `dist` with the line `/* /index.html 200`. On Vercel, add a rewrite from `/(.*)` to `/index.html`. On Apache hosting such as GoDaddy cPanel, use an `.htaccess` with `FallbackResource /index.html`.
4. Point `app.example.com` at the host as its docs describe, set `CORS_ORIGINS` on the API to the site's origin, and remove the `web` component and its ingress rules from the App Platform spec.

Keep the site on a subdomain of the same domain as the API. On a different domain, such as a `netlify.app` address, the session cookie becomes a third-party cookie, which needs `COOKIE_SAMESITE=none` and which many browsers block anyway.

## Teardown

Run through this when the event is over. The repo stays public, so every key that was ever used must be revoked, not just deleted from the app.

- [ ] Copy out anything you want to keep. The dev database has no backups.
- [ ] Destroy the app: the app > Settings > Destroy, or `doctl apps delete <app-id>`. This removes the `api` service, the `web` static site and the dev database with it.
- [ ] Check Databases in the control panel shows no leftover cluster, and Apps shows nothing for this project.
- [ ] Delete the `api` and `app` CNAME records in GoDaddy DNS, plus the apex A records or forwarding and any CAA records you added for this.
- [ ] Revoke the DigitalOcean model access key under Serverless Inference > Model Access Keys.
- [ ] Revoke the Backboard API key the team used, in the Backboard dashboard.
- [ ] Revoke the ElevenLabs API key, and delete the ElevenLabs agent.
- [ ] Revoke the DigitalOcean personal access token used with `doctl`, under API > Tokens, and run `doctl auth remove --context default`.
- [ ] Remove the DigitalOcean GitHub app's access to the repo, in GitHub > Settings > Applications, if nothing else uses it.
- [ ] Check Billing shows no running resources, so nothing eats the remaining credit.
