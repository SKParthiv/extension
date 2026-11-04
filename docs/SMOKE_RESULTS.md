# Runtime smoke results

Date: 2026-11-04

## Status

Deferred because the local TrueForge instance does not currently expose a configured agent or the required Qwen3.5 9B model.

Verified with:

- `GET http://localhost:8790/api/v1/agents` returned `{"data":[],"pagination":{"limit":50}}`.
- `GET http://localhost:8790/api/v1/models` listed `dead-endpoint/dead-model` and `ollama/qwen2.5-coder:7b-instruct`, but not `qwen3.5:9b`.

No model, agent, key or provider configuration was added. Plain turns, structured tools, sequential tools, approval flow and usage fields must be rerun after an agent is configured against the intended local model. Prompt 11 can provide the MCP tool source for those later checks.

