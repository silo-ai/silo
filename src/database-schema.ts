import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// This describes the fixed Silo catalog only. The logical schema document and its compiled DDL
// remain authoritative for the runtime-defined user tables; this module is deliberately not used
// to create or migrate database objects.
export const siloMeta = sqliteTable('_silo_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const siloSchema = sqliteTable('_silo_schema', {
  id: integer('id').primaryKey(),
  schema_json: text('schema_json').notNull(),
})

export const siloReports = sqliteTable('_silo_reports', {
  slug: text('slug').primaryKey(),
  title: text('title').notNull(),
  template_markdown: text('template_markdown').notNull(),
  rendered_markdown: text('rendered_markdown').notNull(),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
  refreshed_at: text('refreshed_at').notNull(),
  last_refresh_attempt_at: text('last_refresh_attempt_at').notNull(),
  last_refresh_error: text('last_refresh_error'),
})

export const siloSavedQueries = sqliteTable('_silo_saved_queries', {
  name: text('name').primaryKey(),
  description: text('description').notNull(),
  sql: text('sql').notNull(),
  parameter_style: text('parameter_style', { enum: ['named', 'positional'] }).notNull(),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const siloReportQueries = sqliteTable('_silo_report_queries', {
  report_slug: text('report_slug').notNull(),
  name: text('name').notNull(),
  sql: text('sql'),
  saved_query_name: text('saved_query_name'),
  parameters_json: text('parameters_json'),
  empty_markdown: text('empty_markdown'),
  position: integer('position').notNull(),
})

export const siloSavedQueryParameters = sqliteTable('_silo_saved_query_parameters', {
  query_name: text('query_name').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  type_options_json: text('type_options_json'),
  description: text('description').notNull(),
  has_default: integer('has_default').notNull(),
  default_json: text('default_json'),
  position: integer('position').notNull(),
})

export const siloJournal = sqliteTable('_silo_journal', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  transaction_id: text('transaction_id').notNull(),
  committed_at: text('committed_at').notNull(),
  operation_json: text('operation_json').notNull(),
  resource_tags_json: text('resource_tags_json').notNull(),
})

export const siloSync = sqliteTable('_silo_sync', {
  id: integer('id').primaryKey(),
  database_id: text('database_id').notNull(),
  remote_url: text('remote_url').notNull(),
  base_generation: text('base_generation'),
  base_etag: text('base_etag'),
  conflict_transaction_id: text('conflict_transaction_id'),
})

export const siloOutbox = sqliteTable('_silo_outbox', {
  sequence: integer('sequence').primaryKey(),
  transaction_id: text('transaction_id').notNull(),
  kind: text('kind', { enum: ['data', 'schema'] }).notNull(),
  base_generation: text('base_generation'),
  schema_revision: integer('schema_revision').notNull(),
  operation_json: text('operation_json').notNull(),
  changeset: blob('changeset', { mode: 'buffer' }).notNull(),
  created_at: text('created_at').notNull(),
})
