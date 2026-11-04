import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ExtensionToWebviewMessage } from "../src/shared/messages"
import "./styles.css"

type RuntimeStatus = "disconnected" | "idle" | "running"

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
}

function App(): React.JSX.Element {
  const [status, setStatus] = useState<RuntimeStatus>("disconnected")
  const [snapshot, setSnapshot] = useState<Extract<ExtensionToWebviewMessage, { type: "contextSnapshot" }>>()
  const [error, setError] = useState<string>()
  const vscode = acquireVsCodeApi()

  useEffect(() => {
    const listener = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      if (event.data.type === "runtimeStatus") {
        setStatus(event.data.status)
      } else if (event.data.type === "contextSnapshot") {
        setSnapshot(event.data)
        setError(undefined)
      } else if (event.data.type === "error") {
        setError(event.data.message)
      }
    }
    window.addEventListener("message", listener)
    vscode.postMessage({ type: "ready" })
    return () => window.removeEventListener("message", listener)
  }, [])

  return (
    <main className="app">
      <header className="session-header">
        <span className="eyebrow">TRUEFORGE</span>
        <strong>Current session</strong>
        <select
          aria-label="Active session"
          value={snapshot?.activeSessionId ?? ""}
          onChange={(event) => vscode.postMessage({ type: "selectSession", sessionId: event.target.value })}
        >
          {snapshot?.sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title}
            </option>
          )) ?? <option>Loading…</option>}
        </select>
      </header>
      <section className="status-card" aria-live="polite">
        <span className={`status-dot status-${status}`} />
        <span>Runtime: {status}</span>
      </section>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {snapshot ? (
        <ContextPanel snapshot={snapshot} onAction={(blockId, action) => vscode.postMessage({ type: "contextAction", blockId, action })} />
      ) : status === "disconnected" ? (
        <section className="empty-state">
          <h1>Ready when you are</h1>
          <p>Connect TrueForge to start a session and manage context.</p>
        </section>
      ) : status === "running" ? (
        <section className="loading-state" aria-busy="true">
          <span className="spinner" />
          <p>Waiting for runtime events…</p>
        </section>
      ) : (
        <section className="empty-state">
          <h1>No turns yet</h1>
          <p>Start a turn from the agent panel.</p>
        </section>
      )}
    </main>
  )
}

function ContextPanel({
  snapshot,
  onAction,
}: {
  snapshot: Extract<ExtensionToWebviewMessage, { type: "contextSnapshot" }>
  onAction: (blockId: string, action: "store" | "attach") => void
}): React.JSX.Element {
  return (
    <section className="context-panel" aria-label="Context Manager">
      <div className="section-heading">
        <div>
          <span className="eyebrow">CONTEXT MANAGER</span>
          <h2>Session context</h2>
        </div>
        <span className="token-count">{snapshot.blocks.reduce((sum, item) => sum + item.tokenEstimate, 0)} tokens</span>
      </div>
      {snapshot.blocks.length === 0 ? (
        <p className="muted">No context blocks attached.</p>
      ) : (
        <div className="context-list">
          {snapshot.blocks.map((block) => (
            <article className="context-item" key={block.id}>
              <div className="context-item-header">
                <strong>{block.title}</strong>
                <span className={`pill status-${block.status}`}>{block.status}</span>
              </div>
              <p>{block.content}</p>
              <div className="context-meta">
                <span>{block.scope}</span>
                <span>{block.priority ?? "unprioritized"}</span>
                <span>{block.tokenEstimate} tok</span>
                {block.pinned ? <span>pinned</span> : null}
                {block.locked ? <span>locked</span> : null}
              </div>
              <div className="context-actions">
                <button type="button" onClick={() => onAction(block.id, "store")} disabled={block.locked}>
                  Store
                </button>
                <button type="button" onClick={() => onAction(block.id, "attach")}>
                  Re-attach
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {snapshot.conflicts.length > 0 ? (
        <div className="conflict-banner" role="status">
          <strong>{snapshot.conflicts.length} possible conflict{snapshot.conflicts.length === 1 ? "" : "s"}</strong>
          {snapshot.conflicts.map((conflict) => (
            <span key={`${conflict.key}:${conflict.leftTitle}:${conflict.rightTitle}`}>
              {conflict.key}: {conflict.leftTitle} / {conflict.rightTitle}
            </span>
          ))}
        </div>
      ) : null}
      <div className="library-summary">
        <strong>Context Library</strong>
        <span>{snapshot.library.length} reusable block{snapshot.library.length === 1 ? "" : "s"}</span>
      </div>
    </section>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
