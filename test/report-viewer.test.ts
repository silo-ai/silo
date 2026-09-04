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
  database.putSavedQuery({
    name: 'metric-count',
    description: 'Count all metric samples.',
    sql: 'SELECT count(*) AS samples FROM metrics',
  })
  database.putReport({
    slug: 'metrics-brief',
    title: 'Metrics brief',
    script:
      "const count = silo.query('metric-count')\nreturn '# Metrics brief\\n\\n' + markdown.table(count)",
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

  test('can omit the report-authored title when the viewer owns the page heading', () => {
    const html = renderReportHtml('# Viewer title\n\n## Details', { hideFirstHeading: true })
    expect(html).not.toContain('Viewer title')
    expect(html).toContain('<h2>Details</h2>')
  })

  test('moves report metadata into a trailing table and formats column names', () => {
    const html = renderReportHtml(
      '# Wave status\n\nRun: wave-123\n\nShared Silo table: wave_rows\n\nSource catalog revision: abc\n\nEach assignment is complete when it contains 10 review rows: five source questions.\n\n---\n\n## Overall progress\n\n| wave | assignments_complete | TOTAL_WAVES |\n| --- | --- | --- |\n| 1 | 2/3 | 3 |',
      { hideFirstHeading: true, moveMetadata: true },
    )

    expect(html.indexOf('<h2>Overall progress</h2>')).toBeLessThan(
      html.indexOf('<h2>Report metadata</h2>'),
    )
    expect(html).toContain('<th>Wave</th>')
    expect(html).toContain('<th>Assignments Complete</th>')
    expect(html).toContain('<th>Total Waves</th>')
    expect(html).toContain('<td>Run</td>')
    expect(html).toContain('<td>Note</td>')
    expect(html).not.toContain('<p>Run: wave-123</p>')
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
    expect(html).toContain('Report script')
    expect(html).toContain('metric-count')
    expect(html).toContain('data-report-view="report"')
    expect(html).toContain('data-report-view="script"')
    expect(html).toContain('class="language-javascript"')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('aria-label="Last refreshed"')
    expect(html).not.toContain('site-header')
    expect(html).not.toContain('>Slug<')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(html).toContain('Metrics brief')
    expect(html).toContain("window.addEventListener('focus'")
    expect(html).toContain("document.addEventListener('visibilitychange'")
    expect(html).toContain('refresh();')

    const css = await fetch(`${origin}/report-viewer.css`)
    expect(css.headers.get('content-type')).toContain('text/css')
    const cssText = await css.text()
    expect(cssText).toContain('.report-markdown')
    expect(cssText).toContain('justify-content: flex-start')
    expect(cssText).toContain('grid-template-columns')
    expect(cssText).toContain('scroll-padding-inline')
    expect(cssText).toContain('padding-bottom: 1rem')
    expect(cssText).not.toContain('text-transform: uppercase')

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
    const body = (await refreshed.json()) as {
      html: string
      source_html: string
      refreshed_at: string
    }
    expect(refreshed.status).toBe(200)
    expect(body.html).toContain('<td>2</td>')
    expect(body.source_html).toContain('metric-count')
    expect(new Date(body.refreshed_at).toString()).not.toBe('Invalid Date')
  })
})
