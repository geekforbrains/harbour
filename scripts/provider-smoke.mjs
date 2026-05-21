#!/usr/bin/env node

const APPROVAL_VALUE = "read-only-provider-smoke-ok";

const providers = {
  openrouter: {
    env: ["OPENROUTER_API_KEY"],
    method: "GET",
    url: "https://openrouter.ai/api/v1/models",
    auth: env => ({ Authorization: `Bearer ${env.OPENROUTER_API_KEY}` }),
    validate: json => Array.isArray(json?.data),
  },
  google: {
    env: ["GOOGLE_API_KEY"],
    method: "GET",
    url: env => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(env.GOOGLE_API_KEY)}`,
    auth: () => ({}),
    validate: json => Array.isArray(json?.models),
  },
  groq: {
    env: ["GROQ_API_KEY"],
    method: "GET",
    url: "https://api.groq.com/openai/v1/models",
    auth: env => ({ Authorization: `Bearer ${env.GROQ_API_KEY}` }),
    validate: json => Array.isArray(json?.data),
  },
  mistral: {
    env: ["MISTRAL_API_KEY"],
    method: "GET",
    url: "https://api.mistral.ai/v1/models",
    auth: env => ({ Authorization: `Bearer ${env.MISTRAL_API_KEY}` }),
    validate: json => Array.isArray(json?.data),
  },
  cerebras: {
    env: ["CEREBRAS_API_KEY"],
    method: "GET",
    url: "https://api.cerebras.ai/v1/models",
    auth: env => ({ Authorization: `Bearer ${env.CEREBRAS_API_KEY}` }),
    validate: json => Array.isArray(json?.data),
  },
  cloudflare: {
    env: ["CLOUDFLARE_API_TOKEN"],
    method: "GET",
    url: "https://api.cloudflare.com/client/v4/user/tokens/verify",
    auth: env => ({ Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }),
    validate: json => json?.success === true,
  },
};

function parseArgs(argv) {
  const selected = [];
  let dryRun = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") dryRun = false;
    if (arg === "--provider") selected.push(argv[++i]);
    if (arg === "--all") selected.push(...Object.keys(providers));
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/provider-smoke.mjs [--all | --provider openrouter] [--live]

Default is dry-run. Live mode requires:
  BORG_PROVIDER_SMOKE_APPROVED=${APPROVAL_VALUE}

Supported providers: ${Object.keys(providers).join(", ")}
Read-only checks only: model list or token metadata. No paid inference.`);
      process.exit(0);
    }
  }
  return { dryRun, selected: selected.length ? [...new Set(selected)] : ["openrouter", "google"] };
}

function requireKnownProviders(selected) {
  for (const provider of selected) {
    if (!providers[provider]) {
      throw new Error(`Unknown provider "${provider}". Supported: ${Object.keys(providers).join(", ")}`);
    }
  }
}

function missingEnv(spec, env) {
  return spec.env.filter(name => !env[name]);
}

async function runProvider(name, spec, env) {
  const url = typeof spec.url === "function" ? spec.url(env) : spec.url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: spec.method,
      headers: {
        Accept: "application/json",
        ...spec.auth(env),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
    if (!res.ok) {
      return { provider: name, ok: false, status: res.status, check: "read-only-auth", detail: "request failed" };
    }
    if (!spec.validate(json)) {
      return { provider: name, ok: false, status: res.status, check: "read-only-auth", detail: "unexpected response shape" };
    }
    return { provider: name, ok: true, status: res.status, check: "read-only-auth" };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const { dryRun, selected } = parseArgs(process.argv.slice(2));
  requireKnownProviders(selected);

  if (dryRun) {
    console.log(JSON.stringify({
      mode: "dry-run",
      selected,
      live_gate: `BORG_PROVIDER_SMOKE_APPROVED=${APPROVAL_VALUE}`,
      checks: selected.map(provider => ({
        provider,
        required_env: providers[provider].env,
        check: "read-only-auth",
      })),
    }, null, 2));
    return;
  }

  if (process.env.BORG_PROVIDER_SMOKE_APPROVED !== APPROVAL_VALUE) {
    throw new Error(`Refusing live smoke without BORG_PROVIDER_SMOKE_APPROVED=${APPROVAL_VALUE}`);
  }

  const results = [];
  for (const provider of selected) {
    const spec = providers[provider];
    const missing = missingEnv(spec, process.env);
    if (missing.length) {
      results.push({ provider, ok: false, check: "read-only-auth", missing_env: missing });
      continue;
    }
    results.push(await runProvider(provider, spec, process.env));
  }

  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.ok)) process.exit(1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
