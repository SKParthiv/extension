# Verified TrueForge SDK API

Verified against `@truefoundry/trueforge-sdk@0.183.0` on 2026-11-04.

| Requirement | Verified API |
|---|---|
| Client | `TrueForge` from `@truefoundry/trueforge-sdk` |
| Base URL | `new TrueForge({ baseUrl, token? })` |
| Create session | `client.sessions.create({ agent: { name } })` |
| Stream a turn | `client.sessions.createTurnStream(sessionId, { input, previousTurnId? })` |
| Stream consumption | `for await (const event of response)` |
| User message | `{ type: "user.message", content }` |
| Approval response | `{ type: "user.tool_approval", threadId, toolCallId, approval }` |
| Approval decisions | `{ status: "allow" }` or `{ status: "deny", reason? }` |
| Approval event | `tool.approval_required` |
| Client tool response event | `tool.response_required` |
| Model streaming events | `model.message.delta` and `model.message` |
| Usage | `event.usage.inputTokens` and `event.usage.outputTokens` |
| Cancellation | `client.sessions.cancel(sessionId)` |
| Terminal event | `turn.done`, whose state is `done`, `cancelled`, or `error` |

The adapter uses the SDK's real event names and request field names. It does not call a model provider directly. The runtime production factory uses a dynamic SDK import because the extension bundle is CommonJS while the package's preferred type declarations are ESM.

