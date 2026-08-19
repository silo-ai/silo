import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dryRun } from 'cmd-ts'
import { describe, expect, test, vi } from 'vitest'
import {
  app,
  createSavedQueryCommand,
  isDirectSavedQueryInvocation,
  readSkillResource,
  skillResources,
} from '../src/cli.js'
import { emptySchema } from '../src/database.js'
import {
  MUTATION_JOURNAL_READ_LIMIT,
  MUTATION_JOURNAL_RETENTION,
  SiloDatabase,
  resolveWorkspace,
} from '../src/index.js'

describe('packaged skill resources', () => {
  test.each(skillResources)('reads %s relative to the package', (resource) => {
    const expected = readFileSync(
      fileURLToPath(new URL(`../skills/silo/${resource}`, import.meta.url)),
      'utf8',
    )

    expect(readSkillResource(resource)).toBe(expected)
  })

  test('defaults to the main skill', () => {
    expect(readSkillResource()).toBe(readSkillResource('SKILL.md'))
  })
})

describe('published library entrypoint', () => {
  test('exposes the local journal boundary', () => {
    expect(typeof SiloDatabase.open).toBe('function')
    expect(typeof resolveWorkspace).toBe('function')
    expect(MUTATION_JOURNAL_RETENTION).toBe(1000)
    expect(MUTATION_JOURNAL_READ_LIMIT).toBe(100)
  })
})

describe('context CLI', () => {
  test('combines workspace, schema, and saved-query inspection with one database open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'silo-context-cli-test-'))
    const previousCwd = process.cwd()
    const previousDataHome = process.env.SILO_DATA_HOME
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/context-cli.git'], {
        cwd: root,
      })
      process.chdir(root)
      process.env.SILO_DATA_HOME = join(root, 'data')
      const database = SiloDatabase.createWithSchema(resolveWorkspace(), {
        ...emptySchema(),
        tables: [
          {
            name: 'issues',
            comment: 'One issue tracked by the repository.',
            columns: [
              {
                name: 'id',
                type: 'text',
                nullable: false,
                comment: 'Stable issue identifier.',
              },
            ],
            primary_key: ['id'],
          },
        ],
      })
      database.putSavedQuery({
        name: 'open-issues',
        description: 'Return open issues.',
        sql: 'SELECT id FROM issues ORDER BY id',
        parameters: [],
      })
      database.close()

      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const open = vi.spyOn(SiloDatabase, 'open')
      const result = await dryRun(app, ['context'])
      const rendered = write.mock.calls.map(([value]) => String(value)).join('')
      expect(result).toMatchObject({ _tag: 'ok' })
      expect(open).toHaveBeenCalledTimes(1)
      expect(rendered).toContain('# Silo Context')
      expect(rendered).toContain('| State | recognized |')
      expect(rendered).toContain('| issues | One issue tracked by the repository. | 1 |')
      expect(rendered).toContain('## Saved queries')
      expect(rendered).toContain('| open-issues | Return open issues. | named | 0 |')
      expect(rendered).not.toContain('# Silo Status')
      open.mockRestore()
      write.mockRestore()
    } finally {
      process.chdir(previousCwd)
      if (previousDataHome === undefined) delete process.env.SILO_DATA_HOME
      else process.env.SILO_DATA_HOME = previousDataHome
      rmSync(root, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })

  test('reports an absent database without failing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'silo-context-absent-test-'))
    const previousCwd = process.cwd()
    const previousDataHome = process.env.SILO_DATA_HOME
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      process.chdir(root)
      process.env.SILO_DATA_HOME = join(root, 'data')

      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const result = await dryRun(app, ['context'])
      const rendered = write.mock.calls.map(([value]) => String(value)).join('')
      expect(result).toMatchObject({ _tag: 'ok' })
      expect(rendered).toContain('| State | absent |')
      expect(rendered).toContain('_Database is absent; schema and saved queries are unavailable._')
      write.mockRestore()
    } finally {
      process.chdir(previousCwd)
      if (previousDataHome === undefined) delete process.env.SILO_DATA_HOME
      else process.env.SILO_DATA_HOME = previousDataHome
      rmSync(root, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })
})

describe('workspace switch CLI', () => {
  test('moves a detached database to a named remote identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'silo-switch-cli-test-'))
    const previousCwd = process.cwd()
    const previousDataHome = process.env.SILO_DATA_HOME
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      process.chdir(root)
      process.env.SILO_DATA_HOME = join(root, 'data')
      const detached = resolveWorkspace()
      SiloDatabase.createWithSchema(detached, emptySchema()).close()

      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      expect(await dryRun(app, ['switch', '--detach'])).toMatchObject({ _tag: 'ok' })
      write.mockClear()
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/switched.git'], {
        cwd: root,
      })
      expect(await dryRun(app, ['switch', 'origin', '--move'])).toMatchObject({ _tag: 'ok' })
      expect(write.mock.calls.map(([value]) => String(value)).join('')).toContain(
        'github.com/acme/switched',
      )
      write.mockClear()

      const selected = resolveWorkspace()
      expect(selected).toMatchObject({
        identity: 'github.com/acme/switched',
        selection: { kind: 'remote', name: 'origin' },
      })
      SiloDatabase.open(selected).close()

      expect(await dryRun(app, ['switch', '--auto'])).toMatchObject({ _tag: 'ok' })
      expect(resolveWorkspace().selection).toEqual({ kind: 'auto' })
      write.mockRestore()
    } finally {
      process.chdir(previousCwd)
      if (previousDataHome === undefined) delete process.env.SILO_DATA_HOME
      else process.env.SILO_DATA_HOME = previousDataHome
      rmSync(root, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })
})

describe('saved query CLI', () => {
  test('reserves management verbs and detects direct query invocation', () => {
    expect(isDirectSavedQueryInvocation(['node', 'silo', 'query', 'issues-by-owner'])).toBe(true)
    expect(isDirectSavedQueryInvocation(['node', 'silo', 'query', 'list'])).toBe(false)
    expect(isDirectSavedQueryInvocation(['node', 'silo', 'query', '--help'])).toBe(false)
  })

  test('builds named options from the stored query definition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'silo-cli-test-'))
    const previousCwd = process.cwd()
    const previousDataHome = process.env.SILO_DATA_HOME
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/cli-test.git'], {
        cwd: root,
      })
      process.chdir(root)
      process.env.SILO_DATA_HOME = join(root, 'data')
      const database = SiloDatabase.createWithSchema(resolveWorkspace(), emptySchema())
      database.putSavedQuery({
        name: 'echo-value',
        description: 'Return one caller-supplied value.',
        sql: 'SELECT :input_value AS value',
        parameters: [
          {
            name: 'input_value',
            type: 'text',
            description: 'Value returned by the query.',
          },
        ],
      })
      database.close()

      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const result = await dryRun(createSavedQueryCommand('echo-value'), ['--input-value', 'hello'])
      expect(result._tag).toBe('ok')
      expect(write.mock.calls.map(([value]) => String(value)).join('')).toContain('| hello |')
      write.mockRestore()

      const help = await dryRun(createSavedQueryCommand('echo-value'), ['--help'])
      expect(help).toMatchObject({ _tag: 'error', error: expect.stringContaining('--input-value') })

      const missing = await dryRun(createSavedQueryCommand('echo-value'), [])
      expect(missing._tag).toBe('error')
    } finally {
      process.chdir(previousCwd)
      if (previousDataHome === undefined) delete process.env.SILO_DATA_HOME
      else process.env.SILO_DATA_HOME = previousDataHome
      rmSync(root, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })
})

describe('report CLI', () => {
  test('validates candidate files and inspects definitions without rendering output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'silo-report-cli-test-'))
    const previousCwd = process.cwd()
    const previousDataHome = process.env.SILO_DATA_HOME
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/report-cli.git'], {
        cwd: root,
      })
      process.chdir(root)
      process.env.SILO_DATA_HOME = join(root, 'data')
      const database = SiloDatabase.createWithSchema(resolveWorkspace(), emptySchema())
      database.putReport({
        slug: 'compact-brief',
        title: 'Compact brief',
        script:
          "const value = silo.sql(\"SELECT 'rendered-only-value' AS value\")\nreturn '# Compact brief\\n\\n' + markdown.table(value)",
      })
      database.close()
      const candidatePath = join(root, 'candidate.json')
      writeFileSync(
        candidatePath,
        JSON.stringify({
          slug: 'candidate-brief',
          title: 'Candidate brief',
          script: "return '# Candidate brief'",
        }),
      )

      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      expect(await dryRun(app, ['report', 'validate', '--file', candidatePath])).toMatchObject({
        _tag: 'ok',
      })
      expect(write.mock.calls.map(([value]) => String(value)).join('')).toContain('Report Valid')
      const afterValidation = SiloDatabase.open(resolveWorkspace())
      expect(() => afterValidation.getReport('candidate-brief')).toThrow(/No report/)
      afterValidation.close()
      write.mockClear()

      expect(await dryRun(app, ['report', 'show', 'compact-brief', '--definition'])).toMatchObject({
        _tag: 'ok',
      })
      const definitionOutput = write.mock.calls.map(([value]) => String(value)).join('')
      expect(definitionOutput).toContain('Report Definition: Compact brief')
      expect(definitionOutput).toContain('"script":')
      expect(definitionOutput).not.toContain('| value |')
      expect(definitionOutput).not.toContain('## Rendered report')
      write.mockRestore()
    } finally {
      process.chdir(previousCwd)
      if (previousDataHome === undefined) delete process.env.SILO_DATA_HOME
      else process.env.SILO_DATA_HOME = previousDataHome
      rmSync(root, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })
})
