import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalize, semantic } from './registry.js'
import {
  compileSchema,
  compileTable,
  generatedValue,
  parseTable,
  policy,
  quote,
  validateCompiledSchema,
} from './schema.js'
import { dataRoot, type Workspace } from './workspace.js'
import {
  exits,
  SiloError,
  type DatabaseMetadata,
  type LogicalSchema,
  type TableDefinition,
  type TemplateSchema,
} from './model.js'

const FORMAT_VERSION = 1
const TOOL_VERSION = '0.1.0'
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

function now(): string {
  return new Date().toISOString()
}

function sqliteError(error: unknown): never {
  if (error instanceof SiloError) throw error
  const message = error instanceof Error ? error.message : String(error)
  const code = /constraint|unique|foreign key|not null|check/i.test(message)
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

function initialize(database: DatabaseSync, workspace: Workspace, schema: LogicalSchema): void {
  const timestamp = now()
  database.exec(`
    CREATE TABLE _silo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE _silo_schema (id INTEGER PRIMARY KEY CHECK (id = 1), schema_json TEXT NOT NULL) STRICT;
  `)
  // This canonical document is the semantic contract; physical objects are checked compiled artifacts.
  const insert = database.prepare('INSERT INTO _silo_meta (key, value) VALUES (?, ?)')
  const values: Record<string, string> = {
    format_version: String(FORMAT_VERSION),
    registry_version: String(schema.registry_version),
    tool_version: TOOL_VERSION,
    identity: workspace.identity,
    original_origin: workspace.origin,
    created_at: timestamp,
    updated_at: timestamp,
  }
  if (schema.template) values.template_name = schema.template.name
  for (const [key, value] of Object.entries(values)) insert.run(key, value)
  database
    .prepare('INSERT INTO _silo_schema (id, schema_json) VALUES (1, ?)')
    .run(JSON.stringify(schema))
}

function metadata(database: DatabaseSync): DatabaseMetadata {
  try {
    const rows = database.prepare('SELECT key, value FROM _silo_meta ORDER BY key').all() as Array<{
      key: string
      value: string
    }>
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

function readSchema(database: DatabaseSync): LogicalSchema {
  try {
    const row = database.prepare('SELECT schema_json FROM _silo_schema WHERE id = 1').get() as
      | { schema_json: string }
      | undefined
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

export class SiloDatabase {
  readonly workspace: Workspace
  private readonly database: DatabaseSync

  private constructor(workspace: Workspace, database: DatabaseSync) {
    this.workspace = workspace
    this.database = database
  }

  static open(workspace: Workspace, writable = false): SiloDatabase {
    if (!existsSync(workspace.databasePath))
      throw new SiloError(
        exits.absent,
        'database_absent',
        'No Silo database exists for this workspace.',
      )
    try {
      const database = new DatabaseSync(workspace.databasePath, { readOnly: !writable })
      configure(database, writable)
      const meta = metadata(database)
      if (meta.identity !== workspace.identity) {
        database.close()
        throw new SiloError(
          exits.integrity,
          'identity_mismatch',
          'Database identity does not match the normalized origin.',
        )
      }
      const instance = new SiloDatabase(workspace, database)
      verifyPhysical(database, instance.getSchema())
      return instance
    } catch (error) {
      sqliteError(error)
    }
  }

  static createWithSchema(workspace: Workspace, schema: LogicalSchema): SiloDatabase {
    if (existsSync(workspace.databasePath))
      throw new SiloError(
        exits.schema,
        'database_exists',
        'A database already exists for this workspace.',
      )
    validateCompiledSchema(schema)
    mkdirSync(dirname(workspace.databasePath), { recursive: true })
    const database = new DatabaseSync(workspace.databasePath)
    try {
      configure(database, true)
      database.exec('BEGIN IMMEDIATE')
      initialize(database, workspace, schema)
      database.exec(compileSchema(schema).join('\n'))
      const instance = new SiloDatabase(workspace, database)
      instance.verify(schema)
      database.exec('COMMIT')
      return instance
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {}
      database.close()
      // SQLite opens the path before BEGIN, so remove sidecars to preserve an actually absent state.
      rmSync(workspace.databasePath, { force: true })
      rmSync(`${workspace.databasePath}-wal`, { force: true })
      rmSync(`${workspace.databasePath}-shm`, { force: true })
      sqliteError(error)
    }
  }

  close(): void {
    this.database.close()
  }
  getMetadata(): DatabaseMetadata {
    return metadata(this.database)
  }

  getSchema(): LogicalSchema {
    return readSchema(this.database)
  }

  private replaceSchema(schema: LogicalSchema): void {
    // Callers keep metadata replacement in the same transaction as the corresponding DDL.
    this.database
      .prepare('UPDATE _silo_schema SET schema_json = ? WHERE id = 1')
      .run(JSON.stringify(schema))
    this.database.prepare("UPDATE _silo_meta SET value = ? WHERE key = 'updated_at'").run(now())
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
    try {
      this.database.exec('BEGIN IMMEDIATE')
      this.database.exec(compileTable(table).join('\n'))
      this.replaceSchema(proposed)
      this.verify(proposed)
      this.database.exec('COMMIT')
      return table
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {}
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
    try {
      this.database.exec('BEGIN IMMEDIATE')
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
      this.database.exec('COMMIT')
      return candidate
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {}
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
    try {
      this.database.exec('BEGIN IMMEDIATE')
      this.database.exec(`DROP TABLE ${quote(existing.name)}`)
      this.replaceSchema(proposed)
      this.verify(proposed)
      this.database.exec('COMMIT')
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {}
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
    const results: Record<string, unknown>[] = []
    try {
      this.database.exec('BEGIN IMMEDIATE')
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new SiloError(exits.input, 'invalid_shape', 'Each row must be an object.')
        const request = raw as Record<string, unknown>
        const row = this.prepareRow(table, request, true)
        const columns = Object.keys(row)
        let sql = columns.length
          ? `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
          : `INSERT INTO ${quote(table.name)} DEFAULT VALUES`
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
          sql += ` ON CONFLICT (${keys.map(quote).join(', ')}) ${allowed.length ? `DO UPDATE SET ${allowed.map((column) => `${quote(column)} = excluded.${quote(column)}`).join(', ')}` : 'DO NOTHING'}`
        }
        sql += ` RETURNING ${table.without_rowid ? '' : 'rowid AS "_silo_rowid", '}*`
        const returned = this.database.prepare(sql).get(...Object.values(row)) as
          | Record<string, unknown>
          | undefined
        results.push(this.readPersistedRow(table, returned, naturalKeys, row))
      }
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {}
      sqliteError(error)
    }
  }

  private readPersistedRow(
    table: TableDefinition,
    returned: Record<string, unknown> | undefined,
    fallbackColumns?: string[],
    fallbackValues?: Record<string, Binding>,
  ): Record<string, unknown> {
    let where: string
    let values: Binding[]
    if (returned?._silo_rowid !== undefined) {
      where = 'rowid = ?'
      values = [binding(returned._silo_rowid)]
    } else {
      const columns = returned ? table.primary_key : fallbackColumns
      if (!columns?.length)
        throw new SiloError(
          exits.integrity,
          'persisted_row_unresolved',
          'The persisted row could not be located after mutation.',
        )
      where = columns.map((column) => `${quote(column)} = ?`).join(' AND ')
      values = columns.map((column) =>
        binding(returned ? returned[column] : fallbackValues?.[column]),
      )
    }
    const persisted = this.database
      .prepare(`SELECT * FROM ${quote(table.name)} WHERE ${where}`)
      .get(...values) as Record<string, unknown> | undefined
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
    const persisted = this.database
      .prepare(
        `SELECT * FROM ${quote(table.name)} WHERE ${columns.map((column) => `${quote(column)} = ?`).join(' AND ')}`,
      )
      .get(...columns.map((column) => source[column]!)) as Record<string, unknown> | undefined
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

  private keyWhere(table: TableDefinition, key: unknown): { sql: string; values: Binding[] } {
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
      sql: keys.map((column) => `${quote(column)} = ?`).join(' AND '),
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
    const row = this.database
      .prepare(`SELECT * FROM ${quote(table.name)} WHERE ${where.sql}`)
      .get(...where.values) as Record<string, unknown> | undefined
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
    return (
      this.database
        .prepare(`SELECT * FROM ${quote(table.name)}${order} LIMIT ? OFFSET ?`)
        .all(limit, offset) as Record<string, unknown>[]
    ).map((row) => this.renderRow(table, row))
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
    const row = this.prepareRow(table, raw, false)
    const timestamps = policy(table, 'timestamps')
    if (timestamps?.updated_column) row[timestamps.updated_column as string] = now()
    const revision = policy(table, 'optimistic_revision')
    const where = this.keyWhere(table, key)
    if (revision) {
      if (!Number.isSafeInteger(expected))
        throw new SiloError(
          exits.input,
          'expected_revision_required',
          '_expected_revision is required for this table.',
        )
      where.sql += ` AND ${quote(revision.column as string)} = ?`
      where.values.push(Number(expected))
      row[revision.column as string] = Number(expected) + 1
    }
    const columns = Object.keys(row)
    if (!columns.length)
      throw new SiloError(exits.input, 'empty_update', 'At least one field must be updated.')
    try {
      const result = this.database
        .prepare(
          `UPDATE ${quote(table.name)} SET ${columns.map((column) => `${quote(column)} = ?`).join(', ')} WHERE ${where.sql}`,
        )
        .run(...Object.values(row), ...where.values)
      if (!result.changes)
        throw new SiloError(
          revision ? exits.revision : exits.notFound,
          revision ? 'revision_conflict' : 'row_not_found',
          revision ? 'The row revision did not match.' : 'No row matches the supplied key.',
        )
      return Number(result.changes)
    } catch (error) {
      sqliteError(error)
    }
  }

  deleteRow(name: string, key: unknown): number {
    const table = this.table(name)
    const where = this.keyWhere(table, key)
    try {
      const result = this.database
        .prepare(`DELETE FROM ${quote(table.name)} WHERE ${where.sql}`)
        .run(...where.values)
      if (!result.changes)
        throw new SiloError(exits.notFound, 'row_not_found', 'No row matches the supplied key.')
      return Number(result.changes)
    } catch (error) {
      sqliteError(error)
    }
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

export function emptySchema(template?: LogicalSchema['template']): LogicalSchema {
  return {
    format_version: 1,
    registry_version: 1,
    revision: 1,
    tables: [],
    ...(template ? { template } : {}),
  }
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
  const path = join(dataRoot(), 'templates', `${name}.json`)
  if (!existsSync(path))
    throw new SiloError(exits.notFound, 'template_not_found', `${name} does not exist.`)
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as TemplateSchema
    if (!value || !Array.isArray(value.tables)) throw new Error('tables must be an array')
    const tables = value.tables.map(parseTable)
    const schema: LogicalSchema = { format_version: 1, registry_version: 1, revision: 1, tables }
    validateCompiledSchema(schema)
    return { format_version: 1, tables }
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
  const root = join(dataRoot(), 'templates')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -5))
    .sort()
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
    try {
      const database = new DatabaseSync(path, { readOnly: true })
      configure(database, false)
      const meta = metadata(database)
      identity = meta.identity
      verifyPhysical(database, readSchema(database))
      database.close()
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
    }
  })
}
