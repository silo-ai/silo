import type { DatabaseSync } from 'node:sqlite'
import { exits, SiloError } from './model.js'
import { table as markdownTable } from './markdown.js'
import {
  bindSavedQuery,
  executeReadOnlyQuery,
  validateQueryName,
  type QueryResult,
  type StoredQuery,
} from './query.js'

const slotPattern = /\{\{silo-query:([a-z][a-z0-9_-]*)\}\}/g
const queryName = /^[a-z][a-z0-9_-]*$/
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const resultLimit = 500

interface ReportQueryBase {
  name: string
  empty_markdown?: string
}

export interface InlineReportQueryDefinition extends ReportQueryBase {
  sql: string
}

export interface SavedReportQueryDefinition extends ReportQueryBase {
  saved_query: string
  parameters?: Record<string, unknown> | unknown[]
}

export type ReportQueryDefinition = InlineReportQueryDefinition | SavedReportQueryDefinition

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
      'queries must contain at least one report query.',
      '$.queries',
    )

  const names = new Set<string>()
  const queries = value.queries.map((candidate, index): ReportQueryDefinition => {
    const path = `$.queries[${index}]`
    object(candidate, path)
    knownFields(candidate, ['name', 'sql', 'saved_query', 'parameters', 'empty_markdown'], path)
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
    const inline = Object.hasOwn(candidate, 'sql')
    const saved = Object.hasOwn(candidate, 'saved_query')
    if (Number(inline) + Number(saved) !== 1)
      throw new SiloError(
        exits.input,
        'invalid_report_query_source',
        'A report query requires exactly one of sql or saved_query.',
        path,
      )
    if (inline && (typeof candidate.sql !== 'string' || !candidate.sql.trim()))
      throw new SiloError(
        exits.input,
        'invalid_report_query',
        'sql must be non-empty.',
        `${path}.sql`,
      )
    if (inline && Object.hasOwn(candidate, 'parameters'))
      throw new SiloError(
        exits.input,
        'inline_report_query_parameters',
        'parameters can only bind a saved_query reference.',
        `${path}.parameters`,
      )
    if (saved) validateQueryName(candidate.saved_query, `${path}.saved_query`)
    if (
      saved &&
      candidate.parameters !== undefined &&
      (!candidate.parameters || typeof candidate.parameters !== 'object')
    )
      throw new SiloError(
        exits.input,
        'invalid_report_query_parameters',
        'parameters must be an object for named queries or an array for positional queries.',
        `${path}.parameters`,
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
    const empty =
      candidate.empty_markdown === undefined
        ? {}
        : { empty_markdown: candidate.empty_markdown as string }
    return inline
      ? { name: candidate.name, sql: candidate.sql as string, ...empty }
      : {
          name: candidate.name,
          saved_query: candidate.saved_query as string,
          ...(candidate.parameters === undefined
            ? {}
            : {
                parameters: structuredClone(candidate.parameters) as
                  | Record<string, unknown>
                  | unknown[],
              }),
          ...empty,
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
        `Report query ${name} has no template slot.`,
        '$.queries',
      )

  return { slug: value.slug, title: value.title.trim(), markdown: value.markdown, queries }
}

function runQuery(
  database: DatabaseSync,
  query: ReportQueryDefinition,
  index: number,
  resolve: (name: string) => StoredQuery,
): string {
  const path = `$.queries[${index}]`
  let result: QueryResult
  if ('sql' in query)
    result = executeReadOnlyQuery(database, query.sql, undefined, [], `${path}.sql`)
  else {
    // References deliberately resolve on every refresh. Stored bindings remain provenance,
    // while the reusable query's current SQL and semantic contract remain authoritative.
    const saved = resolve(query.saved_query)
    const input = query.parameters ?? (saved.parameter_style === 'named' ? {} : [])
    const bindings = bindSavedQuery(saved, input)
    result = executeReadOnlyQuery(
      database,
      saved.sql,
      bindings.named,
      bindings.positional,
      `${path}.saved_query`,
    )
  }
  const rendered = result.rows.length
    ? markdownTable(result.columns, result.rows)
    : (query.empty_markdown ?? '_No rows._')
  return result.truncated ? `${rendered}\n\n> Results truncated to ${resultLimit} rows.` : rendered
}

export function renderReport(
  database: DatabaseSync,
  definition: ReportDefinition,
  resolve: (name: string) => StoredQuery,
): string {
  const results = new Map(
    definition.queries.map((query, index) => [
      query.name,
      runQuery(database, query, index, resolve),
    ]),
  )
  return definition.markdown.replace(slotPattern, (_, name: string) => results.get(name)!)
}
