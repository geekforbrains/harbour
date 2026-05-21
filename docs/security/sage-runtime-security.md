# SAGE Runtime Security

Harbour requires SAGE as the Agent Detection and Response layer for BORG production agent runtimes. The source blueprint is `/Users/davidk/Downloads/secure-hermes-openclaw-runtime-blueprint.md`; this document records the Harbour implementation contract.

## Pin

- Source: `https://github.com/gendigitalinc/sage.git`
- Version: `0.9.0`
- NPM packages: `@gendigital/sage-core@0.9.0`, `@gendigital/sage-openclaw@0.9.0`
- Threat resources: bundled from `@gendigital/sage-openclaw`

## Enforcement

- OpenClaw: Harbour verifies `openclaw plugins list` contains enabled SAGE OpenClaw coverage before spawn.
- Hermes: Harbour verifies `hermes hooks list` and `hermes hooks doctor` before spawn. The hook command is `node "/Users/davidk/Documents/Borg Interface/harbour/bin/sage-hermes-hook.mjs"`.
- Workflow commands: Harbour evaluates every `workflow_command` through SAGE before `bash -c`. `deny` and `ask` both block execution.
- Future CLI providers: Harbour fails closed until the provider is mapped to native SAGE coverage or a SAGE wrapper.

## Privacy

The local SAGE profile is written to `~/.sage/config.json` with `sensitivity: "paranoid"`, `community_iq: false`, URL/file/package/AMSI checks enabled, PI cloud checks disabled, and local cache/audit files under `~/.sage`.

## Toolkit Metadata

`/api/toolkit-libraries` includes:

```json
{
  "provider": "sage",
  "source_repo": "https://github.com/gendigitalinc/sage.git",
  "version": "0.9.0",
  "enforcement": "hard-gate",
  "required_for": ["openclaw", "hermes", "workflow", "future-agent-cli"],
  "privacy_profile": "local-first",
  "config_path": "~/.sage/config.json"
}
```

Run payloads for OpenClaw and Hermes include the same metadata so spawned agents can report SAGE status in summaries.

## Operator Setup

```bash
cd "/Users/davidk/Documents/Borg Interface/harbour"
npm run setup:sage-runtime
openclaw plugins install @gendigital/sage-openclaw@0.9.0 --pin --dangerously-force-unsafe-install
openclaw plugins list | rg -i 'sage|gendigital'
hermes hooks list
hermes hooks doctor
```
