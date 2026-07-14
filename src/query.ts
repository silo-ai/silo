import { constants, type DatabaseSync } from 'node:sqlite'
import { exits, SiloError, type ColumnDefinition } from './model.js'
import { canonicalize, semantic } from './registry.js'

const queryName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const parameterName = /^[a-z][a-z0-9_]*$/
const resultLimit = 500
export const reservedQueryNames = ['put', 'list', 'show', 'delete'] as const

export type QueryParameterStyle = 'named' | 'positional'

export interface SavedQueryParameter {
  name: string
  type: string
  type_options?: Record<string, unknown>
  description: string
  default?: unknown
}

export interface SavedQueryDefinition {
  name: string
  description: string
  sql: string
  parameter_style: QueryParameterStyle
  parameters: SavedQueryParameter[]
}

export interface StoredQuery extends SavedQueryDefinition {
  created_at: string
  updated_at: string
}

export interface SavedQuerySummary {
  name: string
  description: string
  parameter_style: QueryParameterStyle
  parameters: number
  updated_at: string
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
}

export type QueryBinding = null | number | bigint | string | Uint8Array

function object(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SiloError(exits.input, 'invalid_shape', 'Expected a JSON object.', path)
}

function knownFields(value: Record<string, unknown>, allowed: string[], path: string): void {
  const key = Object.keys(value).find((candidate) => !allowed.includes(candidate))
  if (key)
    throw new SiloError(exits.input, 'unknown_field', `Unknown field ${key}.`, `${path}.${key}`)
}

function hasDefault(parameter: SavedQueryParameter): boolean {
  return Object.prototype.hasOwnProperty.call(parameter, 'default')
}

function column(parameter: SavedQueryParameter): ColumnDefinition {
  return {
    name: parameter.name,
    type: parameter.type,
    ...(parameter.type_options === undefined ? {} : { type_options: parameter.type_options }),
    nullable: false,
    comment: parameter.description,
  }
}

export function validateQueryName(value: unknown, path = '$.name'): asserts value is string {
  if (typeof value !== 'string' || !queryName.test(value))
    throw new SiloError(
      exits.input,
      'invalid_query_name',
      'Query names must be lowercase hyphenated names beginning with a letter.',
      path,
    )
  if ((reservedQueryNames as readonly string[]).includes(value))
    throw new SiloError(
      exits.input,
      'reserved_query_name',
      `Query name ${value} is reserved for query management.`,
      path,
    )
}

export function parseSavedQueryDefinition(value: unknown): SavedQueryDefinition {
  object(value, '$')
  knownFields(value, ['name', 'description', 'sql', 'parameter_style', 'parameters'], '$')
  validateQueryName(value.name)
  if (typeof value.description !== 'string' || !value.description.trim())
    throw new SiloError(
      exits.input,
      'invalid_query_description',
      'description must be non-empty.',
      '$.description',
    )
  if (typeof value.sql !== 'string' || !value.sql.trim())
    throw new SiloError(exits.input, 'invalid_saved_query', 'sql must be non-empty.', '$.sql')
  if (
    value.parameter_style !== undefined &&
    value.parameter_style !== 'named' &&
    value.parameter_style !== 'positional'
  )
    throw new SiloError(
      exits.input,
      'invalid_parameter_style',
      'parameter_style must be named or positional.',
      '$.parameter_style',
    )
  if (value.parameters !== undefined && !Array.isArray(value.parameters))
    throw new SiloError(
      exits.input,
      'invalid_query_parameters',
      'parameters must be an array.',
      '$.parameters',
    )

  const names = new Set<string>()
  const parameters = (value.parameters ?? []).map((candidate, index): SavedQueryParameter => {
    const path = `$.parameters[${index}]`
    object(candidate, path)
    knownFields(candidate, ['name', 'type', 'type_options', 'description', 'default'], path)
    if (typeof candidate.name !== 'string' || !parameterName.test(candidate.name))
      throw new SiloError(
        exits.input,
        'invalid_query_parameter_name',
        'Parameter names must begin with a lowercase letter and contain lowercase letters, digits, or underscores.',
        `${path}.name`,
      )
    if (candidate.name === 'help')
      throw new SiloError(
        exits.input,
        'reserved_query_parameter_name',
        'Parameter name help is reserved for query-specific CLI help.',
        `${path}.name`,
      )
    if (names.has(candidate.name))
      throw new SiloError(
        exits.input,
        'duplicate_query_parameter',
        `Duplicate parameter ${candidate.name}.`,
        `${path}.name`,
      )
    names.add(candidate.name)
    if (typeof candidate.type !== 'string' || !candidate.type)
      throw new SiloError(
        exits.input,
        'invalid_query_parameter_type',
        'type must name a registered semantic type.',
        `${path}.type`,
      )
    if (
      candidate.type_options !== undefined &&
      (!candidate.type_options ||
        typeof candidate.type_options !== 'object' ||
        Array.isArray(candidate.type_options))
    )
      throw new SiloError(
        exits.input,
        'invalid_query_parameter_options',
        'type_options must be an object.',
        `${path}.type_options`,
      )
    if (typeof candidate.description !== 'string' || !candidate.description.trim())
      throw new SiloError(
        exits.input,
        'invalid_query_parameter_description',
        'description must be non-empty.',
        `${path}.description`,
      )
    const parameter: SavedQueryParameter = {
      name: candidate.name,
      type: candidate.type,
      ...(candidate.type_options === undefined
        ? {}
        : { type_options: candidate.type_options as Record<string, unknown> }),
      description: candidate.description.trim(),
      ...(Object.prototype.hasOwnProperty.call(candidate, 'default')
        ? { default: candidate.default }
        : {}),
    }
    semantic(column(parameter))
    if (hasDefault(parameter)) canonicalizeSavedQueryValue(parameter, parameter.default)
    return parameter
  })

  const style = (value.parameter_style ?? 'named') as QueryParameterStyle
  if (style === 'positional') {
    let optional = false
    for (const [index, parameter] of parameters.entries()) {
      if (hasDefault(parameter)) optional = true
      else if (optional)
        throw new SiloError(
          exits.input,
          'required_parameter_after_default',
          'Required positional parameters cannot follow parameters with defaults.',
          `$.parameters[${index}]`,
        )
    }
  }

  return {
    name: value.name,
    description: value.description.trim(),
    sql: value.sql,
    parameter_style: style,
    parameters,
  }
}

export function decodeSavedQueryArgument(parameter: SavedQueryParameter, value: string): unknown {
  const storage = semantic(column(parameter)).storage
  let decoded: unknown = value
  if (parameter.type === 'text/json') {
    try {
      decoded = JSON.parse(value)
    } catch (error) {
      throw new SiloError(
        exits.input,
        'invalid_query_argument',
        error instanceof Error ? error.message : String(error),
        parameter.name,
      )
    }
  } else if (storage === 'INTEGER' || storage === 'REAL') {
    if (parameter.type === 'integer/boolean' && (value === 'true' || value === 'false'))
      decoded = value === 'true'
    else decoded = Number(value)
  } else if (storage === 'ANY') {
    try {
      const parsed = JSON.parse(value)
      decoded = parsed && typeof parsed === 'object' ? value : parsed
    } catch {
      decoded = value
    }
  }
  canonicalizeSavedQueryValue(parameter, decoded)
  return decoded
}

export function canonicalizeSavedQueryValue(
  parameter: SavedQueryParameter,
  value: unknown,
): QueryBinding {
  const canonical = canonicalize(column(parameter), value)
  if (
    canonical === null ||
    typeof canonical === 'number' ||
    typeof canonical === 'bigint' ||
    typeof canonical === 'string' ||
    canonical instanceof Uint8Array
  )
    return canonical
  throw new SiloError(
    exits.input,
    'unsupported_query_argument',
    'The semantic value cannot be bound to SQLite.',
    parameter.name,
  )
}

function meaningfulSql(value: string): boolean {
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    const next = value[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (char === '-' && next === '-') {
      lineComment = true
      index++
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (!/\s/.test(char)) return true
  }
  return false
}

export function assertSingleQueryStatement(sql: string, path: string): void {
  let quote: "'" | '"' | '`' | ']' | undefined
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (char === quote) {
        if (quote !== ']' && next === quote) index++
        else quote = undefined
      }
      continue
    }
    if (char === '-' && next === '-') {
      lineComment = true
      index++
    } else if (char === '/' && next === '*') {
      blockComment = true
      index++
    } else if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '[') quote = ']'
    else if (char === ';' && meaningfulSql(sql.slice(index + 1)))
      throw new SiloError(
        exits.input,
        'multiple_query_statements',
        'A saved query must contain exactly one SQLite statement.',
        path,
      )
  }
  if (!meaningfulSql(sql))
    throw new SiloError(exits.input, 'empty_query', 'A saved query must contain SQL.', path)
}

function withReadOnlyAuthorizer<T>(database: DatabaseSync, handler: () => T): T {
  const allowed = new Set([
    constants.SQLITE_SELECT,
    constants.SQLITE_READ,
    constants.SQLITE_FUNCTION,
    constants.SQLITE_RECURSIVE,
  ])
  // Reports validate on a writer and reusable queries may outlive current table permissions.
  // Keep the SQLite authorizer as the invariant: saved SQL can compute results but cannot
  // mutate state, inspect Silo internals, or call filesystem-capable extension functions.
  database.setAuthorizer((action, first, second) => {
    const resource =
      action === constants.SQLITE_READ
        ? first
        : action === constants.SQLITE_FUNCTION
          ? second
          : null
    if (
      resource &&
      (resource.startsWith('_silo_') ||
        resource.startsWith('sqlite_') ||
        ['load_extension', 'readfile', 'writefile', 'fts3_tokenizer'].includes(
          resource.toLowerCase(),
        ))
    )
      return constants.SQLITE_DENY
    return allowed.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY
  })
  try {
    return handler()
  } finally {
    database.setAuthorizer(null)
  }
}

function uniqueColumns(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    return count === 1 ? name : `${name}_${count}`
  })
}

function parameterTokens(sql: string): string[] {
  // Placeholder-like text inside literals, quoted identifiers, and comments is data rather
  // than part of the saved query's callable parameter contract.
  const tokens: string[] = []
  let quote: "'" | '"' | '`' | ']' | undefined
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (char === quote) {
        if (quote !== ']' && next === quote) index++
        else quote = undefined
      }
      continue
    }
    if (char === '-' && next === '-') {
      lineComment = true
      index++
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '[') {
      quote = ']'
      continue
    }
    if (char === '?') {
      let end = index + 1
      while (/\d/.test(sql[end] ?? '')) end++
      tokens.push(sql.slice(index, end))
      index = end - 1
      continue
    }
    if (char === ':' || char === '@' || char === '$') {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(sql.slice(index + 1))
      if (match) {
        tokens.push(`${char}${match[0]}`)
        index += match[0].length
      }
    }
  }
  return tokens
}

function validateParameterReferences(definition: SavedQueryDefinition): void {
  const tokens = parameterTokens(definition.sql)
  if (definition.parameter_style === 'named') {
    const unsupported = tokens.find((token) => !token.startsWith(':'))
    if (unsupported)
      throw new SiloError(
        exits.input,
        'invalid_named_parameter',
        'Named saved queries must use :name placeholders.',
        '$.sql',
      )
    const referenced = new Set(tokens.map((token) => token.slice(1)))
    const declared = new Set(definition.parameters.map((parameter) => parameter.name))
    const missing = [...referenced].find((name) => !declared.has(name))
    if (missing)
      throw new SiloError(
        exits.input,
        'undeclared_query_parameter',
        `SQL references undeclared parameter ${missing}.`,
        '$.sql',
      )
    const unused = [...declared].find((name) => !referenced.has(name))
    if (unused)
      throw new SiloError(
        exits.input,
        'unused_query_parameter',
        `Declared parameter ${unused} is not referenced by SQL.`,
        '$.parameters',
      )
    return
  }

  const unsupported = tokens.find((token) => !token.startsWith('?'))
  if (unsupported)
    throw new SiloError(
      exits.input,
      'invalid_positional_parameter',
      'Positional saved queries must use ? or ?N placeholders.',
      '$.sql',
    )
  const anonymous = tokens.filter((token) => token === '?')
  const numbered = tokens.filter((token) => token !== '?')
  if (anonymous.length && numbered.length)
    throw new SiloError(
      exits.input,
      'mixed_positional_parameters',
      'A saved query cannot mix ? and ?N placeholders.',
      '$.sql',
    )
  if (anonymous.length && anonymous.length !== definition.parameters.length)
    throw new SiloError(
      exits.input,
      'positional_parameter_count_mismatch',
      `SQL has ${anonymous.length} placeholders but ${definition.parameters.length} parameters are declared.`,
      '$.sql',
    )
  if (numbered.length) {
    const referenced = new Set(numbered.map((token) => Number(token.slice(1))))
    const invalid = [...referenced].find(
      (position) =>
        !Number.isSafeInteger(position) || position < 1 || position > definition.parameters.length,
    )
    const missing = definition.parameters.findIndex((_, index) => !referenced.has(index + 1))
    if (invalid !== undefined || missing !== -1)
      throw new SiloError(
        exits.input,
        'positional_parameter_count_mismatch',
        'Numbered placeholders must reference every declared parameter from ?1 through ?N.',
        '$.sql',
      )
  } else if (!anonymous.length && definition.parameters.length)
    throw new SiloError(
      exits.input,
      'unused_query_parameter',
      'Declared positional parameters are not referenced by SQL.',
      '$.parameters',
    )
}

export function validateReadOnlyQuery(
  database: DatabaseSync,
  definition: SavedQueryDefinition,
): void {
  assertSingleQueryStatement(definition.sql, '$.sql')
  validateParameterReferences(definition)
  try {
    withReadOnlyAuthorizer(database, () => {
      const statement = database.prepare(definition.sql)
      if (!statement.columns().length)
        throw new SiloError(
          exits.input,
          'query_has_no_columns',
          'A saved query must return result columns.',
          '$.sql',
        )
    })
  } catch (error) {
    if (error instanceof SiloError) throw error
    throw new SiloError(
      exits.input,
      'invalid_saved_query',
      error instanceof Error ? error.message : String(error),
      '$.sql',
    )
  }
}

export function executeReadOnlyQuery(
  database: DatabaseSync,
  sql: string,
  named: Record<string, QueryBinding> | undefined,
  positional: QueryBinding[],
  path = '$.sql',
): QueryResult {
  assertSingleQueryStatement(sql, path)
  try {
    return withReadOnlyAuthorizer(database, () => {
      const statement = database.prepare(sql)
      statement.setReturnArrays(true)
      const columns = uniqueColumns(statement.columns().map((item) => item.name || 'column'))
      if (!columns.length)
        throw new SiloError(
          exits.input,
          'query_has_no_columns',
          'A saved query must return result columns.',
          path,
        )
      const rows: unknown[][] = []
      let truncated = false
      const iterator = named ? statement.iterate(named) : statement.iterate(...positional)
      for (const row of iterator as Iterable<unknown[]>) {
        if (rows.length === resultLimit) {
          truncated = true
          break
        }
        rows.push(row)
      }
      return { columns, rows, truncated }
    })
  } catch (error) {
    if (error instanceof SiloError) throw error
    throw new SiloError(
      exits.input,
      'invalid_saved_query',
      error instanceof Error ? error.message : String(error),
      path,
    )
  }
}

export function bindSavedQuery(
  definition: SavedQueryDefinition,
  input: Record<string, unknown> | unknown[],
): { named?: Record<string, QueryBinding>; positional: QueryBinding[] } {
  if (definition.parameter_style === 'named') {
    if (Array.isArray(input))
      throw new SiloError(exits.input, 'invalid_query_arguments', 'Expected named parameters.')
    const unknown = Object.keys(input).find(
      (name) => !definition.parameters.some((parameter) => parameter.name === name),
    )
    if (unknown)
      throw new SiloError(
        exits.input,
        'unknown_query_parameter',
        `Unknown query parameter ${unknown}.`,
        unknown,
      )
    const named: Record<string, QueryBinding> = {}
    for (const parameter of definition.parameters) {
      const supplied = Object.prototype.hasOwnProperty.call(input, parameter.name)
      if (!supplied && !hasDefault(parameter))
        throw new SiloError(
          exits.input,
          'missing_query_parameter',
          `Missing query parameter ${parameter.name}.`,
          parameter.name,
        )
      named[`:${parameter.name}`] = canonicalizeSavedQueryValue(
        parameter,
        supplied ? input[parameter.name] : parameter.default,
      )
    }
    return { named, positional: [] }
  }

  if (!Array.isArray(input))
    throw new SiloError(exits.input, 'invalid_query_arguments', 'Expected positional parameters.')
  if (input.length > definition.parameters.length)
    throw new SiloError(
      exits.input,
      'too_many_query_parameters',
      `Expected at most ${definition.parameters.length} positional parameters.`,
    )
  const positional = definition.parameters.map((parameter, index) => {
    if (index >= input.length && !hasDefault(parameter))
      throw new SiloError(
        exits.input,
        'missing_query_parameter',
        `Missing positional parameter ${parameter.name}.`,
        parameter.name,
      )
    return canonicalizeSavedQueryValue(
      parameter,
      index < input.length ? input[index] : parameter.default,
    )
  })
  return { positional }
}
