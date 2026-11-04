import { promises as fs } from "node:fs"
import path from "node:path"
import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js"
import { migrations } from "./migrations"

export interface QueryRow {
  [column: string]: SqlValue
}

export interface DatabaseOptions {
  filePath?: string
  wasmPath?: string
}

export class ContextDatabase {
  private constructor(
    private readonly database: SqlJsDatabase,
    private readonly filePath?: string,
  ) {}

  public static async open(options: DatabaseOptions = {}): Promise<ContextDatabase> {
    const SQL = await initSqlJs({
      locateFile: (fileName) => options.wasmPath ?? path.join(path.dirname(require.resolve("sql.js")), fileName),
    })
    const existing = options.filePath ? await readIfExists(options.filePath) : undefined
    const database = new SQL.Database(existing)
    database.run("PRAGMA foreign_keys = ON")
    database.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL)")

    const appliedRows = database.exec("SELECT version FROM schema_migrations ORDER BY version")
    const applied = new Set((appliedRows[0]?.values ?? []).map((row) => Number(row[0])))
    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue
      }
      database.run("BEGIN")
      try {
        database.exec(migration.sql)
        database.run("INSERT INTO schema_migrations(version) VALUES (?)", [migration.version])
        database.run("COMMIT")
      } catch (error) {
        database.run("ROLLBACK")
        database.close()
        throw error
      }
    }

    const contextDatabase = new ContextDatabase(database, options.filePath)
    await contextDatabase.save()
    return contextDatabase
  }

  public run(sql: string, params: SqlValue[] = []): void {
    this.database.run(sql, params)
  }

  public all(sql: string, params: SqlValue[] = []): QueryRow[] {
    const result = this.database.exec(sql, params)
    const first = result[0]
    if (!first) {
      return []
    }
    return first.values.map((values) =>
      Object.fromEntries(first.columns.map((column, index) => [column, values[index]])),
    )
  }

  public async transaction<T>(callback: () => T | Promise<T>): Promise<T> {
    this.database.run("BEGIN")
    try {
      const result = await callback()
      this.database.run("COMMIT")
      await this.save()
      return result
    } catch (error) {
      this.database.run("ROLLBACK")
      throw error
    }
  }

  public async save(): Promise<void> {
    if (!this.filePath) {
      return
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, this.database.export())
  }

  public close(): void {
    this.database.close()
  }
}

async function readIfExists(filePath: string): Promise<Uint8Array | undefined> {
  try {
    return await fs.readFile(filePath)
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined
    }
    throw error
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

