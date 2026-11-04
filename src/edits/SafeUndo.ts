export interface AppliedEditRecord {
  id: string
  filePath: string
  beforeText: string
  afterText: string
}

export interface UndoWorkspace {
  readText(filePath: string): Promise<string>
  writeText(filePath: string, text: string): Promise<void>
}

export interface UndoResult {
  recordId: string
  filePath: string
  restoredText: string
}

export class UndoConflictError extends Error {
  public constructor(
    public readonly record: AppliedEditRecord,
    public readonly currentText: string,
  ) {
    super(`Cannot undo ${record.filePath}: the file changed after the approved edit.`)
    this.name = "UndoConflictError"
  }
}

export class SafeUndoService {
  private readonly records = new Map<string, AppliedEditRecord>()

  public recordAppliedEdit(record: AppliedEditRecord): void {
    if (!record.id || !record.filePath) {
      throw new Error("An applied edit must have an id and file path.")
    }
    if (record.beforeText === record.afterText) {
      throw new Error("An applied edit must change the file contents.")
    }
    if (this.records.has(record.id)) {
      throw new Error(`An applied edit already exists: ${record.id}`)
    }
    this.records.set(record.id, { ...record })
  }

  public listPending(): AppliedEditRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }))
  }

  public async undo(recordId: string, workspace: UndoWorkspace): Promise<UndoResult> {
    const record = this.records.get(recordId)
    if (!record) {
      throw new Error(`Unknown or already consumed undo record: ${recordId}`)
    }

    const currentText = await workspace.readText(record.filePath)
    if (currentText !== record.afterText) {
      throw new UndoConflictError(record, currentText)
    }

    await workspace.writeText(record.filePath, record.beforeText)
    this.records.delete(recordId)
    return {
      recordId,
      filePath: record.filePath,
      restoredText: record.beforeText,
    }
  }
}
