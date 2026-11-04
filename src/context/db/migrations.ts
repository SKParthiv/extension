export interface Migration {
  version: number
  sql: string
}

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE app_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        trueforge_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE context_blocks (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_type TEXT NOT NULL,
        provenance TEXT NOT NULL,
        parent_block_id TEXT REFERENCES context_blocks(id) ON DELETE SET NULL,
        token_estimate INTEGER NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
        original_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE session_memberships (
        session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
        block_id TEXT NOT NULL REFERENCES context_blocks(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('task', 'project', 'global')),
        priority TEXT CHECK (priority IS NULL OR priority IN ('P0', 'P1', 'P2', 'P3')),
        status TEXT NOT NULL DEFAULT 'inbox'
          CHECK (status IN ('inbox', 'active', 'deferred', 'archived', 'excluded', 'resolved')),
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
        PRIMARY KEY (session_id, block_id)
      );

      CREATE TABLE library_entries (
        block_id TEXT PRIMARY KEY NOT NULL REFERENCES context_blocks(id) ON DELETE CASCADE,
        visibility TEXT NOT NULL CHECK (visibility IN ('global', 'project'))
      );
    `,
  },
]

