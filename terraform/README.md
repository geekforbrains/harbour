# Deploy Harbour to DigitalOcean (Terraform)

Spins up a single Ubuntu 24.04 droplet running Harbour behind Caddy with
Let's Encrypt TLS and HTTP Basic Auth. Hardened with UFW, fail2ban,
SSH-key-only login, and automatic security updates.

## What you get

- Harbour at `https://<your-domain>` behind a shared HTTP Basic Auth gate
- Let's Encrypt cert auto-issued and auto-renewed by Caddy
- Host firewall (UFW) + DigitalOcean cloud firewall: only 22/80/443 open
- Harbour itself listens only on localhost:3030 — not reachable from the internet
- Harbour runs as a plain systemd service (`harbour.service`), not Docker —
  simpler to update (`git pull && npm ci && npm run build && systemctl restart`)
- Harbour agent runner runs as a sibling systemd service (`harbour-agent-runner.service`)
  that polls every 60s and spawns the AI CLIs directly on the host
- fail2ban bans IPs after 20 failed Basic Auth attempts in 10 minutes (1 hour ban).
  The threshold is 20, not 5, because one browser page load with a wrong stored
  password fans out Authorization on many asset requests — 5 would self-ban a
  legitimate user on a single mistake. Only real wrong-password attempts count —
  uncredentialed 401s (manifest.json, favicons, initial page nav) are ignored
- Unattended security upgrades enabled (auto-reboots at 04:30 local if needed)
- Node 22 + Claude Code, Codex, and Gemini CLIs installed on the host
  (you log into each once after the droplet is up — no headless auth path)

## Prerequisites

1. **A domain you control.** You'll point it at the droplet's IP after apply.
   Harbour will not start serving HTTPS until DNS resolves.
2. **DigitalOcean account** with:
   - An API token (create at https://cloud.digitalocean.com/account/api/tokens)
   - At least one SSH key registered (`doctl compute ssh-key list`)
3. **Terraform** ≥ 1.5 installed locally.

## One-time setup

```bash
cd terraform/
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — fill in do_token, domain, letsencrypt_email,
# basic_auth_password (use: openssl rand -base64 24), and ssh_key_names.

terraform init
terraform plan
```

## Deploy

```bash
terraform apply
```

Terraform outputs the droplet IP. Now:

1. **Create a DNS A record** pointing your domain at that IP.
   - If using Cloudflare: set the proxy status to **DNS only** (grey cloud)
     until the initial cert is issued. You can switch to proxied (orange cloud)
     afterward for DDoS protection.
2. **Watch the bootstrap** finish:
   ```bash
   ssh root@<droplet-ip> 'tail -f /var/log/cloud-init-output.log'
   ```
   Look for `HARBOUR READY`. It typically takes 3–6 minutes.
3. **Visit** `https://<your-domain>`. Basic Auth with the user/password from
   your tfvars. You'll land on the Harbour signup screen — create your
   individual account there.

## Log into the AI CLIs

The CLIs don't have a clean headless auth path, so you run each once
interactively over SSH. The runner runs as the `harbour` user (not root),
so auth each CLI under that user — auth state lives in `/home/harbour/`
and persists across restarts.

```bash
ssh root@<droplet-ip>
su - harbour
claude   # OAuth device-code flow — or: export ANTHROPIC_API_KEY=...
codex    # Browser sign-in — or: export OPENAI_API_KEY=...
gemini   # OAuth device-code flow — or: export GEMINI_API_KEY=...
exit
# then, if the runner was already started before the CLI was authed:
systemctl restart harbour-agent-runner
```

For API-key mode, put them in `/home/harbour/.bashrc` (so the systemd
service session picks them up via `su -c` if needed) or in the runner's
systemd drop-in (`systemctl edit harbour-agent-runner`, add
`[Service]\nEnvironment=ANTHROPIC_API_KEY=...`).

## Updating Harbour

```bash
ssh root@<droplet-ip>
cd /opt/harbour
git pull
npm ci
npm run build
systemctl restart harbour
systemctl restart harbour-agent-runner
```

Harbour runs as a plain systemd service (`npm start` under the hood), not
Docker. Logs via `journalctl -u harbour -f`. The agent runner runs as a
sibling service `harbour-agent-runner.service` that polls every 60s and
spawns Claude/Codex/Gemini CLIs directly on the host.

## Rotating the Basic Auth password

Update `basic_auth_password` in `terraform.tfvars`, then:

```bash
# Either re-apply (which re-runs cloud-init on new droplets only — won't
# update existing), or just SSH in and regenerate the Caddyfile:
ssh root@<droplet-ip>
NEW_HASH=$(caddy hash-password --plaintext 'your-new-password')
sed -i "s|basic_auth {.*|basic_auth {|" /etc/caddy/Caddyfile  # manual edit safer
# easier: edit /etc/caddy/Caddyfile directly and replace the hash line
systemctl reload caddy
```

## Teardown

```bash
terraform destroy
```

Delete the DNS record manually afterward.

## Variables

See `variables.tf` for the full list. Required: `do_token`, `domain`,
`letsencrypt_email`, `basic_auth_password`, `ssh_key_names`. Everything
else has sensible defaults.

## Cost

- `s-2vcpu-4gb` droplet: ~$24/mo (default)
- `s-1vcpu-2gb`: ~$12/mo (works for light use — change `size` in tfvars)
- Firewall, VPC, bandwidth: free within normal limits

## Security model

This setup is designed for a small team sharing a deployment. The Basic Auth
is a **gate**, not a **bunker** — it keeps the public internet from poking at
Harbour directly, and slows down credential-stuffing via fail2ban + bcrypt.
Individual accountability lives inside Harbour (each user signs up their own
account after getting past Basic Auth).

**What this protects against:** opportunistic internet scans, bot traffic,
brute-force login attempts, unpatched kernel CVEs (via unattended-upgrades).

**What this does not protect against:** a team member leaking the shared
Basic Auth password (rotate when anyone leaves), a zero-day in Harbour itself
(Basic Auth is one layer, not the only one — keep Harbour updated).

## Troubleshooting

- **Caddy can't get a cert:** DNS isn't resolving yet, or Cloudflare proxy is
  on. Check `journalctl -u caddy -n 100`. Caddy retries automatically; once
  DNS is correct, run `systemctl restart caddy` to force a new attempt.
- **Can't SSH:** check `ssh_allowed_cidrs` in tfvars and the droplet's DO
  firewall rules. Use the DO web console as a fallback.
- **Harbour unreachable over HTTPS but Caddy is running:** check
  `docker compose ps` in `/opt/harbour` — the container may have crashed.
- **fail2ban banned me:** `ssh root@<ip> sudo fail2ban-client unban <your-ip>`.
