# Cline audit

## Scope

- Upstream: https://github.com/cline/cline
- Pinned commit: `7a7878cb52fc33967d8b464b3e3d899beac42d4d`
- License metadata: Apache-2.0 in `apps/vscode/package.json` and the repository `LICENSE`.
- Audit date: 2026-11-04
- No Cline source was copied into this repository.

## Candidate components

| path | purpose | dependencies | licence obligations | native VS Code alternative | verdict |
|---|---|---|---|---|---|
| `apps/vscode/src/extension.ts` | Extension activation, sidebar registration, commands, content providers | Cline controller, registry, telemetry, host services | Apache-2.0 if copied | `activate`, `registerWebviewViewProvider`, `commands.registerCommand`, `registerTextDocumentContentProvider` | Reference only; use native APIs in our own activation |
| `apps/vscode/src/hosts/vscode/VscodeWebviewProvider.ts` | Sidebar Webview lifecycle, CSP/resource setup, message listener and disposal | Cline `WebviewProvider`, controller, message types, telemetry | Apache-2.0 if copied | `WebviewViewProvider`, typed local bridge and extension subscriptions | Reference only; implement a smaller local provider |
| `apps/vscode/src/hosts/vscode/VscodeEditPreview.ts` | Virtual-document diff preview using `vscode.diff` | Cline `EditPreview`, decoration and animation utilities | Apache-2.0 if copied | Native `vscode.diff`, `TextDocumentContentProvider`, `WorkspaceEdit` | Reference only; native diff is the chosen implementation |
| `apps/vscode/src/sdk/sdk-diff-edit-coordinator.ts` | Coordinates Cline SDK edit tools, previews, approval timing and disk executors | `@cline/core`, Cline SDK tool types, host services, filesystem executors | Apache-2.0 if copied | Our proposal store, native diff, TrueForge approval events and `WorkspaceEdit` | Reject as implementation; it contains Cline-specific orchestration and a competing agent/tool boundary |
| `apps/vscode/src/sdk/sdk-message-coordinator.ts` | Bridges Cline SDK messages and Webview state | Cline SDK, controller, protocol types | Apache-2.0 if copied | Local discriminated-union bridge and `AgentRuntime` adapter | Reject; it is tied to Cline's runtime |
| `apps/vscode/src/sdk/webview-grpc-bridge.ts` | gRPC transport between Cline SDK and Webview | Cline gRPC/protobuf stack | Apache-2.0 if copied | `webview.postMessage` with typed messages | Reject; unnecessary transport and broad runtime coupling |
| `apps/vscode/webview-ui/src/components/chat/chat-view/messageReducer.ts` | Chat message state reduction | Cline message model and UI state | Apache-2.0 if copied | Local React reducer with our message/event types | Reference only; do not reproduce Cline UI |
| `apps/vscode/src/shared/ExtensionMessage.ts` and `WebviewMessage.ts` | Cline extension/Webview message contracts | Cline-specific protocol fields | Apache-2.0 if copied | New `src/shared/messages.ts` discriminated union | Reject direct reuse; incompatible contract |

## Explicit exclusions

Do not reuse Cline's agent loop, task orchestration, provider execution, model configuration, SDK controller, gRPC runtime, broad chat UI, or tool execution framework. TrueForge must own sessions, turns, streaming, approvals and tool orchestration.

## Outcome

No component is copied or vendored at this stage. The project will prefer native VS Code APIs and small local abstractions. If a future implementation adapts a specific Cline utility, this file and `THIRD_PARTY_NOTICES.md` must be updated with the exact source path, commit, modifications and licence notice before that code is introduced.

