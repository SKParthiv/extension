import * as vscode from "vscode"
import type { DiagnosticEvent } from "../shared/messages"

let channel: vscode.LogOutputChannel | undefined
const MAX_EVENTS = 500
const events: DiagnosticEvent[] = []
let eventCounter = 0

export function ensureLogger(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("NotTheLeast", { log: true })
  }
  return channel
}

export function getDiagnosticEvents(): readonly DiagnosticEvent[] {
  return events
}

export function clearDiagnosticEvents(): void {
  events.length = 0
}

function redact(value: string): string {
  // Redact tokens, API keys, authorization headers
  return value
    .replace(/(bearer|Bearer)\s+[A-Za-z0-9+/=_-]{20,}/g, "$1 [REDACTED]")
    .replace(/(token|api_key|apikey|secret|authorization)[=:]\s*["']?[A-Za-z0-9+/=_-]{8,}/gi, "$1=[REDACTED]")
    .replace(/(token["']?\s*:\s*["'])[A-Za-z0-9+/=_-]{20,}/g, "$1[REDACTED]")
}

export function logDebug(component: string, message: string, extra?: { requestId?: string; sessionId?: string; turnId?: string; toolCallId?: string; duration?: number }): void {
  const logger = ensureLogger()
  const safeMsg = redact(message)
  logger.debug(`[${component}] ${safeMsg}`)
  recordEvent("debug", component, safeMsg, extra)
}

export function logInfo(component: string, message: string, extra?: { requestId?: string; sessionId?: string; turnId?: string; toolCallId?: string; duration?: number }): void {
  const logger = ensureLogger()
  const safeMsg = redact(message)
  logger.info(`[${component}] ${safeMsg}`)
  recordEvent("info", component, safeMsg, extra)
}

export function logWarn(component: string, message: string, extra?: { requestId?: string; sessionId?: string; turnId?: string; toolCallId?: string; duration?: number }): void {
  const logger = ensureLogger()
  const safeMsg = redact(message)
  logger.warn(`[${component}] ${safeMsg}`)
  recordEvent("warn", component, safeMsg, extra)
}

export function logError(component: string, message: string, extra?: { requestId?: string; sessionId?: string; turnId?: string; toolCallId?: string; duration?: number }): void {
  const logger = ensureLogger()
  const safeMsg = redact(message)
  logger.error(`[${component}] ${safeMsg}`)
  recordEvent("error", component, safeMsg, extra)
}

function recordEvent(level: DiagnosticEvent["level"], component: string, message: string, extra?: { requestId?: string; sessionId?: string; turnId?: string; toolCallId?: string; duration?: number }): void {
  const event: DiagnosticEvent = {
    id: `evt-${++eventCounter}`,
    timestamp: new Date().toISOString(),
    component,
    eventName: message.split("\n")[0] ?? message,
    level,
    message,
    ...extra,
  }
  events.push(event)
  while (events.length > MAX_EVENTS) events.shift()
}

export function exportDiagnosticsJson(): string {
  return JSON.stringify({ events: getDiagnosticEvents(), exportedAt: new Date().toISOString() }, null, 2)
}