# Deploying to production

Harbour is a single-process Next.js app with a SQLite file. Anything that can run Node and persist a directory will host it. This guide covers the two paths the repo supports out of the box: Docker Compose on a single host, and a one-command DigitalOcean droplet via Terraform.

Pick Docker if you already have a server and just want harbour on it. Pick the Terraform path if you don't have a server yet and want one provisioned for you with HTTPS, basic auth, and a hardened SSH config baked in.

## Path A — Docker Compose (single host)

Use this when you already have a Linux host with Docker installed. The shipped [`docker-compose.yml`](../../docker-compose.yml) maps host port `3030` to the container's `3000`, persists everything to `./data`, and uses [`Dockerfile`](../../Dockerfile) to build a Node 22 Alpine image.

### 1. Clone and run

```bash
git clone https://github.com/geekforbrains/harbour.git
cd harbour
make run
```

`make run` is just `docker compose up -d --build` plus a friendly status message — see [`Makefile`](../../Makefile). On first run it builds the image (a few minutes) and starts the container.

Visit `http://<host>:3030`. Sign up — the first account is whoever signs up first. Then go to **Settings** and turn off `signup_enabled` so nobody else can register against your install.

### 2. Operating it

```bash
make logs     # follow logs (docker compose logs -f harbour)
make restart  # restart container
make down     # stop the container
make rebuild  # rebuild image and restart (after pulling new code)
make shell    # exec into the container
make clean    # stop and wipe ./data — destructive
```

> `make clean` deletes the `./data` directory. That's the database, all uploaded attachments, and the encryption key. Don't run it without a backup.

### 3. Updating

```bash
git pull
make rebuild
```

`make rebuild` is `docker compose up -d --build --force-recreate` — it rebuilds the image and recreates the container. The `./data` volume persists across rebuilds, so users, jobs, runs, and credentials survive.

> The README's `npm run release` script is for **bare-metal macOS / launchd installs only** — see [`scripts/release.sh`](../../scripts/release.sh). It bails out on non-Darwin systems. For Docker, always use `make rebuild`.

### 4. State lives in `./data`

Everything harbour persists is under `./data` because [`docker-compose.yml`](../../docker-compose.yml) sets `HARBOUR_HOME=/data` and bind-mounts `./data` to it:

| What | Where |
|---|---|
| SQLite DB | `./data/harbour.db` |
| Uploads | `./data/uploads/` |
| Encryption key | `./data/encryption.key` |
| Captain workspace | `./data/captain/` |
| Runner config (server-side runner) | `./data/runners.json` |

Backing up harbour is "tar up `./data`". Nothing else.

> **Back up `./data/encryption.key` separately.** Lose it and every encrypted env var becomes unrecoverable garbage. Keep a copy somewhere that isn't on the same disk as the database.

### 5. HTTPS in front

The container speaks plaintext HTTP on `:3000` (mapped to host `:3030`). Don't expose that to the internet directly. Stand up a reverse proxy in front:

- **Caddy** is what the [Terraform path](#path-b-digitalocean-droplet-via-terraform) uses internally — auto-issues Let's Encrypt certs, easy to configure.
- **Nginx / Traefik / Cloudflare Tunnel** all work fine. Anything that can do TLS termination + reverse proxy.

Whatever proxy you pick, terminate TLS there and forward to `localhost:3030`.

### 6. The optional `remote` profile

If you want to test the [run-on-a-different-machine](run-on-different-machine.md) flow without a second machine, the compose file ships a `harbour-remote` service under the `remote` profile:

```bash
docker compose --profile remote up -d
```

This brings up a second container with the runner-only image ([`Dockerfile.runner`](../../Dockerfile.runner)) that polls in a 60s loop. See the [run-on-a-different-machine guide](run-on-different-machine.md#trying-it-locally-before-pointing-at-a-real-remote-box) for the connect step — it's a sandbox, not a production setup.

## Path B — DigitalOcean droplet via Terraform

Use this when you don't have a server yet. One `terraform apply` provisions an Ubuntu 24.04 droplet with HTTPS, Basic Auth, fail2ban, automatic security updates, and harbour running as a systemd service. About 5 minutes from `apply` to a logged-in dashboard, plus DNS propagation.

What it gives you, traced through [`terraform/cloud-init.yml.tftpl`](../../terraform/cloud-init.yml.tftpl):

- Caddy out front terminating TLS with Let's Encrypt, gating with HTTP Basic Auth.
- Harbour bound to `localhost:3030` only — never directly reachable from the internet.
- DigitalOcean cloud firewall + UFW: only `22/80/443` open.
- fail2ban watching Caddy's access log; bans IPs after 20 failed Basic Auth attempts in 10 minutes.
- SSH hardened: key-only login, no root password.
- Unattended security upgrades, with auto-reboot at 04:30 local if needed.
- Node 22, Claude Code, Codex, and Gemini CLI installed under a dedicated `harbour` user.
- `harbour.service` (the Next.js server) and `harbour-agent-runner.service` (the runner, polling every 60s) installed and enabled as systemd units.

### 1. Prerequisites

1. **A domain you control.** You'll point an A record at the droplet's IP after apply. Caddy waits for DNS to resolve before requesting a cert (see `wait-for-dns.sh` in the cloud-init template).
2. **DigitalOcean account** with:
   - An API token at https://cloud.digitalocean.com/account/api/tokens.
   - At least one SSH key registered (`doctl compute ssh-key list`).
3. **Terraform** ≥ 1.5 locally.

### 2. Configure tfvars

```bash
cd terraform/
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`. Required (see [`variables.tf`](../../terraform/variables.tf) for the full list with validation):

| Variable | What it is |
|---|---|
| `do_token` | DigitalOcean API token |
| `domain` | FQDN you'll serve harbour at, e.g. `harbour.example.com` |
| `letsencrypt_email` | Email for ACME registration (used for cert expiry notices) |
| `basic_auth_password` | The shared HTTP Basic Auth password — must be ≥ 16 chars; generate with `openssl rand -base64 24` |
| `ssh_key_names` | Names of SSH keys already registered in your DO account |

Sensible defaults:

- `basic_auth_user = "team"` — the Basic Auth username.
- `region = "sfo3"` — droplet region.
- `size = "s-2vcpu-4gb"` — about $24/mo. `s-1vcpu-2gb` (~$12/mo) works for light use.
- `harbour_ref = "main"` — the git ref to check out after cloning. Pin to a tag for production (e.g. `"v1.14.0"`).

Optionally lock SSH down to your IP:

```hcl
ssh_allowed_cidrs = ["1.2.3.4/32"]
```

### 3. Apply

```bash
terraform init
terraform plan
terraform apply
```

Outputs include `droplet_ip`, `ssh_command`, `url`, and a `next_steps` block. Copy the IP.

### 4. Point DNS at the droplet

Create an A record `<your-domain> → <droplet_ip>`. If you're using Cloudflare, set the proxy to **DNS only** (grey cloud) until the initial Let's Encrypt cert is issued — then you can flip to proxied.

### 5. Watch the bootstrap finish

```bash
ssh root@<droplet_ip> 'tail -f /var/log/cloud-init-output.log'
```

Look for the line `HARBOUR READY -- https://<your-domain>`. Typical time: 3–6 minutes (longer if cert issuance takes a few retries).

### 6. Sign up the first user

Visit `https://<your-domain>`. The browser will prompt for HTTP Basic Auth — use the user/password from `terraform.tfvars`.

Past Basic Auth, you land on harbour's signup screen. Create your account.

> **Disable signup right after.** Settings → Signup → off. The Basic Auth gate is shared across the team; harbour accounts are per-person. Until you turn signup off, anyone past the gate can mint another account.

### 7. Auth the AI CLIs

The CLIs each need an interactive auth flow once. The runner runs as the `harbour` user on the droplet, not root, so auth state has to land in `/home/harbour/`.

```bash
ssh root@<droplet_ip>
su - harbour
claude   # OAuth device-code flow — or: export ANTHROPIC_API_KEY=...
codex    # Browser sign-in — or: export OPENAI_API_KEY=...
gemini   # OAuth device-code flow — or: export GEMINI_API_KEY=...
exit
# If the runner was started before the CLI was authed, kick it:
systemctl restart harbour-agent-runner
```

For API-key auth instead of OAuth, either put the keys in `/home/harbour/.bashrc` or use a systemd drop-in: `systemctl edit harbour-agent-runner` and add:

```ini
[Service]
Environment=ANTHROPIC_API_KEY=...
Environment=OPENAI_API_KEY=...
Environment=GEMINI_API_KEY=...
```

### 8. Updating

```bash
ssh root@<droplet_ip>
cd /opt/harbour
git pull
npm ci
npm run build
# Next.js standalone needs public/ and .next/static/ copied next to server.js
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
systemctl restart harbour
systemctl restart harbour-agent-runner
```

The `cp` steps mirror what cloud-init does on first install (see the cloud-init template). The systemd unit's `WorkingDirectory` is `/opt/harbour/.next/standalone`, and the standalone server only finds `public` and `.next/static` if they're siblings of `server.js`.

> Don't run `npm run release` on the droplet — that script is for bare-metal macOS launchd installs and will refuse to run on Linux ([`scripts/release.sh`](../../scripts/release.sh) checks `uname -s`).

### 9. Logs

```bash
journalctl -u harbour -f               # the Next.js server
journalctl -u harbour-agent-runner -f  # the runner
journalctl -u caddy -f                 # the proxy / cert issuance
tail -f /var/log/caddy/access.log      # request log (also what fail2ban watches)
```

### 10. Tearing down

```bash
terraform destroy
```

Then delete the DNS record manually.

## State and backups

Whichever path you took, harbour's state lives in one directory:

| Setup | Directory |
|---|---|
| Docker Compose | `./data/` (bind-mounted to `/data` inside the container) |
| Terraform droplet | `/home/harbour/.harbour/` |
| Bare-metal macOS | `~/.harbour/` |

What's in there: `harbour.db` (SQLite), `uploads/` (run attachments), `encryption.key`, `runners.json` (server-side runner config), `sessions.json` (CLI session IDs for resume), `captain/` (Captain's per-conversation workspaces), `workflows/` (workflow gate scripts).

Backup strategy: snapshot the directory. Restoring is "put it back, restart the service".

> The encryption key is the one piece you should back up **separately** from the database. The DB encrypts env vars with that key, so a backup of the DB without the key is half-useless. A backup of the key without the DB is fine — you can always re-create env vars in a fresh install.

## Choosing between the paths

| | Docker Compose | Terraform droplet |
|---|---|---|
| You already have a host | Yes | No (it provisions one) |
| TLS / cert handling | Bring your own proxy | Caddy + Let's Encrypt baked in |
| Auth gate | Bring your own | Basic Auth + fail2ban baked in |
| Updates | `git pull && make rebuild` | `git pull && npm ci && npm run build && systemctl restart` |
| Hosts the runner too | No (workflow-only jobs polled by `harbour-remote` if you enable the profile) | Yes (`harbour-agent-runner.service`) |
| Cost | Whatever your host costs | ~$12–24/mo droplet + DNS |

If you start with Docker and outgrow it, the data directory is portable — copy `./data/` to the new host, point the new install at it, and you're moved.

## Next

- [Running a runner on a different machine](run-on-different-machine.md) — for jobs that need to run somewhere other than the harbour host.
- [Agents](../concepts/agents.md) — the harbour-vs-external split, polling, API key rotation.
