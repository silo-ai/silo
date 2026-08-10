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
        markdown: '# Compact brief\n\n{{silo-query:value}}',
        queries: [{ name: 'value', sql: "SELECT 'rendered-only-value' AS value" }],
      })
      database.close()
      const candidatePath = join(root, 'candidate.json')
      writeFileSync(
        candidatePath,
        JSON.stringify({
          slug: 'candidate-brief',
          title: 'Candidate brief',
          markdown: '{{silo-query:value}}',
          queries: [{ name: 'value', sql: 'SELECT 1 AS value' }],
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
      expect(definitionOutput).toContain('"markdown": "# Compact brief')
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
