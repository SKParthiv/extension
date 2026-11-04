# TrueForge bootstrap

Date: 2026-11-04

## Verified package versions

```text
@truefoundry/trueforge      0.183.0
@truefoundry/trueforge-sdk  0.183.0
```

## Startup

Command:

```text
npx --yes @truefoundry/trueforge@latest
```

Observed startup:

```text
TrueForge v0.183.0 · standalone
Standalone mode: sqlite at C:\Users\parth\AppData\Local\trueforge\Data\db\db.sqlite
Auth is disabled; browser login is off
Agent server listening on http://localhost:8790 (docs at /api/v1/docs)
```

The local process is still running in the terminal used for bootstrap.

## API and UI

- Bundled UI: `http://localhost:8790/` returned HTTP 200 with the TrueForge frontend.
- Interactive API docs: `http://localhost:8790/api/v1/docs`.
- OpenAPI discovery: `http://localhost:8790/api/v1/openapi.json` returned HTTP 200.
- Tested conventional health paths `/health`, `/api/health`, and `/api/v1/health`; each returned HTTP 404. No health endpoint was claimed.

## Configured models

`GET http://localhost:8790/api/v1/models` returned:

```json
{
  "data": [
    {
      "name": "dead-endpoint/dead-model",
      "model_id": "dead-model",
      "provider": { "name": "dead-endpoint" }
    },
    {
      "name": "ollama/qwen25-coder-7b",
      "model_id": "qwen2.5-coder:7b-instruct",
      "provider": { "name": "ollama" }
    }
  ]
}
```

The local Ollama installation contains `qwen3.5:9b`, but TrueForge does not currently list it as a configured model. No model or credential was added. This is the next prerequisite before runtime integration and Qwen3.5 smoke tests can be truthful.

## Startup limitations

- TrueForge reported that its local sandbox provider is unavailable on Windows.
- Standalone auth is disabled, as expected for this local setup.

