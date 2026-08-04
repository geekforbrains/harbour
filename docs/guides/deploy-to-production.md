# Deploying to production

Harbour is a single-process Next.js app with a SQLite file. Anything that can run Node and persist a directory will host it — no external database, no Redis, no background workers. This guide covers a plain Linux host (systemd + a reverse proxy); the macOS/launchd path is covered briefly at the end.

> Prefer containers? Harbour is a standard Next.js + SQLite app: install, build, run `npm start`, persist `HARBOUR_HOME` as a volume, and bind deliberately with `HARBOUR_HOST=0.0.0.0`. The repo doesn't ship or support a Dockerfile.

## Linux (systemd)

Assumes Ubuntu-ish, but nothing here is distro-specific beyond package names. You'll end with harbour running as two systemd services (server + runner) under a dedicated user, bound to localhost, with Caddy terminating TLS in front.

### 1. Prerequisites

- **Node 24 LTS** (e.g. via [NodeSource](https://github.com/nodesource/distributions): `curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs`)
- **A domain you control**, with an A record you can point at the host.
- Whatever AI CLIs your agents use (Claude Code or Codex) — installed later and visible on the runner service's PATH.

Create a dedicated user. By default the runner launches Claude Code with `--dangerously-skip-permissions` (it's omitted only when an agent's workspace has a valid `.claude/settings.json` with a `permissions` object), and Claude Code refuses that flag when running as root — so both services run unprivileged:

```bash
useradd -m -s /bin/bash harbour
```

### 2. Clone and build

```bash
git clone https://github.com/geekforbrains/harbour.git /opt/harbour
cd /opt/harbour
npm ci
HARBOUR_PUBLIC_URL=https://harbour.example.com npm run build
chown -R harbour:harbour /opt/harbour
install -d -m 0700 -o harbour -g harbour /home/harbour/.harbour
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
WorkingDirectory=/opt/harbour
ExecStart=/usr/bin/node bin/harbour.mjs start
Environment=NODE_ENV=production
Environment=HARBOUR_PORT=14272
Environment=HARBOUR_HOST=127.0.0.1
Environment=HARBOUR_HOME=/home/harbour/.harbour
UMask=0077
Restart=on-failure
RestartSec=5s
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/harbour-runner.service` — the runner (skip if this host won't execute agent jobs or workflows):

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
Environment=HARBOUR_URL=http://127.0.0.1:14272
# Explicit PATH so the service session finds CLIs installed under the
# harbour user's home (the claude installer puts itself in ~/.local/bin).
# systemd does NOT inherit your login shell's PATH, so a CLI installed via a
# version manager (nvm, asdf, pyenv, volta) won't be found unless its bin dir
# is listed here. The runner advertises only CLIs on this PATH; a missing one
# leaves that agent's runs unclaimed. Add e.g. the nvm bin dir
# (/home/harbour/.nvm/versions/node/<ver>/bin) if a CLI lives there.
Environment=PATH=/home/harbour/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=on-failure
RestartSec=10s
UMask=0077

[Install]
WantedBy=multi-user.target
```

Load the units and start the server first. The runner is enabled after setup has
created its credential:

```bash
systemctl daemon-reload
systemctl enable --now harbour.service
```

### 4. HTTPS in front

The server speaks plaintext HTTP on `127.0.0.1:14272` — never expose that directly. Put a TLS-terminating reverse proxy in front. [Caddy](https://caddyserver.com/) is the least-config option (auto-issues Let's Encrypt certs); a minimal `/etc/caddy/Caddyfile`:

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

  reverse_proxy 127.0.0.1:14272
}
```

Nginx, Traefik, or a Cloudflare Tunnel all work just as well. If the dashboard is internet-facing, consider an extra gate in front of harbour's own login — Caddy's `basic_auth` directive, an IP allowlist, or a VPN/Tailscale-only bind. Standard host hygiene applies too: firewall down to `22/80/443` (ufw), fail2ban, unattended security upgrades, key-only SSH.

### 5. Create the first user and log in

There's no web signup — create the first user over SSH (one-time, interactive). Run it as the `harbour` user so the CLI writes to the same `HARBOUR_HOME` the service uses:

```bash
su - harbour
cd /opt/harbour
node bin/harbour.mjs setup
exit
systemctl enable --now harbour-runner.service
```

On Linux, setup provisions the local runner but deliberately does not attempt a
privileged service installation; the command above enables the systemd runner
after its token exists. Visit `https://<your-domain>` and log in. Further
accounts are created from the dashboard (Settings → Users) via set-password
links.

To use a different local port, change `HARBOUR_PORT` in `harbour.service`,
`HARBOUR_URL` in `harbour-runner.service`, and the reverse-proxy upstream
together.

### 6. Install and authenticate the AI CLIs

Install only the CLIs your agents select. Claude Code and Codex use their own auth state or direct API-key environment variables. Complete interactive login as the `harbour` user, because that is the account the runner uses:

```bash
su - harbour
claude   # OAuth device-code flow — or: export ANTHROPIC_API_KEY=...
codex    # Browser sign-in — or: export OPENAI_API_KEY=...
exit
# If the runner was started before the CLI was authed, kick it:
systemctl restart harbour-runner
```

For direct API-key auth instead of OAuth, use a systemd drop-in (`.bashrc` is not sourced by this non-interactive service): `systemctl edit harbour-runner` and add:

```ini
[Service]
Environment=ANTHROPIC_API_KEY=...
Environment=OPENAI_API_KEY=...
```

Then run `systemctl daemon-reload && systemctl restart harbour-runner`.

### 7. Updating

```bash
cd /opt/harbour
git pull
npm ci
HARBOUR_PUBLIC_URL=https://harbour.example.com npm run build
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

macOS is the developer-machine path: `npm run build && npm start` from the repo starts Harbour on `127.0.0.1:14272`, with the runner optionally installed via `npm run harbour -- install` (a launchd plist that fires `run` every 60s — see [Getting started](getting-started.md)). The server itself remains a foreground process by default. If you configure it separately under launchd with label `com.harbour.server`, `npm run release` rebuilds and bounces that installed stack in the right order — see [`scripts/release.sh`](../../scripts/release.sh) for what it does and why the server must stop before the build.

## State and backups

Wherever it runs, harbour's state lives in one directory — `HARBOUR_HOME`, default `~/.harbour/` (so `/home/harbour/.harbour/` in the Linux setup above).

What's in there: `harbour.db` (SQLite), `uploads/` (run attachments), `encryption.key`, `runner.token` (the runner credential, 0600), `runner.url` (its non-secret server URL), `sessions.json` (CLI session IDs for resume), and `workflows/` (workflow and prerun scripts).

Backup strategy: snapshot the directory. Restoring is "put it back, restart the service".

> The encryption key is the one piece you should back up **separately** from the database. The DB encrypts Secrets with that key, so a backup of the DB without the key is half-useless. A backup of the key without the DB is fine — you can always re-create Secrets in a fresh install.

`sessions.json` points at session data owned by each CLI. Back up the relevant CLI data under `/home/harbour` too if restoring in-progress conversation context matters; a Harbour-state-only restore can still run new work but may have to start old waiting/killed sessions fresh.

## Next

- [Running a runner on a different machine](run-on-different-machine.md) — for jobs that need to run somewhere other than the harbour host.
- [Agents](../concepts/agents.md) — the harbour-vs-external split, polling, API key rotation.
