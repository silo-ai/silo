import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dryRun } from 'cmd-ts'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { app } from '../src/cli.js'
import { SiloDatabase, emptySchema, readTemplate, schemaFromTemplate } from '../src/database.js'
import {
  SiloError,
  type LogicalSchema,
  type RelationDefinition,
  type TableDefinition,
} from '../src/model.js'
import {
  deriveRelationCardinality,
  findBackingForeignKey,
  parseRelation,
  parseTable,
  relationsFromTable,
  relationsToTable,
  validateCompiledSchema,
} from '../src/schema.js'
import type { Workspace } from '../src/workspace.js'
import { resolveWorkspace } from '../src/workspace.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(name = 'relations'): Workspace {
  const root = mkdtempSync(join(tmpdir(), `silo-${name}-`))
  roots.push(root)
  return {
    root,
    identity: 'github.com/acme/relations',
    origin: 'git@github.com:acme/relations.git',
    databasePath: join(root, 'relations.sqlite'),
  }
}

function authors(): TableDefinition {
  return parseTable({
    name: 'authors',
    comment: 'One author.',
    columns: [
      { name: 'id', type: 'integer', nullable: false, comment: 'Stable author identifier.' },
      { name: 'slug', type: 'text', nullable: false, comment: 'Stable author slug.' },
    ],
    primary_key: ['id'],
    unique_constraints: [{ columns: ['slug'] }],
  })
}

function posts(): TableDefinition {
  return parseTable({
    name: 'posts',
    comment: 'One authored post.',
    columns: [
      { name: 'id', type: 'integer', nullable: false, comment: 'Stable post identifier.' },
      { name: 'author_id', type: 'integer', nullable: false, comment: 'Author identifier.' },
      { name: 'editor_id', type: 'integer', comment: 'Optional editor identifier.' },
    ],
    primary_key: ['id'],
    foreign_keys: [
      { columns: ['author_id'], references: { table: 'authors', columns: ['id'] } },
      { columns: ['editor_id'], references: { table: 'authors', columns: ['id'] } },
    ],
  })
}

function profiles(): TableDefinition {
  return parseTable({
    name: 'profiles',
    comment: 'One optional author profile.',
    columns: [
      { name: 'id', type: 'integer', nullable: false, comment: 'Stable profile identifier.' },
      { name: 'author_id', type: 'integer', comment: 'Optional author identifier.' },
    ],
    primary_key: ['id'],
    unique_constraints: [{ columns: ['author_id'] }],
    foreign_keys: [{ columns: ['author_id'], references: { table: 'authors', columns: ['id'] } }],
  })
}

function tenants(): TableDefinition {
  return parseTable({
    name: 'tenants',
    comment: 'One tenant-owned parent key.',
    columns: [
      { name: 'tenant_id', type: 'integer', nullable: false, comment: 'Tenant identifier.' },
      { name: 'id', type: 'integer', nullable: false, comment: 'Parent identifier.' },
    ],
    primary_key: ['tenant_id', 'id'],
  })
}

function memberships(): TableDefinition {
  return parseTable({
    name: 'memberships',
    comment: 'One membership assigned to a tenant-owned parent.',
    columns: [
      { name: 'tenant_id', type: 'integer', nullable: false, comment: 'Tenant identifier.' },
      { name: 'parent_id', type: 'integer', nullable: false, comment: 'Parent identifier.' },
    ],
    foreign_keys: [
      {
        columns: ['tenant_id', 'parent_id'],
        references: { table: 'tenants', columns: ['tenant_id', 'id'] },
      },
    ],
  })
}

const authorRelation: RelationDefinition = {
  from: { table: 'posts', columns: ['author_id'], name: 'author' },
  to: { table: 'authors', columns: ['id'] },
  inverse_name: 'posts',
  comment: 'Author responsible for this post.',
  inverse_comment: 'Posts authored by this author.',
}

const editorRelation: RelationDefinition = {
  from: { table: 'posts', columns: ['editor_id'], name: 'editor' },
  to: { table: 'authors', columns: ['id'] },
  inverse_name: 'edited_posts',
  comment: 'Author who last edited this post.',
  inverse_comment: 'Posts last edited by this author.',
}

const profileRelation: RelationDefinition = {
  from: { table: 'profiles', columns: ['author_id'], name: 'author' },
  to: { table: 'authors', columns: ['id'] },
  inverse_name: 'profile',
  comment: 'Author represented by this profile.',
  inverse_comment: 'Optional profile for this author.',
}

const compositeRelation: RelationDefinition = {
  from: { table: 'memberships', columns: ['tenant_id', 'parent_id'], name: 'parent' },
  to: { table: 'tenants', columns: ['tenant_id', 'id'] },
  comment: 'Tenant-owned parent assigned to this membership.',
}

function schemaWithRelations(relations: RelationDefinition[] = []): LogicalSchema {
  return {
    ...emptySchema(),
    tables: [authors(), posts(), profiles(), tenants(), memberships()],
    ...(relations.length ? { relations } : {}),
  }
}

function expectSchemaError(action: () => unknown, code: string, path?: string): void {
  try {
    action()
    throw new Error(`Expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(SiloError)
    expect(error).toMatchObject({ code })
    if (path) expect(error).toMatchObject({ path })
  }
}

describe('semantic relation validation and derivation', () => {
  test('supports required, optional, one-to-one, composite, inverse, and multiple-FK relations', () => {
    const schema = schemaWithRelations([
      authorRelation,
      editorRelation,
      profileRelation,
      compositeRelation,
    ])
    validateCompiledSchema(schema)

    expect(findBackingForeignKey(schema, authorRelation)?.columns).toEqual(['author_id'])
    expect(deriveRelationCardinality(schema, authorRelation)).toEqual({
      source: 'one',
      source_optional: false,
      inverse: 'many',
    })
    expect(deriveRelationCardinality(schema, editorRelation)).toEqual({
      source: 'one',
      source_optional: true,
      inverse: 'many',
    })
    expect(deriveRelationCardinality(schema, profileRelation)).toEqual({
      source: 'one',
      source_optional: true,
      inverse: 'one',
    })
    expect(deriveRelationCardinality(schema, compositeRelation)).toEqual({
      source: 'one',
      source_optional: false,
      inverse: 'many',
    })
    expect(relationsFromTable(schema, 'posts')).toEqual([authorRelation, editorRelation])
    expect(relationsToTable(schema, 'authors')).toEqual([
      authorRelation,
      editorRelation,
      profileRelation,
    ])
  })

  test('allows a relation without an inverse name', () => {
    validateCompiledSchema(schemaWithRelations([compositeRelation]))
    expect(parseRelation(compositeRelation)).toEqual(compositeRelation)
  })

  test.each([
    [
      'missing source table',
      { ...authorRelation, from: { ...authorRelation.from, table: 'missing' } },
      'missing_relation_table',
    ],
    [
      'missing target table',
      { ...authorRelation, to: { ...authorRelation.to, table: 'missing' } },
      'missing_relation_table',
    ],
    [
      'missing source column',
      { ...authorRelation, from: { ...authorRelation.from, columns: ['missing'] } },
      'missing_relation_column',
    ],
    [
      'missing target column',
      { ...authorRelation, to: { ...authorRelation.to, columns: ['missing'] } },
      'missing_relation_column',
    ],
    [
      'missing backing foreign key',
      { ...authorRelation, to: { ...authorRelation.to, columns: ['slug'] } },
      'relation_missing_foreign_key',
    ],
  ])('%s is rejected', (_, relation, code) => {
    expectSchemaError(() => validateCompiledSchema(schemaWithRelations([relation])), code)
  })

  test('rejects a relation whose composite column order differs from its FK', () => {
    expectSchemaError(
      () =>
        validateCompiledSchema(
          schemaWithRelations([
            { ...compositeRelation, to: { table: 'tenants', columns: ['id', 'tenant_id'] } },
          ]),
        ),
      'relation_missing_foreign_key',
    )
  })

  test.each([
    [
      'duplicate source name',
      [authorRelation, { ...editorRelation, from: { ...editorRelation.from, name: 'author' } }],
      'duplicate_relation_name',
    ],
    [
      'duplicate inverse name',
      [authorRelation, { ...editorRelation, inverse_name: 'posts' }],
      'duplicate_relation_name',
    ],
    [
      'invalid relation name',
      [{ ...authorRelation, from: { ...authorRelation.from, name: 'not-valid' } }],
      'invalid_identifier',
    ],
    ['missing source comment', [{ ...authorRelation, comment: ' ' }], 'comment_required'],
    ['missing inverse comment', [{ ...authorRelation, inverse_comment: ' ' }], 'comment_required'],
  ])('%s is rejected', (_, relations, code) => {
    expectSchemaError(() => validateCompiledSchema(schemaWithRelations(relations)), code)
  })

  test('rejects malformed relations and unknown relation properties', () => {
    expectSchemaError(
      () => parseRelation({ ...authorRelation, surprise: true }),
      'unknown_field',
      '$.surprise',
    )
    expectSchemaError(
      () => parseRelation({ ...authorRelation, from: { ...authorRelation.from, columns: [] } }),
      'invalid_relation',
      '$.from.columns',
    )
    expectSchemaError(
      () =>
        parseRelation({
          ...authorRelation,
          inverse_comment: 'Only with a name.',
          inverse_name: undefined,
        }),
      'invalid_relation',
      '$.inverse_comment',
    )
  })
})

describe('semantic relation persistence and templates', () => {
  test('reads relation metadata from templates with an existing-table dependency', () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'silo-relation-template-'))
    roots.push(dataHome)
    const previousDataHome = process.env.SILO_DATA_HOME
    try {
      process.env.SILO_DATA_HOME = dataHome
      const templates = join(dataHome, 'silo', 'templates')
      mkdirSync(templates, { recursive: true })
      writeFileSync(
        join(templates, 'relations.json'),
        JSON.stringify({ format_version: 1, tables: [posts()], relations: [authorRelation] }),
      )
      expect(readTemplate('relations').relations).toEqual([authorRelation])
    } finally {
      if (previousDataHome === undefined) delete process.env.SILO_DATA_HOME
      else process.env.SILO_DATA_HOME = previousDataHome
    }
  })

  test('changes only logical metadata, survives reopen, and can be removed', () => {
    const target = workspace()
    const db = SiloDatabase.createWithSchema(target, schemaWithRelations())
    const ddl = db.ddl()
    const relation = db.addRelation(authorRelation)
    expect(relation).toEqual(authorRelation)
    expect(db.ddl()).toBe(ddl)
    expect(db.getSchema().relations).toEqual([authorRelation])
    expect(db.getSchema().revision).toBe(2)
    db.close()

    const reopened = SiloDatabase.open(target)
    expect(reopened.getRelation('posts', 'author')).toEqual(authorRelation)
    expect(reopened.listRelations()).toEqual([authorRelation])
    reopened.close()

    const writer = SiloDatabase.open(target, true)
    writer.removeRelation('posts', 'author')
    expect(writer.getSchema().relations).toBeUndefined()
    expect(writer.ddl()).toBe(ddl)
    writer.close()
  })

  test('imports relations with a complete template and validates additive dependencies atomically', () => {
    const template = {
      format_version: 1 as const,
      tables: [authors(), posts()],
      relations: [authorRelation],
    }
    expect(schemaFromTemplate('authors-and-posts', template).relations).toEqual([authorRelation])

    const target = workspace('template')
    const db = SiloDatabase.createWithSchema(target, schemaWithRelations())
    const commentTable = parseTable({
      name: 'comments',
      comment: 'One comment attached to a post.',
      columns: [
        { name: 'id', type: 'integer', nullable: false, comment: 'Stable comment identifier.' },
        { name: 'post_id', type: 'integer', nullable: false, comment: 'Attached post identifier.' },
      ],
      primary_key: ['id'],
      foreign_keys: [{ columns: ['post_id'], references: { table: 'posts', columns: ['id'] } }],
    })
    const commentRelation: RelationDefinition = {
      from: { table: 'comments', columns: ['post_id'], name: 'post' },
      to: { table: 'posts', columns: ['id'] },
      inverse_name: 'comments',
      comment: 'Post containing this comment.',
      inverse_comment: 'Comments attached to this post.',
    }
    const imported = db.importTemplate('comments', {
      format_version: 1,
      tables: [commentTable],
      relations: [commentRelation],
    })
    expect(imported.relations).toEqual([commentRelation])
    expect(db.getRelation('comments', 'post')).toEqual(commentRelation)

    const before = structuredClone(db.getSchema())
    const duplicate = {
      ...authorRelation,
      from: { ...authorRelation.from, name: 'comments' },
      inverse_name: 'commented_posts',
      inverse_comment: 'Posts commented on by this author.',
    }
    expectSchemaError(
      () =>
        db.importTemplate('duplicate', { format_version: 1, tables: [], relations: [duplicate] }),
      'duplicate_relation_name',
    )
    expect(db.getSchema()).toEqual(before)

    expectSchemaError(
      () =>
        db.importTemplate('missing', {
          format_version: 1,
          tables: [],
          relations: [{ ...authorRelation, to: { table: 'missing', columns: ['id'] } }],
        }),
      'missing_relation_table',
    )
    expect(db.getSchema()).toEqual(before)
    expect(() => db.table('missing')).toThrow()
    db.close()
  })
})

describe('semantic relation inspection', () => {
  test('schema and table inspection expose relation meaning and derived cardinality', async () => {
    const root = mkdtempSync(join(tmpdir(), 'silo-relation-cli-'))
    roots.push(root)
    const previousCwd = process.cwd()
    const previousDataHome = process.env.SILO_DATA_HOME
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/cli-relations.git'], {
        cwd: root,
      })
      process.chdir(root)
      process.env.SILO_DATA_HOME = join(root, 'data')
      SiloDatabase.createWithSchema(
        resolveWorkspace(),
        schemaWithRelations([authorRelation]),
      ).close()

      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      expect(await dryRun(app, ['schema', 'show'])).toMatchObject({ _tag: 'ok' })
      const schemaOutput = write.mock.calls.map(([value]) => String(value)).join('')
      expect(schemaOutput).toContain('Semantic relations')
      expect(schemaOutput).toContain('posts.author')
      expect(schemaOutput).toContain('required → many')
      write.mockClear()

      expect(await dryRun(app, ['table', 'show', 'authors'])).toMatchObject({ _tag: 'ok' })
      const tableOutput = write.mock.calls.map(([value]) => String(value)).join('')
      expect(tableOutput).toContain('Incoming semantic relations')
      expect(tableOutput).toContain('posts.author')
      expect(tableOutput).toContain('Posts authored by this author.')
      write.mockRestore()
    } finally {
      process.chdir(previousCwd)
      if (previousDataHome === undefined) delete process.env.SILO_DATA_HOME
      else process.env.SILO_DATA_HOME = previousDataHome
      vi.restoreAllMocks()
    }
  })
})
