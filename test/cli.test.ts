import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { readSkillResource, skillResources } from '../src/cli.js'

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
