import { blob, integer, text, snakeCase } from 'drizzle-orm/sqlite-core'

const { table } = snakeCase

// This describes the fixed Silo catalog only. The logical schema document and its compiled DDL
// remain authoritative for the runtime-defined user tables; this module is deliberately not used
// to create or migrate database objects.
export const siloMeta = table('_silo_meta', {
  key: text().primaryKey(),
  value: text().notNull(),
})

export const siloSchema = table('_silo_schema', {
  id: integer().primaryKey(),
  schemaJson: text().notNull(),
})

export const siloReports = table('_silo_reports', {
  slug: text().primaryKey(),
  title: text().notNull(),
  templateMarkdown: text().notNull(),
  renderedMarkdown: text().notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
  refreshedAt: text().notNull(),
  lastRefreshAttemptAt: text().notNull(),
  lastRefreshError: text(),
})

export const siloSavedQueries = table('_silo_saved_queries', {
  name: text().primaryKey(),
  description: text().notNull(),
  sql: text().notNull(),
  parameterStyle: text({ enum: ['named', 'positional'] }).notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
})

export const siloReportQueries = table('_silo_report_queries', {
  reportSlug: text().notNull(),
  name: text().notNull(),
  sql: text(),
  savedQueryName: text(),
  parametersJson: text(),
  emptyMarkdown: text(),
  position: integer().notNull(),
})

export const siloSavedQueryParameters = table('_silo_saved_query_parameters', {
  queryName: text().notNull(),
  name: text().notNull(),
  type: text().notNull(),
  typeOptionsJson: text(),
  description: text().notNull(),
  hasDefault: integer().notNull(),
  defaultJson: text(),
  position: integer().notNull(),
})

export const siloJournal = table('_silo_journal', {
  sequence: integer().primaryKey({ autoIncrement: true }),
  transactionId: text().notNull(),
  committedAt: text().notNull(),
  operationJson: text().notNull(),
  resourceTagsJson: text().notNull(),
})

export const siloSync = table('_silo_sync', {
  id: integer().primaryKey(),
  databaseId: text().notNull(),
  remoteUrl: text().notNull(),
  baseGeneration: text(),
  baseEtag: text(),
  conflictTransactionId: text(),
})

export const siloOutbox = table('_silo_outbox', {
  sequence: integer().primaryKey(),
  transactionId: text().notNull(),
  kind: text({ enum: ['data', 'schema'] }).notNull(),
  baseGeneration: text(),
  schemaRevision: integer().notNull(),
  operationJson: text().notNull(),
  changeset: blob({ mode: 'buffer' }).notNull(),
  createdAt: text().notNull(),
})
