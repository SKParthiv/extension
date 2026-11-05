import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ExtensionToWebviewMessage } from "../src/shared/messages"
import "./styles.css"

type RuntimeStatus = "disconnected" | "idle" | "running"

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
}

const vscode = acquireVsCodeApi()

function App(): React.JSX.Element {
  const [status, setStatus] = useState<RuntimeStatus>("disconnected")
  const [snapshot, setSnapshot] = useState<Extract<ExtensionToWebviewMessage, { type: "contextSnapshot" }>>()
  const [error, setError] = useState<string>()
  const [connection, setConnection] = useState<"disconnected" | "connected" | "degraded">("disconnected")
  const [prompt, setPrompt] = useState("")
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([])
  const [approvals, setApprovals] = useState<Array<{ threadId: string; id: string; sourceEventId: string }>>([])
  const [assembly, setAssembly] = useState<Extract<ExtensionToWebviewMessage, { type: "contextAssembly" }>>()

  useEffect(() => {
    const listener = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      if (event.data.type === "runtimeStatus") {
        setStatus(event.data.status)
      } else if (event.data.type === "runtimeConnection") {
        setConnection(event.data.state)
      } else if (event.data.type === "userMessage") {
        setMessages((current) => [...current, { role: "user", text: event.data.text }])
      } else if (event.data.type === "assistantDelta") {
        setMessages((current) => {
          const last = current[current.length - 1]
          if (!last || last.role !== "assistant") {
            return [...current, { role: "assistant", text: event.data.text }]
          }
          return [...current.slice(0, -1), { ...last, text: last.text + event.data.text }]
        })
      } else if (event.data.type === "assistantMessage") {
        setMessages((current) => {
          const last = current[current.length - 1]
          if (!last || last.role !== "assistant") {
            return [...current, { role: "assistant", text: event.data.text }]
          }
          return [...current.slice(0, -1), { ...last, text: event.data.text }]
        })
      } else if (event.data.type === "toolApprovalRequired") {
        setApprovals((current) => [
          ...current,
          ...event.data.toolCalls.map((toolCall) => ({
            threadId: event.data.threadId,
            id: toolCall.id,
            sourceEventId: toolCall.sourceEventId,
          })),
        ])
      } else if (event.data.type === "contextAssembly") {
        setAssembly(event.data)
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
        <span>Runtime: {status} ({connection})</span>
      </section>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {assembly ? <AssemblySummary assembly={assembly} /> : null}
      <ChatPanel
        status={status}
        prompt={prompt}
        messages={messages}
        onPromptChange={setPrompt}
        onSend={() => {
          vscode.postMessage({ type: "sendPrompt", text: prompt })
          setPrompt("")
        }}
        onCancel={() => vscode.postMessage({ type: "cancelTurn" })}
        onModeChange={(mode) => vscode.postMessage({ type: "setMode", mode })}
        approvals={approvals}
        onApproval={(threadId, toolCallId, decision) => {
          vscode.postMessage({ type: "toolApproval", threadId, toolCallId, decision })
          setApprovals((current) => current.filter((approval) => approval.id !== toolCallId))
        }}
      />
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

function AssemblySummary({
  assembly,
}: {
  assembly: Extract<ExtensionToWebviewMessage, { type: "contextAssembly" }>
}): React.JSX.Element {
  return (
    <section className="assembly-summary" aria-label="Context assembly">
      <div className="section-heading">
        <strong>Context assembled</strong>
        <span className="muted">{assembly.usedTokens}/{assembly.budget} tokens</span>
      </div>
      {assembly.selected.length > 0 ? (
        <div className="assembly-list">
          {assembly.selected.map((item) => (
            <span className="assembly-item" key={`selected:${item.title}`}>
              {item.title} · {item.reason} · {item.tokenEstimate} tok
            </span>
          ))}
        </div>
      ) : <span className="muted">No session blocks selected.</span>}
      {assembly.omitted.length > 0 ? (
        <span className="muted">
          Omitted for budget: {assembly.omitted.map((item) => item.title).join(", ")}
        </span>
      ) : null}
      {assembly.retrieved.length > 0 ? (
        <div className="assembly-list">
          {assembly.retrieved.map((item) => (
            <span className="assembly-item" key={`retrieved:${item.path}:${item.startLine}`}>
              {item.path}:{item.startLine}-{item.endLine} · {item.reason}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function ChatPanel({
  status,
  prompt,
  messages,
  onPromptChange,
  onSend,
  onCancel,
  onModeChange,
  approvals,
  onApproval,
}: {
  status: RuntimeStatus
  prompt: string
  messages: Array<{ role: "user" | "assistant"; text: string }>
  onPromptChange: (value: string) => void
  onSend: () => void
  onCancel: () => void
  onModeChange: (mode: "thinking" | "tool") => void
  approvals: Array<{ threadId: string; id: string; sourceEventId: string }>
  onApproval: (threadId: string, toolCallId: string, decision: "allow" | "deny") => void
}): React.JSX.Element {
  return (
    <section className="chat-panel" aria-label="TrueForge agent chat">
      <div className="section-heading">
        <div>
          <span className="eyebrow">AGENT CHAT</span>
          <h2>Prompt TrueForge</h2>
        </div>
        <select aria-label="Runtime mode" defaultValue="thinking" onChange={(event) => onModeChange(event.target.value as "thinking" | "tool")}>
          <option value="thinking">Thinking</option>
          <option value="tool">Tool</option>
        </select>
      </div>
      <div className="chat-messages" aria-live="polite">
        {messages.length === 0 ? <p className="muted">No messages yet. Configure an agent, then send a prompt.</p> : null}
        {messages.map((message, index) => (
          <div className={`chat-message chat-${message.role}`} key={`${message.role}-${index}`}>
            <strong>{message.role === "user" ? "You" : "TrueForge"}</strong>
            <p>{message.text}</p>
          </div>
        ))}
      </div>
      {approvals.length > 0 ? (
        <div className="approval-list" aria-label="Pending tool approvals">
          {approvals.map((approval) => (
            <div className="approval-card" key={`${approval.threadId}:${approval.id}`}>
              <strong>TrueForge requests tool approval</strong>
              <code>{approval.id}</code>
              <span className="muted">Source event: {approval.sourceEventId}</span>
              <div className="approval-actions">
                <button type="button" onClick={() => onApproval(approval.threadId, approval.id, "allow")}>Allow</button>
                <button type="button" onClick={() => onApproval(approval.threadId, approval.id, "deny")}>Deny</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <textarea
        aria-label="Prompt"
        placeholder="Ask TrueForge to inspect or change your project…"
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            onSend()
          }
        }}
        rows={4}
      />
      <div className="chat-actions">
        <span className="muted">Ctrl/Cmd+Enter to send</span>
        {status === "running" ? (
          <button type="button" onClick={onCancel}>Cancel</button>
        ) : (
          <button type="button" onClick={onSend} disabled={!prompt.trim()}>Send</button>
        )}
      </div>
    </section>
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
