export type SQLiteStorage = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'

export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal }

export interface DefaultValue {
  literal?: Literal
  expression?: string
}

export interface ColumnDefinition {
  name: string
  type: string
  type_options?: Record<string, unknown>
  nullable?: boolean
  default?: DefaultValue
  comment: string
  collate?: string
  generated?: { expression: string; storage?: 'VIRTUAL' | 'STORED' }
}

export interface ForeignKeyDefinition {
  columns: string[]
  references: { table: string; columns: string[] }
  on_update?: string
  on_delete?: string
  deferrable?: boolean
  initially_deferred?: boolean
}

export interface IndexPart {
  column?: string
  expression?: string
  direction?: 'ASC' | 'DESC'
  collate?: string
}

export interface IndexDefinition {
  name?: string
  columns: IndexPart[]
  unique?: boolean
  where?: string
  comment?: string
}

export interface CheckDefinition {
  name?: string
  expression: string
  comment?: string
}

export interface PolicyDefinition {
  type:
    | 'generated_identity'
    | 'timestamps'
    | 'optimistic_revision'
    | 'immutable_rows'
    | 'immutable_columns'
    | 'append_only'
    | 'natural_key_upsert'
  [key: string]: unknown
}

export interface TableDefinition {
  name: string
  comment: string
  columns: ColumnDefinition[]
  primary_key?: string[]
  foreign_keys?: ForeignKeyDefinition[]
  unique_constraints?: Array<{ name?: string; columns: string[] }>
  indexes?: IndexDefinition[]
  checks?: CheckDefinition[]
  policies?: PolicyDefinition[]
  strict?: boolean
  without_rowid?: boolean
}

export interface RelationEndpoint {
  table: string
  columns: string[]
}

export interface RelationDefinition {
  from: RelationEndpoint & { name: string }
  to: RelationEndpoint
  inverse_name?: string
  comment: string
  inverse_comment?: string
}

export interface LogicalSchema {
  format_version: 1
  registry_version: 1
  revision: number
  tables: TableDefinition[]
  relations?: RelationDefinition[]
  template_imports?: Array<{ name: string; imported_at: string }>
  agent_instructions?: Array<{ source: string; content: string }>
}

export interface TemplateSchema {
  format_version?: 1
  agent_instructions?: string
  tables: TableDefinition[]
  relations?: RelationDefinition[]
}

export interface DatabaseMetadata {
  identity: string
  original_origin: string
  created_at: string
  updated_at: string
  format_version: number
  tool_version: string
}

export interface SyncState {
  database_id: string
  remote_url: string
  base_generation: string | null
  base_etag: string | null
  conflict_transaction_id: string | null
}

export interface PendingTransaction {
  sequence: number
  transaction_id: string
  kind: 'data' | 'schema'
  base_generation: string | null
  schema_revision: number
  operation: Record<string, unknown>
  changeset: Uint8Array
  created_at: string
}

/** One committed, attributed mutation retained by the local invalidation journal. */
export interface MutationJournalEntry {
  /** Database-local monotonic sequence assigned to this journal entry. */
  sequence: number
  /** Unique transaction identity, shared with synchronization state when configured. */
  transaction_id: string
  /** ISO timestamp recorded at the mutation's commit boundary. */
  committed_at: string
  /** Structured operation context; this metadata is not a replay command. */
  operation: Record<string, unknown>
  /** Opaque consumer resource tags; `*` means that every resource may be stale. */
  resource_tags: string[]
}

/** A bounded journal page and observer state returned by `readMutationJournal`. */
export interface MutationJournalRead {
  /** Entries after the requested cursor, capped by the journal read limit. */
  entries: MutationJournalEntry[]
  /** Oldest sequence still retained, or `null` when the journal is empty. */
  oldest_sequence: number | null
  /** Latest sequence currently retained. */
  latest_sequence: number
  /** Cursor for the next page, or the latest sequence after a full refresh. */
  next_sequence: number
  /** The requested cursor is outside the retained window or the journal is unavailable. */
  full_refresh_required: boolean
  /** Current SQLite data version observed on this connection. */
  data_version: number
  /** A data-version advance without a matching journal window requires global invalidation. */
  unknown_change: boolean
}

/** Options for one atomic multi-table row mutation transaction. */
export interface SiloTransactionOptions {
  /**
   * Structured context stored in the mutation journal and synchronization outbox. Silo adds the
   * actual touched `tables` and compact `mutations` fields, replacing any values with those names.
   */
  operation?: Record<string, unknown>
}

/**
 * Validated row-mutation methods available inside `SiloDatabase.transaction()`.
 *
 * The callback is synchronous and must use this scoped surface for every write
 * that belongs to the transaction. It does not expose SQLite handles, SQL
 * execution, or Silo's internal catalog tables.
 */
export interface SiloTransaction {
  /** Insert one row or an array of rows into a user table. */
  addRows(name: string, input: unknown, upsert?: boolean): Record<string, unknown>[]
  /** Update one keyed row, optionally using `_expected_revision` for a CAS. */
  updateRow(name: string, key: unknown, input: unknown): number
  /** Delete one keyed row from a user table. */
  deleteRow(name: string, key: unknown): number
}

export class SiloError extends Error {
  readonly exitCode: number
  readonly code: string
  readonly path: string

  constructor(exitCode: number, code: string, message: string, path = '') {
    super(message)
    this.name = 'SiloError'
    this.exitCode = exitCode
    this.code = code
    this.path = path
  }
}

export const exits = {
  input: 2,
  workspace: 3,
  absent: 4,
  notFound: 5,
  schema: 6,
  constraint: 7,
  revision: 8,
  io: 9,
  integrity: 10,
} as const
