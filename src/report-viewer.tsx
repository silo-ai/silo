import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SiloDatabase } from './database.js'
import { exits, SiloError } from './model.js'
import type { StoredReport } from './report.js'
import type { Workspace } from './workspace.js'

const stylesheet = readFileSync(new URL('./report-viewer.css', import.meta.url), 'utf8')
hljs.registerLanguage('javascript', javascript)

function formatRelativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'Unknown'

  const elapsedSeconds = (timestamp - now) / 1000
  if (Math.abs(elapsedSeconds) < 45) return 'Just now'

  const units = [
    { name: 'year', seconds: 31_536_000 },
    { name: 'month', seconds: 2_592_000 },
    { name: 'week', seconds: 604_800 },
    { name: 'day', seconds: 86_400 },
    { name: 'hour', seconds: 3_600 },
    { name: 'minute', seconds: 60 },
  ] as const
  const unit = units.find(({ seconds }) => Math.abs(elapsedSeconds) >= seconds) ?? units.at(-1)!

  return new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(
    Math.round(elapsedSeconds / unit.seconds),
    unit.name,
  )
}

function titleCaseColumnName(value: string): string {
  if (!/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/.test(value)) return value
  return value
    .split('_')
    .map((word) => `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(' ')
}

function formatColumnHeading(children: React.ReactNode): React.ReactNode {
  const content = React.Children.toArray(children)
  return content.length === 1 && typeof content[0] === 'string'
    ? titleCaseColumnName(content[0])
    : children
}

function tableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function moveMetadataIntro(markdown: string): string {
  const title = /^\s*#[ \t]+[^\r\n]+/.exec(markdown)
  if (!title || title.index === undefined) return markdown

  const afterTitle = markdown.slice(title.index + title[0].length)
  const firstSection = /^##[ \t]+[^\r\n]+/m.exec(afterTitle)
  if (!firstSection || firstSection.index === undefined) return markdown

  const intro = afterTitle.slice(0, firstSection.index).trim()
  const blocks = intro
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block && !/^(?:---+|\*\*\*+|___+)\s*$/.test(block))
  if (!blocks.length) return markdown

  const rows: [string, string][] = blocks.map((block) => {
    const labeled = /^([^:\n]+):\s*([\s\S]+)$/.exec(block)
    return labeled && labeled[1]!.trim().length <= 48
      ? [labeled[1]!.trim(), labeled[2]!.trim()]
      : ['Note', block]
  })
  const labeledRows = rows.filter(([label]) => label !== 'Note')
  if (!labeledRows.length || rows.length - labeledRows.length > 1) return markdown

  const report = afterTitle.slice(firstSection.index).trim()
  const metadata = [
    '## Report metadata',
    '',
    '| Metadata | Value |',
    '| --- | --- |',
    ...rows.map(([label, value]) => `| ${tableCell(label)} | ${tableCell(value)} |`),
  ].join('\n')
  return `${title[0].trim()}\n\n${report}\n\n---\n\n${metadata}`
}

function ReportMarkdown({
  markdown,
  hideFirstHeading = false,
  moveMetadata = false,
}: {
  markdown: string
  hideFirstHeading?: boolean
  moveMetadata?: boolean
}): React.ReactNode {
  let firstHeading = true
  const preparedMarkdown = moveMetadata ? moveMetadataIntro(markdown) : markdown

  return (
    <div className="report-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          table: ({ node: _node, children, ...props }) => (
            <div className="report-table">
              <table {...props}>{children}</table>
            </div>
          ),
          th: ({ node: _node, children, ...props }) => (
            <th {...props}>{formatColumnHeading(children)}</th>
          ),
          ...(hideFirstHeading
            ? {
                h1: ({ node: _node, children, ...props }) => {
                  if (firstHeading) {
                    firstHeading = false
                    return null
                  }
                  return <h1 {...props}>{children}</h1>
                },
              }
            : {}),
        }}
      >
        {preparedMarkdown}
      </ReactMarkdown>
    </div>
  )
}

export function renderReportHtml(
  markdown: string,
  options: { hideFirstHeading?: boolean; moveMetadata?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <ReportMarkdown
      markdown={markdown}
      hideFirstHeading={options.hideFirstHeading}
      moveMetadata={options.moveMetadata}
    />,
  )
}

function LegacyReportQueries({
  queries,
}: {
  queries: Extract<StoredReport, { queries: unknown }>['queries']
}): React.ReactNode {
  return (
    <div className="query-list">
      {queries.map((query) => (
        <section key={query.name}>
          <h2>{query.name}</h2>
          {'sql' in query ? (
            <pre className="source-code">
              <code>{query.sql}</code>
            </pre>
          ) : (
            <>
              <p>
                Saved query: <code>{query.saved_query}</code>
              </p>
              <p>Parameters:</p>
              {query.parameters === undefined ? (
                <p>
                  <em>Uses declared defaults only.</em>
                </p>
              ) : (
                <pre className="source-code">
                  <code>{JSON.stringify(query.parameters, null, 2)}</code>
                </pre>
              )}
            </>
          )}
        </section>
      ))}
    </div>
  )
}

function ReportSource({ report }: { report: StoredReport }): React.ReactNode {
  if ('script' in report)
    return (
      <pre className="source-code">
        <code
          className="language-javascript"
          dangerouslySetInnerHTML={{
            __html: hljs.highlight(report.script, { language: 'javascript' }).value,
          }}
        />
      </pre>
    )
  return <LegacyReportQueries queries={report.queries} />
}

function renderReportSource(report: StoredReport): string {
  return renderToStaticMarkup(<ReportSource report={report} />)
}

function clientScript(slug: string, token: string): string {
  return `
const slug = ${JSON.stringify(slug)};
const token = ${JSON.stringify(token)};
const content = document.querySelector('[data-report-body]');
const status = document.querySelector('[data-refresh-status]');
const refreshed = document.querySelector('[data-refreshed-at]');
const error = document.querySelector('[data-refresh-error]');
const reportTitle = document.querySelector('[data-report-title]');
const reportSource = document.querySelector('[data-report-source]');
const viewButtons = [...document.querySelectorAll('[data-report-view]')];
const viewPanels = [...document.querySelectorAll('[data-report-panel]')];
let refreshRequest;

function displayRelativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const elapsedSeconds = (timestamp - Date.now()) / 1000;
  if (Math.abs(elapsedSeconds) < 45) return 'Just now';
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60]
  ];
  const unit = units.find((entry) => Math.abs(elapsedSeconds) >= entry[1]) || units[units.length - 1];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(
    Math.round(elapsedSeconds / unit[1]),
    unit[0]
  );
}

function selectView(view) {
  viewButtons.forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.reportView === view));
  });
  viewPanels.forEach((panel) => {
    panel.hidden = panel.dataset.reportPanel !== view;
  });
}

viewButtons.forEach((button) => {
  button.addEventListener('click', () => selectView(button.dataset.reportView));
});
selectView('report');

async function refresh() {
  if (refreshRequest) return refreshRequest;
  document.body.dataset.refreshState = 'refreshing';
  status.textContent = 'Refreshing…';
  error.hidden = true;
  refreshRequest = fetch('/api/reports/' + encodeURIComponent(slug) + '/refresh', {
    method: 'POST',
    headers: { 'x-silo-token': token }
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || 'Refresh failed.');
    content.innerHTML = body.html;
    reportTitle.textContent = body.title;
    if (reportSource.innerHTML !== body.source_html) reportSource.innerHTML = body.source_html;
    document.title = body.title + ' · Silo';
    refreshed.dateTime = body.refreshed_at;
    refreshed.textContent = displayRelativeTime(body.refreshed_at);
    status.textContent = 'Current';
    document.body.dataset.refreshState = 'current';
  }).catch((cause) => {
    status.textContent = 'Showing last good result';
    error.textContent = cause instanceof Error ? cause.message : String(cause);
    error.hidden = false;
    document.body.dataset.refreshState = 'stale';
  }).finally(() => {
    refreshRequest = undefined;
  });
  return refreshRequest;
}

setInterval(() => {
  refreshed.textContent = displayRelativeTime(refreshed.dateTime);
}, 30000);

window.addEventListener('focus', () => {
  if (!document.hidden) refresh();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
refresh();
`
}

function reportDocument(report: StoredReport, token: string, nonce: string): string {
  const script = clientScript(report.slug, token)
  const body = (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{`${report.title} · Silo`}</title>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wdth,wght@6..144,75..100,400..700&display=swap"
        />
        <link rel="stylesheet" href="/report-viewer.css" />
      </head>
      <body data-refresh-state={report.last_refresh_error ? 'stale' : 'current'}>
        <div className="page-shell">
          <main className="report-card">
            <header className="report-heading">
              <div className="report-heading-nav">
                <nav className="report-nav" aria-label="Report views">
                  <div role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected="true"
                      aria-controls="report-view"
                      data-report-view="report"
                    >
                      Report
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected="false"
                      aria-controls="script-view"
                      aria-label="Report script"
                      data-report-view="script"
                    >
                      Script
                    </button>
                  </div>
                </nav>
              </div>
              <h1 data-report-title>{report.title}</h1>
              <div className="report-meta">
                <time dateTime={report.refreshed_at} data-refreshed-at aria-label="Last refreshed">
                  {formatRelativeTime(report.refreshed_at)}
                </time>
                <span className="refresh-state" aria-live="polite">
                  <span className="status-dot" aria-hidden="true" />
                  <span data-refresh-status>
                    {report.last_refresh_error ? 'Showing last good result' : 'Current'}
                  </span>
                </span>
              </div>
              <p
                className="refresh-error"
                role="alert"
                data-refresh-error
                hidden={!report.last_refresh_error}
              >
                {report.last_refresh_error}
              </p>
            </header>
            <div
              id="report-view"
              className="report-panel"
              role="tabpanel"
              aria-label="Report"
              data-report-panel="report"
              data-report-body
              data-report-content
            >
              <ReportMarkdown markdown={report.rendered_markdown} hideFirstHeading moveMetadata />
            </div>
            <div
              id="script-view"
              className="report-panel report-source-panel"
              role="tabpanel"
              aria-label="Report script"
              data-report-panel="script"
              data-report-source
              hidden
            >
              <ReportSource report={report} />
            </div>
          </main>
        </div>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: script }} />
      </body>
    </html>
  )
  return `<!doctype html>${renderToStaticMarkup(body)}`
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function closeDatabase<T>(database: SiloDatabase, action: (database: SiloDatabase) => T): T {
  try {
    return action(database)
  } finally {
    database.close()
  }
}

async function launch(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? { executable: 'open', args: [url] }
      : process.platform === 'win32'
        ? { executable: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
        : { executable: 'xdg-open', args: [url] }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export interface ReportViewerServer {
  server: Server
  url: string
  token: string
  close(): Promise<void>
}

export async function startReportViewer(
  workspace: Workspace,
  slug: string,
  options: { launchBrowser?: boolean } = {},
): Promise<ReportViewerServer> {
  closeDatabase(SiloDatabase.open(workspace), (database) => database.getReport(slug))
  const token = randomBytes(32).toString('base64url')
  const nonce = randomBytes(24).toString('base64url')
  let origin = ''
  const reportPath = `/reports/${encodeURIComponent(slug)}`
  const refreshPath = `/api/reports/${encodeURIComponent(slug)}/refresh`
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin)
      if (request.method === 'GET' && url.pathname === '/report-viewer.css') {
        send(response, 200, 'text/css; charset=utf-8', stylesheet)
        return
      }
      if (request.method === 'GET' && url.pathname === reportPath) {
        const report = closeDatabase(SiloDatabase.open(workspace), (database) =>
          database.getReport(slug),
        )
        const html = reportDocument(report, token, nonce)
        response.setHeader(
          'content-security-policy',
          `default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        )
        response.setHeader('x-content-type-options', 'nosniff')
        response.setHeader('referrer-policy', 'no-referrer')
        send(response, 200, 'text/html; charset=utf-8', html)
        return
      }
      if (request.method === 'POST' && url.pathname === refreshPath) {
        if (
          request.headers.host !== new URL(origin).host ||
          request.headers.origin !== origin ||
          !sameToken(
            Array.isArray(request.headers['x-silo-token'])
              ? request.headers['x-silo-token'][0]
              : request.headers['x-silo-token'],
            token,
          )
        ) {
          send(
            response,
            403,
            'application/json; charset=utf-8',
            JSON.stringify({ error: { message: 'Refresh request rejected.' } }),
          )
          return
        }
        try {
          const report = closeDatabase(SiloDatabase.open(workspace, true), (database) =>
            database.refreshReport(slug),
          )
          send(
            response,
            200,
            'application/json; charset=utf-8',
            JSON.stringify({
              html: renderReportHtml(report.rendered_markdown, {
                hideFirstHeading: true,
                moveMetadata: true,
              }),
              title: report.title,
              source_html: renderReportSource(report),
              refreshed_at: report.refreshed_at,
            }),
          )
        } catch (error) {
          const silo =
            error instanceof SiloError
              ? error
              : new SiloError(
                  exits.io,
                  'unexpected_error',
                  error instanceof Error ? error.message : String(error),
                )
          send(
            response,
            silo.exitCode === exits.notFound ? 404 : silo.exitCode === exits.input ? 400 : 500,
            'application/json; charset=utf-8',
            JSON.stringify({ error: { code: silo.code, message: silo.message } }),
          )
        }
        return
      }
      send(response, 404, 'text/plain; charset=utf-8', 'Not found.\n')
    })().catch((error) => {
      if (!response.headersSent)
        send(
          response,
          500,
          'application/json; charset=utf-8',
          JSON.stringify({
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
        )
      else response.destroy(error instanceof Error ? error : undefined)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new SiloError(
      exits.io,
      'viewer_address_unavailable',
      'Could not resolve the viewer address.',
    )
  }
  origin = `http://127.0.0.1:${address.port}`
  const url = `${origin}${reportPath}`
  if (options.launchBrowser !== false) {
    try {
      await launch(url)
    } catch (error) {
      server.close()
      throw new SiloError(
        exits.io,
        'browser_open_failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  return {
    server,
    url,
    token,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
