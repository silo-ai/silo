import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { count, eq, gt, sql, type SQL } from 'drizzle-orm'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { acquireFileLock } from './lock.js'
import { canonicalize, semantic } from './registry.js'
import {
  compileSchema,
  compileTable,
  generatedValue,
  parseRelation,
  parseTable,
  policy,
  quote,
  relationsFromTable,
  validateCompiledSchema,
} from './schema.js'
import { dataRoot, workspaceMigrationSource, type Workspace } from './workspace.js'
import {
  exits,
  SiloError,
  type DatabaseMetadata,
  type LogicalSchema,
  type MutationJournalEntry,
  type MutationJournalRead,
  type PendingTransaction,
  type RelationDefinition,
  type SyncState,
  type TableDefinition,
  type TemplateSchema,
} from './model.js'
import {
  parseReportDefinition,
  renderReport,
  type ReportDefinition,
  type ReportSummary,
  type StoredReport,
  validateReportSlug,
} from './report.js'
import {
  bindSavedQuery,
  executeReadOnlyQuery,
  parseSavedQueryDefinition,
  validateQueryName,
  validateReadOnlyQuery,
  type QueryResult,
  type SavedQuerySummary,
  type StoredQuery,
} from './query.js'
import {
  siloJournal,
  siloMeta,
  siloOutbox,
  siloReportQueries,
  siloReports,
  siloSavedQueries,
  siloSavedQueryParameters,
  siloSchema as siloSchemaTable,
  siloSync,
} from './database-schema.js'

const FORMAT_VERSION = 4
const TOOL_VERSION = '0.1.0'
// These bounds keep the journal useful for live observers without turning it into audit history.
/** Maximum number of newest local mutation entries retained per database. */
export const MUTATION_JOURNAL_RETENTION = 1000
/** Maximum number of local mutation entries returned by one journal read. */
export const MUTATION_JOURNAL_READ_LIMIT = 100
type Binding = null | number | bigint | string | Uint8Array

function binding(value: unknown): Binding {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  )
    return value
  throw new SiloError(
    exits.input,
    'unsupported_sqlite_value',
    'The semantic value cannot be bound to SQLite.',
  )
}

function identifier(name: string): SQL {
  return sql.raw(quote(name))
}

function identifiers(names: string[]): SQL {
  return sql.join(names.map(identifier), sql`, `)
}

function bindings(values: unknown[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )
}

function equals(columns: string[], values: unknown[]): SQL {
  return sql.join(
    columns.map((column, index) => sql`${identifier(column)} = ${values[index]}`),
    sql` AND `,
  )
}

function now(): string {
  return new Date().toISOString()
}

function laterThan(value: unknown): string {
  const current = Date.now()
  const previous = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return new Date(
    Number.isFinite(previous) ? Math.max(current, previous + 1) : current,
  ).toISOString()
}

function withRelations(schema: LogicalSchema, relations: RelationDefinition[]): LogicalSchema {
  if (relations.length) return { ...schema, relations }
  const result = { ...schema }
  delete result.relations
  return result
}

function templateRelations(template: TemplateSchema): RelationDefinition[] {
  if (template.relations === undefined) return []
  if (!Array.isArray(template.relations))
    throw new SiloError(exits.input, 'invalid_shape', 'relations must be an array.', '$.relations')
  return template.relations
}

function sqliteError(error: unknown): never {
  if (error instanceof SiloError) throw error
  const causes: unknown[] = []
  let current: unknown = error
  while (current && typeof current === 'object' && !causes.includes(current)) {
    causes.push(current)
    current = (current as { cause?: unknown }).cause
  }
  const message = causes
    .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
    .join(' ')
  const sqlite = causes.find(
    (cause): cause is { errcode?: unknown; errstr?: unknown } =>
      typeof cause === 'object' && cause !== null && 'errcode' in cause,
  )
  const primaryCode = typeof sqlite?.errcode === 'number' ? sqlite.errcode & 0xff : undefined
  const code =
    primaryCode === 19 ||
    /constraint|unique|foreign key|not null|check/i.test(
      `${typeof sqlite?.errstr === 'string' ? sqlite.errstr : ''} ${message}`,
    )
      ? exits.constraint
      : exits.io
  throw new SiloError(
    code,
    code === exits.constraint ? 'sqlite_constraint' : 'sqlite_error',
    message,
  )
}

function configure(database: DatabaseSync, writable: boolean): void {
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;')
  if (writable) {
    // WAL is persistent, so every writer verifies it instead of trusting a prior invocation.
    const result = database.prepare('PRAGMA journal_mode=WAL').get() as Record<string, unknown>
    if (!Object.values(result).some((value) => String(value).toLowerCase() === 'wal'))
      throw new SiloError(
        exits.io,
        'wal_unavailable',
        'SQLite could not establish WAL journal mode.',
      )
    database.exec('PRAGMA synchronous=NORMAL;')
  }
  const version = String(
    Object.values(
      database.prepare('SELECT sqlite_version() AS version').get() as Record<string, unknown>,
    )[0],
  )
  const [major, minor] = version.split('.').map(Number)
  if (major! < 3 || (major === 3 && minor! < 37))
    throw new SiloError(
      exits.integrity,
      'sqlite_too_old',
      `SQLite ${version} is older than the required 3.37.0.`,
    )
}

function checkpointSnapshot(database: DatabaseSync): void {
  // Snapshots copy only the main file, so every WAL frame must be checkpointed first. PASSIVE
  // avoids waiting behind readers; an incomplete checkpoint is unsafe and must fail closed.
  const result = database.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as Record<string, unknown>
  const busy = result.busy
  const log = result.log
  const checkpointed = result.checkpointed
  if (busy !== 0 || log !== checkpointed)
    throw new SiloError(
      exits.io,
      'sync_snapshot_busy',
      `SQLite could not checkpoint all WAL frames for a consistent snapshot (${String(checkpointed)} of ${String(log)} frames checkpointed).`,
    )
}

function initialize(
  database: DatabaseSync,
  db: NodeSQLiteDatabase,
  workspace: Workspace,
  schema: LogicalSchema,
): void {
  const timestamp = now()
  database.exec(`
    CREATE TABLE _silo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE _silo_schema (id INTEGER PRIMARY KEY CHECK (id = 1), schema_json TEXT NOT NULL) STRICT;
    CREATE TABLE _silo_reports (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      template_markdown TEXT NOT NULL,
      rendered_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      refreshed_at TEXT NOT NULL,
      last_refresh_attempt_at TEXT NOT NULL,
      last_refresh_error TEXT
    ) STRICT;
    CREATE TABLE _silo_report_queries (
      report_slug TEXT NOT NULL REFERENCES _silo_reports(slug) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sql TEXT,
      saved_query_name TEXT REFERENCES _silo_saved_queries(name),
      parameters_json TEXT,
      empty_markdown TEXT,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (report_slug, name),
      UNIQUE (report_slug, position),
      CHECK (
        (sql IS NOT NULL AND saved_query_name IS NULL AND parameters_json IS NULL) OR
        (sql IS NULL AND saved_query_name IS NOT NULL)
      )
    ) STRICT;
    CREATE TABLE _silo_saved_queries (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      sql TEXT NOT NULL,
      parameter_style TEXT NOT NULL CHECK (parameter_style IN ('named', 'positional')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE _silo_saved_query_parameters (
      query_name TEXT NOT NULL REFERENCES _silo_saved_queries(name) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      type_options_json TEXT,
      description TEXT NOT NULL,
      has_default INTEGER NOT NULL CHECK (has_default IN (0, 1)),
      default_json TEXT,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (query_name, name),
      UNIQUE (query_name, position),
      CHECK ((has_default = 0 AND default_json IS NULL) OR has_default = 1)
    ) STRICT;
    CREATE TABLE _silo_journal (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL UNIQUE,
      committed_at TEXT NOT NULL,
      operation_json TEXT NOT NULL CHECK (json_valid(operation_json) AND json_type(operation_json) = 'object'),
      resource_tags_json TEXT NOT NULL CHECK (json_valid(resource_tags_json) AND json_type(resource_tags_json) = 'array')
    ) STRICT;
  `)
  // This canonical document is the semantic contract; physical objects are checked compiled artifacts.
  const values: Record<string, string> = {
    format_version: String(FORMAT_VERSION),
    registry_version: String(schema.registry_version),
    tool_version: TOOL_VERSION,
    identity: workspace.identity,
    original_origin: workspace.origin,
    created_at: timestamp,
    updated_at: timestamp,
  }
  if (schema.template_imports?.length)
    values.template_names = JSON.stringify(schema.template_imports.map((item) => item.name))
  db.insert(siloMeta)
    .values(Object.entries(values).map(([key, value]) => ({ key, value })))
    .run()
  db.insert(siloSchemaTable)
    .values({ id: 1, schemaJson: JSON.stringify(schema) })
    .run()
}

function hasJournalTable(database: DatabaseSync): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_silo_journal'")
      .get(),
  )
}

function createJournalTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE _silo_journal (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL UNIQUE,
      committed_at TEXT NOT NULL,
      operation_json TEXT NOT NULL CHECK (json_valid(operation_json) AND json_type(operation_json) = 'object'),
      resource_tags_json TEXT NOT NULL CHECK (json_valid(resource_tags_json) AND json_type(resource_tags_json) = 'array')
    ) STRICT;
  `)
}

function ensureJournalTable(database: DatabaseSync, writable: boolean): void {
  if (!hasJournalTable(database) && writable) createJournalTable(database)
}

function dataVersion(database: DatabaseSync): number {
  const value = Object.values(
    database.prepare('PRAGMA data_version').get() as Record<string, unknown>,
  )[0]
  const version = Number(value)
  if (!Number.isSafeInteger(version))
    throw new SiloError(
      exits.integrity,
      'data_version_invalid',
      'SQLite returned an invalid data version.',
    )
  return version
}

function journalBounds(
  database: DatabaseSync,
  db: NodeSQLiteDatabase,
): {
  oldest_sequence: number | null
  latest_sequence: number
} {
  if (!hasJournalTable(database)) return { oldest_sequence: null, latest_sequence: 0 }
  const row = db
    .select({
      oldest_sequence: sql<number | null>`min(${siloJournal.sequence})`,
      latest_sequence: sql<number | null>`max(${siloJournal.sequence})`,
    })
    .from(siloJournal)
    .get()
  if (!row) return { oldest_sequence: null, latest_sequence: 0 }
  return {
    oldest_sequence: row.oldest_sequence === null ? null : Number(row.oldest_sequence),
    latest_sequence: row.latest_sequence === null ? 0 : Number(row.latest_sequence),
  }
}

function resourceTags(operation: Record<string, unknown>): string[] {
  const command = typeof operation.command === 'string' ? operation.command : ''
  if (command.startsWith('row.')) {
    return typeof operation.table === 'string' ? [`table:${operation.table}`] : ['*']
  }
  if (command.startsWith('query.')) {
    return typeof operation.query === 'string' ? [`query:${operation.query}`] : ['*']
  }
  if (command.startsWith('report.')) {
    return typeof operation.report === 'string' ? [`report:${operation.report}`] : ['*']
  }
  return ['*']
}

function operationJson(operation: Record<string, unknown>): string {
  const value = JSON.stringify(operation, (_key, nested) =>
    typeof nested === 'bigint' ? nested.toString() : nested,
  )
  if (value === undefined)
    throw new SiloError(
      exits.integrity,
      'operation_metadata_invalid',
      'The operation metadata is not JSON-serializable.',
    )
  return value
}

function metadata(db: NodeSQLiteDatabase): DatabaseMetadata {
  try {
    const rows = db
      .select({ key: siloMeta.key, value: siloMeta.value })
      .from(siloMeta)
      .orderBy(siloMeta.key)
      .all()
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]))
    if (!values.identity || Number(values.format_version) !== FORMAT_VERSION)
      throw new SiloError(
        exits.integrity,
        'incompatible_database',
        'Database metadata is missing or incompatible.',
      )
    return {
      identity: values.identity,
      original_origin: values.original_origin!,
      created_at: values.created_at!,
      updated_at: values.updated_at!,
      format_version: Number(values.format_version),
      tool_version: values.tool_version!,
    }
  } catch (error) {
    if (error instanceof SiloError) throw error
    throw new SiloError(
      exits.integrity,
      'unrecognized_database',
      'The file is not a recognized Silo database.',
    )
  }
}

function readSchema(db: NodeSQLiteDatabase): LogicalSchema {
  try {
    const row = db
      .select({ schema_json: siloSchemaTable.schemaJson })
      .from(siloSchemaTable)
      .where(eq(siloSchemaTable.id, 1))
      .get()
    if (!row) throw new Error('schema row missing')
    return JSON.parse(row.schema_json) as LogicalSchema
  } catch (error) {
    throw new SiloError(
      exits.integrity,
      'schema_metadata_invalid',
      error instanceof Error ? error.message : String(error),
    )
  }
}

export function normalizeDdl(sql: string): string {
  const tokens: string[] = []
  for (let i = 0; i < sql.length; ) {
    const char = sql[i]!
    if (/\s/.test(char)) {
      i++
      continue
    }
    if (char === '-' && sql[i + 1] === '-') {
      i = sql.indexOf('\n', i + 2)
      if (i < 0) break
      continue
    }
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 2
      continue
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char
      let token = char
      i++
      while (i < sql.length) {
        token += sql[i]
        if (sql[i] === close) {
          if (close !== ']' && sql[i + 1] === close) {
            token += close
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      tokens.push(token)
      continue
    }
    if (/[A-Za-z0-9_$]/.test(char)) {
      let end = i + 1
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) end++
      tokens.push(sql.slice(i, end).toLowerCase())
      i = end
      continue
    }
    const operator = ['->>', '||', '>=', '<=', '<>', '!=', '==', '->'].find((candidate) =>
      sql.startsWith(candidate, i),
    )
    tokens.push(operator ?? char)
    i += operator?.length ?? 1
  }
  return tokens.join(' ')
}

function physicalFingerprint(database: DatabaseSync, schema: LogicalSchema): string[] {
  const tableNames = new Set(schema.tables.map((table) => table.name.toLowerCase()))
  return (
    database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'index', 'trigger') AND sql IS NOT NULL ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>
  )
    .filter((row) => tableNames.has(row.tbl_name.toLowerCase()))
    .map(
      (row) =>
        `${row.type}:${row.name.toLowerCase()}:${row.tbl_name.toLowerCase()}:${normalizeDdl(row.sql)}`,
    )
}

function verifyPhysical(database: DatabaseSync, schema: LogicalSchema): void {
  validateCompiledSchema(schema)
  const expectedDatabase = new DatabaseSync(':memory:')
  try {
    expectedDatabase.exec('PRAGMA foreign_keys=ON;')
    expectedDatabase.exec(compileSchema(schema).join('\n'))
    const expected = physicalFingerprint(expectedDatabase, schema)
    const actual = physicalFingerprint(database, schema)
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new SiloError(
        exits.integrity,
        'physical_schema_mismatch',
        'Physical tables, indexes, or triggers do not match authoritative schema metadata.',
      )
  } finally {
    expectedDatabase.close()
  }
}

function validateSynchronizedSchema(schema: LogicalSchema): void {
  for (const table of schema.tables) {
    if (!table.primary_key?.length)
      throw new SiloError(
        exits.schema,
        'sync_primary_key_required',
        `Synchronized table ${table.name} must declare a primary key.`,
      )
    const nullable = table.primary_key.find(
      (name) => table.columns.find((column) => column.name === name)?.nullable !== false,
    )
    if (nullable)
      throw new SiloError(
        exits.schema,
        'sync_primary_key_nullable',
        `Synchronized primary key ${table.name}.${nullable} must be non-nullable.`,
      )
  }
}

/** Move an unsynchronized database between repository identities without overwriting a target. */
export function moveWorkspaceDatabase(source: Workspace, target: Workspace): void {
  if (source.databasePath === target.databasePath) return
  mkdirSync(dirname(source.databasePath), { recursive: true })
  mkdirSync(dirname(target.databasePath), { recursive: true })
  const lockPaths = [source.databasePath, target.databasePath]
    .sort()
    .map((path) => `${path}.write-lock`)
  const releases: Array<() => void> = []
  let sourceDatabase: DatabaseSync | undefined
  let candidateDatabase: DatabaseSync | undefined
  const candidate = `${target.databasePath}.move.${randomUUID()}.sqlite`
  try {
    for (const path of lockPaths)
      releases.push(
        acquireFileLock(
          path,
          'Another writer or synchronization operation is using this database.',
        ),
      )
    if (
      existsSync(`${source.databasePath}.sync-lock`) ||
      existsSync(`${target.databasePath}.sync-lock`)
    )
      throw new SiloError(
        exits.io,
        'sync_in_progress',
        'A synchronization operation is already using the source or target database.',
      )
    if (!existsSync(source.databasePath))
      throw new SiloError(
        exits.absent,
        'database_absent',
        'The selected source database does not exist.',
      )
    if (existsSync(target.databasePath))
      throw new SiloError(
        exits.schema,
        'database_exists',
        'A database already exists for the target workspace identity.',
      )

    sourceDatabase = new DatabaseSync(source.databasePath)
    configure(sourceDatabase, true)
    const sourceDb = drizzle({ client: sourceDatabase })
    const sourceMeta = metadata(sourceDb)
    if (sourceMeta.identity !== source.identity)
      throw new SiloError(
        exits.integrity,
        'identity_mismatch',
        'The source database does not match the selected Git workspace identity.',
      )
    const sourceSchema = readSchema(sourceDb)
    verifyPhysical(sourceDatabase, sourceSchema)
    if (
      sourceDatabase
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_silo_sync'")
        .get()
    )
      throw new SiloError(
        exits.workspace,
        'synchronized_database_move_unsupported',
        'A synchronized database cannot move between Git workspace identities.',
      )
    checkpointSnapshot(sourceDatabase)
    copyFileSync(source.databasePath, candidate)

    candidateDatabase = new DatabaseSync(candidate)
    configure(candidateDatabase, true)
    const candidateDb = drizzle({ client: candidateDatabase })
    candidateDb.transaction(
      () => {
        candidateDb
          .update(siloMeta)
          .set({ value: target.identity })
          .where(eq(siloMeta.key, 'identity'))
          .run()
        candidateDb
          .update(siloMeta)
          .set({ value: target.origin })
          .where(eq(siloMeta.key, 'original_origin'))
          .run()
        candidateDb
          .update(siloMeta)
          .set({ value: now() })
          .where(eq(siloMeta.key, 'updated_at'))
          .run()
      },
      { behavior: 'immediate' },
    )
    checkpointSnapshot(candidateDatabase)
    verifyPhysical(candidateDatabase, readSchema(candidateDb))
    const movedMeta = metadata(candidateDb)
    if (movedMeta.identity !== target.identity)
      throw new SiloError(
        exits.integrity,
        'identity_mismatch',
        'The moved database identity was not updated.',
      )
    candidateDatabase.close()
    candidateDatabase = undefined
    sourceDatabase.close()
    sourceDatabase = undefined

    // Installing through a hard link is atomic and refuses to overwrite a concurrently-created target.
    linkSync(candidate, target.databasePath)
    rmSync(candidate, { force: true })
    for (const suffix of ['', '-wal', '-shm', '-journal', '-txid'])
      rmSync(`${source.databasePath}${suffix}`, { force: true })
  } catch (error) {
    if (error instanceof SiloError) throw error
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new SiloError(
        exits.schema,
        'database_exists',
        'A database already exists for the target workspace identity.',
      )
    sqliteError(error)
  } finally {
    candidateDatabase?.close()
    sourceDatabase?.close()
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      rmSync(`${candidate}${suffix}`, { force: true })
    for (const release of releases.reverse()) release()
  }
}

export function ensureWorkspaceDatabase(workspace: Workspace): void {
  const source = workspaceMigrationSource(workspace)
  if (!source || existsSync(workspace.databasePath) || !existsSync(source.databasePath)) return
  moveWorkspaceDatabase({ ...workspace, ...source }, workspace)
}

export class SiloDatabase {
  readonly workspace: Workspace
  private readonly database: DatabaseSync
  private readonly db: NodeSQLiteDatabase
  private readonly releaseWriterLock: (() => void) | undefined
  private closed = false
  private observedDataVersion: number
  private observedJournalSequence: number

  private constructor(
    workspace: Workspace,
    database: DatabaseSync,
    db: NodeSQLiteDatabase,
    releaseWriterLock?: () => void,
  ) {
    this.workspace = workspace
    this.database = database
    this.db = db
    this.releaseWriterLock = releaseWriterLock
    this.observedDataVersion = dataVersion(database)
    this.observedJournalSequence = journalBounds(database, db).latest_sequence
  }

  static open(workspace: Workspace, writable = false, allowSyncLock = false): SiloDatabase {
    ensureWorkspaceDatabase(workspace)
    if (!existsSync(workspace.databasePath))
      throw new SiloError(
        exits.absent,
        'database_absent',
        'No Silo database exists for this workspace.',
      )
    let database: DatabaseSync | undefined
    let releaseWriterLock: (() => void) | undefined
    try {
      if (writable && !allowSyncLock) {
        releaseWriterLock = acquireFileLock(
          `${workspace.databasePath}.write-lock`,
          'Another writer or synchronization operation is using this database.',
        )
        // Close the check/acquire race with synchronization, which creates its lock first.
        if (existsSync(`${workspace.databasePath}.sync-lock`))
          throw new SiloError(
            exits.io,
            'sync_in_progress',
            'A synchronization operation is already using this database.',
          )
      }
      database = new DatabaseSync(workspace.databasePath, { readOnly: !writable })
      configure(database, writable)
      const db = drizzle({ client: database })
      const meta = metadata(db)
      if (meta.identity !== workspace.identity) {
        throw new SiloError(
          exits.integrity,
          'identity_mismatch',
          'Database identity does not match the current Git workspace identity.',
        )
      }
      const instance = new SiloDatabase(workspace, database, db, releaseWriterLock)
      verifyPhysical(database, instance.getSchema())
      ensureJournalTable(database, writable)
      return instance
    } catch (error) {
      database?.close()
      releaseWriterLock?.()
      sqliteError(error)
    }
  }

  static createWithSchema(workspace: Workspace, schema: LogicalSchema): SiloDatabase {
    ensureWorkspaceDatabase(workspace)
    if (existsSync(workspace.databasePath))
      throw new SiloError(
        exits.schema,
        'database_exists',
        'A database already exists for this workspace.',
      )
    validateCompiledSchema(schema)
    mkdirSync(dirname(workspace.databasePath), { recursive: true })
    const releaseWriterLock = acquireFileLock(
      `${workspace.databasePath}.write-lock`,
      'Another writer or synchronization operation is using this database.',
    )
    if (existsSync(`${workspace.databasePath}.sync-lock`)) {
      releaseWriterLock()
      throw new SiloError(
        exits.io,
        'sync_in_progress',
        'A synchronization operation is already using this database.',
      )
    }
    if (existsSync(workspace.databasePath)) {
      releaseWriterLock()
      throw new SiloError(
        exits.schema,
        'database_exists',
        'A database already exists for this workspace.',
      )
    }
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(workspace.databasePath)
      configure(database, true)
      const db = drizzle({ client: database })
      const instance = new SiloDatabase(workspace, database, db, releaseWriterLock)
      db.transaction(
        () => {
          initialize(database!, db, workspace, schema)
          database!.exec(compileSchema(schema).join('\n'))
          instance.verify(schema)
          instance.recordMutationJournal(
            randomUUID(),
            {
              command: 'schema.create',
              tables: schema.tables.map((table) => table.name),
              before_revision: 0,
              after_revision: schema.revision,
            },
            ['*'],
          )
        },
        { behavior: 'immediate' },
      )
      return instance
    } catch (error) {
      try {
        database?.exec('ROLLBACK')
      } catch {}
      database?.close()
      // SQLite opens the path before BEGIN, so remove sidecars to preserve an actually absent state.
      rmSync(workspace.databasePath, { force: true })
      rmSync(`${workspace.databasePath}-wal`, { force: true })
      rmSync(`${workspace.databasePath}-shm`, { force: true })
      releaseWriterLock()
      sqliteError(error)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.database.close()
    } finally {
      this.releaseWriterLock?.()
    }
  }
  getMetadata(): DatabaseMetadata {
    return metadata(this.db)
  }

  getSchema(): LogicalSchema {
    return readSchema(this.db)
  }

  /**
   * Read SQLite's data-version counter for this connection.
   *
   * @returns The current `PRAGMA data_version` value.
   * @remarks The counter detects commits made by other connections but does not attribute them
   * to a resource. `readMutationJournal()` includes this value and compares it with the previous
   * read for the same long-lived `SiloDatabase` instance.
   */
  getDataVersion(): number {
    return dataVersion(this.database)
  }

  /**
   * Read committed local mutation entries after a database-local sequence cursor.
   *
   * @param afterSequence The last sequence already consumed. Use `0` to read from the beginning
   * of the retained window.
   * @param limit The requested page size. The response is always capped at
   * `MUTATION_JOURNAL_READ_LIMIT`.
   * @returns Journal entries, retention bounds, and fallback state for the observing connection.
   * @throws {SiloError} If the cursor or limit is not a valid non-negative or positive safe
   * integer, respectively.
   * @remarks Reuse the same `SiloDatabase` instance for polling. A data-version advance without
   * a matching journal window sets `unknown_change`, which means the consumer must invalidate
   * globally rather than attributing the change to the returned resource tags.
   */
  readMutationJournal(afterSequence = 0, limit = MUTATION_JOURNAL_READ_LIMIT): MutationJournalRead {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new SiloError(
        exits.input,
        'invalid_journal_cursor',
        'The journal cursor must be a non-negative safe integer.',
      )
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new SiloError(
        exits.input,
        'invalid_journal_limit',
        'The journal read limit must be a positive safe integer.',
      )

    const currentDataVersion = dataVersion(this.database)
    const journalAvailable = hasJournalTable(this.database)
    const bounds = journalBounds(this.database, this.db)
    const dataVersionDelta = currentDataVersion - this.observedDataVersion
    const journalSequenceDelta = bounds.latest_sequence - this.observedJournalSequence
    // Direct writes can share the interval with supported commits; a mismatch is therefore a
    // global invalidation instead of attributing the whole interval to the journal entries.
    const unknownChange =
      currentDataVersion !== this.observedDataVersion &&
      (dataVersionDelta <= 0 || dataVersionDelta !== journalSequenceDelta)
    this.observedDataVersion = currentDataVersion
    this.observedJournalSequence = bounds.latest_sequence

    const fullRefreshRequired =
      !journalAvailable ||
      (bounds.oldest_sequence !== null && afterSequence < bounds.oldest_sequence - 1)
    const entries: MutationJournalEntry[] = []
    if (!fullRefreshRequired && journalAvailable) {
      const rows = this.db
        .select({
          sequence: siloJournal.sequence,
          transaction_id: siloJournal.transactionId,
          committed_at: siloJournal.committedAt,
          operation_json: siloJournal.operationJson,
          resource_tags_json: siloJournal.resourceTagsJson,
        })
        .from(siloJournal)
        .where(gt(siloJournal.sequence, afterSequence))
        .orderBy(siloJournal.sequence)
        .limit(Math.min(limit, MUTATION_JOURNAL_READ_LIMIT))
        .all()
      for (const row of rows) {
        let operation: Record<string, unknown>
        let resourceTags: unknown
        try {
          operation = JSON.parse(row.operation_json) as Record<string, unknown>
          resourceTags = JSON.parse(row.resource_tags_json)
        } catch (error) {
          throw new SiloError(
            exits.integrity,
            'journal_entry_invalid',
            error instanceof Error ? error.message : String(error),
          )
        }
        if (
          !operation ||
          typeof operation !== 'object' ||
          Array.isArray(operation) ||
          !Array.isArray(resourceTags) ||
          !resourceTags.every((tag) => typeof tag === 'string')
        )
          throw new SiloError(
            exits.integrity,
            'journal_entry_invalid',
            'A local mutation journal entry has invalid metadata.',
          )
        entries.push({
          sequence: Number(row.sequence),
          transaction_id: row.transaction_id,
          committed_at: row.committed_at,
          operation,
          resource_tags: resourceTags,
        })
      }
    }
    return {
      entries,
      oldest_sequence: bounds.oldest_sequence,
      latest_sequence: bounds.latest_sequence,
      next_sequence: fullRefreshRequired
        ? bounds.latest_sequence
        : (entries.at(-1)?.sequence ?? afterSequence),
      full_refresh_required: fullRefreshRequired,
      data_version: currentDataVersion,
      unknown_change: unknownChange,
    }
  }

  private readSavedQuery(name: string): StoredQuery {
    validateQueryName(name)
    const row = this.db
      .select({
        name: siloSavedQueries.name,
        description: siloSavedQueries.description,
        sql: siloSavedQueries.sql,
        parameter_style: siloSavedQueries.parameterStyle,
        created_at: siloSavedQueries.createdAt,
        updated_at: siloSavedQueries.updatedAt,
      })
      .from(siloSavedQueries)
      .where(eq(siloSavedQueries.name, name))
      .get()
    if (!row)
      throw new SiloError(exits.notFound, 'query_not_found', `No saved query is named ${name}.`)
    const parameters = this.db
      .select({
        name: siloSavedQueryParameters.name,
        type: siloSavedQueryParameters.type,
        type_options_json: siloSavedQueryParameters.typeOptionsJson,
        description: siloSavedQueryParameters.description,
        has_default: siloSavedQueryParameters.hasDefault,
        default_json: siloSavedQueryParameters.defaultJson,
      })
      .from(siloSavedQueryParameters)
      .where(eq(siloSavedQueryParameters.queryName, name))
      .orderBy(siloSavedQueryParameters.position)
      .all()
    return {
      ...row,
      parameters: parameters.map((parameter) => ({
        name: parameter.name,
        type: parameter.type,
        ...(parameter.type_options_json === null
          ? {}
          : { type_options: JSON.parse(parameter.type_options_json) as Record<string, unknown> }),
        description: parameter.description,
        ...(parameter.has_default ? { default: JSON.parse(parameter.default_json!) } : {}),
      })),
    }
  }

  getSavedQuery(name: string): StoredQuery {
    return this.readSavedQuery(name)
  }

  listSavedQueries(): SavedQuerySummary[] {
    return this.db
      .select({
        name: siloSavedQueries.name,
        description: siloSavedQueries.description,
        parameter_style: siloSavedQueries.parameterStyle,
        parameters: count(siloSavedQueryParameters.name),
        updated_at: siloSavedQueries.updatedAt,
      })
      .from(siloSavedQueries)
      .leftJoin(
        siloSavedQueryParameters,
        eq(siloSavedQueryParameters.queryName, siloSavedQueries.name),
      )
      .groupBy(
        siloSavedQueries.name,
        siloSavedQueries.description,
        siloSavedQueries.parameterStyle,
        siloSavedQueries.updatedAt,
      )
      .orderBy(siloSavedQueries.name)
      .all()
  }

  putSavedQuery(input: unknown): StoredQuery {
    const definition = parseSavedQueryDefinition(input)
    const timestamp = now()
    return this.mutateRows(
      (query) => ({ command: 'query.put', query: query.name }),
      () => {
        validateReadOnlyQuery(this.database, definition)
        this.db
          .insert(siloSavedQueries)
          .values({
            name: definition.name,
            description: definition.description,
            sql: definition.sql,
            parameterStyle: definition.parameter_style,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: siloSavedQueries.name,
            set: {
              description: definition.description,
              sql: definition.sql,
              parameterStyle: definition.parameter_style,
              updatedAt: timestamp,
            },
          })
          .run()
        this.db
          .delete(siloSavedQueryParameters)
          .where(eq(siloSavedQueryParameters.queryName, definition.name))
          .run()
        if (definition.parameters.length)
          this.db
            .insert(siloSavedQueryParameters)
            .values(
              definition.parameters.map((parameter, position) => {
                const hasDefault = Object.prototype.hasOwnProperty.call(parameter, 'default')
                return {
                  queryName: definition.name,
                  name: parameter.name,
                  type: parameter.type,
                  typeOptionsJson:
                    parameter.type_options === undefined
                      ? null
                      : JSON.stringify(parameter.type_options),
                  description: parameter.description,
                  hasDefault: hasDefault ? 1 : 0,
                  defaultJson: hasDefault ? JSON.stringify(parameter.default) : null,
                  position,
                }
              }),
            )
            .run()
        return this.readSavedQuery(definition.name)
      },
    )
  }

  runSavedQuery(name: string, input: Record<string, unknown> | unknown[]): QueryResult {
    const definition = this.readSavedQuery(name)
    const bindings = bindSavedQuery(definition, input)
    return executeReadOnlyQuery(this.database, definition.sql, bindings.named, bindings.positional)
  }

  deleteSavedQuery(name: string): void {
    validateQueryName(name)
    this.mutateRows(
      () => ({ command: 'query.delete', query: name }),
      () => {
        // The foreign key is the integrity backstop; this check preserves actionable report
        // names instead of reducing an intentional lifecycle constraint to a SQLite error.
        const reports = this.db
          .select({ report_slug: siloReportQueries.reportSlug })
          .from(siloReportQueries)
          .where(eq(siloReportQueries.savedQueryName, name))
          .orderBy(siloReportQueries.reportSlug)
          .all()
        if (reports.length)
          throw new SiloError(
            exits.constraint,
            'query_in_use',
            `Saved query ${name} is referenced by reports: ${reports.map((row) => row.report_slug).join(', ')}.`,
          )
        const result = this.db.delete(siloSavedQueries).where(eq(siloSavedQueries.name, name)).run()
        if (!result.changes)
          throw new SiloError(exits.notFound, 'query_not_found', `No saved query is named ${name}.`)
      },
    )
  }

  private readReport(slug: string): StoredReport {
    validateReportSlug(slug, '$.slug')
    const row = this.db
      .select({
        slug: siloReports.slug,
        title: siloReports.title,
        template_markdown: siloReports.templateMarkdown,
        rendered_markdown: siloReports.renderedMarkdown,
        created_at: siloReports.createdAt,
        updated_at: siloReports.updatedAt,
        refreshed_at: siloReports.refreshedAt,
        last_refresh_attempt_at: siloReports.lastRefreshAttemptAt,
        last_refresh_error: siloReports.lastRefreshError,
      })
      .from(siloReports)
      .where(eq(siloReports.slug, slug))
      .get()
    if (!row) throw new SiloError(exits.notFound, 'report_not_found', `No report has slug ${slug}.`)
    const queries = this.db
      .select({
        name: siloReportQueries.name,
        sql: siloReportQueries.sql,
        saved_query_name: siloReportQueries.savedQueryName,
        parameters_json: siloReportQueries.parametersJson,
        empty_markdown: siloReportQueries.emptyMarkdown,
      })
      .from(siloReportQueries)
      .where(eq(siloReportQueries.reportSlug, slug))
      .orderBy(siloReportQueries.position)
      .all()
    return {
      slug: row.slug,
      title: row.title,
      markdown: row.template_markdown,
      queries: queries.map((query) => {
        const empty = query.empty_markdown === null ? {} : { empty_markdown: query.empty_markdown }
        return query.sql === null
          ? {
              name: query.name,
              saved_query: query.saved_query_name!,
              ...(query.parameters_json === null
                ? {}
                : {
                    parameters: JSON.parse(query.parameters_json) as
                      | Record<string, unknown>
                      | unknown[],
                  }),
              ...empty,
            }
          : { name: query.name, sql: query.sql, ...empty }
      }),
      rendered_markdown: row.rendered_markdown,
      created_at: row.created_at,
      updated_at: row.updated_at,
      refreshed_at: row.refreshed_at,
      last_refresh_attempt_at: row.last_refresh_attempt_at,
      last_refresh_error: row.last_refresh_error,
    }
  }

  getReport(slug: string): StoredReport {
    return this.readReport(slug)
  }

  listReports(): ReportSummary[] {
    return this.db
      .select({
        slug: siloReports.slug,
        title: siloReports.title,
        refreshed_at: siloReports.refreshedAt,
        last_refresh_attempt_at: siloReports.lastRefreshAttemptAt,
        last_refresh_error: siloReports.lastRefreshError,
      })
      .from(siloReports)
      .orderBy(siloReports.slug)
      .all()
  }

  /**
   * Validate a report definition and execute its queries without persisting a report.
   *
   * @param input The candidate report definition.
   * @returns The parsed definition after every query succeeds through the report read boundary.
   * @throws {SiloError} If the definition, a saved-query binding, or query execution is invalid.
   * @remarks This does not save a rendered snapshot, update refresh metadata, or create mutation
   * journal and synchronization entries.
   */
  validateReport(input: unknown): ReportDefinition {
    const definition = parseReportDefinition(input)
    this.db.transaction(() =>
      renderReport(this.database, definition, (name) => this.readSavedQuery(name)),
    )
    return definition
  }

  putReport(input: unknown): StoredReport {
    const definition = parseReportDefinition(input)
    const timestamp = now()
    return this.mutateRows(
      (report) => ({ command: 'report.put', report: report.slug }),
      () => {
        const rendered = renderReport(this.database, definition, (name) =>
          this.readSavedQuery(name),
        )
        this.db
          .insert(siloReports)
          .values({
            slug: definition.slug,
            title: definition.title,
            templateMarkdown: definition.markdown,
            renderedMarkdown: rendered,
            createdAt: timestamp,
            updatedAt: timestamp,
            refreshedAt: timestamp,
            lastRefreshAttemptAt: timestamp,
            lastRefreshError: null,
          })
          .onConflictDoUpdate({
            target: siloReports.slug,
            set: {
              title: definition.title,
              templateMarkdown: definition.markdown,
              renderedMarkdown: rendered,
              updatedAt: timestamp,
              refreshedAt: timestamp,
              lastRefreshAttemptAt: timestamp,
              lastRefreshError: null,
            },
          })
          .run()
        this.db
          .delete(siloReportQueries)
          .where(eq(siloReportQueries.reportSlug, definition.slug))
          .run()
        if (definition.queries.length)
          this.db
            .insert(siloReportQueries)
            .values(
              definition.queries.map((query, position) => ({
                reportSlug: definition.slug,
                name: query.name,
                sql: 'sql' in query ? query.sql : null,
                savedQueryName: 'saved_query' in query ? query.saved_query : null,
                parametersJson:
                  'saved_query' in query && query.parameters !== undefined
                    ? JSON.stringify(query.parameters)
                    : null,
                emptyMarkdown: query.empty_markdown ?? null,
                position,
              })),
            )
            .run()
        return this.readReport(definition.slug)
      },
    )
  }

  refreshReport(slug: string): StoredReport {
    validateReportSlug(slug, '$.slug')
    const timestamp = now()
    try {
      return this.mutateRows(
        (report) => ({ command: 'report.refresh', report: report.slug }),
        () => {
          const current = this.readReport(slug)
          const definition: ReportDefinition = {
            slug: current.slug,
            title: current.title,
            markdown: current.markdown,
            queries: current.queries,
          }
          const rendered = renderReport(this.database, definition, (name) =>
            this.readSavedQuery(name),
          )
          this.db
            .update(siloReports)
            .set({
              renderedMarkdown: rendered,
              refreshedAt: timestamp,
              lastRefreshAttemptAt: timestamp,
              lastRefreshError: null,
            })
            .where(eq(siloReports.slug, slug))
            .run()
          return this.readReport(slug)
        },
      )
    } catch (error) {
      if (!(error instanceof SiloError) || error.code !== 'report_not_found') {
        try {
          this.mutateRows(
            () => ({ command: 'report.refresh_error', report: slug }),
            () => {
              this.db
                .update(siloReports)
                .set({
                  lastRefreshAttemptAt: timestamp,
                  lastRefreshError:
                    error instanceof SiloError
                      ? `${error.code}: ${error.message}`
                      : error instanceof Error
                        ? error.message
                        : String(error),
                })
                .where(eq(siloReports.slug, slug))
                .run()
            },
          )
        } catch (recordError) {
          sqliteError(recordError)
        }
      }
      sqliteError(error)
    }
  }

  deleteReport(slug: string): void {
    validateReportSlug(slug, '$.slug')
    this.mutateRows(
      () => ({ command: 'report.delete', report: slug }),
      () => {
        const result = this.db.delete(siloReports).where(eq(siloReports.slug, slug)).run()
        if (!result.changes)
          throw new SiloError(exits.notFound, 'report_not_found', `No report has slug ${slug}.`)
      },
    )
  }

  getSyncState(): SyncState | undefined {
    const exists = this.database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_silo_sync'")
      .get()
    if (!exists) return undefined
    return this.db
      .select({
        database_id: siloSync.databaseId,
        remote_url: siloSync.remoteUrl,
        base_generation: siloSync.baseGeneration,
        base_etag: siloSync.baseEtag,
        conflict_transaction_id: siloSync.conflictTransactionId,
      })
      .from(siloSync)
      .where(eq(siloSync.id, 1))
      .get()
  }

  configureSync(remoteUrl: string, databaseId: string = randomUUID()): SyncState {
    const existing = this.getSyncState()
    if (existing) {
      if (existing.remote_url !== remoteUrl)
        throw new SiloError(
          exits.workspace,
          'sync_already_configured',
          `This database is already synchronized with ${existing.remote_url}.`,
        )
      return existing
    }
    validateSynchronizedSchema(this.getSchema())
    try {
      this.db.transaction(
        () => {
          this.database.exec(`
            CREATE TABLE _silo_sync (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              database_id TEXT NOT NULL UNIQUE,
              remote_url TEXT NOT NULL,
              base_generation TEXT,
              base_etag TEXT,
              conflict_transaction_id TEXT
            ) STRICT;
            CREATE TABLE _silo_outbox (
              sequence INTEGER PRIMARY KEY,
              transaction_id TEXT NOT NULL UNIQUE,
              kind TEXT NOT NULL CHECK (kind IN ('data', 'schema')),
              base_generation TEXT,
              schema_revision INTEGER NOT NULL,
              operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
              changeset BLOB NOT NULL,
              created_at TEXT NOT NULL
            ) STRICT;
          `)
          this.db.insert(siloSync).values({ id: 1, databaseId, remoteUrl }).run()
        },
        { behavior: 'immediate' },
      )
      return this.getSyncState()!
    } catch (error) {
      sqliteError(error)
    }
  }

  pendingTransactions(): PendingTransaction[] {
    if (!this.getSyncState()) return []
    const rows = this.db
      .select({
        sequence: siloOutbox.sequence,
        transaction_id: siloOutbox.transactionId,
        kind: siloOutbox.kind,
        base_generation: siloOutbox.baseGeneration,
        schema_revision: siloOutbox.schemaRevision,
        operation_json: siloOutbox.operationJson,
        changeset: siloOutbox.changeset,
        created_at: siloOutbox.createdAt,
      })
      .from(siloOutbox)
      .orderBy(siloOutbox.sequence)
      .all()
    return rows.map(({ operation_json, ...row }) => ({
      ...row,
      operation: JSON.parse(operation_json) as Record<string, unknown>,
      changeset: new Uint8Array(row.changeset),
    }))
  }

  setSyncConflict(transactionId: string | null): void {
    if (!this.getSyncState())
      throw new SiloError(
        exits.workspace,
        'sync_not_configured',
        'Synchronization is not configured.',
      )
    this.db
      .update(siloSync)
      .set({ conflictTransactionId: transactionId })
      .where(eq(siloSync.id, 1))
      .run()
  }

  markSynchronized(generation: string, etag: string): void {
    if (!this.getSyncState())
      throw new SiloError(
        exits.workspace,
        'sync_not_configured',
        'Synchronization is not configured.',
      )
    try {
      this.db.transaction(
        () => {
          this.db
            .update(siloSync)
            .set({
              baseGeneration: generation,
              baseEtag: etag,
              conflictTransactionId: null,
            })
            .where(eq(siloSync.id, 1))
            .run()
          this.db.delete(siloOutbox).run()
        },
        { behavior: 'immediate' },
      )
    } catch (error) {
      sqliteError(error)
    }
  }

  async backupCanonical(path: string, generation: string): Promise<void> {
    if (!this.getSyncState())
      throw new SiloError(
        exits.workspace,
        'sync_not_configured',
        'Synchronization is not configured.',
      )
    checkpointSnapshot(this.database)
    // Silo holds its writer lock while taking snapshots. After the checkpoint, the main file is
    // a complete consistent image; copying it preserves rowids and avoids SQLite backup's retry
    // loop when a recent changeset-bearing mutation left a native statement in the same process.
    copyFileSync(this.workspace.databasePath, path)
    const canonical = new DatabaseSync(path)
    try {
      configure(canonical, true)
      const canonicalDb = drizzle({ client: canonical })
      canonicalDb.transaction(
        () => {
          canonicalDb.delete(siloOutbox).run()
          canonicalDb
            .update(siloSync)
            .set({
              baseGeneration: generation,
              baseEtag: null,
              conflictTransactionId: null,
            })
            .where(eq(siloSync.id, 1))
            .run()
        },
        { behavior: 'immediate' },
      )
    } catch (error) {
      try {
        canonical.exec('ROLLBACK')
      } catch {}
      sqliteError(error)
    } finally {
      canonical.close()
    }
  }

  async backupRecovery(path: string): Promise<void> {
    // Recovery snapshots retain synchronization metadata and pending work verbatim so an
    // operator can inspect or restore the losing local authority after adopting a remote.
    checkpointSnapshot(this.database)
    copyFileSync(this.workspace.databasePath, path)
  }

  rebasePending(
    pending: PendingTransaction[],
    generation: string,
    etag: string,
    discardTransactionId?: string,
  ): string | undefined {
    const sync = this.getSyncState()
    if (!sync)
      throw new SiloError(
        exits.integrity,
        'sync_metadata_missing',
        'Restored sync metadata is missing.',
      )
    class RebaseConflict extends Error {
      readonly transactionId: string

      constructor(transactionId: string) {
        super(transactionId)
        this.transactionId = transactionId
      }
    }
    try {
      this.db.transaction(
        () => {
          this.db.delete(siloOutbox).run()
          this.db
            .update(siloSync)
            .set({
              baseGeneration: generation,
              baseEtag: etag,
              conflictTransactionId: null,
            })
            .where(eq(siloSync.id, 1))
            .run()
          for (const item of pending) {
            if (item.transaction_id === discardTransactionId) continue
            if (item.kind !== 'data' || item.schema_revision !== this.getSchema().revision)
              throw new RebaseConflict(item.transaction_id)
            if (!this.database.applyChangeset(item.changeset))
              throw new RebaseConflict(item.transaction_id)
            this.db
              .insert(siloOutbox)
              .values({
                sequence: item.sequence,
                transactionId: item.transaction_id,
                kind: item.kind,
                baseGeneration: generation,
                schemaRevision: item.schema_revision,
                operationJson: JSON.stringify(item.operation),
                changeset: Buffer.from(item.changeset),
                createdAt: item.created_at,
              })
              .run()
          }
          this.verify(this.getSchema())
          const integrity = this.database.prepare('PRAGMA integrity_check').get() as Record<
            string,
            unknown
          >
          if (!Object.values(integrity).some((value) => value === 'ok'))
            throw new SiloError(
              exits.integrity,
              'integrity_check_failed',
              'SQLite integrity check failed.',
            )
        },
        { behavior: 'immediate' },
      )
      return undefined
    } catch (error) {
      if (error instanceof RebaseConflict) return error.transactionId
      sqliteError(error)
    }
  }

  private recordMutationJournal(
    transactionId: string,
    operation: Record<string, unknown>,
    tags: string[] = resourceTags(operation),
    committedAt = now(),
  ): void {
    this.db
      .insert(siloJournal)
      .values({
        transactionId,
        committedAt,
        operationJson: operationJson(operation),
        resourceTagsJson: JSON.stringify(tags),
      })
      .run()
    this.db
      .delete(siloJournal)
      .where(
        sql`${siloJournal.sequence} <= (SELECT coalesce(max(${siloJournal.sequence}), 0) - ${MUTATION_JOURNAL_RETENTION} FROM ${siloJournal})`,
      )
      .run()
  }

  private mutateRows<T>(operation: (result: T) => Record<string, unknown>, mutate: () => T): T {
    const sync = this.getSyncState()
    const session = sync ? this.database.createSession() : undefined
    const transactionId = randomUUID()
    try {
      return this.db.transaction(
        (() => {
          const result = mutate()
          const operationContext = operation(result)
          const committedAt = now()
          if (session) {
            // Extract before writing journal or outbox metadata so replication never recursively
            // captures its own bookkeeping; the surrounding transaction still commits all metadata
            // atomically with the supported mutation.
            const changeset = session.changeset()
            this.recordMutationJournal(
              transactionId,
              operationContext,
              resourceTags(operationContext),
              committedAt,
            )
            if (changeset.byteLength)
              this.db
                .insert(siloOutbox)
                .values({
                  transactionId,
                  kind: 'data',
                  baseGeneration: sync!.base_generation,
                  schemaRevision: this.getSchema().revision,
                  operationJson: operationJson(operationContext),
                  changeset: Buffer.from(changeset),
                  createdAt: committedAt,
                })
                .run()
          } else
            this.recordMutationJournal(
              transactionId,
              operationContext,
              resourceTags(operationContext),
              committedAt,
            )
          return result
        }) as never,
        { behavior: 'immediate' },
      ) as T
    } catch (error) {
      return sqliteError(error)
    } finally {
      session?.close()
    }
  }

  private prepareSchemaMutation(proposed: LogicalSchema): SyncState | undefined {
    const sync = this.getSyncState()
    if (!sync) return undefined
    if (sync.conflict_transaction_id)
      throw new SiloError(
        exits.revision,
        'sync_conflict_unresolved',
        `Resolve synchronized transaction ${sync.conflict_transaction_id} before changing schema.`,
      )
    if (this.pendingTransactions().length)
      throw new SiloError(
        exits.revision,
        'sync_schema_requires_clean_base',
        'Push or discard pending transactions before changing synchronized schema.',
      )
    validateSynchronizedSchema(proposed)
    return sync
  }

  private recordSchemaMutation(
    sync: SyncState | undefined,
    operation: Record<string, unknown>,
    beforeRevision: number,
    afterRevision: number,
  ): void {
    const transactionId = randomUUID()
    const operationContext = {
      ...operation,
      before_revision: beforeRevision,
      after_revision: afterRevision,
    }
    const committedAt = now()
    this.recordMutationJournal(transactionId, operationContext, ['*'], committedAt)
    if (!sync) return
    // SQLite Sessions do not capture DDL. This marker forces publication of the full
    // checkpoint and makes any remote advance reject instead of attempting a schema merge.
    this.db
      .insert(siloOutbox)
      .values({
        transactionId,
        kind: 'schema',
        baseGeneration: sync.base_generation,
        schemaRevision: afterRevision,
        operationJson: operationJson(operationContext),
        changeset: Buffer.alloc(0),
        createdAt: committedAt,
      })
      .run()
  }

  private replaceSchema(schema: LogicalSchema): void {
    // Callers keep metadata replacement in the same transaction as the corresponding DDL.
    this.db
      .update(siloSchemaTable)
      .set({ schemaJson: JSON.stringify(schema) })
      .where(eq(siloSchemaTable.id, 1))
      .run()
    this.db.update(siloMeta).set({ value: now() }).where(eq(siloMeta.key, 'updated_at')).run()
    if (schema.template_imports?.length)
      this.db
        .insert(siloMeta)
        .values({
          key: 'template_names',
          value: JSON.stringify(schema.template_imports.map((item) => item.name)),
        })
        .onConflictDoUpdate({
          target: siloMeta.key,
          set: { value: JSON.stringify(schema.template_imports.map((item) => item.name)) },
        })
        .run()
  }

  createTable(input: unknown): TableDefinition {
    const table = parseTable(input)
    const schema = this.getSchema()
    if (
      schema.tables.some((candidate) => candidate.name.toLowerCase() === table.name.toLowerCase())
    )
      throw new SiloError(exits.schema, 'table_exists', `${table.name} already exists.`, '$.name')
    const proposed = { ...schema, revision: schema.revision + 1, tables: [...schema.tables, table] }
    validateCompiledSchema(proposed)
    const sync = this.prepareSchemaMutation(proposed)
    try {
      this.db.transaction(
        () => {
          this.database.exec(compileTable(table).join('\n'))
          this.replaceSchema(proposed)
          this.verify(proposed)
          this.recordSchemaMutation(
            sync,
            { command: 'table.create', table: table.name },
            schema.revision,
            proposed.revision,
          )
        },
        { behavior: 'immediate' },
      )
      return table
    } catch (error) {
      sqliteError(error)
    }
  }

  addRelation(input: unknown): RelationDefinition {
    const relation = parseRelation(input)
    const schema = this.getSchema()
    const proposed = withRelations({ ...schema, revision: schema.revision + 1 }, [
      ...(schema.relations ?? []),
      relation,
    ])
    validateCompiledSchema(proposed)
    const sync = this.prepareSchemaMutation(proposed)
    try {
      this.db.transaction(
        () => {
          this.replaceSchema(proposed)
          this.verify(proposed)
          this.recordSchemaMutation(
            sync,
            {
              command: 'relation.add',
              from_table: relation.from.table,
              name: relation.from.name,
              to_table: relation.to.table,
            },
            schema.revision,
            proposed.revision,
          )
        },
        { behavior: 'immediate' },
      )
      return relation
    } catch (error) {
      sqliteError(error)
    }
  }

  getRelation(tableName: string, name: string): RelationDefinition {
    const schema = this.getSchema()
    const table = this.table(tableName)
    const relation = relationsFromTable(schema, table.name).find(
      (candidate) => candidate.from.name.toLowerCase() === name.toLowerCase(),
    )
    if (!relation)
      throw new SiloError(
        exits.notFound,
        'relation_not_found',
        `${table.name}.${name} does not exist.`,
      )
    return relation
  }

  listRelations(): RelationDefinition[] {
    return this.getSchema().relations ?? []
  }

  removeRelation(tableName: string, name: string): void {
    const schema = this.getSchema()
    const table = this.table(tableName)
    const relation = relationsFromTable(schema, table.name).find(
      (candidate) => candidate.from.name.toLowerCase() === name.toLowerCase(),
    )
    if (!relation)
      throw new SiloError(
        exits.notFound,
        'relation_not_found',
        `${table.name}.${name} does not exist.`,
      )
    const proposed = withRelations(
      { ...schema, revision: schema.revision + 1 },
      (schema.relations ?? []).filter((candidate) => candidate !== relation),
    )
    validateCompiledSchema(proposed)
    const sync = this.prepareSchemaMutation(proposed)
    try {
      this.db.transaction(
        () => {
          this.replaceSchema(proposed)
          this.verify(proposed)
          this.recordSchemaMutation(
            sync,
            {
              command: 'relation.remove',
              from_table: relation.from.table,
              name: relation.from.name,
              to_table: relation.to.table,
            },
            schema.revision,
            proposed.revision,
          )
        },
        { behavior: 'immediate' },
      )
    } catch (error) {
      sqliteError(error)
    }
  }

  importTemplate(name: string, template: TemplateSchema): LogicalSchema {
    const schema = this.getSchema()
    const importedRelations = templateRelations(template)
    const existing = new Set(schema.tables.map((table) => table.name.toLowerCase()))
    const conflict = template.tables.find((table) => existing.has(table.name.toLowerCase()))
    if (conflict)
      throw new SiloError(
        exits.schema,
        'template_table_conflict',
        `Template ${name} conflicts with existing table ${conflict.name}.`,
        '$.tables',
      )
    const proposed = withRelations(
      {
        ...schema,
        revision: schema.revision + 1,
        tables: [...schema.tables, ...template.tables],
        template_imports: [...(schema.template_imports ?? []), { name, imported_at: now() }],
        agent_instructions: [
          ...(schema.agent_instructions ?? []),
          ...(template.agent_instructions
            ? [{ source: `template:${name}`, content: template.agent_instructions }]
            : []),
        ],
      },
      [...(schema.relations ?? []), ...importedRelations],
    )
    validateCompiledSchema(proposed)
    const sync = this.prepareSchemaMutation(proposed)
    try {
      this.db.transaction(
        () => {
          this.database.exec(template.tables.flatMap(compileTable).join('\n'))
          this.replaceSchema(proposed)
          this.verify(proposed)
          this.recordSchemaMutation(
            sync,
            { command: 'schema.import', template: name },
            schema.revision,
            proposed.revision,
          )
        },
        { behavior: 'immediate' },
      )
      return proposed
    } catch (error) {
      sqliteError(error)
    }
  }

  alterTable(name: string, input: unknown): TableDefinition {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new SiloError(exits.input, 'invalid_shape', 'Expected an alter request object.')
    const request = input as { add_columns?: unknown[]; add_indexes?: unknown[] }
    const unknown = Object.keys(request).find(
      (key) => key !== 'add_columns' && key !== 'add_indexes',
    )
    if (unknown)
      throw new SiloError(exits.input, 'unknown_field', `Unknown field ${unknown}.`, `$.${unknown}`)
    const schema = this.getSchema()
    const position = schema.tables.findIndex(
      (table) => table.name.toLowerCase() === name.toLowerCase(),
    )
    if (position < 0)
      throw new SiloError(exits.notFound, 'table_not_found', `${name} does not exist.`)
    const current = schema.tables[position]!
    const candidate = parseTable({
      ...current,
      columns: [...current.columns, ...(request.add_columns ?? [])],
      indexes: [...(current.indexes ?? []), ...(request.add_indexes ?? [])],
    })
    for (const column of request.add_columns ?? []) {
      const value = column as { nullable?: boolean; default?: unknown; generated?: unknown }
      if (value.generated || (value.nullable === false && value.default === undefined))
        throw new SiloError(
          exits.schema,
          'unsupported_alter',
          'Added columns must be nullable or have a compatible constant default, and cannot be generated.',
        )
      if ((value.default as { expression?: unknown } | undefined)?.expression)
        throw new SiloError(
          exits.schema,
          'unsupported_alter',
          'Added-column defaults must be JSON literals in the initial release.',
        )
    }
    const proposed = {
      ...schema,
      revision: schema.revision + 1,
      tables: schema.tables.map((table, i) => (i === position ? candidate : table)),
    }
    validateCompiledSchema(proposed)
    const sync = this.prepareSchemaMutation(proposed)
    try {
      this.db.transaction(
        () => {
          for (const column of request.add_columns ?? [])
            this.database.exec(
              `ALTER TABLE ${quote(current.name)} ADD COLUMN ${compileTable({ ...current, columns: [column as never], primary_key: undefined, foreign_keys: [], unique_constraints: [], indexes: [], checks: [], policies: [] })[0]!.match(/\(\n  (.*)\n\)/s)![1]};`,
            )
          const additions = candidate.indexes?.slice(current.indexes?.length ?? 0) ?? []
          if (additions.length) {
            const indexes = compileTable(candidate).filter((statement) =>
              /^CREATE (?:UNIQUE )?INDEX /.test(statement),
            )
            for (const statement of indexes.slice(current.indexes?.length ?? 0))
              this.database.exec(statement)
          }
          this.replaceSchema(proposed)
          this.verify(proposed)
          this.recordSchemaMutation(
            sync,
            { command: 'table.alter', table: current.name },
            schema.revision,
            proposed.revision,
          )
        },
        { behavior: 'immediate' },
      )
      return candidate
    } catch (error) {
      sqliteError(error)
    }
  }

  dropTable(name: string): void {
    const schema = this.getSchema()
    const existing = schema.tables.find((table) => table.name.toLowerCase() === name.toLowerCase())
    if (!existing) throw new SiloError(exits.notFound, 'table_not_found', `${name} does not exist.`)
    const proposed = {
      ...schema,
      revision: schema.revision + 1,
      tables: schema.tables.filter((table) => table.name !== existing.name),
    }
    validateCompiledSchema(proposed)
    const sync = this.prepareSchemaMutation(proposed)
    try {
      this.db.transaction(
        () => {
          this.database.exec(`DROP TABLE ${quote(existing.name)}`)
          this.replaceSchema(proposed)
          this.verify(proposed)
          this.recordSchemaMutation(
            sync,
            { command: 'table.drop', table: existing.name },
            schema.revision,
            proposed.revision,
          )
        },
        { behavior: 'immediate' },
      )
    } catch (error) {
      sqliteError(error)
    }
  }

  private verify(schema: LogicalSchema): void {
    verifyPhysical(this.database, schema)
  }

  table(name: string): TableDefinition {
    const table = this.getSchema().tables.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    )
    if (!table) throw new SiloError(exits.notFound, 'table_not_found', `${name} does not exist.`)
    return table
  }

  addRows(name: string, input: unknown, upsert = false): Record<string, unknown>[] {
    const table = this.table(name)
    const rows = Array.isArray(input) ? input : [input]
    if (!rows.length)
      throw new SiloError(exits.input, 'invalid_shape', 'At least one row is required.')
    return this.mutateRows(
      (results) => ({
        command: upsert ? 'row.upsert' : 'row.add',
        table: table.name,
        keys: table.primary_key
          ? results.map((row) => table.primary_key!.map((key) => row[key]))
          : [],
      }),
      () => {
        const results: Record<string, unknown>[] = []
        for (const raw of rows) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new SiloError(exits.input, 'invalid_shape', 'Each row must be an object.')
          const request = raw as Record<string, unknown>
          const row = this.prepareRow(table, request, true)
          const columns = Object.keys(row)
          let statement = columns.length
            ? sql`INSERT INTO ${identifier(table.name)} (${identifiers(columns)}) VALUES (${bindings(Object.values(row))})`
            : sql`INSERT INTO ${identifier(table.name)} DEFAULT VALUES`
          let naturalKeys: string[] | undefined
          if (upsert) {
            const upsertPolicy = policy(table, 'natural_key_upsert')
            if (!upsertPolicy)
              throw new SiloError(
                exits.schema,
                'upsert_not_declared',
                'The table has no natural_key_upsert policy.',
              )
            const keys = upsertPolicy.columns as string[]
            if (keys.some((key) => row[key] === undefined))
              throw new SiloError(
                exits.input,
                'upsert_key_required',
                'Every natural-key upsert column must be provided.',
              )
            naturalKeys = keys
            const configured = upsertPolicy.update_columns as string[] | undefined
            const allowed = (
              configured ?? Object.keys(request).filter((column) => !keys.includes(column))
            ).filter((column) => columns.includes(column))
            if (!allowed.length) {
              const existing = this.findPersistedRow(table, keys, row)
              if (existing) {
                results.push(existing)
                continue
              }
            }
            statement = allowed.length
              ? sql`${statement} ON CONFLICT (${identifiers(keys)}) DO UPDATE SET ${sql.join(
                  allowed.map(
                    (column) => sql`${identifier(column)} = excluded.${identifier(column)}`,
                  ),
                  sql`, `,
                )}`
              : sql`${statement} ON CONFLICT (${identifiers(keys)}) DO NOTHING`
          }
          statement = table.without_rowid
            ? sql`${statement} RETURNING *`
            : sql`${statement} RETURNING rowid AS "_silo_rowid", *`
          const returned = this.db.get<Record<string, unknown>>(statement) as
            | Record<string, unknown>
            | undefined
          results.push(this.readPersistedRow(table, returned, naturalKeys, row))
        }
        return results
      },
    )
  }

  private readPersistedRow(
    table: TableDefinition,
    returned: Record<string, unknown> | undefined,
    fallbackColumns?: string[],
    fallbackValues?: Record<string, Binding>,
  ): Record<string, unknown> {
    let where: SQL
    if (returned?._silo_rowid !== undefined) {
      where = sql`rowid = ${binding(returned._silo_rowid)}`
    } else {
      const columns = returned ? table.primary_key : fallbackColumns
      if (!columns?.length)
        throw new SiloError(
          exits.integrity,
          'persisted_row_unresolved',
          'The persisted row could not be located after mutation.',
        )
      where = equals(
        columns,
        columns.map((column) => binding(returned ? returned[column] : fallbackValues?.[column])),
      )
    }
    const persisted = this.db.get<Record<string, unknown>>(
      sql`SELECT * FROM ${identifier(table.name)} WHERE ${where}`,
    ) as Record<string, unknown> | undefined
    if (!persisted)
      throw new SiloError(
        exits.integrity,
        'persisted_row_unresolved',
        'The persisted row could not be located after mutation.',
      )
    return this.renderRow(table, persisted)
  }

  private findPersistedRow(
    table: TableDefinition,
    columns: string[],
    source: Record<string, Binding>,
  ): Record<string, unknown> | undefined {
    const persisted = this.db.get<Record<string, unknown>>(
      sql`SELECT * FROM ${identifier(table.name)} WHERE ${equals(
        columns,
        columns.map((column) => source[column]!),
      )}`,
    ) as Record<string, unknown> | undefined
    return persisted ? this.renderRow(table, persisted) : undefined
  }

  private prepareRow(
    table: TableDefinition,
    raw: Record<string, unknown>,
    insert: boolean,
  ): Record<string, Binding> {
    const known = new Map(table.columns.map((column) => [column.name, column]))
    for (const key of Object.keys(raw))
      if (!known.has(key))
        throw new SiloError(exits.input, 'unknown_field', `Unknown field ${key}.`, `$.${key}`)
      else if (known.get(key)!.generated)
        throw new SiloError(
          exits.input,
          'generated_column_input',
          `Generated column ${key} cannot be written directly.`,
          `$.${key}`,
        )
    const row: Record<string, Binding> = {}
    for (const [key, value] of Object.entries(raw))
      row[key] = binding(canonicalize(known.get(key)!, value))
    if (insert) {
      const identity = policy(table, 'generated_identity')
      if (
        identity &&
        identity.strategy !== 'integer' &&
        row[identity.column as string] === undefined
      )
        row[identity.column as string] = generatedValue(identity.strategy)
      const timestamps = policy(table, 'timestamps')
      if (timestamps) {
        const timestamp = now()
        if (timestamps.created_column && row[timestamps.created_column as string] === undefined)
          row[timestamps.created_column as string] = timestamp
        if (timestamps.updated_column && row[timestamps.updated_column as string] === undefined)
          row[timestamps.updated_column as string] = timestamp
      }
      const revision = policy(table, 'optimistic_revision')
      if (revision && row[revision.column as string] === undefined)
        row[revision.column as string] = binding(revision.initial ?? 1)
    }
    return row
  }

  private keyWhere(
    table: TableDefinition,
    key: unknown,
  ): {
    columns: string[]
    values: Binding[]
  } {
    const keys = table.primary_key?.length
      ? table.primary_key
      : table.columns
          .filter((column) => policy(table, 'generated_identity')?.column === column.name)
          .map((column) => column.name)
    if (!keys?.length)
      throw new SiloError(
        exits.schema,
        'primary_key_required',
        'Row-by-key operations require a primary key or generated identity.',
      )
    let values: unknown[]
    if (keys.length === 1) values = [key]
    else if (Array.isArray(key)) values = key
    else if (typeof key === 'string') {
      try {
        const decoded = JSON.parse(key)
        values = Array.isArray(decoded) ? decoded : []
      } catch {
        values = []
      }
    } else values = []
    if (values.length !== keys.length)
      throw new SiloError(exits.input, 'invalid_key', `Expected ${keys.length} key values.`)
    return {
      columns: keys,
      values: values.map((value, i) => {
        const column = table.columns.find((candidate) => candidate.name === keys[i])!
        let decoded = value
        if (typeof value === 'string') {
          const storage = semantic(column).storage
          const parseJson =
            storage !== 'TEXT' || column.type === 'text/json' || /^"(?:[^"\\]|\\.)*"$/.test(value)
          if (parseJson)
            try {
              decoded = JSON.parse(value)
            } catch {}
        }
        return binding(canonicalize(column, decoded))
      }),
    }
  }

  getRow(name: string, key: unknown): Record<string, unknown> {
    const table = this.table(name)
    const where = this.keyWhere(table, key)
    const row = this.db.get<Record<string, unknown>>(
      sql`SELECT * FROM ${identifier(table.name)} WHERE ${equals(where.columns, where.values)}`,
    ) as Record<string, unknown> | undefined
    if (!row)
      throw new SiloError(exits.notFound, 'row_not_found', 'No row matches the supplied key.')
    return this.renderRow(table, row)
  }

  listRows(name: string, limit: number, offset: number): Record<string, unknown>[] {
    const table = this.table(name)
    const order = table.primary_key?.length
      ? ` ORDER BY ${table.primary_key.map(quote).join(', ')}`
      : table.without_rowid
        ? ''
        : ' ORDER BY rowid'
    const query = order
      ? sql`SELECT * FROM ${identifier(table.name)} ${sql.raw(order)} LIMIT ${limit} OFFSET ${offset}`
      : sql`SELECT * FROM ${identifier(table.name)} LIMIT ${limit} OFFSET ${offset}`
    return (this.db.all<Record<string, unknown>>(query) as Record<string, unknown>[]).map((row) =>
      this.renderRow(table, row),
    )
  }

  private renderRow(table: TableDefinition, row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(row).map(([name, value]) => [
        name,
        semantic(table.columns.find((column) => column.name === name)!).render?.(value) ?? value,
      ]),
    )
  }

  updateRow(name: string, key: unknown, input: unknown): number {
    const table = this.table(name)
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new SiloError(exits.input, 'invalid_shape', 'Expected a row object.')
    const raw = { ...(input as Record<string, unknown>) }
    const expected = raw._expected_revision
    delete raw._expected_revision
    if (this.getSyncState() && table.primary_key?.some((column) => column in raw))
      throw new SiloError(
        exits.input,
        'sync_primary_key_immutable',
        'Synchronized primary-key values cannot be updated.',
      )
    const row = this.prepareRow(table, raw, false)
    const timestamps = policy(table, 'timestamps')
    const revision = policy(table, 'optimistic_revision')
    const where = this.keyWhere(table, key)
    let whereExpression = equals(where.columns, where.values)
    if (timestamps?.updated_column) {
      const column = timestamps.updated_column as string
      const persisted = this.db.get<{ value?: unknown }>(
        sql`SELECT ${identifier(column)} AS value FROM ${identifier(table.name)} WHERE ${whereExpression}`,
      ) as { value?: unknown } | undefined
      row[column] = laterThan(persisted?.value)
    }
    if (revision) {
      if (!Number.isSafeInteger(expected))
        throw new SiloError(
          exits.input,
          'expected_revision_required',
          '_expected_revision is required for this table.',
        )
      where.columns.push(revision.column as string)
      where.values.push(Number(expected))
      whereExpression = equals(where.columns, where.values)
      row[revision.column as string] = Number(expected) + 1
    }
    const columns = Object.keys(row)
    if (!columns.length)
      throw new SiloError(exits.input, 'empty_update', 'At least one field must be updated.')
    return this.mutateRows(
      () => ({ command: 'row.update', table: table.name, key }),
      () => {
        const result = this.db.run(
          sql`UPDATE ${identifier(table.name)} SET ${sql.join(
            columns.map((column) => sql`${identifier(column)} = ${row[column]}`),
            sql`, `,
          )} WHERE ${whereExpression}`,
        )
        if (!result.changes)
          throw new SiloError(
            revision ? exits.revision : exits.notFound,
            revision ? 'revision_conflict' : 'row_not_found',
            revision ? 'The row revision did not match.' : 'No row matches the supplied key.',
          )
        return Number(result.changes)
      },
    )
  }

  deleteRow(name: string, key: unknown): number {
    const table = this.table(name)
    const where = this.keyWhere(table, key)
    return this.mutateRows(
      () => ({ command: 'row.delete', table: table.name, key }),
      () => {
        const result = this.db.run(
          sql`DELETE FROM ${identifier(table.name)} WHERE ${equals(where.columns, where.values)}`,
        )
        if (!result.changes)
          throw new SiloError(exits.notFound, 'row_not_found', 'No row matches the supplied key.')
        return Number(result.changes)
      },
    )
  }

  query(sql: string): { columns: string[]; rows: unknown[][] } {
    try {
      const statement = this.database.prepare(sql) as StatementSync
      statement.setReturnArrays(true)
      const rawColumns = statement.columns().map((column) => column.name || 'column')
      const seen = new Map<string, number>()
      const columns = rawColumns.map((name) => {
        const count = (seen.get(name) ?? 0) + 1
        seen.set(name, count)
        return count === 1 ? name : `${name}_${count}`
      })
      return { columns, rows: statement.all() as unknown as unknown[][] }
    } catch (error) {
      sqliteError(error)
    }
  }

  ddl(): string {
    return compileSchema(this.getSchema()).join('\n\n')
  }
}

export function emptySchema(): LogicalSchema {
  return {
    format_version: 1,
    registry_version: 1,
    revision: 1,
    tables: [],
  }
}

export function schemaFromTemplate(
  name: string,
  template: TemplateSchema,
  importedAt = now(),
): LogicalSchema {
  const importedRelations = templateRelations(template)
  const schema = withRelations(
    {
      ...emptySchema(),
      tables: template.tables,
      template_imports: [{ name, imported_at: importedAt }],
      ...(template.agent_instructions
        ? {
            agent_instructions: [
              { source: `template:${name}`, content: template.agent_instructions },
            ],
          }
        : {}),
    },
    importedRelations,
  )
  validateCompiledSchema(schema)
  return schema
}

export function sqliteVersion(): string {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(
      'CREATE TABLE _capability_probe (value TEXT) STRICT; DROP TABLE _capability_probe;',
    )
    return String(
      Object.values(
        database.prepare('SELECT sqlite_version() AS version').get() as Record<string, unknown>,
      )[0],
    )
  } finally {
    database.close()
  }
}

export function readTemplate(name: string): TemplateSchema {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))
    throw new SiloError(
      exits.input,
      'invalid_template_name',
      'Template names use letters, digits, hyphens, and underscores.',
    )
  const localPath = join(dataRoot(), 'templates', `${name}.json`)
  const bundledPath = join(fileURLToPath(new URL('../templates', import.meta.url)), `${name}.json`)
  const path = existsSync(localPath) ? localPath : bundledPath
  if (!existsSync(path))
    throw new SiloError(exits.notFound, 'template_not_found', `${name} does not exist.`)
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('template must be an object')
    const unknown = Object.keys(value).find(
      (key) => !['format_version', 'agent_instructions', 'tables', 'relations'].includes(key),
    )
    if (unknown) throw new Error(`unknown field ${unknown}`)
    if (value.format_version !== undefined && value.format_version !== 1)
      throw new Error('format_version must be 1')
    if (
      value.agent_instructions !== undefined &&
      (typeof value.agent_instructions !== 'string' || !value.agent_instructions.trim())
    )
      throw new Error('agent_instructions must be a non-empty string')
    if (!Array.isArray(value.tables)) throw new Error('tables must be an array')
    const tables = value.tables.map(parseTable)
    if (value.relations !== undefined && !Array.isArray(value.relations))
      throw new Error('relations must be an array')
    const relations = value.relations?.map((relation, index) =>
      parseRelation(relation, `$.relations[${index}]`),
    )
    const schema: LogicalSchema = {
      format_version: 1,
      registry_version: 1,
      revision: 1,
      tables,
      ...(relations?.length ? { relations } : {}),
    }
    validateCompiledSchema(schema, { allowExternalReferences: true })
    return {
      format_version: 1,
      ...(value.agent_instructions
        ? { agent_instructions: value.agent_instructions as string }
        : {}),
      tables,
      ...(relations?.length ? { relations } : {}),
    }
  } catch (error) {
    if (error instanceof SiloError) throw error
    throw new SiloError(
      exits.input,
      'invalid_template',
      error instanceof Error ? error.message : String(error),
    )
  }
}

export function listTemplates(): string[] {
  const roots = [
    fileURLToPath(new URL('../templates', import.meta.url)),
    join(dataRoot(), 'templates'),
  ]
  return [
    ...new Set(
      roots.flatMap((root) =>
        existsSync(root)
          ? readdirSync(root, { withFileTypes: true })
              .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
              .map((entry) => entry.name.slice(0, -5))
          : [],
      ),
    ),
  ].sort()
}

export interface CatalogEntry {
  path: string
  state: string
  identity?: string
  message?: string
}
export function discoverDatabases(): CatalogEntry[] {
  const root = join(dataRoot(), 'databases')
  if (!existsSync(root)) return []
  const paths: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.sqlite')) paths.push(path)
    }
  }
  walk(root)
  return paths.sort().map((path) => {
    let identity: string | undefined
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(path, { readOnly: true })
      configure(database, false)
      const db = drizzle({ client: database })
      const meta = metadata(db)
      identity = meta.identity
      verifyPhysical(database, readSchema(db))
      return { path, state: 'recognized', identity: meta.identity }
    } catch (error) {
      const state =
        error instanceof SiloError && error.code === 'unrecognized_database'
          ? 'unrecognized'
          : error instanceof SiloError && error.exitCode === exits.integrity
            ? 'incompatible'
            : 'unreadable'
      return {
        path,
        state,
        identity,
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      database?.close()
    }
  })
}
