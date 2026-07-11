import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  SiloDatabase,
  discoverDatabases,
  emptySchema,
  listTemplates,
  normalizeDdl,
  readTemplate,
  schemaFromTemplate,
} from '../src/database.js'
import { SiloError, type TableDefinition } from '../src/model.js'
import { canonicalize, semantic } from '../src/registry.js'
import { compileTable, parseTable, validateCompiledSchema } from '../src/schema.js'
import { normalizeOrigin, type Workspace } from '../src/workspace.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'silo-test-'))
  roots.push(root)
  return {
    root,
    identity: 'github.com/acme/payments',
    origin: 'git@github.com:acme/payments.git',
    databasePath: join(root, 'payments.sqlite'),
  }
}

function issues(): TableDefinition {
  return parseTable({
    name: 'issues',
    comment: 'One tracked issue.',
    columns: [
      { name: 'id', type: 'text/uuid', nullable: false, comment: 'Stable generated identifier.' },
      { name: 'slug', type: 'text/slug', nullable: false, comment: 'Natural idempotency key.' },
      { name: 'title', type: 'text', nullable: false, comment: 'Issue summary.' },
      {
        name: 'revision',
        type: 'integer/nonnegative',
        nullable: false,
        comment: 'Optimistic revision.',
      },
      { name: 'created_at', type: 'text/datetime', nullable: false, comment: 'Creation instant.' },
      {
        name: 'updated_at',
        type: 'text/datetime',
        nullable: false,
        comment: 'Last update instant.',
      },
    ],
    primary_key: ['id'],
    unique_constraints: [{ columns: ['slug'] }],
    policies: [
      { type: 'generated_identity', column: 'id', strategy: 'uuid' },
      { type: 'timestamps', created_column: 'created_at', updated_column: 'updated_at' },
      { type: 'optimistic_revision', column: 'revision', initial: 1 },
      { type: 'natural_key_upsert', columns: ['slug'], update_columns: ['title'] },
    ],
  })
}

describe('origin normalization', () => {
  test.each([
    ['git@github.com:acme/payments.git', 'github.com/acme/payments'],
    ['https://user:secret@GitHub.com/acme/payments.git', 'github.com/acme/payments'],
    ['ssh://git@gitlab.example.com/team/service', 'gitlab.example.com/team/service'],
  ])('normalizes %s', (input, expected) => expect(normalizeOrigin(input)).toBe(expected))

  test('rejects traversal segments', () =>
    expect(() => normalizeOrigin('git@example.com:team/../secret.git')).toThrow(SiloError))

  test('rejects URL-encoded traversal segments', () =>
    expect(() => normalizeOrigin('https://example.com/team/%2e%2e/secret.git')).toThrow(SiloError))
})

describe('schema compilation', () => {
  test('canonicalizes native JSON and constrains ANY to SQLite scalars', () => {
    const json = { name: 'payload', type: 'text/json', comment: 'JSON payload.' }
    expect(canonicalize(json, { nested: [true, 2] })).toBe('{"nested":[true,2]}')
    expect(canonicalize(json, 'already text')).toBe('"already text"')

    const any = { name: 'value', type: 'any', comment: 'SQLite scalar.' }
    expect(canonicalize(any, true)).toBe(1)
    expect(canonicalize(any, 2.5)).toBe(2.5)
    expect(() => canonicalize(any, { nested: true })).toThrow(/only JSON strings/)
    expect(() => canonicalize(any, Number.MAX_VALUE)).not.toThrow()
  })

  test('renders semantic booleans and rejects calendar rollover', () => {
    const boolean = { name: 'enabled', type: 'integer/boolean', comment: 'Enabled flag.' }
    expect(semantic(boolean).render?.(1)).toBe(true)
    expect(semantic(boolean).render?.(0)).toBe(false)
    expect(() =>
      canonicalize({ name: 'date', type: 'text/date', comment: 'Calendar date.' }, '2025-02-29'),
    ).toThrow(/not valid/)
  })

  test('validates and canonicalizes semantic literal defaults in DDL', () => {
    const definition = parseTable({
      name: 'defaults',
      comment: 'Semantic defaults.',
      columns: [
        {
          name: 'payload',
          type: 'text/json',
          nullable: false,
          default: { literal: { compact: true } },
          comment: 'Default JSON payload.',
        },
        {
          name: 'enabled',
          type: 'integer/boolean',
          nullable: false,
          default: { literal: true },
          comment: 'Default enabled state.',
        },
      ],
    })
    const ddl = compileTable(definition)[0]
    expect(ddl).toContain(`DEFAULT '{"compact":true}'`)
    expect(ddl).toContain('DEFAULT 1')
    validateCompiledSchema({ ...emptySchema(), tables: [definition] })
  })

  test('compiles strict semantic checks and policy triggers', () => {
    const ddl = compileTable(issues()).join('\n')
    expect(ddl).toContain('STRICT')
    expect(ddl).toContain('CHECK ("revision" >= 0)')
    validateCompiledSchema({ ...emptySchema(), tables: [issues()] })
  })

  test.each(['append_only', 'immutable_rows'] as const)('compiles %s triggers', (type) => {
    const definition = parseTable({
      name: 'events',
      comment: 'One event.',
      columns: [{ name: 'id', type: 'integer', nullable: false, comment: 'Event id.' }],
      primary_key: ['id'],
      policies: [{ type }],
    })
    validateCompiledSchema({ ...emptySchema(), tables: [definition] })
    expect(
      compileTable(definition).filter((statement) => statement.includes('TRIGGER')),
    ).toHaveLength(2)
  })

  test('compiles immutable-column triggers', () => {
    const definition = parseTable({
      name: 'facts',
      comment: 'One fact.',
      columns: [{ name: 'id', type: 'integer', nullable: false, comment: 'Fact id.' }],
      primary_key: ['id'],
      policies: [{ type: 'immutable_columns', columns: ['id'] }],
    })
    validateCompiledSchema({ ...emptySchema(), tables: [definition] })
  })

  test('rejects unknown input fields', () =>
    expect(() => parseTable({ name: 'x', comment: 'x', columns: [], surprise: true })).toThrow(
      /Unknown field/,
    ))

  test('rejects foreign keys that do not target a declared key', () => {
    const parent = parseTable({
      name: 'parents',
      comment: 'One parent.',
      columns: [{ name: 'label', type: 'text', nullable: false, comment: 'Parent label.' }],
    })
    const child = parseTable({
      name: 'children',
      comment: 'One child.',
      columns: [{ name: 'parent', type: 'text', nullable: false, comment: 'Parent label.' }],
      foreign_keys: [{ columns: ['parent'], references: { table: 'parents', columns: ['label'] } }],
    })
    expect(() => validateCompiledSchema({ ...emptySchema(), tables: [parent, child] })).toThrow(
      /primary key or unique constraint/,
    )
  })
})

describe('database lifecycle', () => {
  test('captures synchronized row mutations as ordered SQLite changesets', () => {
    const target = workspace()
    const db = SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [issues()] })
    expect(db.pendingTransactions()).toEqual([])
    expect(db.configureSync('s3://silo-test/payments', 'database-1')).toMatchObject({
      database_id: 'database-1',
      remote_url: 's3://silo-test/payments',
      base_generation: null,
    })

    const [inserted] = db.addRows('issues', { slug: 'sync-me', title: 'First' })
    db.updateRow('issues', inserted!.id, { title: 'Second', _expected_revision: 1 })
    expect(() =>
      db.updateRow('issues', inserted!.id, { title: 'Stale', _expected_revision: 1 }),
    ).toThrow(/revision/i)
    db.deleteRow('issues', inserted!.id)

    const pending = db.pendingTransactions()
    expect(pending.map((item) => item.operation.command)).toEqual([
      'row.add',
      'row.update',
      'row.delete',
    ])
    expect(pending.map((item) => item.sequence)).toEqual([1, 2, 3])
    expect(new Set(pending.map((item) => item.transaction_id)).size).toBe(3)
    expect(pending.every((item) => item.changeset.byteLength > 0)).toBe(true)

    const replica = new DatabaseSync(':memory:')
    replica.exec(db.ddl())
    for (const item of pending)
      expect(replica.applyChangeset(item.changeset), String(item.operation.command)).toBe(true)
    expect(replica.prepare('SELECT * FROM issues').all()).toEqual([])
    replica.close()
    db.close()
  })

  test('rejects schemas and key changes that cannot synchronize safely', () => {
    const target = workspace()
    const noKey = parseTable({
      name: 'notes',
      comment: 'One unkeyed note.',
      columns: [{ name: 'body', type: 'text', nullable: false, comment: 'Note body.' }],
    })
    const db = SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [noKey] })
    expect(() => db.configureSync('s3://silo-test/notes')).toThrow(/must declare a primary key/)
    expect(db.getSyncState()).toBeUndefined()
    db.close()

    const keyedTarget = workspace()
    const keyed = SiloDatabase.createWithSchema(keyedTarget, {
      ...emptySchema(),
      tables: [issues()],
    })
    keyed.configureSync('s3://silo-test/issues')
    const [row] = keyed.addRows('issues', { slug: 'stable', title: 'Stable key' })
    expect(() =>
      keyed.updateRow('issues', row!.id, {
        id: 'fcdbf20e-f3ee-4d84-a46f-66188f3c162a',
        _expected_revision: 1,
      }),
    ).toThrow(/primary-key values cannot be updated/)
    expect(keyed.pendingTransactions()).toHaveLength(1)
    keyed.close()
  })

  test('verifies complete physical schema whenever a database opens', () => {
    const target = workspace()
    SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [issues()] }).close()

    const external = new DatabaseSync(target.databasePath)
    external.exec('ALTER TABLE issues ADD COLUMN rogue TEXT')
    external.close()

    expect(() => SiloDatabase.open(target)).toThrow(/do not match authoritative schema metadata/)
  })

  test('ignores insignificant DDL formatting during verification', () => {
    expect(normalizeDdl('CREATE   TABLE issues ( id INTEGER /* comment */ ) STRICT')).toBe(
      normalizeDdl('create table issues(id integer) strict'),
    )
  })

  test('reports physical mismatches during catalog discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'silo-catalog-test-'))
    roots.push(root)
    const previous = process.env.SILO_DATA_HOME
    process.env.SILO_DATA_HOME = root
    try {
      const target: Workspace = {
        root,
        identity: 'github.com/acme/payments',
        origin: 'git@github.com:acme/payments.git',
        databasePath: join(root, 'silo', 'databases', 'github.com', 'acme', 'payments.sqlite'),
      }
      SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [issues()] }).close()
      const external = new DatabaseSync(target.databasePath)
      external.exec('DROP TRIGGER _silo_issues_timestamps_1')
      external.close()
      expect(discoverDatabases()).toMatchObject([
        { identity: target.identity, state: 'incompatible', path: target.databasePath },
      ])
    } finally {
      if (previous === undefined) delete process.env.SILO_DATA_HOME
      else process.env.SILO_DATA_HOME = previous
    }
  })

  test('creates metadata atomically and performs canonical row operations', () => {
    const target = workspace()
    const db = SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [issues()] })
    const [insert] = db.addRows('issues', { slug: 'first-issue', title: 'First' })
    expect(insert).toMatchObject({ slug: 'first-issue', title: 'First', revision: 1 })
    expect(insert?.id).toMatch(/^[0-9a-f-]{36}$/)

    const rows = db.listRows('issues', 10, 0)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[0]?.revision).toBe(1)
    const id = rows[0]?.id as string

    expect(db.updateRow('issues', id, { title: 'Updated', _expected_revision: 1 })).toBe(1)
    expect(db.getRow('issues', id)).toMatchObject({ title: 'Updated', revision: 2 })
    expect(() => db.updateRow('issues', id, { title: 'Stale', _expected_revision: 1 })).toThrow(
      /revision/i,
    )

    expect(db.addRows('issues', { slug: 'first-issue', title: 'Upserted' }, true)[0]).toMatchObject(
      {
        id,
        slug: 'first-issue',
        title: 'Upserted',
      },
    )
    expect(db.addRows('issues', { slug: 'first-issue' }, true)[0]).toMatchObject({
      id,
      title: 'Upserted',
    })
    expect(db.getRow('issues', id)).toMatchObject({ title: 'Upserted' })
    db.close()

    const external = new DatabaseSync(target.databasePath)
    expect(() =>
      external
        .prepare(
          'INSERT INTO issues (id, slug, title, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          'not-a-uuid',
          'external',
          'External',
          1,
          new Date().toISOString(),
          new Date().toISOString(),
        ),
    ).toThrow(/constraint/i)
    external.close()

    const readOnly = SiloDatabase.open(target)
    expect(readOnly.query('SELECT title, title FROM issues')).toEqual({
      columns: ['title', 'title_2'],
      rows: [['Upserted', 'Upserted']],
    })
    expect(() => readOnly.query('DELETE FROM issues')).toThrow()
    readOnly.close()
  })

  test('does not leave a database after failed initial compilation', () => {
    const target = workspace()
    expect(() =>
      SiloDatabase.createWithSchema(target, {
        ...emptySchema(),
        tables: [{ ...issues(), checks: [{ expression: 'missing > 0' }] }],
      }),
    ).toThrow()
    expect(() => SiloDatabase.open(target)).toThrow(/No Silo database/)
  })

  test('applies supported additive column and index alterations', () => {
    const target = workspace()
    const db = SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [issues()] })
    const altered = db.alterTable('issues', {
      add_columns: [
        {
          name: 'details',
          type: 'text/markdown',
          nullable: true,
          comment: 'Optional issue details.',
        },
      ],
      add_indexes: [{ columns: [{ column: 'title' }] }],
    })
    expect(altered.columns.at(-1)?.name).toBe('details')
    expect(altered.indexes).toHaveLength(1)
    expect(db.getSchema().revision).toBe(2)
    db.close()
  })

  test('supports default-only inserts and schema-directed keys', () => {
    const target = workspace()
    const defaults = parseTable({
      name: 'Defaults',
      comment: 'One default-populated row.',
      columns: [
        { name: 'id', type: 'integer', nullable: false, comment: 'Generated row identifier.' },
        {
          name: 'enabled',
          type: 'integer/boolean',
          nullable: false,
          default: { literal: true },
          comment: 'Default enabled state.',
        },
      ],
      primary_key: ['id'],
      policies: [{ type: 'generated_identity', column: 'id', strategy: 'integer' }],
    })
    const db = SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [defaults] })
    expect(db.addRows('defaults', {})[0]).toEqual({ id: 1, enabled: true })
    expect(db.getRow('DEFAULTS', '1')).toEqual({ id: 1, enabled: true })

    db.createTable({
      name: 'labels',
      comment: 'One text-keyed label.',
      columns: [
        { name: 'id', type: 'text', nullable: false, comment: 'Text identifier.' },
        { name: 'value', type: 'text', nullable: false, comment: 'Label value.' },
      ],
      primary_key: ['id'],
    })
    db.addRows('labels', { id: '123', value: 'numeric-looking text' })
    expect(db.getRow('LABELS', '123')).toMatchObject({ id: '123' })
    expect(db.getRow('labels', '"123"')).toMatchObject({ id: '123' })

    db.createTable({
      name: 'pairs',
      comment: 'One composite-keyed pair.',
      columns: [
        { name: 'namespace', type: 'text', nullable: false, comment: 'Pair namespace.' },
        { name: 'position', type: 'integer', nullable: false, comment: 'Pair position.' },
      ],
      primary_key: ['namespace', 'position'],
    })
    db.addRows('pairs', { namespace: 'alpha', position: 2 })
    expect(db.getRow('pairs', '["alpha",2]')).toEqual({ namespace: 'alpha', position: 2 })
    db.close()
  })

  test('classifies trigger policy failures as SQLite constraints', () => {
    const target = workspace()
    const events = parseTable({
      name: 'events',
      comment: 'One append-only event.',
      columns: [{ name: 'id', type: 'integer', nullable: false, comment: 'Event identifier.' }],
      primary_key: ['id'],
      policies: [{ type: 'append_only' }],
    })
    const db = SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [events] })
    db.addRows('events', { id: 1 })
    try {
      db.updateRow('events', '1', { id: 2 })
      expect.fail('append-only update should fail')
    } catch (error) {
      expect(error).toMatchObject({ exitCode: 7, code: 'sqlite_constraint' })
    }
    db.close()
  })
})

describe('markdown reports', () => {
  test('stores definitions and renders bounded saved query results', () => {
    const target = workspace()
    const db = SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [issues()] })
    db.addRows('issues', [
      { slug: 'second', title: 'Second | issue' },
      { slug: 'first', title: 'First issue' },
    ])
    db.configureSync('s3://silo-test/reporting')

    const report = db.putReport({
      slug: 'execution-brief',
      title: 'Execution brief',
      markdown: '# Execution brief\n\n{{silo-query:issues}}\n\n{{silo-query:many_rows}}',
      queries: [
        {
          name: 'issues',
          sql: 'SELECT slug, title FROM issues ORDER BY slug',
        },
        {
          name: 'many_rows',
          sql: `WITH RECURSIVE numbers(value) AS (
                  VALUES (1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 501
                ) SELECT value FROM numbers ORDER BY value`,
        },
      ],
    })

    expect(report.rendered_markdown).toContain('| first | First issue |')
    expect(report.rendered_markdown).toContain('| second | Second \\| issue |')
    expect(report.rendered_markdown).toContain('Results truncated to 500 rows')
    expect(report.queries.map((query) => query.name)).toEqual(['issues', 'many_rows'])
    expect(db.listReports()).toMatchObject([
      { slug: 'execution-brief', title: 'Execution brief', last_refresh_error: null },
    ])
    expect(db.pendingTransactions()).toMatchObject([
      { operation: { command: 'report.put', report: 'execution-brief' } },
    ])
    expect(db.pendingTransactions()[0]?.changeset.byteLength).toBeGreaterThan(0)
    db.close()

    const external = new DatabaseSync(target.databasePath)
    expect(
      external.prepare("SELECT value FROM _silo_meta WHERE key = 'format_version'").get(),
    ).toEqual({ value: '2' })
    external.close()
  })

  test('validates query slots and rejects statements outside the read-only boundary', () => {
    const target = workspace()
    const db = SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [issues()] })
    const definition = {
      slug: 'unsafe',
      title: 'Unsafe',
      markdown: '{{silo-query:data}}',
      queries: [{ name: 'data', sql: 'SELECT title FROM issues' }],
    }
    db.putReport(definition)

    expect(() =>
      db.putReport({
        ...definition,
        queries: [{ name: 'data', sql: 'SELECT title FROM issues; DELETE FROM issues' }],
      }),
    ).toThrow(/exactly one SQLite statement/)
    expect(() =>
      db.putReport({ ...definition, queries: [{ name: 'data', sql: 'PRAGMA user_version' }] }),
    ).toThrow(/not authorized|prohibited/)
    expect(() =>
      db.putReport({
        ...definition,
        queries: [{ name: 'data', sql: 'SELECT value FROM _silo_meta' }],
      }),
    ).toThrow(/not authorized|prohibited/)
    expect(() => db.putReport({ ...definition, markdown: '{{silo-query:missing}}' })).toThrow(
      /unknown query missing/,
    )
    expect(db.getReport('unsafe').queries[0]?.sql).toBe('SELECT title FROM issues')
    db.close()
  })

  test('retains the last successful rendering and records failed refreshes', () => {
    const target = workspace()
    const db = SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [issues()] })
    db.addRows('issues', { slug: 'first', title: 'First issue' })
    const saved = db.putReport({
      slug: 'issue-brief',
      title: 'Issue brief',
      markdown: '{{silo-query:issues}}',
      queries: [{ name: 'issues', sql: 'SELECT title FROM issues' }],
    })
    db.dropTable('issues')

    expect(() => db.refreshReport('issue-brief')).toThrow(/no such table/)
    const stale = db.getReport('issue-brief')
    expect(stale.rendered_markdown).toBe(saved.rendered_markdown)
    expect(stale.refreshed_at).toBe(saved.refreshed_at)
    expect(stale.last_refresh_error).toMatch(/no such table/)
    db.deleteReport('issue-brief')
    expect(() => db.getReport('issue-brief')).toThrow(/No report/)
    db.close()
  })
})

describe('schema templates', () => {
  test('loads the bundled tasks template with agent instructions', () => {
    expect(listTemplates()).toContain('tasks')
    const template = readTemplate('tasks')
    expect(template.agent_instructions).toContain('human authorization boundary')
    expect(template.tables.map((table) => table.name)).toEqual([
      'tasks',
      'task_dependencies',
      'task_tags',
      'task_sessions',
    ])
  })

  test('imports multiple nonconflicting templates and preserves their instructions', () => {
    const target = workspace()
    const first = {
      format_version: 1 as const,
      agent_instructions: 'Follow the first template instructions.',
      tables: [
        {
          ...issues(),
          indexes: [{ name: 'shared_lookup', columns: [{ column: 'title' }] }],
        },
      ],
    }
    const db = SiloDatabase.createWithSchema(
      target,
      schemaFromTemplate('first', first, '2026-07-11T00:00:00.000Z'),
    )
    const secondTable = parseTable({
      name: 'notes',
      comment: 'One durable note.',
      columns: [{ name: 'body', type: 'text', nullable: false, comment: 'Note content.' }],
      indexes: [{ name: 'shared_lookup', columns: [{ column: 'body' }] }],
    })
    const schema = db.importTemplate('second', {
      format_version: 1,
      agent_instructions: 'Follow the second template instructions.',
      tables: [secondTable],
    })

    expect(schema.tables.map((table) => table.name)).toEqual(['issues', 'notes'])
    expect(schema.template_imports?.map((item) => item.name)).toEqual(['first', 'second'])
    expect(schema.agent_instructions).toEqual([
      { source: 'template:first', content: 'Follow the first template instructions.' },
      { source: 'template:second', content: 'Follow the second template instructions.' },
    ])
    expect(() =>
      db.importTemplate('conflicting', { format_version: 1, tables: [issues()] }),
    ).toThrow(/conflicts with existing table issues/)
    expect(db.getSchema().revision).toBe(2)
    db.close()
  })
})
