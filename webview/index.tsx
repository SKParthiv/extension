import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"

type RuntimeStatus = "disconnected" | "idle" | "running"

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
}

function App(): React.JSX.Element {
  const [status, setStatus] = useState<RuntimeStatus>("disconnected")

  useEffect(() => {
    const vscode = acquireVsCodeApi()
    const listener = (event: MessageEvent<{ type?: string; status?: RuntimeStatus }>) => {
      if (event.data.type === "runtimeStatus" && event.data.status) {
        setStatus(event.data.status)
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
        <span className="session-placeholder">Not connected</span>
      </header>
      <section className="status-card" aria-live="polite">
        <span className={`status-dot status-${status}`} />
        <span>Runtime: {status}</span>
      </section>
      {status === "disconnected" ? (
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

createRoot(document.getElementById("root")!).render(<App />)

