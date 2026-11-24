import React, { useEffect, useState, useRef } from "react"
import { createRoot } from "react-dom/client"
import type { ExtensionToWebviewMessage, ActivityEntry, ToolExecutionInfo, TelemetryData } from "../src/shared/messages"
import {
  attachmentKey,
  addAttachment,
  removeAttachment,
  toAttachmentResult,
  isCurrentResponse,
  isBarePrefix,
  attachmentLocation,
} from "../src/attachments/attachmentPicker"
import type { Attachment, AttachmentResult } from "../src/attachments/attachmentPicker"
import "./styles.css"

declare function acquireVsCodeApi(): { postMessage(m: unknown): void }
const vscode = acquireVsCodeApi()
const rootEl = document.getElementById("root")
const currentView = rootEl?.getAttribute("data-view") ?? "chat"

type S = "disconnected" | "idle" | "running"

function ChatView() {
  const [status, setStatus] = useState<S>("disconnected")
  const [conn, setConn] = useState<string>("disconnected")
  const [snap, setSnap] = useState<any>()
  const [err, setErr] = useState<string>()
  const [prompt, setPrompt] = useState("")
  // Map of sessionId -> messages array for strict chat isolation
  const [sessionMsgs, setSessionMsgs] = useState<Record<string, Array<{ role: string; text: string }>>>({})
  const [sessionApps, setSessionApps] = useState<Record<string, Array<any>>>({})
  const [activeSid, setActiveSid] = useState<string>("")
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; ready?: boolean }>>([])
  const [newSessionTitle, setNewSessionTitle] = useState("")
  const [showNewModal, setShowNewModal] = useState(false)
  const [renamingSid, setRenamingSid] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [sessionBusy, setSessionBusy] = useState(false)
  const [stage, setStage] = useState("idle")
  const [tele, setTele] = useState<any>()
  const [asm, setAsm] = useState<any>()
  const [att, setAtt] = useState<Attachment[]>([])
  const [aq, setAq] = useState("")
  const [ar, setAr] = useState<AttachmentResult[]>([])
  const [latestReqId, setLatestReqId] = useState(0)
  const latestReqIdRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const msgs = (activeSid && sessionMsgs[activeSid]) ? sessionMsgs[activeSid] : []
  const apps = (activeSid && sessionApps[activeSid]) ? sessionApps[activeSid] : []
  const activeSession = sessions.find((s) => s.id === activeSid)

  useEffect(() => { ref.current?.scrollIntoView({ behavior: "smooth" }) }, [msgs])

  useEffect(() => {
    const l = (e: MessageEvent<ExtensionToWebviewMessage>) => {
      const d = e.data
      if (d.type === "runtimeStatus") setStatus(d.status)
      else if (d.type === "runtimeConnection") setConn(d.state)
      else if (d.type === "userMessage") {
        const sid = d.sessionId || activeSid
        if (sid) {
          setSessionMsgs((prev) => ({
            ...prev,
            [sid]: [...(prev[sid] || []), { role: "user", text: d.text }],
          }))
        }
      }
      else if (d.type === "assistantDelta") {
        const sid = d.sessionId || activeSid
        if (sid) {
          setSessionMsgs((prev) => {
            const current = prev[sid] || []
            const last = current[current.length - 1]
            if (last?.role === "assistant") {
              return {
                ...prev,
                [sid]: [...current.slice(0, -1), { ...last, text: last.text + d.text }],
              }
            }
            return {
              ...prev,
              [sid]: [...current, { role: "assistant", text: d.text }],
            }
          })
        }
      }
      else if (d.type === "assistantMessage") {
        const sid = d.sessionId || activeSid
        if (sid) {
          setSessionMsgs((prev) => {
            const current = prev[sid] || []
            const last = current[current.length - 1]
            if (last?.role === "assistant") {
              return {
                ...prev,
                [sid]: [...current.slice(0, -1), { ...last, text: d.text }],
              }
            }
            return {
              ...prev,
              [sid]: [...current, { role: "assistant", text: d.text }],
            }
          })
        }
      }
      else if (d.type === "toolApprovalRequired") {
        const sid = d.sessionId || activeSid
        if (sid) {
          setSessionApps((prev) => ({
            ...prev,
            [sid]: [...(prev[sid] || []), ...d.toolCalls.map((tc: any) => ({ ...tc, threadId: d.threadId }))],
          }))
        }
      }
      else if (d.type === "contextAssembly") setAsm(d)
      else if (d.type === "contextSnapshot") {
        setSnap(d)
        if (d.activeSessionId) setActiveSid(d.activeSessionId)
        if (d.sessions) setSessions(d.sessions)
      }
      else if (d.type === "error") { setErr(d.message); setSessionBusy(false) }
      else if (d.type === "sessionChanged") {
        setActiveSid(d.sessionId)
        if (d.sessions) setSessions(d.sessions)
        setAsm(undefined)
        setSessionBusy(false)
      }
      else if (d.type === "sessionsList") {
        setActiveSid(d.activeSessionId)
        setSessions(d.sessions)
        setSessionBusy(false)
      }
      else if (d.type === "telemetryUpdate") {
        setTele(d.data)
        setStage(d.data.currentStage)
        if (d.data.activeSessionId && !activeSid) {
          setActiveSid(d.data.activeSessionId)
        }
      }
      else if (d.type === "attachmentResolved") setAr((prev) => (isCurrentResponse(d.query, d.requestId, latestReqIdRef.current) ? d.results.map(toAttachmentResult) : prev))
      // Final assistant message from turn.done.output — deduplicate against already-streamed text
      else if (d.type === "assistantFinalMessage") {
        const sid = d.sessionId || activeSid
        if (sid) {
          setSessionMsgs((prev) => {
            const current = prev[sid] || []
            const last = current[current.length - 1]
            if (last?.role === "assistant") {
              return {
                ...prev,
                [sid]: [...current.slice(0, -1), { role: "assistant" as const, text: d.text }],
              }
            }
            return {
              ...prev,
              [sid]: [...current, { role: "assistant" as const, text: d.text }],
            }
          })
        }
      }
      else if (d.type === "terminalEventReport") { /* handled by telemetryUpdate */ }
      else if (d.type === "requestCancelled") { setStatus("idle"); setErr("Request was cancelled: " + d.reason) }
      else if (d.type === "requestFailed") { setStatus("idle"); setErr(d.errorMessage) }
      else if (d.type === "turnPaused") { /* paused — keep running status visible via existing stage */ }
      else if (d.type === "requestCompleted") { /* optional — use telemetryUpdate instead */ }
    }
    window.addEventListener("message", l)
    vscode.postMessage({ type: "ready", viewId: "chat" })
    return () => {
      window.removeEventListener("message", l)
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [activeSid])

  const send = () => {
    if (!prompt.trim() || status === "running") return
    const at = att.length > 0 ? att : undefined
    vscode.postMessage({ type: "sendPrompt", text: prompt, attachments: at })
    setAtt([]); setPrompt("")
  }

  const switchSession = (sid: string) => {
    if (sid === activeSid || !sid || sessionBusy) return
    setSessionBusy(true)
    vscode.postMessage({ type: "selectSession", sessionId: sid })
  }

  const onAttachmentQuery = (raw: string) => {
    setAq(raw)
    // Clear any pending debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    if (!raw.startsWith("#") && !raw.startsWith("@")) {
      setAr([])
      latestReqIdRef.current += 1
      setLatestReqId(latestReqIdRef.current)
      return
    }
    if (isBarePrefix(raw)) {
      setAr([])
      latestReqIdRef.current += 1
      setLatestReqId(latestReqIdRef.current)
      return
    }
    const query = raw.trim()
    if (!query) { setAr([]); return }
    const reqId = ++latestReqIdRef.current
    setLatestReqId(reqId)
    debounceTimerRef.current = setTimeout(() => {
      vscode.postMessage({ type: "resolveAttachment", query, requestId: reqId })
    }, 150)
  }

  const selectAttachment = (result: AttachmentResult) => {
    const attachment: Attachment = {
      type: result.type,
      path: result.path,
      label: result.label,
      startLine: result.startLine,
      endLine: result.endLine,
    }
    setAtt((prev) => addAttachment(prev, attachment))
    setAr([])
    setAq("")
    latestReqIdRef.current += 1
    setLatestReqId(latestReqIdRef.current)
  }

  const dropAttachment = (index: number) => {
    setAtt((prev) => removeAttachment(prev, index))
  }

  const createSession = () => {
    const trimmed = newSessionTitle.trim()
    if (!trimmed) return
    setSessionBusy(true)
    vscode.postMessage({ type: "createSession", title: trimmed })
    setNewSessionTitle("")
    setShowNewModal(false)
  }

  const renameSession = () => {
    if (!renamingSid) return
    const trimmed = renameTitle.trim()
    if (!trimmed) return
    vscode.postMessage({ type: "renameSession", sessionId: renamingSid, title: trimmed })
    setRenamingSid(null)
    setRenameTitle("")
  }

  const run = status === "running"
  const el = tele?.elapsedSeconds ?? 0

  return React.createElement("main", { className: "app" },
    React.createElement("div", { className: "status-card" },
      React.createElement("span", { className: `status-dot ${run ? "status-running" : conn === "connected" ? "status-idle" : ""}` }),
      React.createElement("span", null, run ? `Running (${el}s)` : conn === "connected" ? "Ready" : conn === "degraded" ? "Degraded" : "Disconnected"),
      stage !== "idle" && React.createElement("span", { className: "muted" }, stage)
    ),
    React.createElement("div", { className: "session-bar" },
      React.createElement("label", { className: "session-label" }, "Session:"),
      React.createElement("select", {
        value: activeSid,
        disabled: run || sessionBusy,
        title: run ? "Cannot switch sessions during an active turn" : "Switch active session",
        onChange: (e: any) => switchSession(e.target.value),
      },
        sessions.length === 0
          ? React.createElement("option", { value: "" }, "No sessions")
          : sessions.map((s) => React.createElement("option", { key: s.id, value: s.id }, `${s.title || s.id}${s.ready === false ? " (unbound)" : ""}`))
      ),
      React.createElement("button", {
        disabled: run || sessionBusy,
        title: "Create a new session",
        onClick: () => setShowNewModal(true)
      }, "+ New"),
      activeSid && React.createElement("button", {
        disabled: run || sessionBusy,
        title: "Rename current session",
        onClick: () => {
          const current = sessions.find((s) => s.id === activeSid)
          setRenamingSid(activeSid)
          setRenameTitle(current?.title ?? "")
        }
      }, "Rename"),
      sessionBusy && React.createElement("span", { className: "muted" }, "Working…"),
      activeSession && React.createElement("span", { className: `session-indicator ${activeSession.ready === false ? "session-unbound" : "session-ready"}` }, activeSession.ready === false ? "Runtime unbound" : "Active")
    ),
    // New session input modal / inline form
    showNewModal && React.createElement("div", { style: { display: "flex", gap: "4px", padding: "4px 0" } },
      React.createElement("input", {
        placeholder: "New session title...",
        value: newSessionTitle,
        autoFocus: true,
        onChange: (e: any) => setNewSessionTitle(e.target.value),
        onKeyDown: (e: any) => { if (e.key === "Enter") createSession(); else if (e.key === "Escape") setShowNewModal(false) }
      }),
      React.createElement("button", { onClick: createSession, disabled: !newSessionTitle.trim() }, "Create"),
      React.createElement("button", { onClick: () => setShowNewModal(false) }, "Cancel")
    ),
    // Rename session input inline form
    renamingSid && React.createElement("div", { style: { display: "flex", gap: "4px", padding: "4px 0" } },
      React.createElement("input", {
        placeholder: "Session title...",
        value: renameTitle,
        autoFocus: true,
        onChange: (e: any) => setRenameTitle(e.target.value),
        onKeyDown: (e: any) => { if (e.key === "Enter") renameSession(); else if (e.key === "Escape") setRenamingSid(null) }
      }),
      React.createElement("button", { onClick: renameSession, disabled: !renameTitle.trim() }, "Save"),
      React.createElement("button", { onClick: () => setRenamingSid(null) }, "Cancel")
    ),
    err && React.createElement("div", { className: "error-banner" }, err, React.createElement("button", { onClick: () => setErr(undefined) }, "x")),
    asm && React.createElement("div", { className: "assembly-summary" }, React.createElement("span", { className: "muted" }, `Context: ${asm.usedTokens}/${asm.budget}`)),
    React.createElement("section", { className: "chat-messages" },
      sessions.length === 0
        ? React.createElement("div", { className: "empty-state" }, React.createElement("h1", null, "No session"), React.createElement("p", null, "Create a named session to start chatting. Transcripts stay isolated per session."))
        : msgs.length === 0
          ? React.createElement("div", { className: "empty-state" }, React.createElement("h1", null, "NotTheLeast"), React.createElement("p", null, "Ask me to inspect or change your project."))
          : msgs.map((m, i) => React.createElement("div", { key: i, className: `chat-message chat-${m.role}` }, React.createElement("span", { className: "message-role" }, m.role === "user" ? "You" : "Assistant"), React.createElement("p", null, m.text)))
    ),
    att.length > 0 && React.createElement("div", { className: "attachment-bar" }, att.map((a, i) => React.createElement("span", { key: attachmentKey(a), className: "attachment-pill" },
      React.createElement("span", { className: "attachment-pill-label", title: attachmentLocation(a) }, a.label),
      React.createElement("span", { className: "attachment-pill-loc", title: attachmentLocation(a) }, attachmentLocation(a)),
      React.createElement("button", { onClick: () => dropAttachment(i), title: "Remove attachment" }, "x")
    ))),
    React.createElement("input", { className: "attachment-input", placeholder: "#file or @symbol to attach", value: aq, title: "Type #file to search files, @symbol to search workspace symbols", onChange: (e: any) => onAttachmentQuery(e.target.value) }),
    ar.length > 0 && React.createElement("div", { className: "attachment-results" },
      ar.map((r) => React.createElement("button", { key: r.key, className: "attachment-result", title: attachmentLocation(r), onClick: () => selectAttachment(r) },
        r.type === "symbol"
          ? React.createElement("span", null, `@{${r.label}}`, React.createElement("span", { className: "attachment-result-loc" }, attachmentLocation(r)))
          : React.createElement("span", null, `#${r.label}`, React.createElement("span", { className: "attachment-result-loc" }, r.path))
      ))
    ),
    React.createElement("textarea", { placeholder: "Ask NotTheLeast...", value: prompt, onChange: (e: any) => setPrompt(e.target.value), onKeyDown: (e: any) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } }, rows: 3 }),
    React.createElement("div", { className: "chat-actions" },
      React.createElement("span", { className: "muted" }, run ? stage : "Ctrl+Enter"),
      run ? React.createElement("button", { onClick: () => vscode.postMessage({type:"cancelTurn"}) }, "Cancel") : React.createElement("button", { onClick: send, disabled: !prompt.trim() }, "Send")
    ),
    apps.map((app: any, i: number) => React.createElement("div", { key: i, className: "approval-card" },
      React.createElement("strong", null, app.toolName ?? "Tool"),
      React.createElement("code", null, JSON.stringify(app.arguments).slice(0,200)),
      React.createElement("div", { className: "approval-actions" },
        React.createElement("button", { onClick: () => vscode.postMessage({type:"toolApproval",threadId:app.threadId,toolCallId:app.id,decision:"allow"}) }, "Allow"),
        React.createElement("button", { onClick: () => vscode.postMessage({type:"toolApproval",threadId:app.threadId,toolCallId:app.id,decision:"deny"}) }, "Deny")
      )
    ))
  )
}

function ActivityView() {
  const [acts, setActs] = useState<ActivityEntry[]>([])
  useEffect(() => {
    const l = (e: MessageEvent<ExtensionToWebviewMessage>) => { if (e.data.type === "activityUpdate") setActs((a) => [e.data.entry, ...a].slice(0,200)) }
    window.addEventListener("message", l); vscode.postMessage({type:"ready",viewId:"activity"})
    return () => window.removeEventListener("message", l)
  }, [])
  return React.createElement("main", { className: "app" },
    React.createElement("div", { className: "section-heading" }, React.createElement("span", { className: "eyebrow" }, "NOTTHELEAST"), React.createElement("h2", null, "Agent Activity")),
    acts.length === 0
      ? React.createElement("div", { className: "empty-state" }, React.createElement("p", null, "No activity yet."))
      : React.createElement("div", { className: "activity-list" }, acts.map((e) => React.createElement("div", { key: e.id, className: `activity-item activity-${e.type}` },
        React.createElement("span", { className: "activity-time" }, new Date(e.timestamp).toLocaleTimeString()),
        React.createElement("span", { className: `pill type-${e.type}` }, e.type),
        React.createElement("span", null, e.title)
      )))
  )
}

function ToolsView() {
  const [tools, setTools] = useState<ToolExecutionInfo[]>([])
  useEffect(() => {
    const l = (e: MessageEvent<ExtensionToWebviewMessage>) => { if (e.data.type === "toolExecutionUpdate") setTools((t) => [e.data.tool, ...t.filter((x) => x.id !== e.data.tool.id)].slice(0,100)) }
    window.addEventListener("message", l); vscode.postMessage({type:"ready",viewId:"tools"})
    return () => window.removeEventListener("message", l)
  }, [])
  return React.createElement("main", { className: "app" },
    React.createElement("div", { className: "section-heading" }, React.createElement("span", { className: "eyebrow" }, "NOTTHELEAST"), React.createElement("h2", null, "Tool Execution")),
    tools.length === 0
      ? React.createElement("div", { className: "empty-state" }, React.createElement("p", null, "No tools called yet."))
      : React.createElement("div", { className: "tool-list" }, tools.map((t) => React.createElement("div", { key: t.id, className: `tool-item tool-${t.state}` },
        React.createElement("strong", null, t.toolName || "Tool"),
        React.createElement("span", { className: `pill state-${t.state}` }, t.state),
        t.arguments && React.createElement("code", null, JSON.stringify(t.arguments).slice(0,200)),
        t.error && React.createElement("div", { className: "error-banner" }, t.error)
      )))
  )
}

function DiagnosticsView() {
  const [tele, setTele] = useState<TelemetryData>()
  useEffect(() => {
    const l = (e: MessageEvent<ExtensionToWebviewMessage>) => { if (e.data.type === "telemetryUpdate") setTele(e.data.data) }
    window.addEventListener("message", l); vscode.postMessage({type:"ready",viewId:"diagnostics"})
    return () => window.removeEventListener("message", l)
  }, [])
  return React.createElement("main", { className: "app" },
    React.createElement("div", { className: "section-heading" }, React.createElement("span", { className: "eyebrow" }, "NOTTHELEAST"), React.createElement("h2", null, "Diagnostics")),
    React.createElement("button", { onClick: () => vscode.postMessage({type:"exportDiagnostics"}) }, "Copy Report"),
    tele && React.createElement("div", { className: "diagnostics-card" },
      React.createElement("h3", null, "Status"),
      React.createElement("table", { className: "diag-table" }, React.createElement("tbody", null,
        [["Connection",tele.connectionState],["Stage",tele.currentStage],["Input Tokens",tele.inputTokens],["Output Tokens",tele.outputTokens],["Errors",tele.errors],["Requests",tele.requestCount]].map(([k,v]) => React.createElement("tr", { key: k as string }, React.createElement("td", null, k as string), React.createElement("td", null, String(v))))
      ))
    )
  )
}

function ContextView() {
  const [asm, setAsm] = useState<any>()
  const [snap, setSnap] = useState<any>()
  const [err, setErr] = useState<string>()
  const [busyBlockId, setBusyBlockId] = useState<string>()
  const [moveDest, setMoveDest] = useState<Record<string, string>>({})
  const [copyDest, setCopyDest] = useState<Record<string, string>>({})
  const [showNewModal, setShowNewModal] = useState(false)
  const [newTitle, setNewTitle] = useState("")
  const [renamingSid, setRenamingSid] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [sessionBusy, setSessionBusy] = useState(false)

  useEffect(() => {
    const l = (e: MessageEvent<ExtensionToWebviewMessage>) => {
      const d = e.data
      if (d.type === "contextAssembly") setAsm(d)
      else if (d.type === "contextSnapshot") {
        setSnap(d)
        setBusyBlockId(undefined)
      } else if (d.type === "error") {
        setErr(d.message)
        setBusyBlockId(undefined)
        setSessionBusy(false)
      } else if (d.type === "sessionChanged") {
        setBusyBlockId(undefined)
        setSessionBusy(false)
      } else if (d.type === "sessionsList") {
        setSessionBusy(false)
        if (snap) {
          setSnap({ ...snap, activeSessionId: d.activeSessionId, sessions: d.sessions })
        }
      }
    }
    window.addEventListener("message", l)
    vscode.postMessage({ type: "ready", viewId: "context" })
    return () => window.removeEventListener("message", l)
  }, [snap])

  const act = (action: string, blockId: string, extra?: Record<string, any>) => {
    setBusyBlockId(blockId)
    setErr(undefined)
    vscode.postMessage({ type: "contextAction", action, blockId, ...extra } as any)
  }

  const selectSession = (sessionId: string) => {
    if (!sessionId || sessionBusy) return
    setErr(undefined)
    setSessionBusy(true)
    vscode.postMessage({ type: "selectSession", sessionId })
  }

  const createSession = () => {
    const trimmed = newTitle.trim()
    if (!trimmed) return
    setSessionBusy(true)
    vscode.postMessage({ type: "createSession", title: trimmed })
    setNewTitle("")
    setShowNewModal(false)
  }

  const renameSession = () => {
    if (!renamingSid) return
    const trimmed = renameTitle.trim()
    if (!trimmed) return
    vscode.postMessage({ type: "renameSession", sessionId: renamingSid, title: trimmed })
    setRenamingSid(null)
    setRenameTitle("")
  }

  const sessions = snap?.sessions ?? []
  const otherSessions = sessions.filter((s: any) => s.id !== snap?.activeSessionId)
  const blocks = snap?.blocks ?? []
  const library = snap?.library ?? []
  const conflicts = snap?.conflicts ?? []

  const activeBlocks = blocks.filter((b: any) => b.status === "active")
  const inboxBlocks = blocks.filter((b: any) => b.status === "inbox")
  const otherBlocks = blocks.filter((b: any) => b.status !== "active" && b.status !== "inbox")

  const renderBlock = (b: any) => {
    const isBusy = busyBlockId === b.id
    const locked = b.locked
    return React.createElement(
      "div",
      { key: b.id, className: `context-item ${b.pinned ? "pinned" : ""}` },
      React.createElement(
        "div",
        { className: "context-item-header" },
        React.createElement("strong", null, b.title),
        React.createElement(
          "div",
          { style: { display: "flex", gap: "4px", alignItems: "center" } },
          React.createElement("span", { className: `pill status-${b.status}` }, b.status),
          React.createElement("span", { className: "token-count" }, `${b.tokenEstimate} tok`),
          React.createElement(
            "button",
            {
              disabled: isBusy || locked,
              title: b.pinned ? "Unpin block" : "Pin block",
              onClick: () => act(b.pinned ? "unpin" : "pin", b.id),
            },
            b.pinned ? "📌 Pinned" : "Pin",
          ),
          React.createElement(
            "button",
            {
              disabled: isBusy,
              title: locked ? "Unlock block" : "Lock block",
              onClick: () => act(locked ? "unlock" : "lock", b.id),
            },
            locked ? "🔒 Locked" : "🔓 Lock",
          ),
        ),
      ),
      b.content && React.createElement("p", null, b.content.length > 120 ? b.content.slice(0, 120) + "..." : b.content),
      React.createElement(
        "div",
        { className: "context-meta" },
        React.createElement("span", null, `Source: ${b.sourceType}`),
        b.provenance && React.createElement("span", null, `Provenance: ${b.provenance}`),
        locked && React.createElement("span", { className: "muted" }, "(Locked: editing disabled)"),
      ),
      React.createElement(
        "div",
        { className: "context-actions", style: { flexWrap: "wrap", gap: "6px" } },
        // Priority selector
        React.createElement(
          "select",
          {
            value: b.priority ?? "",
            disabled: isBusy || locked,
            title: "Priority (P0=highest, P3=lowest)",
            onChange: (e: any) => act("setPriority", b.id, { priority: e.target.value || null }),
          },
          React.createElement("option", { value: "" }, "Priority: Unset"),
          React.createElement("option", { value: "P0" }, "P0"),
          React.createElement("option", { value: "P1" }, "P1"),
          React.createElement("option", { value: "P2" }, "P2"),
          React.createElement("option", { value: "P3" }, "P3"),
        ),
        // Scope selector
        React.createElement(
          "select",
          {
            value: b.scope,
            disabled: isBusy || locked,
            title: "Scope",
            onChange: (e: any) => act("setScope", b.id, { scope: e.target.value }),
          },
          React.createElement("option", { value: "task" }, "Scope: task"),
          React.createElement("option", { value: "project" }, "Scope: project"),
          React.createElement("option", { value: "global" }, "Scope: global"),
        ),
        // Status selector
        React.createElement(
          "select",
          {
            value: b.status,
            disabled: isBusy || locked,
            title: "Status",
            onChange: (e: any) => act("setStatus", b.id, { status: e.target.value }),
          },
          React.createElement("option", { value: "active" }, "Status: active"),
          React.createElement("option", { value: "inbox" }, "Status: inbox"),
          React.createElement("option", { value: "deferred" }, "Status: deferred"),
          React.createElement("option", { value: "archived" }, "Status: archived"),
          React.createElement("option", { value: "excluded" }, "Status: excluded"),
          React.createElement("option", { value: "resolved" }, "Status: resolved"),
        ),
        // Promote button for inbox blocks
        b.status === "inbox" &&
          React.createElement(
            "button",
            {
              disabled: isBusy || locked,
              title: "Promote to active context",
              onClick: () => act("promote", b.id),
            },
            "Promote to Active",
          ),
        // Store in Library button
        React.createElement(
          "button",
          {
            disabled: isBusy || locked,
            title: "Store block in reusable Library",
            onClick: () => act("store", b.id, { visibility: "project" }),
          },
          "Store in Library",
        ),
        // Move dropdown & button
        otherSessions.length > 0 &&
          React.createElement(
            "div",
            { style: { display: "inline-flex", gap: "4px" } },
            React.createElement(
              "select",
              {
                value: moveDest[b.id] ?? "",
                disabled: isBusy || locked,
                onChange: (e: any) => setMoveDest({ ...moveDest, [b.id]: e.target.value }),
              },
              React.createElement("option", { value: "" }, "Move to session..."),
              otherSessions.map((s: any) => React.createElement("option", { key: s.id, value: s.id }, s.title || s.id)),
            ),
            React.createElement(
              "button",
              {
                disabled: isBusy || locked || !moveDest[b.id],
                onClick: () => act("move", b.id, { destinationSessionId: moveDest[b.id] }),
              },
              "Move",
            ),
          ),
        // Copy dropdown & button
        otherSessions.length > 0 &&
          React.createElement(
            "div",
            { style: { display: "inline-flex", gap: "4px" } },
            React.createElement(
              "select",
              {
                value: copyDest[b.id] ?? "",
                disabled: isBusy,
                onChange: (e: any) => setCopyDest({ ...copyDest, [b.id]: e.target.value }),
              },
              React.createElement("option", { value: "" }, "Copy to session..."),
              otherSessions.map((s: any) => React.createElement("option", { key: s.id, value: s.id }, s.title || s.id)),
            ),
            React.createElement(
              "button",
              {
                disabled: isBusy || !copyDest[b.id],
                onClick: () => act("copy", b.id, { destinationSessionId: copyDest[b.id] }),
              },
              "Copy",
            ),
          ),
        // Re-attach / restore button if inactive
        (b.status === "archived" || b.status === "deferred" || b.status === "resolved") &&
          React.createElement(
            "button",
            {
              disabled: isBusy,
              title: "Restore block to Inbox",
              onClick: () => act("restore", b.id),
            },
            "Restore to Inbox",
          ),
      ),
    )
  }

  return React.createElement(
    "main",
    { className: "app" },
    React.createElement(
      "div",
      { className: "section-heading" },
      React.createElement("span", { className: "eyebrow" }, "NOTTHELEAST"),
      React.createElement("h2", null, "Context Manager"),
    ),
    React.createElement(
      "div",
      { className: "session-bar" },
      React.createElement("label", { className: "session-label" }, "Active Session:"),
      React.createElement(
        "select",
        {
          value: snap?.activeSessionId ?? "",
          disabled: sessionBusy,
          onChange: (e: any) => selectSession(e.target.value),
        },
        sessions.length === 0
          ? React.createElement("option", { value: "" }, "No sessions")
          : sessions.map((s: any) => React.createElement("option", { key: s.id, value: s.id }, `${s.title || s.id}${s.ready === false ? " (unbound)" : ""}`)),
      ),
      React.createElement("button", {
        disabled: sessionBusy,
        title: "Create a new session",
        onClick: () => setShowNewModal(true)
      }, "+ New"),
      snap?.activeSessionId && React.createElement("button", {
        disabled: sessionBusy,
        title: "Rename current session",
        onClick: () => {
          const current = sessions.find((s: any) => s.id === snap?.activeSessionId)
          setRenamingSid(snap?.activeSessionId)
          setRenameTitle(current?.title ?? "")
        }
      }, "Rename"),
      sessionBusy && React.createElement("span", { className: "muted" }, "Working…"),
    ),
    !snap && React.createElement("div", { className: "empty-state" }, React.createElement("p", null, "Loading sessions…")),
    snap && sessions.length === 0 && React.createElement("div", { className: "empty-state" }, React.createElement("p", null, "No sessions yet. Create one to manage context.")),
    // New session inline form
    showNewModal && React.createElement("div", { style: { display: "flex", gap: "4px", padding: "4px 0" } },
      React.createElement("input", {
        placeholder: "New session title...",
        value: newTitle,
        autoFocus: true,
        onChange: (e: any) => setNewTitle(e.target.value),
        onKeyDown: (e: any) => { if (e.key === "Enter") createSession(); else if (e.key === "Escape") setShowNewModal(false) }
      }),
      React.createElement("button", { onClick: createSession, disabled: !newTitle.trim() }, "Create"),
      React.createElement("button", { onClick: () => setShowNewModal(false) }, "Cancel")
    ),
    // Rename session inline form
    renamingSid && React.createElement("div", { style: { display: "flex", gap: "4px", padding: "4px 0" } },
      React.createElement("input", {
        placeholder: "Session title...",
        value: renameTitle,
        autoFocus: true,
        onChange: (e: any) => setRenameTitle(e.target.value),
        onKeyDown: (e: any) => { if (e.key === "Enter") renameSession(); else if (e.key === "Escape") setRenamingSid(null) }
      }),
      React.createElement("button", { onClick: renameSession, disabled: !renameTitle.trim() }, "Save"),
      React.createElement("button", { onClick: () => setRenamingSid(null) }, "Cancel")
    ),
    // Error banner
    err &&
      React.createElement(
        "div",
        { className: "error-banner" },
        err,
        React.createElement("button", { onClick: () => setErr(undefined) }, "x"),
      ),
    // Conflict warnings
    conflicts.length > 0 &&
      React.createElement(
        "div",
        { style: { display: "grid", gap: "4px" } },
        conflicts.map((c: any, i: number) =>
          React.createElement(
            "div",
            { key: i, className: "conflict-banner" },
            `⚠️ Conflict on "${c.key}": "${c.leftTitle}" vs "${c.rightTitle}"`,
          ),
        ),
      ),
    // Assembly summary (budget and tokens)
    asm &&
      React.createElement(
        "div",
        { className: "assembly-summary" },
        React.createElement(
          "span",
          null,
          `Prompt Budget: ${asm.usedTokens}/${asm.budget} tokens (${asm.selected?.length ?? 0} selected, ${asm.omitted?.length ?? 0} omitted)`,
        ),
      ),
    // Section: Active Context
    React.createElement(
      "section",
      { className: "context-panel" },
      React.createElement("h3", { style: { margin: "4px 0", fontSize: "12px" } }, `Active Context (${activeBlocks.length})`),
      activeBlocks.length === 0
        ? React.createElement("div", { className: "empty-state" }, React.createElement("p", null, "No active context blocks. Promote from Inbox or attach from Library."))
        : React.createElement("div", { className: "context-list" }, activeBlocks.map(renderBlock)),
    ),
    // Section: Inbox
    React.createElement(
      "section",
      { className: "context-panel" },
      React.createElement(
        "h3",
        { style: { margin: "4px 0", fontSize: "12px" } },
        `Observation Inbox (${inboxBlocks.length})`,
        React.createElement("span", { className: "muted", style: { marginLeft: "6px", fontWeight: "normal" } }, "(Never auto-injected)"),
      ),
      inboxBlocks.length === 0
        ? React.createElement("div", { className: "empty-state" }, React.createElement("p", null, "Inbox is empty."))
        : React.createElement("div", { className: "context-list" }, inboxBlocks.map(renderBlock)),
    ),
    // Section: Inactive Context
    otherBlocks.length > 0 &&
      React.createElement(
        "section",
        { className: "context-panel" },
        React.createElement("h3", { style: { margin: "4px 0", fontSize: "12px" } }, `Other Blocks (${otherBlocks.length})`),
        React.createElement("div", { className: "context-list" }, otherBlocks.map(renderBlock)),
      ),
    // Section: Reusable Library
    React.createElement(
      "section",
      { className: "context-panel" },
      React.createElement("h3", { style: { margin: "4px 0", fontSize: "12px" } }, `Context Library (${library.length})`),
      library.length === 0
        ? React.createElement("div", { className: "empty-state" }, React.createElement("p", null, "Library is empty. Store blocks here to reuse across sessions."))
        : React.createElement(
            "div",
            { className: "context-list" },
            library.map((item: any) =>
              React.createElement(
                "div",
                { key: item.id, className: "context-item" },
                React.createElement(
                  "div",
                  { className: "context-item-header" },
                  React.createElement("strong", null, item.title),
                  React.createElement("span", { className: "pill" }, item.visibility),
                ),
                React.createElement(
                  "div",
                  { className: "context-actions" },
                  React.createElement(
                    "button",
                    {
                      disabled: !!busyBlockId,
                      title: "Attach this reusable block to active session",
                      onClick: () => act("attach", item.id, { scope: "task" }),
                    },
                    "Attach to Session",
                  ),
                ),
              ),
            ),
          ),
    ),
  )
}

function App() {
  switch (currentView) {
    case "activity": return React.createElement(ActivityView)
    case "tools": return React.createElement(ToolsView)
    case "diagnostics": return React.createElement(DiagnosticsView)
    case "context": return React.createElement(ContextView)
    default: return React.createElement(ChatView)
  }
}

createRoot(document.getElementById("root")!).render(React.createElement(App))
