import type { Database } from "bun:sqlite"

/** Brings the durable client store to the current execution-owned source and
 * replay-deduplication model. Persistence evolution stays outside client
 * lifecycle orchestration. */
export const migrateClientDatabase = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wf_client_executions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT,
      actor TEXT,
      source_hash TEXT,
      result_json TEXT,
      error_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS wf_client_executions_idempotency_idx
      ON wf_client_executions(workflow_name, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS wf_client_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dedupe_key TEXT,
      UNIQUE(execution_id, sequence)
    );
  `)

  const columns = db.query<{ name: string }, []>("PRAGMA table_info(wf_client_history)").all()
  if (!columns.some((column) => column.name === "dedupe_key")) {
    db.exec("ALTER TABLE wf_client_history ADD COLUMN dedupe_key TEXT")
  }
  const executionColumns = db.query<{ name: string }, []>(
    "PRAGMA table_info(wf_client_executions)"
  ).all()
  if (!executionColumns.some((column) => column.name === "artifact_id")) {
    db.exec("ALTER TABLE wf_client_executions ADD COLUMN artifact_id TEXT")
  }
  if (!executionColumns.some((column) => column.name === "source_hash")) {
    db.exec("ALTER TABLE wf_client_executions ADD COLUMN source_hash TEXT")
  }
  if (executionColumns.some((column) => column.name === "workflow_version")) {
    db.exec(`
      DROP INDEX IF EXISTS wf_client_executions_idempotency_idx;
      ALTER TABLE wf_client_executions DROP COLUMN workflow_version;
      CREATE UNIQUE INDEX IF NOT EXISTS wf_client_executions_idempotency_idx
        ON wf_client_executions(workflow_name, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `)
  }

  const legacyWorkflowTable = db.query<{ readonly name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wf_client_workflows'"
  ).get()
  if (legacyWorkflowTable !== null) {
    db.exec(`
      UPDATE wf_client_executions
      SET source_hash = (
        SELECT source_hash
        FROM wf_client_workflows
        WHERE wf_client_workflows.workflow_name = wf_client_executions.workflow_name
      )
      WHERE source_hash IS NULL
        AND EXISTS (
          SELECT 1
          FROM wf_client_workflows
          WHERE wf_client_workflows.workflow_name = wf_client_executions.workflow_name
        );
    `)
  }
  db.exec("DROP TABLE IF EXISTS wf_client_workflows")
  db.exec(`
    CREATE INDEX IF NOT EXISTS wf_client_history_dedupe_idx
      ON wf_client_history(execution_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL
  `)
}
