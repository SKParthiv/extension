/**
 * @file
 * Pure, framework-free helpers backing the webview attachment picker.
 * Kept outside the React tree so the selection, duplication, removal,
 * symbol line-range, and stale-response rules are unit-testable without
 * a DOM. The webview imports these and wires them to React state.
 *
 * == Query modes ==
 * - `#query`  → workspace file search (findFiles, controller).
 * - `@query`  → workspace symbol search (executeWorkspaceSymbolProvider, controller).
 *
 * == Attachments ==
 * A {@link Attachment} is a resolved file or symbol. Each attachment is
 * identified by a stable {@link attachmentKey} so duplicates can be
 * prevented. Selection appends a chip; removal drops it. Symbol
 * attachments carry a 1-based [startLine, endLine] range.
 */

/** A resolved file or symbol attachment produced by the attachment search. */
export interface Attachment {
  type: "file" | "symbol"
  path: string
  label: string
  startLine?: number
  endLine?: number
}

/** A result row returned to the webview, including its originating query. */
export interface AttachmentResult extends Attachment {
  key: string
}

/**
 * Stable identity for an attachment. A file is unique by path; a symbol is
 * unique by path + line range so the same symbol name in different ranges
 * (overloads) can coexist without being treated as a duplicate.
 */
export function attachmentKey(attachment: Attachment): string {
  if (attachment.type === "symbol" && attachment.startLine !== undefined) {
    return `symbol:${attachment.path}:${attachment.startLine}-${attachment.endLine ?? attachment.startLine}`
  }
  return `${attachment.type}:${attachment.path}`
}

/** The query mode a search string implies, or null when it has no prefix. */
export type QueryMode = "file" | "symbol"

export function queryMode(query: string): QueryMode | null {
  if (query.startsWith("#")) return "file"
  if (query.startsWith("@")) return "symbol"
  return null
}

/**
 * True when a search string is non-empty and carries a `#` or `@` prefix,
 * i.e. it should trigger a resolution request rather than be ignored.
 */
export function isSearchableQuery(query: string): boolean {
  return queryMode(query) !== null && query.slice(1).trim().length > 0
}

/** True when the query is a bare `#` or `@` with nothing after the prefix. */
export function isBarePrefix(query: string): boolean {
  return query === "#" || query === "@"
}

/**
 * Attach a result to the current attachment list, preventing duplicates by
 * {@link attachmentKey}. Returns the new list (does not mutate the input).
 */
export function addAttachment(current: Attachment[], next: Attachment): Attachment[] {
  const key = attachmentKey(next)
  if (current.some((a) => attachmentKey(a) === key)) return current
  return [...current, next]
}

/** Remove the attachment at `index`. Returns the new list without mutation. */
export function removeAttachment(current: Attachment[], index: number): Attachment[] {
  if (index < 0 || index >= current.length) return current
  return current.filter((_, i) => i !== index)
}

/** Map a raw search-result row to an {@link AttachmentResult} with its stable key. */
export function toAttachmentResult(result: Attachment): AttachmentResult {
  return { ...result, key: attachmentKey(result) }
}

/**
 * Decides whether an `attachmentResolved` response is still relevant.
 * Compares requestId to the latest known requestId, not the query string.
 * This correctly handles out-of-order responses even when queries differ.
 */
export function isCurrentResponse(responseQuery: string, responseRequestId: number, latestRequestId: number): boolean {
  return responseRequestId === latestRequestId
}

/**
 * Formats the human-readable location of an attachment for the chip.
 * Files show their relative path; symbols show `path:startLine-endLine`.
 */
export function attachmentLocation(attachment: Attachment): string {
  if (attachment.type === "symbol" && attachment.startLine !== undefined) {
    return `${attachment.path}:${attachment.startLine}-${attachment.endLine ?? attachment.startLine}`
  }
  return attachment.path
}
