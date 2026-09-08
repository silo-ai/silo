import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import {
  SiloDatabase,
  emptySchema,
  listTemplates,
  readTemplate,
  schemaFromTemplate,
} from '../src/database.js'
import type { QueryResult } from '../src/query.js'

const databases: SiloDatabase[] = []
const roots: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'silo-source-audit-'))
  roots.push(root)
  return {
    root,
    identity: 'github.com/acme/audit',
    origin: 'https://github.com/acme/audit.git',
    databasePath: join(root, 'audit.sqlite'),
  }
}
function database(fresh = false) {
  const template = readTemplate('source-audit')
  const db = fresh
    ? SiloDatabase.createWithSchema(
        workspace(),
        schemaFromTemplate('source-audit', template),
        template.reports,
        template.queries,
      )
    : SiloDatabase.createWithSchema(workspace(), emptySchema())
  databases.push(db)
  if (!fresh) db.importTemplate('source-audit', template)
  return db
}
function rows(result: QueryResult) {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((name, i) => [name, row[i]])),
  )
}
function query(db: SiloDatabase, name: string, input: Record<string, unknown>) {
  return rows(db.runSavedQuery('source-audit-' + name, input))
}
function run(db: SiloDatabase, extra: Record<string, unknown> = {}) {
  return db.addRows('source_audit_runs', {
    package_path: '.',
    commit_sha: 'a'.repeat(40),
    worktree_dirty: false,
    scope: 'src and exported APIs',
    exclusions: 'None',
    ...extra,
  })[0]!
}
const assessment = {
  title: 'Repeated parse',
  category: 'performance',
  severity: 'high',
  confidence: 'medium',
  file_path: 'src/read.ts',
  related_symbols: ['read'],
  evidence: 'read.ts:42 reparses the same input for each item when loading a batch.',
  issue: 'Parsing repeats in the item loop.',
  impact: 'Avoidable parsing proportional to batch size.',
  recommendation: 'Parse once before the loop if the input is unchanged.',
  notes: null,
}
function finding(
  db: SiloDatabase,
  audit: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return db.addRows('source_audit_findings', {
    ...assessment,
    package_path: audit.package_path,
    first_seen_run_id: audit.run_id,
    last_checked_run_id: audit.run_id,
    ...extra,
  })[0]!
}
function observe(
  db: SiloDatabase,
  audit: Record<string, unknown>,
  issue: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const copied = Object.fromEntries(
    Object.keys(assessment).map((key) => [
      key,
      key === 'related_symbols' ? JSON.parse(String(issue[key])) : issue[key],
    ]),
  )
  return db.addRows('source_audit_observations', {
    ...copied,
    package_path: audit.package_path,
    run_id: audit.run_id,
    finding_id: issue.finding_id,
    ...extra,
  })[0]!
}
function unit(
  unit_id: string,
  implementation: string,
  api: string,
  extra: Record<string, unknown> = {},
) {
  return {
    unit_id,
    file_path: `src/${unit_id}.ts`,
    implementation,
    api,
    checks_performed: [],
    remaining_checks: [],
    priority: 'medium',
    reason: null,
    ...extra,
  }
}

test.each([false, true])(
  'installs the complete template and renders empty reports (fresh=%s)',
  (fresh) => {
    expect(listTemplates()).toContain('source-audit')
    const db = database(fresh)
    expect(db.getSchema().tables).toHaveLength(3)
    expect(db.listRelations()).toHaveLength(4)
    expect(db.getSchema().agent_instructions).toEqual([
      {
        source: 'template:source-audit',
        content: expect.stringContaining(
          'never modify audited source without explicit authorization',
        ),
      },
    ])
    expect(db.listSavedQueries()).toHaveLength(6)
    expect(db.listReports()).toHaveLength(3)
    for (const report of db.listReports()) {
      expect(
        db.validateReport(
          readTemplate('source-audit').reports!.find(
            (definition) => definition.slug === report.slug,
          ),
        ),
      ).toBeDefined()
      expect(db.refreshReport(report.slug).rendered_markdown).toContain('No audit runs.')
    }
    for (const name of ['runs', 'findings']) expect(query(db, name, { package: '.' })).toEqual([])
    for (const name of ['next-review', 'hotspots', 'needs-verification', 'summary'])
      expect(
        query(db, name, { package: '.', run: '11111111-1111-4111-8111-111111111111' }),
      ).toEqual([])
  },
)

test('rejects reimports and query/report collisions without replacing rows or partial imports', () => {
  const db = database()
  const audit = run(db)
  const schema = db.getSchema()
  expect(() => db.importTemplate('source-audit', readTemplate('source-audit'))).toThrow(/conflicts/)
  expect(db.getRow('source_audit_runs', audit.run_id)).toEqual(audit)
  const existing = db.getSavedQuery('source-audit-runs')
  expect(() =>
    db.importTemplate('query-conflict', {
      tables: [],
      queries: [readTemplate('source-audit').queries![0]!],
    }),
  ).toThrow(/already exists/)
  expect(db.getSchema()).toEqual(schema)
  expect(db.getSavedQuery(existing.name)).toEqual(existing)
  const goodQuery = { ...readTemplate('source-audit').queries![0]!, name: 'audit-extra' }
  expect(() =>
    db.importTemplate('report-conflict', {
      tables: [],
      queries: [goodQuery],
      reports: [readTemplate('source-audit').reports![0]!],
    }),
  ).toThrow(/already exists/)
  expect(() => db.getSavedQuery(goodQuery.name)).toThrow(/No saved query/)
  expect(db.getSchema()).toEqual(schema)
  expect(() =>
    db.importTemplate('invalid-query', {
      tables: [],
      queries: [{ ...goodQuery, sql: 'SELECT missing FROM source_audit_runs', parameters: [] }],
    }),
  ).toThrow(/missing/)
  expect(() =>
    db.importTemplate('duplicate-query', { tables: [], queries: [goodQuery, goodQuery] }),
  ).toThrow(/Duplicate/)
  expect(db.getSchema()).toEqual(schema)
})

test('enforces types, array checks, package-consistent references, identities and revisions', () => {
  const db = database()
  const audit = run(db)
  expect(audit).toMatchObject({
    status: 'in_progress',
    revision: 1,
    worktree_dirty: false,
    coverage: '[]',
  })
  expect(audit.run_id).toMatch(/^[a-f0-9-]{36}$/)
  expect(audit.created_at).toBeTruthy()
  expect(() => run(db, { status: 'finished' })).toThrow()
  expect(() => run(db, { commit_sha: 'main' })).toThrow()
  expect(() => run(db, { coverage: {} })).toThrow(/CHECK/)
  expect(() => run(db, { package_path: '../outside' })).toThrow()
  db.updateRow('source_audit_runs', audit.run_id, {
    summary: 'Partial review',
    _expected_revision: 1,
  })
  expect(db.getRow('source_audit_runs', audit.run_id)).toMatchObject({
    revision: 2,
    summary: 'Partial review',
  })
  expect(() =>
    db.updateRow('source_audit_runs', audit.run_id, { status: 'completed', _expected_revision: 1 }),
  ).toThrow(/revision/i)
  expect(() =>
    db.updateRow('source_audit_runs', audit.run_id, {
      commit_sha: 'b'.repeat(40),
      _expected_revision: 2,
    }),
  ).toThrow(/immutable/i)
  const other = run(db, { package_path: 'packages/other' })
  expect(() => finding(db, audit, { last_checked_run_id: other.run_id })).toThrow(/FOREIGN KEY/)
  expect(() => finding(db, audit, { confidence: 'certain' })).toThrow()
  const issue = finding(db, audit)
  observe(db, audit, issue)
  expect(() => observe(db, other, issue)).toThrow(/FOREIGN KEY/)
  expect(() => observe(db, audit, issue)).toThrow(/UNIQUE/)
  expect(() => db.deleteRow('source_audit_runs', audit.run_id)).toThrow(/FOREIGN KEY/)
  expect(() =>
    db.updateRow('source_audit_findings', issue.finding_id, {
      title: 'new',
      _expected_revision: 2,
    }),
  ).toThrow(/revision/i)
  expect(() =>
    db.updateRow('source_audit_observations', [audit.run_id, issue.finding_id], {
      confidence: 'high',
      _expected_revision: 2,
    }),
  ).toThrow(/revision/i)
})

test('typed filters isolate packages and order severity, confidence, path and stable IDs', () => {
  const db = database()
  const audit = run(db)
  const other = run(db, { package_path: 'packages/other' })
  finding(db, other)
  const low = finding(db, audit, { severity: 'low', confidence: 'high' })
  const medium = finding(db, audit, { severity: 'medium', confidence: 'high' })
  const uncertain = finding(db, audit, { severity: 'high', confidence: 'low' })
  const high = finding(db, audit, { severity: 'high', confidence: 'high', category: 'comments' })
  const same = finding(db, audit, { severity: 'high', confidence: 'high', category: 'comments' })
  const sorted = query(db, 'findings', { package: '.' })
  expect(sorted.map((row) => row.finding_id)).toEqual(
    [high.finding_id, same.finding_id]
      .sort()
      .concat([uncertain.finding_id, medium.finding_id, low.finding_id]),
  )
  expect(
    query(db, 'findings', {
      package: '.',
      category: 'comments',
      severity: 'high',
      confidence: 'high',
      file: 'src/read.ts',
    }),
  ).toHaveLength(2)
  expect(query(db, 'findings', { package: '.', file: "x' OR 1=1 --" })).toEqual([])
  expect(() => query(db, 'findings', { package: '.', severity: 'critical' })).toThrow()
  expect(() => query(db, 'findings', { package: '.', confidence: null })).toThrow()
  expect(() => query(db, 'runs', {})).toThrow()
  expect(() => query(db, 'summary', { package: '.', run: 'invalid' })).toThrow()
  expect(query(db, 'runs', { package: '.', status: 'blocked' })).toEqual([])
  expect(query(db, 'findings', { package: 'packages/other', run: audit.run_id })).toEqual([])
})

test('coverage distinguishes no findings, partial API review, missing checks, exclusions and no scan', () => {
  const db = database()
  const audit = run(db, {
    status: 'blocked',
    coverage: [
      unit('clean', 'reviewed_no_findings', 'reviewed_no_findings'),
      unit('api', 'reviewed_no_findings', 'partial'),
      unit('excluded', 'excluded', 'excluded', { reason: 'Generated code' }),
      { unit_id: 'missing', file_path: 'src/missing.ts' },
    ],
    remaining_work: [
      { kind: 'lead', text: 'Verify cache invalidation', file_path: 'src/api.ts' },
      { kind: 'blocker', text: 'scc unavailable', file_path: null },
    ],
  })
  const input = { package: '.', run: audit.run_id }
  expect(query(db, 'next-review', input).map((row) => row.unit_id)).toEqual([
    'api',
    'excluded',
    'missing',
  ])
  expect(query(db, 'next-review', input)[2]).toMatchObject({
    implementation: 'unreviewed',
    api: 'unreviewed',
  })
  expect(query(db, 'hotspots', input)).toEqual([])
  expect(query(db, 'summary', input)).toEqual(
    expect.arrayContaining([
      { dimension: 'implementation', bucket: 'reviewed_no_findings', count: 2 },
      { dimension: 'api', bucket: 'partial', count: 1 },
      { dimension: 'implementation', bucket: 'excluded', count: 1 },
      { dimension: 'findings', bucket: 'recorded_assessments', count: 0 },
    ]),
  )
  expect(query(db, 'needs-verification', input)).toEqual([
    expect.objectContaining({
      kind: 'lead',
      finding_id: null,
      confidence: null,
      detail: 'Verify cache invalidation',
    }),
  ])
  const report = db.refreshReport('source-audit-overview').rendered_markdown
  expect(report).toContain('No scan artifact.')
  expect(report).toContain('blocked')
  expect(report).not.toContain('Stored summary:')
  expect(report).toContain('No findings recorded as evaluated in this run.')
  expect(db.refreshReport('source-audit-review-queue').rendered_markdown).toContain(
    'scc unavailable',
  )
})

test('historical observations retain evidence/ratings and reports select latest runs per package', () => {
  const db = database()
  const old = run(db, {
    run_id: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-09-01T00:00:00.000Z',
  })
  const current = run(db, {
    run_id: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-09-01T00:00:00.000Z',
    worktree_dirty: true,
    worktree_notes: 'Changed src/read.ts',
    summary: '<img src=x> [link](javascript:alert(1)) | *theme*',
    scan_command: 'scc src --by-file --format csv > .audit/run.csv',
    scan_artifact: '.audit/run.csv',
    complexity_hotspots: [
      {
        file_path: 'src/read.ts',
        complexity: 42,
        lines: 200,
        priority: 'high',
        reason: 'Critical path',
      },
      { file_path: 'src/tiny.ts', complexity: 1, lines: 5, priority: 'low', reason: null },
    ],
    coverage: [unit('read', 'reviewed_with_findings', 'partial')],
  })
  const other = run(db, { package_path: 'packages/other', status: 'blocked' })
  const issue = finding(db, old)
  const unrechecked = finding(db, old, { title: 'Old unchecked' })
  observe(db, old, issue)
  observe(db, old, unrechecked)
  db.updateRow('source_audit_findings', issue.finding_id, {
    severity: 'medium',
    confidence: 'high',
    evidence: 'Later evidence',
    last_checked_run_id: current.run_id,
    notes: 'Reassessed workload assumption.',
    _expected_revision: 1,
  })
  observe(db, current, db.getRow('source_audit_findings', issue.finding_id))
  const otherIssue = finding(db, other, { title: 'OTHER PACKAGE ONLY' })
  observe(db, other, otherIssue)
  expect(query(db, 'runs', { package: '.' }).map((row) => row.run_id)).toEqual([
    current.run_id,
    old.run_id,
  ])
  expect(
    query(db, 'findings', { package: '.', run: old.run_id }).find(
      (row) => row.finding_id === issue.finding_id,
    ),
  ).toMatchObject({
    severity: 'high',
    evidence: assessment.evidence,
    assessed_run_id: old.run_id,
    assessment_scope: 'recorded_run',
  })
  expect(query(db, 'findings', { package: '.', run: current.run_id })).toEqual([
    expect.objectContaining({
      finding_id: issue.finding_id,
      severity: 'medium',
      evidence: 'Later evidence',
    }),
  ])
  expect(query(db, 'summary', { package: '.', run: old.run_id })).toContainEqual({
    dimension: 'severity',
    bucket: 'high',
    count: 2,
  })
  expect(query(db, 'needs-verification', { package: '.', run: old.run_id })).toHaveLength(2)
  expect(query(db, 'needs-verification', { package: '.', run: current.run_id })).toEqual([])
  expect(query(db, 'hotspots', { package: '.', run: current.run_id })[0]).toMatchObject({
    file_path: 'src/read.ts',
    complexity: 42,
    lines: 200,
  })
  const overview = db.refreshReport('source-audit-overview').rendered_markdown
  expect(overview).toContain('dirty worktree: yes')
  expect(overview).toContain('Stored summary: &lt;img')
  expect(overview).not.toContain('[link](')
  expect(overview).not.toContain('<img')
  expect(overview).toContain('## Package: packages/other')
  const report = db.refreshReport('source-audit-findings').rendered_markdown
  const firstPackage = report.split('## Package: packages/other')[0]!
  expect(firstPackage).not.toContain('OTHER PACKAGE ONLY')
  expect(firstPackage).toContain('Later evidence')
  expect(firstPackage).toContain('Old unchecked')
  expect(firstPackage).toContain('Current findings not recorded as checked in this run')
  expect(db.refreshReport('source-audit-review-queue').rendered_markdown).toContain('Critical path')
  const before = db.listRows('source_audit_runs', 100, 0)
  expect(db.refreshReport('source-audit-overview').rendered_markdown).toBe(overview)
  expect(db.listRows('source_audit_runs', 100, 0)).toEqual(before)
})

test('query and report failures roll back fresh creation and existing schema imports', () => {
  const template = readTemplate('source-audit')
  const target = workspace()
  const invalid = {
    ...template.queries![0]!,
    sql: 'SELECT missing FROM source_audit_runs',
    parameters: [],
  }
  expect(() =>
    SiloDatabase.createWithSchema(
      target,
      schemaFromTemplate('source-audit', template),
      template.reports,
      [invalid],
    ),
  ).toThrow(/missing/)
  expect(existsSync(target.databasePath)).toBe(false)
  const db = SiloDatabase.createWithSchema(target, emptySchema())
  databases.push(db)
  const before = db.getSchema()
  expect(() =>
    db.importTemplate('source-audit', { ...template, queries: [template.queries![0]!, invalid] }),
  ).toThrow(/Duplicate/)
  expect(() =>
    db.importTemplate('source-audit', {
      ...template,
      queries: [{ ...invalid, name: 'audit-invalid' }],
    }),
  ).toThrow(/missing/)
  expect(db.getSchema()).toEqual(before)
  expect(db.listSavedQueries()).toEqual([])
  expect(db.listReports()).toEqual([])
  expect(() =>
    db.importTemplate('source-audit', {
      ...template,
      reports: [
        { slug: 'audit-broken', title: 'Broken', script: 'throw new Error("render failed")' },
      ],
    }),
  ).toThrow(/render failed/)
  expect(db.getSchema()).toEqual(before)
  expect(db.listSavedQueries()).toEqual([])
  expect(db.listReports()).toEqual([])
  // A corrected import works after rollback, including report query dependencies.
  db.importTemplate('source-audit', template)
  expect(db.listSavedQueries()).toHaveLength(6)
})

test('hotspot priority advances pending units and fully reviewed inventories remain explicit', () => {
  const db = database()
  const audit = run(db, {
    scan_artifact: '.audit/scan.csv',
    coverage: [
      unit('a', 'partial', 'partial'),
      unit('z', 'partial', 'partial', { priority: 'low' }),
      unit('clean', 'reviewed_no_findings', 'not_applicable', { reason: 'Internal module' }),
    ],
    complexity_hotspots: [
      {
        file_path: 'src/z.ts',
        priority: 'high',
        complexity: null,
        lines: 10,
        reason: 'Entry point',
      },
    ],
  })
  const input = { package: '.', run: audit.run_id }
  expect(query(db, 'next-review', input).map((row) => row.unit_id)).toEqual(['z', 'a'])
  expect(query(db, 'hotspots', input)[0]).toMatchObject({ complexity: null, lines: 10 })
  db.updateRow('source_audit_runs', audit.run_id, {
    coverage: [unit('clean', 'reviewed_no_findings', 'reviewed_no_findings')],
    _expected_revision: 1,
  })
  expect(query(db, 'next-review', input)).toEqual([])
  expect(query(db, 'summary', input)).toContainEqual({
    dimension: 'inventory',
    bucket: 'recorded_units',
    count: 1,
  })
  expect(query(db, 'summary', input)).toContainEqual({
    dimension: 'api',
    bucket: 'reviewed_no_findings',
    count: 1,
  })
  const empty = run(db, { package_path: 'packages/empty', commit_sha: 'f'.repeat(64) })
  expect(query(db, 'summary', { package: 'packages/empty', run: empty.run_id })).toContainEqual({
    dimension: 'inventory',
    bucket: 'recorded_units',
    count: 0,
  })
  expect(db.refreshReport('source-audit-overview').rendered_markdown).toContain(
    'No inventory recorded; coverage is unknown.',
  )
})

test('reports retain truncation notices when the returned hotspot subset is fully covered', () => {
  const db = database()
  const hotspots = Array.from({ length: 501 }, (_, i) => ({
    file_path: `src/unit-${i}.ts`,
    complexity: 501 - i,
    lines: 1000,
    priority: 'high',
    reason: 'Review signal',
  }))
  run(db, {
    scan_artifact: '.audit/scan.csv',
    complexity_hotspots: hotspots,
    coverage: hotspots
      .slice(0, 500)
      .map((_, i) => unit(`unit-${i}`, 'reviewed_no_findings', 'reviewed_no_findings')),
  })
  const report = db.refreshReport('source-audit-review-queue').rendered_markdown
  expect(report).toContain('No uncovered high-priority hotspots in the returned scan rows.')
  expect(report).toContain('Results truncated at 500 rows; use narrower typed queries.')
  expect(db.refreshReport('source-audit-overview').rendered_markdown).toContain(
    'Showing the first 10 hotspots; use source-audit-hotspots for more.',
  )
})
