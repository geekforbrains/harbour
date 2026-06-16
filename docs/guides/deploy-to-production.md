# Deploying to production

Harbour is a single-process Next.js app with a SQLite file. Anything that can run Node and persist a directory will host it — no external database, no Redis, no background workers. This guide covers a plain Linux host (systemd + a reverse proxy); the macOS/launchd path is covered briefly at the end.

> Prefer containers? Harbour is a standard Next.js + SQLite app and containerizes the usual way (build, copy `.next/standalone`, persist `HARBOUR_HOME` as a volume). The repo doesn't ship or support a Dockerfile, but nothing about harbour resists one.

## Linux (systemd)

Assumes Ubuntu-ish, but nothing here is distro-specific beyond package names. You'll end with harbour running as two systemd services (server + runner) under a dedicated user, bound to localhost, with Caddy terminating TLS in front.

### 1. Prerequisites

- **Node 24 LTS** (e.g. via [NodeSource](https://github.com/nodesource/distributions): `curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs`)
- **A domain you control**, with an A record you can point at the host.
- Whatever AI CLIs your agents use (Claude Code, Codex, Gemini CLI) — installed later, under the service user.

Create a dedicated user. The runner refuses to drive Claude Code as root (`--dangerously-skip-permissions` is always passed, and Claude Code rejects it when running as root), so both services run unprivileged:

```bash
useradd -m -s /bin/bash harbour
```

### 2. Clone and build

```bash
git clone https://github.com/geekforbrains/harbour.git /opt/harbour
cd /opt/harbour
npm ci
npm run build
# Next.js standalone output: server.js expects public/ and .next/static/
# (and docs/, which /api/guide serves from) as siblings — next build
# doesn't put them there, so copy explicitly:
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
chown -R harbour:harbour /opt/harbour
mkdir -p /home/harbour/.harbour && chown harbour:harbour /home/harbour/.harbour
```

### 3. systemd units

`/etc/systemd/system/harbour.service` — the Next.js server:

```ini
[Unit]
Description=Harbour (Next.js server)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=harbour
Group=harbour
# Next.js is configured with output: standalone. The standalone server.js
# only resolves ./public and ./.next/static relative to its own directory,
# so run from inside .next/standalone/ (see the cp steps above).
WorkingDirectory=/opt/harbour/.next/standalone
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
Environment=HARBOUR_HOME=/home/harbour/.harbour
Restart=on-failure
RestartSec=5s
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/harbour-runner.service` — the runner (skip if this host won't run agents):

```ini
[Unit]
Description=Harbour runner (claims and runs work via /api/runner/claim)
After=harbour.service network-online.target
# Wants (not Requires) so a harbour restart doesn't stop the runner.
Wants=harbour.service network-online.target

[Service]
Type=simple
User=harbour
Group=harbour
WorkingDirectory=/opt/harbour
# Loop locally so one poll failure doesn't kill the service.
ExecStart=/bin/bash -c 'while true; do /usr/bin/node bin/harbour.mjs run || true; sleep 60; done'
Environment=HARBOUR_HOME=/home/harbour/.harbour
# Explicit PATH so the service session finds CLIs installed under the
# harbour user's home (the claude installer puts itself in ~/.local/bin).
Environment=PATH=/home/harbour/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

Enable both:

```bash
systemctl daemon-reload
systemctl enable --now harbour.service
systemctl enable --now harbour-runner.service
```

### 4. HTTPS in front

The server speaks plaintext HTTP on `127.0.0.1:3000` — never expose that directly. Put a TLS-terminating reverse proxy in front. [Caddy](https://caddyserver.com/) is the least-config option (auto-issues Let's Encrypt certs); a minimal `/etc/caddy/Caddyfile`:

```
harbour.example.com {
  encode zstd gzip

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "SAMEORIGIN"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }

  reverse_proxy localhost:3000
}
```

Nginx, Traefik, or a Cloudflare Tunnel all work just as well. If the dashboard is internet-facing, consider an extra gate in front of harbour's own login — Caddy's `basic_auth` directive, an IP allowlist, or a VPN/Tailscale-only bind. Standard host hygiene applies too: firewall down to `22/80/443` (ufw), fail2ban, unattended security upgrades, key-only SSH.

### 5. Create the admin and log in

There's no web signup — create the instance admin over SSH (one-time, interactive). Run it as the `harbour` user so the CLI writes to the same `HARBOUR_HOME` the service uses:

```bash
su - harbour
cd /opt/harbour
node bin/harbour.mjs setup
```

Visit `https://<your-domain>` and log in. Further accounts are created from the dashboard (Settings → Users) via set-password links.

### 6. Auth the AI CLIs

Each CLI needs an interactive auth flow once, as the `harbour` user (the runner runs as that user, so auth state has to land in `/home/harbour/`):

```bash
su - harbour
claude   # OAuth device-code flow — or: export ANTHROPIC_API_KEY=...
codex    # Browser sign-in — or: export OPENAI_API_KEY=...
gemini   # OAuth device-code flow — or: export GEMINI_API_KEY=...
exit
# If the runner was started before the CLI was authed, kick it:
systemctl restart harbour-runner
```

For API-key auth instead of OAuth, either put the keys in `/home/harbour/.bashrc` or use a systemd drop-in: `systemctl edit harbour-runner` and add:

```ini
[Service]
Environment=ANTHROPIC_API_KEY=...
Environment=OPENAI_API_KEY=...
Environment=GEMINI_API_KEY=...
```

### 7. Updating

```bash
cd /opt/harbour
git pull
npm ci
npm run build
# Standalone needs public/, .next/static/ (and the traced files) refreshed
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
systemctl restart harbour
systemctl restart harbour-runner
```

> Don't run `npm run release` here — that script is for macOS/launchd installs and refuses to run on Linux ([`scripts/release.sh`](../../scripts/release.sh) checks `uname -s`).

### 8. Logs

```bash
journalctl -u harbour -f               # the Next.js server
journalctl -u harbour-runner -f  # the runner
journalctl -u caddy -f                 # the proxy / cert issuance
```

## macOS (launchd)

macOS is the developer-machine path: `npm run build && npm start` from the repo, with the runner installed via `npm run harbour -- install` (a launchd plist that fires `run` every 60s — see [Getting started](getting-started.md)). If you run the server itself under launchd (label `com.harbour.server`), `npm run release` rebuilds and bounces the full stack in the right order — see [`scripts/release.sh`](../../scripts/release.sh) for what it does and why the server must stop before the build.

## State and backups

Wherever it runs, harbour's state lives in one directory — `HARBOUR_HOME`, default `~/.harbour/` (so `/home/harbour/.harbour/` in the Linux setup above).

What's in there: `harbour.db` (SQLite), `uploads/` (run attachments), `encryption.key`, `runner.token` (the runner credential, 0600), `sessions.json` (CLI session IDs for resume), `captain/` (Captain's per-conversation workspaces), `workflows/` (workflow and prerun scripts).

Backup strategy: snapshot the directory. Restoring is "put it back, restart the service".

> The encryption key is the one piece you should back up **separately** from the database. The DB encrypts env vars with that key, so a backup of the DB without the key is half-useless. A backup of the key without the DB is fine — you can always re-create env vars in a fresh install.

## Next

- [Running a runner on a different machine](run-on-different-machine.md) — for jobs that need to run somewhere other than the harbour host.
- [Agents](../concepts/agents.md) — the harbour-vs-external split, polling, API key rotation.
