export type SQLiteStorage = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'

export type Literal = string | number | boolean | null

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

export interface LogicalSchema {
  format_version: 1
  registry_version: 1
  revision: number
  tables: TableDefinition[]
  template?: { name: string; instantiated_at: string }
}

export interface TemplateSchema {
  format_version?: 1
  tables: TableDefinition[]
}

export interface DatabaseMetadata {
  identity: string
  original_origin: string
  created_at: string
  updated_at: string
  format_version: number
  tool_version: string
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
