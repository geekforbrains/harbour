# Workflows

A workflow is a deterministic scheduled shell command. It is not an agent job, does not invoke an LLM, and is claimed by a workflow runner using workflow-runner credentials.

Agent jobs can still have a `prerun_command`. That is a separate feature: a cheap gate that runs immediately before the LLM so the runner can skip token spend when there is no work.

| Feature | Own schedule | Own runner auth | Uses an agent | Purpose |
|---|---:|---:|---:|---|
| Agent job | Yes | No | Yes | LLM-driven work |
| Agent prerun command | No | No | Yes | Gate before LLM |
| Workflow | Yes | Yes | No | Deterministic scheduled work |

The full workflow contract, runner setup, payload shape, exit-code protocol, and operational notes live in [Workflows](../workflows.md).
