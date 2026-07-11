import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { SiloDatabase, emptySchema } from '../src/database.js'
import {
  renderReportHtml,
  startReportViewer,
  type ReportViewerServer,
} from '../src/report-viewer.js'
import { parseTable } from '../src/schema.js'
import type { Workspace } from '../src/workspace.js'

const roots: string[] = []
const viewers: ReportViewerServer[] = []

afterEach(async () => {
  await Promise.all(viewers.splice(0).map((viewer) => viewer.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'silo-viewer-test-'))
  roots.push(root)
  return {
    root,
    identity: 'github.com/acme/viewer',
    origin: 'git@github.com:acme/viewer.git',
    databasePath: join(root, 'viewer.sqlite'),
  }
}

function createReport(target: Workspace): void {
  const metrics = parseTable({
    name: 'metrics',
    comment: 'One metric sample.',
    columns: [
      { name: 'id', type: 'integer', nullable: false, comment: 'Metric sample identifier.' },
    ],
    primary_key: ['id'],
  })
  const database = SiloDatabase.createWithSchema(target, {
    ...emptySchema(),
    tables: [metrics],
  })
  database.addRows('metrics', { id: 1 })
  database.putReport({
    slug: 'metrics-brief',
    title: 'Metrics brief',
    markdown: '# Metrics brief\n\n{{silo-query:count}}',
    queries: [{ name: 'count', sql: 'SELECT count(*) AS samples FROM metrics' }],
  })
  database.close()
}

describe('report viewer', () => {
  test('renders GFM without executing report-authored HTML', () => {
    const html = renderReportHtml(
      '# Safe report\n\n<script>alert("unsafe")</script>\n\n| Item | Value |\n| --- | --- |\n| A | 1 |',
    )
    expect(html).toContain('<h1>Safe report</h1>')
    expect(html).toContain('<table>')
    expect(html).not.toContain('<script')
  })

  test('serves stale-first HTML and protects focus-triggered refreshes', async () => {
    const target = workspace()
    createReport(target)
    const viewer = await startReportViewer(target, 'metrics-brief', { launchBrowser: false })
    viewers.push(viewer)
    const origin = new URL(viewer.url).origin

    const page = await fetch(viewer.url)
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(html).toContain('Metrics brief')
    expect(html).toContain("window.addEventListener('focus'")
    expect(html).toContain("document.addEventListener('visibilitychange'")
    expect(html).toContain('refresh();')

    const css = await fetch(`${origin}/report-viewer.css`)
    expect(css.headers.get('content-type')).toContain('text/css')
    expect(await css.text()).toContain('.report-markdown')

    const rejected = await fetch(`${origin}/api/reports/metrics-brief/refresh`, {
      method: 'POST',
      headers: { 'x-silo-token': viewer.token },
    })
    expect(rejected.status).toBe(403)

    const database = SiloDatabase.open(target, true)
    database.addRows('metrics', { id: 2 })
    database.close()
    const refreshed = await fetch(`${origin}/api/reports/metrics-brief/refresh`, {
      method: 'POST',
      headers: { origin, 'x-silo-token': viewer.token },
    })
    const body = (await refreshed.json()) as { html: string; refreshed_at: string }
    expect(refreshed.status).toBe(200)
    expect(body.html).toContain('<td>2</td>')
    expect(new Date(body.refreshed_at).toString()).not.toBe('Invalid Date')
  })
})
