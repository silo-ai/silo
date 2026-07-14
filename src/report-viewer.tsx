import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SiloDatabase } from './database.js'
import { exits, SiloError } from './model.js'
import type { StoredReport } from './report.js'
import type { Workspace } from './workspace.js'

const stylesheet = readFileSync(new URL('./report-viewer.css', import.meta.url), 'utf8')

function ReportMarkdown({ markdown }: { markdown: string }): React.ReactNode {
  return (
    <div className="report-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

export function renderReportHtml(markdown: string): string {
  return renderToStaticMarkup(<ReportMarkdown markdown={markdown} />)
}

function ReportQueries({ queries }: { queries: StoredReport['queries'] }): React.ReactNode {
  return (
    <details className="query-panel">
      <summary>Report queries ({queries.length})</summary>
      <div className="query-list">
        {queries.map((query) => (
          <section key={query.name}>
            <h3>{query.name}</h3>
            {'sql' in query ? (
              <pre>
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
                  <pre>
                    <code>{JSON.stringify(query.parameters, null, 2)}</code>
                  </pre>
                )}
              </>
            )}
          </section>
        ))}
      </div>
    </details>
  )
}

function renderReportQueries(queries: StoredReport['queries']): string {
  return renderToStaticMarkup(<ReportQueries queries={queries} />)
}

function clientScript(slug: string, token: string): string {
  return `
const slug = ${JSON.stringify(slug)};
const token = ${JSON.stringify(token)};
const content = document.querySelector('[data-report-content]');
const status = document.querySelector('[data-refresh-status]');
const refreshed = document.querySelector('[data-refreshed-at]');
const error = document.querySelector('[data-refresh-error]');
const reportTitle = document.querySelector('[data-report-title]');
const reportQueries = document.querySelector('[data-saved-queries]');
let refreshRequest;

function displayTime(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

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
if (reportQueries.innerHTML !== body.queries_html) reportQueries.innerHTML = body.queries_html;
    document.title = body.title + ' · Silo';
    refreshed.dateTime = body.refreshed_at;
    refreshed.textContent = displayTime(body.refreshed_at);
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
        <link rel="stylesheet" href="/report-viewer.css" />
      </head>
      <body data-refresh-state={report.last_refresh_error ? 'stale' : 'current'}>
        <header className="site-header">
          <a className="brand" href={`/reports/${encodeURIComponent(report.slug)}`}>
            <span className="brand-mark" aria-hidden="true">
              S
            </span>
            <span>Silo report</span>
          </a>
          <div className="refresh-state" aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            <span data-refresh-status>
              {report.last_refresh_error ? 'Showing last good result' : 'Current'}
            </span>
          </div>
        </header>
        <div className="page-shell">
          <main className="report-card" data-report-content>
            <ReportMarkdown markdown={report.rendered_markdown} />
          </main>
          <aside className="report-sidebar" aria-label="Report details">
            <section className="metadata-card">
              <p className="eyebrow">Report</p>
              <h2 data-report-title>{report.title}</h2>
              <dl>
                <div>
                  <dt>Slug</dt>
                  <dd>
                    <code>{report.slug}</code>
                  </dd>
                </div>
                <div>
                  <dt>Last refreshed</dt>
                  <dd>
                    <time dateTime={report.refreshed_at} data-refreshed-at>
                      {new Date(report.refreshed_at).toLocaleString()}
                    </time>
                  </dd>
                </div>
              </dl>
              <p
                className="refresh-error"
                role="alert"
                data-refresh-error
                hidden={!report.last_refresh_error}
              >
                {report.last_refresh_error}
              </p>
            </section>
            <div data-saved-queries>
              <ReportQueries queries={report.queries} />
            </div>
          </aside>
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
          `default-src 'none'; style-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
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
              html: renderReportHtml(report.rendered_markdown),
              title: report.title,
              queries_html: renderReportQueries(report.queries),
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
