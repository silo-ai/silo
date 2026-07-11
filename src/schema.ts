import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  exits,
  SiloError,
  type ColumnDefinition,
  type IndexDefinition,
  type LogicalSchema,
  type PolicyDefinition,
  type TableDefinition,
} from './model.js'
import { canonicalize, semantic } from './registry.js'

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/
const actions = new Set(['NO ACTION', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'CASCADE'])

export function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export function validateIdentifier(name: unknown, path: string): asserts name is string {
  if (
    typeof name !== 'string' ||
    !identifier.test(name) ||
    name.toLowerCase().startsWith('_silo_')
  ) {
    throw new SiloError(
      exits.schema,
      'invalid_identifier',
      'Expected a SQLite identifier outside the reserved _silo_ namespace.',
      path,
    )
  }
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SiloError(exits.input, 'invalid_shape', 'Expected a JSON object.', path)
}

function rejectUnknown(object: Record<string, unknown>, allowed: string[], path: string): void {
  const key = Object.keys(object).find((candidate) => !allowed.includes(candidate))
  if (key)
    throw new SiloError(exits.input, 'unknown_field', `Unknown field ${key}.`, `${path}.${key}`)
}

export function parseTable(value: unknown): TableDefinition {
  assertObject(value, '$.')
  rejectUnknown(
    value,
    [
      'name',
      'comment',
      'columns',
      'primary_key',
      'foreign_keys',
      'unique_constraints',
      'indexes',
      'checks',
      'policies',
      'strict',
      'without_rowid',
    ],
    '$.',
  )
  validateIdentifier(value.name, '$.name')
  if (typeof value.comment !== 'string' || !value.comment.trim())
    throw new SiloError(
      exits.schema,
      'comment_required',
      'A non-empty table comment is required.',
      '$.comment',
    )
  if (!Array.isArray(value.columns))
    throw new SiloError(exits.input, 'invalid_shape', 'columns must be an array.', '$.columns')
  const table = value as unknown as TableDefinition
  const names = new Set<string>()
  for (const [i, column] of table.columns.entries()) {
    assertObject(column, `$.columns[${i}]`)
    rejectUnknown(
      column,
      ['name', 'type', 'type_options', 'nullable', 'default', 'comment', 'collate', 'generated'],
      `$.columns[${i}]`,
    )
    validateIdentifier(column.name, `$.columns[${i}].name`)
    if (names.has(column.name.toLowerCase()))
      throw new SiloError(
        exits.schema,
        'duplicate_column',
        'Column names are case-insensitively unique.',
        `$.columns[${i}].name`,
      )
    names.add(column.name.toLowerCase())
    if (typeof column.comment !== 'string' || !column.comment.trim())
      throw new SiloError(
        exits.schema,
        'comment_required',
        'A non-empty column comment is required.',
        `$.columns[${i}].comment`,
      )
    if (typeof column.type !== 'string')
      throw new SiloError(
        exits.schema,
        'unknown_semantic_type',
        'A semantic type is required.',
        `$.columns[${i}].type`,
      )
    semantic(column)
    if (column.default) {
      assertObject(column.default, `$.columns[${i}].default`)
      rejectUnknown(column.default, ['literal', 'expression'], `$.columns[${i}].default`)
      if (
        Number(Object.hasOwn(column.default, 'literal')) +
          Number(Object.hasOwn(column.default, 'expression')) !==
        1
      )
        throw new SiloError(
          exits.schema,
          'invalid_default',
          'A default requires exactly one literal or expression.',
          `$.columns[${i}].default`,
        )
      if (Object.hasOwn(column.default, 'literal')) canonicalize(column, column.default.literal)
    }
    if (column.generated) {
      assertObject(column.generated, `$.columns[${i}].generated`)
      rejectUnknown(column.generated, ['expression', 'storage'], `$.columns[${i}].generated`)
    }
    if (column.default && column.generated)
      throw new SiloError(
        exits.schema,
        'incompatible_features',
        'A generated column cannot have a default.',
        `$.columns[${i}]`,
      )
  }
  const has = (name: string) => names.has(name.toLowerCase())
  for (const [i, name] of (table.primary_key ?? []).entries())
    if (!has(name))
      throw new SiloError(
        exits.schema,
        'missing_column',
        'Primary-key column does not exist.',
        `$.primary_key[${i}]`,
      )
  for (const [i, foreign] of (table.foreign_keys ?? []).entries()) {
    assertObject(foreign, `$.foreign_keys[${i}]`)
    rejectUnknown(
      foreign,
      ['columns', 'references', 'on_update', 'on_delete', 'deferrable', 'initially_deferred'],
      `$.foreign_keys[${i}]`,
    )
    assertObject(foreign.references, `$.foreign_keys[${i}].references`)
    rejectUnknown(foreign.references, ['table', 'columns'], `$.foreign_keys[${i}].references`)
    if (!foreign.columns?.length || foreign.columns.length !== foreign.references?.columns?.length)
      throw new SiloError(
        exits.schema,
        'invalid_foreign_key',
        'Foreign-key column lists must be non-empty and have equal length.',
        `$.foreign_keys[${i}]`,
      )
    for (const name of foreign.columns)
      if (!has(name))
        throw new SiloError(
          exits.schema,
          'missing_column',
          'Foreign-key column does not exist.',
          `$.foreign_keys[${i}].columns`,
        )
    validateIdentifier(foreign.references.table, `$.foreign_keys[${i}].references.table`)
    for (const name of foreign.references.columns)
      validateIdentifier(name, `$.foreign_keys[${i}].references.columns`)
    for (const action of [foreign.on_update, foreign.on_delete])
      if (action && !actions.has(action))
        throw new SiloError(
          exits.schema,
          'invalid_foreign_key_action',
          `${action} is not a SQLite foreign-key action.`,
          `$.foreign_keys[${i}]`,
        )
  }
  for (const [i, unique] of (table.unique_constraints ?? []).entries()) {
    assertObject(unique, `$.unique_constraints[${i}]`)
    rejectUnknown(unique, ['name', 'columns'], `$.unique_constraints[${i}]`)
    if (!Array.isArray(unique.columns) || !unique.columns.length)
      throw new SiloError(
        exits.schema,
        'invalid_unique',
        'Unique constraints require columns.',
        `$.unique_constraints[${i}].columns`,
      )
    for (const column of unique.columns)
      if (!has(column))
        throw new SiloError(
          exits.schema,
          'missing_column',
          'Unique column does not exist.',
          `$.unique_constraints[${i}].columns`,
        )
  }
  for (const [i, index] of (table.indexes ?? []).entries()) {
    assertObject(index, `$.indexes[${i}]`)
    rejectUnknown(index, ['name', 'columns', 'unique', 'where', 'comment'], `$.indexes[${i}]`)
    if (!Array.isArray(index.columns) || !index.columns.length)
      throw new SiloError(
        exits.schema,
        'invalid_index',
        'Indexes require columns or expressions.',
        `$.indexes[${i}].columns`,
      )
    for (const [j, part] of index.columns.entries()) {
      assertObject(part, `$.indexes[${i}].columns[${j}]`)
      rejectUnknown(
        part,
        ['column', 'expression', 'direction', 'collate'],
        `$.indexes[${i}].columns[${j}]`,
      )
      if (typeof part.column === 'string' && !has(part.column))
        throw new SiloError(
          exits.schema,
          'missing_column',
          'Indexed column does not exist.',
          `$.indexes[${i}].columns[${j}].column`,
        )
    }
  }
  for (const [i, check] of (table.checks ?? []).entries()) {
    assertObject(check, `$.checks[${i}]`)
    rejectUnknown(check, ['name', 'expression', 'comment'], `$.checks[${i}]`)
    if (!check.expression)
      throw new SiloError(
        exits.schema,
        'invalid_check',
        'Check expression is required.',
        `$.checks[${i}].expression`,
      )
  }
  if (table.without_rowid && !table.primary_key?.length)
    throw new SiloError(
      exits.schema,
      'without_rowid_requires_key',
      'WITHOUT ROWID requires a primary key.',
      '$.without_rowid',
    )
  validatePolicies(table, has)
  return structuredClone(table)
}

function validatePolicies(table: TableDefinition, has: (name: string) => boolean): void {
  const seen = new Set<string>()
  for (const [i, policy] of (table.policies ?? []).entries()) {
    if (!policy || typeof policy !== 'object' || typeof policy.type !== 'string')
      throw new SiloError(
        exits.schema,
        'invalid_policy',
        'A policy type is required.',
        `$.policies[${i}]`,
      )
    if (seen.has(policy.type))
      throw new SiloError(
        exits.schema,
        'duplicate_policy',
        'A policy may be configured once per table.',
        `$.policies[${i}]`,
      )
    seen.add(policy.type)
    const fields: Record<string, string[]> = {
      generated_identity: ['type', 'column', 'strategy'],
      timestamps: ['type', 'created_column', 'updated_column'],
      optimistic_revision: ['type', 'column', 'initial'],
      immutable_rows: ['type'],
      immutable_columns: ['type', 'columns'],
      append_only: ['type'],
      natural_key_upsert: ['type', 'columns', 'update_columns'],
    }
    rejectUnknown(policy, fields[policy.type] ?? ['type'], `$.policies[${i}]`)
    const required = (key: string) => {
      if (typeof policy[key] !== 'string' || !has(policy[key] as string))
        throw new SiloError(
          exits.schema,
          'policy_precondition',
          `Policy requires an existing ${key}.`,
          `$.policies[${i}].${key}`,
        )
    }
    if (policy.type === 'generated_identity') {
      required('column')
      if (!new Set(['integer', 'uuid', 'ulid']).has(policy.strategy as string))
        throw new SiloError(
          exits.schema,
          'invalid_identity_strategy',
          'Identity strategy must be integer, uuid, or ulid.',
          `$.policies[${i}].strategy`,
        )
      if (
        policy.strategy === 'integer' &&
        (table.primary_key?.length !== 1 || table.primary_key[0] !== policy.column)
      )
        throw new SiloError(
          exits.schema,
          'policy_precondition',
          "Integer identity must be the table's single primary key.",
          `$.policies[${i}]`,
        )
      const column = table.columns.find((item) => item.name === policy.column)!
      if (policy.strategy === 'integer' && column.type !== 'integer')
        throw new SiloError(
          exits.schema,
          'policy_precondition',
          'Integer identity requires the integer type.',
          `$.policies[${i}].column`,
        )
      if (
        (policy.strategy === 'uuid' && column.type !== 'text/uuid') ||
        (policy.strategy === 'ulid' && column.type !== 'text/ulid')
      )
        throw new SiloError(
          exits.schema,
          'policy_precondition',
          `${policy.strategy} identity requires its matching semantic type.`,
          `$.policies[${i}].column`,
        )
    } else if (policy.type === 'timestamps') {
      if (policy.created_column) required('created_column')
      if (policy.updated_column) required('updated_column')
      if (!policy.created_column && !policy.updated_column)
        throw new SiloError(
          exits.schema,
          'policy_precondition',
          'timestamps requires a created_column or updated_column.',
          `$.policies[${i}]`,
        )
      for (const key of ['created_column', 'updated_column'] as const)
        if (
          policy[key] &&
          table.columns.find((item) => item.name === policy[key])!.type !== 'text/datetime'
        )
          throw new SiloError(
            exits.schema,
            'policy_precondition',
            `timestamps ${key} requires text/datetime.`,
            `$.policies[${i}].${key}`,
          )
    } else if (policy.type === 'optimistic_revision') {
      required('column')
      if (!table.columns.find((item) => item.name === policy.column)!.type.startsWith('integer'))
        throw new SiloError(
          exits.schema,
          'policy_precondition',
          'Optimistic revision requires an integer column.',
          `$.policies[${i}].column`,
        )
    } else if (policy.type === 'immutable_columns') {
      if (!Array.isArray(policy.columns) || !(policy.columns as unknown[]).length)
        throw new SiloError(
          exits.schema,
          'policy_precondition',
          'immutable_columns requires columns.',
          `$.policies[${i}].columns`,
        )
      for (const column of policy.columns as string[])
        if (!has(column))
          throw new SiloError(
            exits.schema,
            'policy_precondition',
            'Immutable column does not exist.',
            `$.policies[${i}].columns`,
          )
    } else if (policy.type === 'natural_key_upsert') {
      if (!Array.isArray(policy.columns) || !(policy.columns as unknown[]).length)
        throw new SiloError(
          exits.schema,
          'policy_precondition',
          'natural_key_upsert requires columns.',
          `$.policies[${i}].columns`,
        )
      for (const column of policy.columns as string[])
        if (!has(column))
          throw new SiloError(
            exits.schema,
            'policy_precondition',
            'Natural-key column does not exist.',
            `$.policies[${i}].columns`,
          )
      for (const column of (policy.update_columns as string[] | undefined) ?? [])
        if (!has(column))
          throw new SiloError(
            exits.schema,
            'policy_precondition',
            'Natural-key update column does not exist.',
            `$.policies[${i}].update_columns`,
          )
      const key = policy.columns as string[]
      const targets = [
        table.primary_key ?? [],
        ...(table.unique_constraints ?? []).map((item) => item.columns),
      ]
      if (
        !targets.some(
          (columns) =>
            columns.length === key.length &&
            columns.every((column, position) => column === key[position]),
        )
      )
        throw new SiloError(
          exits.schema,
          'policy_precondition',
          'Natural-key upsert columns must exactly match a primary key or unique constraint.',
          `$.policies[${i}].columns`,
        )
    } else if (policy.type !== 'immutable_rows' && policy.type !== 'append_only') {
      throw new SiloError(
        exits.schema,
        'unknown_policy',
        `${policy.type} is not registered.`,
        `$.policies[${i}].type`,
      )
    }
  }
  if (seen.has('append_only') && seen.has('immutable_rows'))
    throw new SiloError(
      exits.schema,
      'incompatible_policies',
      'append_only and immutable_rows are redundant and cannot be combined.',
      '$.policies',
    )
  if (
    (seen.has('append_only') || seen.has('immutable_rows')) &&
    (seen.has('optimistic_revision') || seen.has('natural_key_upsert'))
  )
    throw new SiloError(
      exits.schema,
      'incompatible_policies',
      'Immutable and append-only rows cannot use update-oriented policies.',
      '$.policies',
    )
  if (
    (seen.has('append_only') || seen.has('immutable_rows')) &&
    seen.has('timestamps') &&
    table.policies?.find((item) => item.type === 'timestamps')?.updated_column
  )
    throw new SiloError(
      exits.schema,
      'incompatible_policies',
      'An updated timestamp cannot be combined with an immutable or append-only row.',
      '$.policies',
    )
  const immutable = table.policies?.find((item) => item.type === 'immutable_columns')
  if (immutable) {
    const managed = [
      table.policies?.find((item) => item.type === 'timestamps')?.updated_column,
      table.policies?.find((item) => item.type === 'optimistic_revision')?.column,
    ].filter(Boolean)
    if ((immutable.columns as string[]).some((column) => managed.includes(column)))
      throw new SiloError(
        exits.schema,
        'incompatible_policies',
        'CLI-managed update columns cannot also be immutable.',
        '$.policies',
      )
  }
}

function literal(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`
  throw new SiloError(
    exits.schema,
    'invalid_default',
    'Default literal must be a JSON scalar.',
    'default.literal',
  )
}

function columnSql(column: ColumnDefinition, table: TableDefinition): string {
  const type = semantic(column)
  const integerIdentity = (table.policies ?? []).some(
    (p) => p.type === 'generated_identity' && p.column === column.name && p.strategy === 'integer',
  )
  const pieces = [quote(column.name), integerIdentity ? 'INTEGER PRIMARY KEY' : type.storage]
  if (column.collate) {
    validateIdentifier(column.collate, `${column.name}.collate`)
    pieces.push(`COLLATE ${quote(column.collate)}`)
  }
  if (column.generated)
    pieces.push(
      `GENERATED ALWAYS AS (${column.generated.expression}) ${column.generated.storage ?? 'VIRTUAL'}`,
    )
  if (column.nullable === false && !integerIdentity) pieces.push('NOT NULL')
  if (column.default) {
    if (Object.hasOwn(column.default, 'literal'))
      pieces.push(`DEFAULT ${literal(canonicalize(column, column.default.literal))}`)
    else if (column.default.expression) pieces.push(`DEFAULT (${column.default.expression})`)
  }
  const check = type.check?.(quote(column.name), column)
  if (check) pieces.push(`CHECK (${check})`)
  if (column.type === 'text/enum')
    pieces.push(
      `CHECK (${quote(column.name)} IN (${(column.type_options!.values as string[]).map(literal).join(', ')}))`,
    )
  return pieces.join(' ')
}

function generatedName(table: string, kind: string, index: number): string {
  return `_silo_${table}_${kind}_${index}`
}

function indexSql(table: TableDefinition, index: IndexDefinition, position: number): string {
  if (index.name) validateIdentifier(index.name, `${table.name}.indexes[${position}].name`)
  // Logical index names are table-scoped, so physical names include an unambiguous table prefix.
  const logicalName = index.name ?? String(position)
  const name = `_silo_idx_${table.name.length}_${table.name}_${logicalName}`
  const parts = index.columns.map((part) => {
    if (part.column) validateIdentifier(part.column, `${table.name}.indexes[${position}].columns`)
    if (!part.column && !part.expression)
      throw new SiloError(
        exits.schema,
        'invalid_index',
        'Index part requires column or expression.',
        `${table.name}.indexes[${position}].columns`,
      )
    return `${part.column ? quote(part.column) : `(${part.expression})`}${part.collate ? ` COLLATE ${quote(part.collate)}` : ''}${part.direction ? ` ${part.direction}` : ''}`
  })
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(name)} ON ${quote(table.name)} (${parts.join(', ')})${index.where ? ` WHERE ${index.where}` : ''};`
}

export function compileTable(table: TableDefinition): string[] {
  const integerIdentity = (table.policies ?? []).some(
    (p) => p.type === 'generated_identity' && p.strategy === 'integer',
  )
  const constraints: string[] = []
  if (table.primary_key?.length && !integerIdentity)
    constraints.push(`PRIMARY KEY (${table.primary_key.map(quote).join(', ')})`)
  for (const unique of table.unique_constraints ?? []) {
    if (unique.name) validateIdentifier(unique.name, `${table.name}.unique_constraints.name`)
    constraints.push(
      `${unique.name ? `CONSTRAINT ${quote(unique.name)} ` : ''}UNIQUE (${unique.columns.map(quote).join(', ')})`,
    )
  }
  for (const check of table.checks ?? [])
    constraints.push(
      `${check.name ? `CONSTRAINT ${quote(check.name)} ` : ''}CHECK (${check.expression})`,
    )
  for (const fk of table.foreign_keys ?? [])
    constraints.push(
      `FOREIGN KEY (${fk.columns.map(quote).join(', ')}) REFERENCES ${quote(fk.references.table)} (${fk.references.columns.map(quote).join(', ')})${fk.on_update ? ` ON UPDATE ${fk.on_update}` : ''}${fk.on_delete ? ` ON DELETE ${fk.on_delete}` : ''}${fk.deferrable ? ` DEFERRABLE${fk.initially_deferred ? ' INITIALLY DEFERRED' : ''}` : ''}`,
    )
  const body = [...table.columns.map((column) => columnSql(column, table)), ...constraints].join(
    ',\n  ',
  )
  const options = [
    table.strict !== false ? 'STRICT' : '',
    table.without_rowid ? 'WITHOUT ROWID' : '',
  ]
    .filter(Boolean)
    .join(', ')
  const statements = [
    `CREATE TABLE ${quote(table.name)} (\n  ${body}\n)${options ? ` ${options}` : ''};`,
  ]
  for (const [i, index] of (table.indexes ?? []).entries())
    statements.push(indexSql(table, index, i))
  for (const [i, unique] of (table.unique_constraints ?? []).entries()) {
    // The table constraint enforces uniqueness; no duplicate physical index is needed.
    void i
    void unique
  }
  statements.push(...compilePolicyTriggers(table))
  return statements
}

function compilePolicyTriggers(table: TableDefinition): string[] {
  const result: string[] = []
  for (const [i, policy] of (table.policies ?? []).entries()) {
    const name = generatedName(table.name, policy.type, i)
    if (policy.type === 'append_only' || policy.type === 'immutable_rows') {
      result.push(
        `CREATE TRIGGER ${quote(`${name}_update`)} BEFORE UPDATE ON ${quote(table.name)} BEGIN SELECT RAISE(ABORT, '${policy.type} forbids updates'); END;`,
      )
      result.push(
        `CREATE TRIGGER ${quote(`${name}_delete`)} BEFORE DELETE ON ${quote(table.name)} BEGIN SELECT RAISE(ABORT, '${policy.type} forbids deletes'); END;`,
      )
    } else if (policy.type === 'immutable_columns') {
      const changed = (policy.columns as string[])
        .map((column) => `OLD.${quote(column)} IS NOT NEW.${quote(column)}`)
        .join(' OR ')
      result.push(
        `CREATE TRIGGER ${quote(name)} BEFORE UPDATE ON ${quote(table.name)} WHEN ${changed} BEGIN SELECT RAISE(ABORT, 'immutable column changed'); END;`,
      )
    } else if (policy.type === 'timestamps' && policy.updated_column) {
      const column = quote(policy.updated_column as string)
      const locator = table.without_rowid
        ? table.primary_key!.map((key) => `${quote(key)} = NEW.${quote(key)}`).join(' AND ')
        : 'rowid = NEW.rowid'
      result.push(
        `CREATE TRIGGER ${quote(name)} AFTER UPDATE ON ${quote(table.name)} WHEN NEW.${column} IS OLD.${column} BEGIN UPDATE ${quote(table.name)} SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE ${locator}; END;`,
      )
    }
  }
  return result
}

export function compileSchema(schema: LogicalSchema): string[] {
  return schema.tables.flatMap(compileTable)
}

export function validateCompiledSchema(schema: LogicalSchema): void {
  const names = new Set<string>()
  for (const [i, table] of schema.tables.entries()) {
    const key = table.name.toLowerCase()
    if (names.has(key))
      throw new SiloError(
        exits.schema,
        'duplicate_table',
        'Table names are case-insensitively unique.',
        `$.tables[${i}].name`,
      )
    names.add(key)
  }
  for (const [i, table] of schema.tables.entries())
    for (const [j, foreign] of (table.foreign_keys ?? []).entries()) {
      const target = schema.tables.find(
        (candidate) => candidate.name.toLowerCase() === foreign.references.table.toLowerCase(),
      )
      if (!target)
        throw new SiloError(
          exits.schema,
          'missing_referenced_table',
          `${foreign.references.table} does not exist.`,
          `$.tables[${i}].foreign_keys[${j}]`,
        )
      for (const column of foreign.references.columns)
        if (
          !target.columns.some((candidate) => candidate.name.toLowerCase() === column.toLowerCase())
        )
          throw new SiloError(
            exits.schema,
            'missing_referenced_column',
            `${column} does not exist on ${target.name}.`,
            `$.tables[${i}].foreign_keys[${j}]`,
          )
      const targets = [
        target.primary_key ?? [],
        ...(target.unique_constraints ?? []).map((item) => item.columns),
      ]
      if (
        !targets.some(
          (columns) =>
            columns.length === foreign.references.columns.length &&
            columns.every((column, position) => column === foreign.references.columns[position]),
        )
      )
        throw new SiloError(
          exits.schema,
          'invalid_foreign_key_target',
          'Referenced columns must exactly match a primary key or unique constraint.',
          `$.tables[${i}].foreign_keys[${j}]`,
        )
    }
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('PRAGMA foreign_keys=ON;')
    database.exec(compileSchema(schema).join('\n'))
    const check = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown>
    if (!Object.values(check).includes('ok')) throw new Error('integrity_check did not return ok')
  } catch (error) {
    throw new SiloError(
      exits.schema,
      'sqlite_compile_error',
      error instanceof Error ? error.message : String(error),
      '$.',
    )
  } finally {
    database.close()
  }
}

export function policy(
  table: TableDefinition,
  type: PolicyDefinition['type'],
): PolicyDefinition | undefined {
  return table.policies?.find((candidate) => candidate.type === type)
}

export function generatedValue(strategy: unknown): string {
  if (strategy === 'uuid') return randomUUID().toLowerCase()
  if (strategy === 'ulid') {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    let time = Date.now()
    let result = ''
    for (let i = 0; i < 10; i++) {
      result = alphabet[time % 32] + result
      time = Math.floor(time / 32)
    }
    for (let i = 0; i < 16; i++) result += alphabet[Math.floor(Math.random() * 32)]
    return result
  }
  throw new SiloError(
    exits.schema,
    'invalid_identity_strategy',
    'Generated identity strategy must be uuid, ulid, or integer.',
    'policy.strategy',
  )
}
