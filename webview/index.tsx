import React, { useEffect, useState, useRef } from "react"
import { createRoot } from "react-dom/client"
import type { ExtensionToWebviewMessage, ActivityEntry, ToolExecutionInfo, TelemetryData } from "../src/shared/messages"
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
  const [msgs, setMsgs] = useState<Array<{role:string;text:string}>>([])
  const [apps, setApps] = useState<Array<any>>([])
  const [stage, setStage] = useState("idle")
  const [tele, setTele] = useState<any>()
  const [asm, setAsm] = useState<any>()
  const [att, setAtt] = useState<Array<any>>([])
  const [aq, setAq] = useState("")
  const [ar, setAr] = useState<Array<any>>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { ref.current?.scrollIntoView({ behavior: "smooth" }) }, [msgs])

  useEffect(() => {
    const l = (e: MessageEvent<ExtensionToWebviewMessage>) => {
      const d = e.data
      if (d.type === "runtimeStatus") setStatus(d.status)
      else if (d.type === "runtimeConnection") setConn(d.state)
      else if (d.type === "userMessage") setMsgs((m) => [...m, { role: "user", text: d.text }])
      else if (d.type === "assistantDelta") setMsgs((m) => { const last = m[m.length-1]; if (last?.role === "assistant") return [...m.slice(0,-1), {...last, text: last.text + d.text}]; return [...m, {role:"assistant", text: d.text}] })
      else if (d.type === "assistantMessage") setMsgs((m) => { const last = m[m.length-1]; if (last?.role === "assistant") return [...m.slice(0,-1), {...last, text: d.text}]; return [...m, {role:"assistant", text: d.text}] })
      else if (d.type === "toolApprovalRequired") setApps((a) => [...a, ...d.toolCalls.map((tc:any) => ({...tc, threadId: d.threadId}))])
      else if (d.type === "contextAssembly") setAsm(d)
      else if (d.type === "contextSnapshot") setSnap(d)
      else if (d.type === "error") setErr(d.message)
      else if (d.type === "sessionChanged") { setMsgs([]); setApps([]); setAsm(undefined) }
      else if (d.type === "telemetryUpdate") { setTele(d.data); setStage(d.data.currentStage) }
      else if (d.type === "attachmentResolved") setAr(d.results)
      // Final assistant message from turn.done.output — deduplicate against already-streamed text
      else if (d.type === "assistantFinalMessage") {
        const last = msgs[msgs.length-1]
        if (last?.role === "assistant" && last.text.startsWith(d.text)) { /* already streamed, skip */ }
        else if (last?.role === "assistant") { setMsgs((m:any)=>[...m.slice(0,-1),{...last,text:last.text+d.text}]) }
        else { setMsgs((m:any)=>[...m,{role:"assistant",text:d.text}]) }
      }
      else if (d.type === "terminalEventReport") { /* handled by telemetryUpdate */ }
      else if (d.type === "requestCancelled") { setStatus("idle"); setErr("Request was cancelled: " + d.reason) }
      else if (d.type === "requestFailed") { setStatus("idle"); setErr(d.errorMessage) }
      else if (d.type === "turnPaused") { /* paused — keep running status visible via existing stage */ }
      else if (d.type === "requestCompleted") { /* optional — use telemetryUpdate instead */ }
    }
    window.addEventListener("message", l)
    vscode.postMessage({ type: "ready", viewId: "chat" })
    return () => window.removeEventListener("message", l)
  }, [])

  const send = () => {
    if (!prompt.trim() || status === "running") return
    const at = att.length > 0 ? att : undefined
    vscode.postMessage({ type: "sendPrompt", text: prompt, attachments: at })
    setAtt([]); setPrompt("")
  }

  const run = status === "running"
  const el = tele?.elapsedSeconds ?? 0

  return React.createElement("main", { className: "app" },
    React.createElement("div", { className: "status-card" },
      React.createElement("span", { className: `status-dot ${run ? "status-running" : conn === "connected" ? "status-idle" : ""}` }),
      React.createElement("span", null, run ? `Running (${el}s)` : conn === "connected" ? "Ready" : conn === "degraded" ? "Degraded" : "Disconnected"),
      stage !== "idle" && React.createElement("span", { className: "muted" }, stage)
    ),
    err && React.createElement("div", { className: "error-banner" }, err, React.createElement("button", { onClick: () => setErr(undefined) }, "x")),
    asm && React.createElement("div", { className: "assembly-summary" }, React.createElement("span", { className: "muted" }, `Context: ${asm.usedTokens}/${asm.budget}`)),
    React.createElement("section", { className: "chat-messages" }, msgs.length === 0
      ? React.createElement("div", { className: "empty-state" }, React.createElement("h1", null, "NotTheLeast"), React.createElement("p", null, "Ask me to inspect or change your project."))
      : msgs.map((m, i) => React.createElement("div", { key: i, className: `chat-message chat-${m.role}` }, React.createElement("span", { className: "message-role" }, m.role === "user" ? "You" : "Assistant"), React.createElement("p", null, m.text)))
    ),
    att.length > 0 && React.createElement("div", { className: "attachment-bar" }, att.map((a, i) => React.createElement("span", { key: i, className: "attachment-pill" }, a.label, React.createElement("button", { onClick: () => setAtt((x: any) => x.filter((_: any, j: any) => j !== i)) }, "x")))),
    React.createElement("input", { className: "attachment-input", placeholder: "#file or @symbol...", value: aq, onChange: (e: any) => { const q = e.target.value; setAq(q); if (q.startsWith("#") || q.startsWith("@")) vscode.postMessage({type:"resolveAttachment", query: q}); else setAr([]) } }),
    ar.length > 0 && React.createElement("div", { className: "attachment-results" }, ar.map((r, i) => React.createElement("button", { key: i, onClick: () => { setAtt((a:any)=>[...a,r]); setAq(""); setAr([]) } }, r.label))),
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
  useEffect(() => {
    const l = (e: MessageEvent<ExtensionToWebviewMessage>) => { if (e.data.type === "contextAssembly") setAsm(e.data) }
    window.addEventListener("message", l); vscode.postMessage({type:"ready",viewId:"context"})
    return () => window.removeEventListener("message", l)
  }, [])
  return React.createElement("main", { className: "app" },
    React.createElement("div", { className: "section-heading" }, React.createElement("span", { className: "eyebrow" }, "NOTTHELEAST"), React.createElement("h2", null, "Context Assembly")),
    !asm
      ? React.createElement("div", { className: "empty-state" }, React.createElement("p", null, "Send a prompt to see context."))
      : React.createElement(React.Fragment, null,
        React.createElement("div", { className: "assembly-summary" }, React.createElement("span", null, `Budget: ${asm.budget}`), React.createElement("span", null, `Used: ${asm.usedTokens}`)),
        asm.selected?.map((item: any, i: number) => React.createElement("div", { key: i }, React.createElement("strong", null, item.title), ` ${item.tokenEstimate} tok (${item.reason})`)),
        asm.omitted?.length > 0 && React.createElement("div", { className: "muted" }, `${asm.omitted.length} blocks omitted`),
        asm.retrieved?.map((item: any, i: number) => React.createElement("div", { key: i }, React.createElement("strong", null, item.path), `:${item.startLine}-${item.endLine}`))
      )
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
