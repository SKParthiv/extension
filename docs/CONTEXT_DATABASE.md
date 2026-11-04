# Context Manager database

The Context Manager uses `sql.js@1.15.2`, a pure WebAssembly SQLite implementation. This avoids native-module ABI coupling between the extension's Node runtime and the Electron runtime used by VS Code. Drizzle is not used because the small schema and migration layer do not require an ORM yet.

The database is exported to a file under the extension's `globalStorageUri` by the extension host. Foreign keys are enabled on every open. Migrations are versioned in `schema_migrations`.

The initial schema separates:

- `app_sessions`
- `context_blocks`
- `session_memberships`
- `library_entries`

Scope, priority and status are separate constrained columns on memberships. Transfers will use the database transaction helper.

