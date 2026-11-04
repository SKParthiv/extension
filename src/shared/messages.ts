export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "openPanel" }
  | { type: "inlineEditRequest"; instruction: string }

export type ExtensionToWebviewMessage =
  | { type: "runtimeStatus"; status: "disconnected" | "idle" | "running" }
  | { type: "error"; message: string }

