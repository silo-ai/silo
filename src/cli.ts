import { readFileSync } from 'node:fs'
import { command, option, optional, positional, string, number, subcommands } from 'cmd-ts'
import { File } from 'cmd-ts/batteries/fs'
import {
  SiloDatabase,
  discoverDatabases,
  emptySchema,
  listTemplates,
  readTemplate,
  schemaFromTemplate,
  sqliteVersion,
} from './database.js'
import { errorMarkdown, heading, table as markdownTable } from './markdown.js'
import { exits, SiloError, type LogicalSchema, type TableDefinition } from './model.js'
import { parseTable } from './schema.js'
import { SiloSync } from './sync.js'
import { resolveWorkspace } from './workspace.js'

const inputFile = option({
  type: optional(File),
  long: 'file',
  short: 'f',
  description: 'Read the JSON request from this file instead of stdin.',
})

function readInput(file: string | undefined): unknown {
  const source = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
  if (!source.trim())
    throw new SiloError(
      exits.input,
      'empty_input',
      'Expected a JSON request on stdin or through --file.',
    )
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new SiloError(
      exits.input,
      'invalid_json',
      error instanceof Error ? error.message : String(error),
    )
  }
}

function output(value: string): void {
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`)
}

function renderSchema(schema: LogicalSchema): string {
  const summary = markdownTable(
    ['Property', 'Value'],
    [
      ['Format', schema.format_version],
      ['Registry', schema.registry_version],
      ['Revision', schema.revision],
      ['Templates', schema.template_imports?.map((item) => item.name).join(', ') ?? null],
    ],
  )
  const tables = schema.tables.length
    ? markdownTable(
        ['Table', 'Comment', 'Columns'],
        schema.tables.map((item) => [item.name, item.comment, item.columns.length]),
      )
    : '_No tables._'
  const instructions = schema.agent_instructions?.length
    ? schema.agent_instructions.map((item) => `### ${item.source}\n\n${item.content}`).join('\n\n')
    : '_No agent instructions._'
  return `${summary}\n\n## Agent instructions\n\n${instructions}\n\n## Tables\n\n${tables}`
}

function renderTable(definition: TableDefinition): string {
  const properties = markdownTable(
    ['Property', 'Value'],
    [
      ['Strict', definition.strict !== false],
      ['Without rowid', definition.without_rowid ?? false],
      ['Primary key', definition.primary_key?.join(', ') ?? null],
    ],
  )
  const columns = markdownTable(
    ['Column', 'Semantic type', 'Physical type', 'Nullable', 'Default', 'Comment'],
    definition.columns.map((column) => [
      column.name,
      column.type,
      column.type.split('/')[0]!.toUpperCase(),
      column.nullable !== false,
      column.default ? JSON.stringify(column.default) : null,
      column.comment,
    ]),
  )
  const policies = definition.policies?.length
    ? markdownTable(
        ['Policy', 'Enforcement', 'Parameters'],
        definition.policies.map((item) => [
          item.type,
          ['immutable_rows', 'immutable_columns', 'append_only', 'timestamps'].includes(item.type)
            ? 'trigger + cli'
            : 'cli',
          JSON.stringify(
            Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'type')),
          ),
        ]),
      )
    : '_No policies._'
  const foreignKeys = definition.foreign_keys?.length
    ? markdownTable(
        ['Columns', 'References', 'On update', 'On delete'],
        definition.foreign_keys.map((item) => [
          item.columns.join(', '),
          `${item.references.table}(${item.references.columns.join(', ')})`,
          item.on_update ?? 'NO ACTION',
          item.on_delete ?? 'NO ACTION',
        ]),
      )
    : '_No foreign keys._'
  const indexes = definition.indexes?.length
    ? markdownTable(
        ['Name', 'Unique', 'Parts', 'Where'],
        definition.indexes.map((item) => [
          item.name ?? null,
          item.unique ?? false,
          item.columns.map((part) => part.column ?? part.expression).join(', '),
          item.where ?? null,
        ]),
      )
    : '_No explicit indexes._'
  const checks = definition.checks?.length
    ? markdownTable(
        ['Name', 'Expression', 'Comment'],
        definition.checks.map((item) => [item.name ?? null, item.expression, item.comment ?? null]),
      )
    : '_No table checks._'
  return `${definition.comment}\n\n${properties}\n\n## Columns\n\n${columns}\n\n## Foreign Keys\n\n${foreignKeys}\n\n## Indexes\n\n${indexes}\n\n## Checks\n\n${checks}\n\n## Policies\n\n${policies}`
}

function withErrors(
  handler: (args: Record<string, any>) => void | Promise<void>,
): (args: Record<string, any>) => Promise<void> {
  return async (args) => {
    try {
      await handler(args)
    } catch (error) {
      const silo =
        error instanceof SiloError
          ? error
          : new SiloError(
              exits.io,
              'unexpected_error',
              error instanceof Error ? error.message : String(error),
            )
      process.stderr.write(heading('Error', errorMarkdown(silo)))
      process.exitCode = silo.exitCode
    }
  }
}

async function useDatabase<T>(
  database: SiloDatabase,
  handler: (database: SiloDatabase) => T | Promise<T>,
): Promise<T> {
  try {
    return await handler(database)
  } finally {
    database.close()
  }
}

const status = command({
  name: 'status',
  description: 'Resolve the Git workspace and report its Silo database state.',
  args: {},
  handler: withErrors(async () => {
    const workspace = resolveWorkspace()
    let state = 'absent'
    let revision: number | null = null
    try {
      await useDatabase(SiloDatabase.open(workspace), (database) => {
        state = 'recognized'
        revision = database.getSchema().revision
      })
    } catch (error) {
      if (!(error instanceof SiloError) || error.exitCode !== exits.absent) throw error
    }
    output(
      heading(
        'Silo Status',
        markdownTable(
          ['Property', 'Value'],
          [
            ['Workspace', workspace.root],
            ['Identity', workspace.identity],
            ['Database', workspace.databasePath],
            ['State', state],
            ['Schema revision', revision],
            ['SQLite', sqliteVersion()],
          ],
        ),
      ),
    )
  }),
})

const databaseList = command({
  name: 'list',
  description: 'Discover Silo databases in the application-data catalog.',
  args: {},
  handler: withErrors(async () => {
    const entries = discoverDatabases()
    output(
      heading(
        'Databases',
        entries.length
          ? markdownTable(
              ['Identity', 'State', 'Path', 'Message'],
              entries.map((entry) => [
                entry.identity ?? null,
                entry.state,
                entry.path,
                entry.message ?? null,
              ]),
            )
          : '_No databases._',
      ),
    )
  }),
})
const templateList = command({
  name: 'list',
  description: 'List globally installed JSON schema templates.',
  args: {},
  handler: withErrors(async () => {
    const names = listTemplates()
    output(
      heading(
        'Templates',
        names.length ? names.map((name) => `- \`${name}\``).join('\n') : '_No templates._',
      ),
    )
  }),
})
const templateShow = command({
  name: 'show',
  description: 'Validate and show a schema template.',
  args: {
    name: positional({
      type: string,
      displayName: 'name',
      description: 'Template filename without .json.',
    }),
  },
  handler: withErrors(async ({ name }) =>
    output(
      heading(
        `Template: ${name}`,
        `\`\`\`json\n${JSON.stringify(readTemplate(name), null, 2)}\n\`\`\``,
      ),
    ),
  ),
})

const schemaShow = command({
  name: 'show',
  description: 'Show the authoritative logical schema.',
  args: {},
  handler: withErrors(async () => {
    await useDatabase(SiloDatabase.open(resolveWorkspace()), (database) => {
      const meta = database.getMetadata()
      output(
        heading(
          'Schema',
          `${markdownTable(
            ['Property', 'Value'],
            [
              ['Identity', meta.identity],
              ['Database', database.workspace.databasePath],
              ['Metadata format', meta.format_version],
              ['Tool version', meta.tool_version],
            ],
          )}\n\n${renderSchema(database.getSchema())}`,
        ),
      )
    })
  }),
})
const schemaExport = command({
  name: 'export',
  description: 'Export the canonical logical schema as fenced JSON.',
  args: {},
  handler: withErrors(async () => {
    await useDatabase(SiloDatabase.open(resolveWorkspace()), (database) =>
      output(
        heading(
          'Schema Export',
          `\`\`\`json\n${JSON.stringify(database.getSchema(), null, 2)}\n\`\`\``,
        ),
      ),
    )
  }),
})
const schemaDdl = command({
  name: 'ddl',
  description: 'Show diagnostic compiled SQLite DDL. Logical metadata remains authoritative.',
  args: {},
  handler: withErrors(async () => {
    await useDatabase(SiloDatabase.open(resolveWorkspace()), (database) =>
      output(heading('Compiled SQLite DDL', `\`\`\`sql\n${database.ddl()}\n\`\`\``)),
    )
  }),
})
const schemaImport = command({
  name: 'import',
  description: 'Import a validated template into this workspace schema.',
  examples: [{ description: 'Import the tasks template', command: 'silo schema import tasks' }],
  args: { template: positional({ type: string, displayName: 'template' }) },
  handler: withErrors(async ({ template }) => {
    const source = readTemplate(template)
    const workspace = resolveWorkspace()
    let database: SiloDatabase | undefined
    let schema: LogicalSchema
    try {
      try {
        database = SiloDatabase.open(workspace, true)
        schema = database.importTemplate(template, source)
      } catch (error) {
        if (!(error instanceof SiloError) || error.code !== 'database_absent') throw error
        schema = schemaFromTemplate(template, source)
        database = SiloDatabase.createWithSchema(workspace, schema)
      }
      output(
        heading(
          'Schema Template Imported',
          markdownTable(
            ['Template', 'Tables', 'Revision'],
            [[template, schema.tables.length, schema.revision]],
          ),
        ),
      )
    } finally {
      database?.close()
    }
  }),
})

const tableList = command({
  name: 'list',
  description: 'List tables from authoritative logical metadata.',
  args: {},
  handler: withErrors(async () => {
    await useDatabase(SiloDatabase.open(resolveWorkspace()), (database) => {
      const tables = database.getSchema().tables
      output(
        heading(
          'Tables',
          tables.length
            ? markdownTable(
                ['Table', 'Comment'],
                tables.map((item) => [item.name, item.comment]),
              )
            : '_No tables._',
        ),
      )
    })
  }),
})
const tableShow = command({
  name: 'show',
  description: "Show a table's semantic types and policy enforcement.",
  args: { table: positional({ type: string, displayName: 'table' }) },
  handler: withErrors(async ({ table }) => {
    await useDatabase(SiloDatabase.open(resolveWorkspace()), (database) =>
      output(heading(`Table: ${table}`, renderTable(database.table(table)))),
    )
  }),
})
const tableCreate = command({
  name: 'create',
  description: 'Create a STRICT table from JSON, creating the workspace database on first use.',
  examples: [
    { description: 'Read a request from stdin', command: 'silo table create < table.json' },
  ],
  args: { file: inputFile },
  handler: withErrors(async ({ file }) => {
    const workspace = resolveWorkspace()
    const input = readInput(file)
    let database: SiloDatabase | undefined
    let definition: TableDefinition
    try {
      try {
        database = SiloDatabase.open(workspace, true)
      } catch (error) {
        if (!(error instanceof SiloError) || error.exitCode !== exits.absent) throw error
        definition = parseTable(input)
        database = SiloDatabase.createWithSchema(workspace, {
          ...emptySchema(),
          tables: [definition],
        })
      }
      definition ??= database.createTable(input)
      output(
        heading(
          'Table Created',
          markdownTable(['Table', 'Columns'], [[definition.name, definition.columns.length]]),
        ),
      )
    } finally {
      database?.close()
    }
  }),
})
const tableAlter = command({
  name: 'alter',
  description: 'Add nullable/defaulted columns or indexes from JSON.',
  args: { table: positional({ type: string, displayName: 'table' }), file: inputFile },
  handler: withErrors(async ({ table, file }) => {
    await useDatabase(SiloDatabase.open(resolveWorkspace(), true), (database) => {
      const result = database.alterTable(table, readInput(file))
      output(
        heading(
          'Table Altered',
          markdownTable(
            ['Table', 'Columns', 'Indexes'],
            [[result.name, result.columns.length, result.indexes?.length ?? 0]],
          ),
        ),
      )
    })
  }),
})
const tableDrop = command({
  name: 'drop',
  description: 'Permanently drop a table; the explicit command is destructive intent.',
  args: { table: positional({ type: string, displayName: 'table' }) },
  handler: withErrors(async ({ table }) => {
    await useDatabase(SiloDatabase.open(resolveWorkspace(), true), (database) => {
      database.dropTable(table)
      output(heading('Table Dropped', `\`${table}\` was dropped.`))
    })
  }),
})

const rowAdd = command({
  name: 'add',
  description: 'Atomically insert one JSON object or an array of objects.',
  args: { table: positional({ type: string, displayName: 'table' }), file: inputFile },
  handler: withErrors(async ({ table, file }) => {
    await useDatabase(SiloDatabase.open(resolveWorkspace(), true), (database) => {
      const rows = database.addRows(table, readInput(file))
      output(heading('Rows Added', markdownTable(Object.keys(rows[0]!), rows.map(Object.values))))
    })
  }),
})
const rowUpsert = command({
  name: 'upsert',
  description: 'Insert or update through the declared natural-key policy.',
  args: { table: positional({ type: string, displayName: 'table' }), file: inputFile },
  handler: withErrors(async ({ table, file }) => {
    await useDatabase(SiloDatabase.open(resolveWorkspace(), true), (database) => {
      const rows = database.addRows(table, readInput(file), true)
      output(
        heading('Rows Upserted', markdownTable(Object.keys(rows[0]!), rows.map(Object.values))),
      )
    })
  }),
})
const rowGet = command({
  name: 'get',
  description: 'Get a row by a schema-decoded key; composite keys use a JSON array.',
  args: {
    table: positional({ type: string, displayName: 'table' }),
    key: positional({ type: string, displayName: 'key' }),
  },
  handler: withErrors(async ({ table, key: value }) => {
    await useDatabase(SiloDatabase.open(resolveWorkspace()), (database) => {
      const row = database.getRow(table, value)
      output(heading('Row', markdownTable(Object.keys(row), [Object.values(row)])))
    })
  }),
})
const rowList = command({
  name: 'list',
  description: 'List rows deterministically by primary key or rowid.',
  args: {
    table: positional({ type: string, displayName: 'table' }),
    limit: option({
      type: number,
      long: 'limit',
      defaultValue: () => 100,
      description: 'Maximum rows.',
    }),
    offset: option({
      type: number,
      long: 'offset',
      defaultValue: () => 0,
      description: 'Rows to skip.',
    }),
  },
  handler: withErrors(async ({ table, limit, offset }) => {
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0)
      throw new SiloError(
        exits.input,
        'invalid_pagination',
        'limit and offset must be nonnegative integers.',
      )
    await useDatabase(SiloDatabase.open(resolveWorkspace()), (database) => {
      const rows = database.listRows(table, limit, offset)
      output(
        heading(
          'Rows',
          rows.length
            ? markdownTable(Object.keys(rows[0]!), rows.map(Object.values))
            : '_No rows._',
        ),
      )
    })
  }),
})
const rowUpdate = command({
  name: 'update',
  description: 'Update by key; revisioned tables require _expected_revision.',
  args: {
    table: positional({ type: string, displayName: 'table' }),
    key: positional({ type: string, displayName: 'key' }),
    file: inputFile,
  },
  handler: withErrors(async ({ table, key: value, file }) => {
    await useDatabase(SiloDatabase.open(resolveWorkspace(), true), (database) => {
      const changes = database.updateRow(table, value, readInput(file))
      output(heading('Row Updated', markdownTable(['Changes'], [[changes]])))
    })
  }),
})
const rowDelete = command({
  name: 'delete',
  description: 'Permanently delete a row by key.',
  args: {
    table: positional({ type: string, displayName: 'table' }),
    key: positional({ type: string, displayName: 'key' }),
  },
  handler: withErrors(async ({ table, key: value }) => {
    await useDatabase(SiloDatabase.open(resolveWorkspace(), true), (database) => {
      const changes = database.deleteRow(table, value)
      output(heading('Row Deleted', markdownTable(['Changes'], [[changes]])))
    })
  }),
})
const sql = command({
  name: 'sql',
  description: 'Run one query through a read-only SQLite connection; omit it to read stdin.',
  examples: [{ description: 'Query a table', command: "silo sql 'SELECT * FROM issues'" }],
  args: { query: positional({ type: optional(string), displayName: 'query' }) },
  handler: withErrors(async ({ query }) => {
    const source = query ?? readFileSync(0, 'utf8')
    if (!source.trim())
      throw new SiloError(exits.input, 'empty_query', 'Expected a SQL query argument or stdin.')
    await useDatabase(SiloDatabase.open(resolveWorkspace()), (database) => {
      const result = database.query(source)
      output(
        heading(
          'Query Result',
          result.rows.length
            ? markdownTable(result.columns, result.rows)
            : result.columns.length
              ? markdownTable(result.columns, [])
              : '_Query returned no result columns._',
        ),
      )
    })
  }),
})

function renderSyncStatus(status: Awaited<ReturnType<SiloSync['status']>>): string {
  return heading(
    'Synchronization',
    markdownTable(
      ['Property', 'Value'],
      [
        ['State', status.state],
        ['Remote', status.remote_url],
        ['Database ID', status.database_id],
        ['Local generation', status.local_generation],
        ['Remote generation', status.remote_generation],
        ['Pending transactions', status.pending_transactions],
        ['Conflict transaction', status.conflict_transaction_id],
      ],
    ),
  )
}

const syncInit = command({
  name: 'init',
  description: 'Connect this workspace to an S3-compatible synchronization remote.',
  args: { remote: positional({ type: string, displayName: 's3-url' }) },
  handler: withErrors(async ({ remote }) => {
    output(renderSyncStatus(await new SiloSync(resolveWorkspace()).initialize(remote)))
  }),
})

const syncStatus = command({
  name: 'status',
  description: 'Compare local synchronization state with remote HEAD.',
  args: {},
  handler: withErrors(async () => {
    output(renderSyncStatus(await new SiloSync(resolveWorkspace()).status()))
  }),
})

const syncDiscard = command({
  name: 'discard',
  description: 'Discard one pending transaction by rebuilding from remote state.',
  args: { transaction: positional({ type: string, displayName: 'transaction-id' }) },
  handler: withErrors(async ({ transaction }) => {
    output(renderSyncStatus(await new SiloSync(resolveWorkspace()).pull(transaction)))
  }),
})

const pull = command({
  name: 'pull',
  description: 'Restore remote HEAD and reapply pending local changesets.',
  args: {},
  handler: withErrors(async () => {
    output(renderSyncStatus(await new SiloSync(resolveWorkspace()).pull()))
  }),
})

const push = command({
  name: 'push',
  description: 'Publish a merged immutable checkpoint and conditionally advance remote HEAD.',
  args: {},
  handler: withErrors(async () => {
    output(renderSyncStatus(await new SiloSync(resolveWorkspace()).push()))
  }),
})

export const app = subcommands({
  name: 'silo',
  version: '0.1.0',
  cmds: {
    status,
    push,
    pull,
    sync: subcommands({
      name: 'sync',
      cmds: { init: syncInit, status: syncStatus, discard: syncDiscard },
    }),
    database: subcommands({ name: 'database', cmds: { list: databaseList } }),
    template: subcommands({ name: 'template', cmds: { list: templateList, show: templateShow } }),
    schema: subcommands({
      name: 'schema',
      cmds: {
        show: schemaShow,
        export: schemaExport,
        ddl: schemaDdl,
        import: schemaImport,
      },
    }),
    table: subcommands({
      name: 'table',
      cmds: {
        list: tableList,
        show: tableShow,
        create: tableCreate,
        alter: tableAlter,
        drop: tableDrop,
      },
    }),
    row: subcommands({
      name: 'row',
      cmds: {
        add: rowAdd,
        get: rowGet,
        list: rowList,
        update: rowUpdate,
        delete: rowDelete,
        upsert: rowUpsert,
      },
    }),
    sql,
  },
})
