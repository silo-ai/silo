import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { exits, SiloError } from './model.js'
import { table as markdownTable } from './markdown.js'
import {
  bindSavedQuery,
  executeReadOnlyQuery,
  validateQueryName,
  type QueryBinding,
  type QueryResult,
  type StoredQuery,
} from './query.js'
import type { Workspace } from './workspace.js'

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

/** @deprecated Use {@link ScriptedReportDefinition}. */
export interface LegacyReportDefinition {
  slug: string
  title: string
  markdown: string
  queries: ReportQueryDefinition[]
}

export interface ScriptedReportDefinition {
  slug: string
  title: string
  /**
   * A synchronous JavaScript function body. The script receives `silo`, `markdown`, and `require`
   * arguments and must return the rendered Markdown string.
   */
  script: string
}

export type ReportDefinition = ScriptedReportDefinition | LegacyReportDefinition

interface StoredReportMetadata {
  rendered_markdown: string
  created_at: string
  updated_at: string
  refreshed_at: string
  last_refresh_attempt_at: string
  last_refresh_error: string | null
}

export type StoredReport = ReportDefinition & StoredReportMetadata

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
  validateReportSlug(value.slug)
  if (typeof value.title !== 'string' || !value.title.trim())
    throw new SiloError(exits.input, 'invalid_report_title', 'title must be non-empty.', '$.title')
  const scripted = Object.hasOwn(value, 'script')
  const legacy = Object.hasOwn(value, 'markdown') || Object.hasOwn(value, 'queries')
  if (Number(scripted) + Number(legacy) !== 1)
    throw new SiloError(
      exits.input,
      'invalid_report_source',
      'A report requires either script or the deprecated markdown and queries fields.',
      '$',
    )
  if (scripted) {
    knownFields(value, ['slug', 'title', 'script'], '$')
    if (typeof value.script !== 'string' || !value.script.trim())
      throw new SiloError(
        exits.input,
        'invalid_report_script',
        'script must be non-empty.',
        '$.script',
      )
    return { slug: value.slug, title: value.title.trim(), script: value.script }
  }

  knownFields(value, ['slug', 'title', 'markdown', 'queries'], '$')
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

export interface ReportScriptSilo {
  /** The Git workspace whose local database is being reported. */
  workspace: Pick<Workspace, 'root' | 'identity' | 'origin'>
  /** Run one bounded read-only SQL statement. */
  sql(sql: string, parameters?: Record<string, QueryBinding> | QueryBinding[]): QueryResult
  /** Run a saved query with its typed parameter contract. */
  query(name: string, parameters?: Record<string, unknown> | unknown[]): QueryResult
}

export interface ReportScriptMarkdown {
  /** Render a query result as a GitHub-flavored Markdown table. */
  table(result: Pick<QueryResult, 'columns' | 'rows'>): string
}

function scriptBindings(parameters: Record<string, QueryBinding> | QueryBinding[] | undefined): {
  named?: Record<string, QueryBinding>
  positional: QueryBinding[]
} {
  if (parameters === undefined) return { positional: [] }
  if (Array.isArray(parameters)) return { positional: parameters }
  return {
    named: Object.fromEntries(
      Object.entries(parameters).map(([name, value]) => [
        name.startsWith(':') ? name : `:${name}`,
        value,
      ]),
    ),
    positional: [],
  }
}

function renderScript(
  database: DatabaseSync,
  definition: ScriptedReportDefinition,
  resolve: (name: string) => StoredQuery,
  workspace: Workspace,
): string {
  const silo: ReportScriptSilo = {
    workspace: {
      root: workspace.root,
      identity: workspace.identity,
      origin: workspace.origin,
    },
    sql(sql, parameters) {
      const bindings = scriptBindings(parameters)
      return executeReadOnlyQuery(database, sql, bindings.named, bindings.positional, '$.script')
    },
    query(name, parameters) {
      const saved = resolve(name)
      const input = parameters ?? (saved.parameter_style === 'named' ? {} : [])
      const bindings = bindSavedQuery(saved, input)
      return executeReadOnlyQuery(
        database,
        saved.sql,
        bindings.named,
        bindings.positional,
        '$.script',
      )
    },
  }
  const markdown: ReportScriptMarkdown = {
    table(result) {
      return markdownTable(result.columns, result.rows)
    },
  }
  let execute: (
    silo: ReportScriptSilo,
    markdown: ReportScriptMarkdown,
    require: NodeJS.Require,
  ) => unknown
  try {
    execute = Function(
      'silo',
      'markdown',
      'require',
      `"use strict";\n${definition.script}\n//# sourceURL=silo-report:${definition.slug}`,
    ) as typeof execute
  } catch (error) {
    throw new SiloError(
      exits.input,
      'invalid_report_script',
      error instanceof Error ? error.message : String(error),
      '$.script',
    )
  }
  let rendered: unknown
  try {
    rendered = execute(silo, markdown, createRequire(join(workspace.root, 'package.json')))
  } catch (error) {
    if (error instanceof SiloError) throw error
    throw new SiloError(
      exits.input,
      'report_script_failed',
      error instanceof Error ? error.message : String(error),
      '$.script',
    )
  }
  if (rendered instanceof Promise)
    throw new SiloError(
      exits.input,
      'async_report_script',
      'Report scripts must return Markdown synchronously.',
      '$.script',
    )
  if (typeof rendered !== 'string')
    throw new SiloError(
      exits.input,
      'invalid_report_result',
      'A report script must return a Markdown string.',
      '$.script',
    )
  return rendered
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
  workspace: Workspace,
): string {
  if ('script' in definition) return renderScript(database, definition, resolve, workspace)
  const results = new Map(
    definition.queries.map((query, index) => [
      query.name,
      runQuery(database, query, index, resolve),
    ]),
  )
  return definition.markdown.replace(slotPattern, (_, name: string) => results.get(name)!)
}
