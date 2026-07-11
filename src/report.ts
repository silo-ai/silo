import { constants, type DatabaseSync } from 'node:sqlite'
import { exits, SiloError } from './model.js'
import { table as markdownTable } from './markdown.js'

const slotPattern = /\{\{silo-query:([a-z][a-z0-9_-]*)\}\}/g
const queryName = /^[a-z][a-z0-9_-]*$/
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const resultLimit = 500

export interface ReportQueryDefinition {
  name: string
  sql: string
  empty_markdown?: string
}

export interface ReportDefinition {
  slug: string
  title: string
  markdown: string
  queries: ReportQueryDefinition[]
}

export interface StoredReport extends ReportDefinition {
  rendered_markdown: string
  created_at: string
  updated_at: string
  refreshed_at: string
  last_refresh_attempt_at: string
  last_refresh_error: string | null
}

export interface ReportSummary {
  slug: string
  title: string
  refreshed_at: string
  last_refresh_attempt_at: string
  last_refresh_error: string | null
}

function object(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SiloError(exits.input, 'invalid_shape', 'Expected a JSON object.', path)
}

function knownFields(value: Record<string, unknown>, allowed: string[], path: string): void {
  const key = Object.keys(value).find((candidate) => !allowed.includes(candidate))
  if (key)
    throw new SiloError(exits.input, 'unknown_field', `Unknown field ${key}.`, `${path}.${key}`)
}

export function validateReportSlug(value: unknown, path = '$.slug'): asserts value is string {
  if (typeof value !== 'string' || !slug.test(value))
    throw new SiloError(
      exits.input,
      'invalid_report_slug',
      'Expected a lowercase slug containing letters, digits, and single hyphens.',
      path,
    )
}

export function parseReportDefinition(value: unknown): ReportDefinition {
  object(value, '$')
  knownFields(value, ['slug', 'title', 'markdown', 'queries'], '$')
  validateReportSlug(value.slug)
  if (typeof value.title !== 'string' || !value.title.trim())
    throw new SiloError(exits.input, 'invalid_report_title', 'title must be non-empty.', '$.title')
  if (typeof value.markdown !== 'string' || !value.markdown.trim())
    throw new SiloError(
      exits.input,
      'invalid_report_markdown',
      'markdown must be non-empty.',
      '$.markdown',
    )
  if (!Array.isArray(value.queries) || !value.queries.length)
    throw new SiloError(
      exits.input,
      'invalid_report_queries',
      'queries must contain at least one saved query.',
      '$.queries',
    )

  const names = new Set<string>()
  const queries = value.queries.map((candidate, index): ReportQueryDefinition => {
    const path = `$.queries[${index}]`
    object(candidate, path)
    knownFields(candidate, ['name', 'sql', 'empty_markdown'], path)
    if (typeof candidate.name !== 'string' || !queryName.test(candidate.name))
      throw new SiloError(
        exits.input,
        'invalid_report_query_name',
        'Query names must start with a lowercase letter and contain lowercase letters, digits, underscores, or hyphens.',
        `${path}.name`,
      )
    if (names.has(candidate.name))
      throw new SiloError(
        exits.input,
        'duplicate_report_query',
        `Duplicate query name ${candidate.name}.`,
        `${path}.name`,
      )
    names.add(candidate.name)
    if (typeof candidate.sql !== 'string' || !candidate.sql.trim())
      throw new SiloError(
        exits.input,
        'invalid_report_query',
        'sql must be non-empty.',
        `${path}.sql`,
      )
    if (
      candidate.empty_markdown !== undefined &&
      (typeof candidate.empty_markdown !== 'string' || !candidate.empty_markdown.trim())
    )
      throw new SiloError(
        exits.input,
        'invalid_empty_markdown',
        'empty_markdown must be a non-empty Markdown string when supplied.',
        `${path}.empty_markdown`,
      )
    return {
      name: candidate.name,
      sql: candidate.sql,
      ...(candidate.empty_markdown === undefined
        ? {}
        : { empty_markdown: candidate.empty_markdown }),
    }
  })

  const referenced = new Set<string>()
  for (const match of value.markdown.matchAll(slotPattern)) referenced.add(match[1]!)
  const withoutValidSlots = value.markdown.replace(slotPattern, '')
  if (withoutValidSlots.includes('{{silo-query:'))
    throw new SiloError(
      exits.input,
      'invalid_report_slot',
      'Query slots must use {{silo-query:name}} with a valid query name.',
      '$.markdown',
    )
  for (const name of referenced)
    if (!names.has(name))
      throw new SiloError(
        exits.input,
        'unknown_report_query',
        `The template references unknown query ${name}.`,
        '$.markdown',
      )
  for (const name of names)
    if (!referenced.has(name))
      throw new SiloError(
        exits.input,
        'unused_report_query',
        `Saved query ${name} has no template slot.`,
        '$.queries',
      )

  return { slug: value.slug, title: value.title.trim(), markdown: value.markdown, queries }
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

function assertSingleStatement(sql: string, path: string): void {
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
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '[') {
      quote = ']'
    } else if (char === ';' && meaningfulSql(sql.slice(index + 1))) {
      throw new SiloError(
        exits.input,
        'multiple_report_statements',
        'A saved query must contain exactly one SQLite statement.',
        path,
      )
    }
  }
}

function runQuery(database: DatabaseSync, query: ReportQueryDefinition, index: number): string {
  const path = `$.queries[${index}].sql`
  assertSingleStatement(query.sql, path)
  try {
    const statement = database.prepare(query.sql)
    statement.setReturnArrays(true)
    const rawColumns = statement.columns().map((column) => column.name || 'column')
    if (!rawColumns.length)
      throw new SiloError(
        exits.input,
        'report_query_has_no_columns',
        'A saved query must return result columns.',
        path,
      )
    const seen = new Map<string, number>()
    const columns = rawColumns.map((name) => {
      const count = (seen.get(name) ?? 0) + 1
      seen.set(name, count)
      return count === 1 ? name : `${name}_${count}`
    })
    const rows: unknown[][] = []
    let truncated = false
    for (const row of statement.iterate() as Iterable<unknown[]>) {
      if (rows.length === resultLimit) {
        truncated = true
        break
      }
      rows.push(row)
    }
    const rendered = rows.length
      ? markdownTable(columns, rows)
      : (query.empty_markdown ?? '_No rows._')
    return truncated ? `${rendered}\n\n> Results truncated to ${resultLimit} rows.` : rendered
  } catch (error) {
    if (error instanceof SiloError) throw error
    throw new SiloError(
      exits.input,
      'invalid_report_query',
      error instanceof Error ? error.message : String(error),
      path,
    )
  }
}

export function renderReport(database: DatabaseSync, definition: ReportDefinition): string {
  const allowed = new Set([
    constants.SQLITE_SELECT,
    constants.SQLITE_READ,
    constants.SQLITE_FUNCTION,
    constants.SQLITE_RECURSIVE,
  ])
  // Saved SQL runs on the writer used to atomically publish its rendering. The authorizer is
  // therefore the security boundary: allow result computation, but never connection or Silo state.
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
    const results = new Map(
      definition.queries.map((query, index) => [query.name, runQuery(database, query, index)]),
    )
    return definition.markdown.replace(slotPattern, (_, name: string) => results.get(name)!)
  } finally {
    database.setAuthorizer(null)
  }
}
