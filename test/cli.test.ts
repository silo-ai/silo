import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dryRun } from 'cmd-ts'
import { describe, expect, test, vi } from 'vitest'
import {
  createSavedQueryCommand,
  isDirectSavedQueryInvocation,
  readSkillResource,
  skillResources,
} from '../src/cli.js'
import { SiloDatabase, emptySchema } from '../src/database.js'
import { resolveWorkspace } from '../src/workspace.js'

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
