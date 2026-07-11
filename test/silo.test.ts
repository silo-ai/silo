import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { SiloDatabase, emptySchema } from '../src/database.js'
import { SiloError, type TableDefinition } from '../src/model.js'
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
  test('creates metadata atomically and performs canonical row operations', () => {
    const target = workspace()
    const db = SiloDatabase.createWithSchema(target, { ...emptySchema(), tables: [issues()] })
    const [insert] = db.addRows('issues', { slug: 'first-issue', title: 'First' })
    expect(insert?.changes).toBe(1)

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

    db.addRows('issues', { slug: 'first-issue', title: 'Upserted' }, true)
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
})
