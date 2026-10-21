// SQL migrations. Append-only — never edit a past migration; add a new one.
// Each migration runs in a single transaction.
//
// The embeddings table is the only one that needs the sqlite-vec extension
// loaded; openDatabase() loads it before runMigrations() so the v2 migration
// can create the vec0 virtual table.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const EMBEDDING_DIM = 384;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS files (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        path          TEXT NOT NULL UNIQUE,
        language      TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        loc           INTEGER NOT NULL DEFAULT 0,
        indexed_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
      CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

      CREATE TABLE IF NOT EXISTS symbols (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        name        TEXT NOT NULL,
        signature   TEXT,
        start_line  INTEGER NOT NULL,
        end_line    INTEGER NOT NULL,
        docstring   TEXT,
        qualified_name TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified_name);

      CREATE TABLE IF NOT EXISTS edges (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        src_symbol  INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
        dst_symbol  INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        weak        INTEGER NOT NULL DEFAULT 0,
        meta        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_symbol);
      CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_symbol);
      CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);

      -- Embeddings stored as raw bytes (Float32Array). Phase 4 may switch to
      -- a sqlite-vec virtual table; this is the portable fallback.
      CREATE TABLE IF NOT EXISTS embeddings (
        symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
        model       TEXT NOT NULL,
        dim         INTEGER NOT NULL,
        vector      BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS docs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        target_kind   TEXT NOT NULL,
        target_id     INTEGER NOT NULL,
        content       TEXT NOT NULL,
        source_hash   TEXT NOT NULL,
        generated_at  TEXT NOT NULL,
        UNIQUE(target_kind, target_id)
      );

      CREATE INDEX IF NOT EXISTS idx_docs_target ON docs(target_kind, target_id);

      CREATE TABLE IF NOT EXISTS runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_sha   TEXT,
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        stats_json   TEXT
      );

      CREATE TABLE IF NOT EXISTS imports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        module      TEXT NOT NULL,
        imported    TEXT,
        alias       TEXT,
        start_line  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
      CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(module);
    `,
  },
  {
    version: 2,
    name: 'embeddings_vec0',
    sql: `
      DROP TABLE IF EXISTS embeddings;

      CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_vec USING vec0(
        embedding float[${EMBEDDING_DIM}]
      );

      CREATE TABLE IF NOT EXISTS embeddings_meta (
        symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
        model     TEXT NOT NULL,
        dim       INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'symbols_exported_fts',
    sql: `
      ALTER TABLE symbols ADD COLUMN exported INTEGER NOT NULL DEFAULT 0;

      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name, qualified_name, docstring,
        content='symbols', content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS symbols_fts_ai AFTER INSERT ON symbols BEGIN
        INSERT INTO symbols_fts (rowid, name, qualified_name, docstring)
        VALUES (new.id, new.name, new.qualified_name, new.docstring);
      END;

      CREATE TRIGGER IF NOT EXISTS symbols_fts_ad AFTER DELETE ON symbols BEGIN
        INSERT INTO symbols_fts (symbols_fts, rowid, name, qualified_name, docstring)
        VALUES ('delete', old.id, old.name, old.qualified_name, old.docstring);
      END;

      CREATE TRIGGER IF NOT EXISTS symbols_fts_au AFTER UPDATE ON symbols BEGIN
        INSERT INTO symbols_fts (symbols_fts, rowid, name, qualified_name, docstring)
        VALUES ('delete', old.id, old.name, old.qualified_name, old.docstring);
        INSERT INTO symbols_fts (rowid, name, qualified_name, docstring)
        VALUES (new.id, new.name, new.qualified_name, new.docstring);
      END;

      INSERT INTO symbols_fts (symbols_fts) VALUES ('rebuild');
    `,
  },
  {
    version: 4,
    name: 'refs',
    sql: `
      -- Call and heritage references from the CST; the resolver turns them into edges.
      CREATE TABLE IF NOT EXISTS refs (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id             INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        src_qualified_name  TEXT,
        name                TEXT NOT NULL,
        receiver            TEXT NOT NULL,
        object              TEXT,
        kind                TEXT NOT NULL,
        line                INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);

      -- Force a re-parse so files indexed before v4 get their refs.
      UPDATE files SET content_hash = '';
    `,
  },
  {
    version: 5,
    name: 'imports_reexport',
    sql: `
      -- 1 = the row re-exports rather than binds (export ... from), or, with module '',
      -- exports a local name under alias (export default x, module.exports = x).
      ALTER TABLE imports ADD COLUMN reexport INTEGER NOT NULL DEFAULT 0;

      -- Force a re-parse so files indexed before v5 get their re-export rows.
      UPDATE files SET content_hash = '';
    `,
  },
];
