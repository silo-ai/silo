import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import { format as formatJavaScript } from 'prettier'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SiloDatabase } from './database.js'
import { exits, SiloError } from './model.js'
import type { StoredReport } from './report.js'
import type { Workspace } from './workspace.js'

const stylesheet = readFileSync(new URL('./report-viewer.css', import.meta.url), 'utf8')

function readOptionalFile(url: URL): string | undefined {
  try {
    return readFileSync(url, 'utf8')
  } catch {
    return undefined
  }
}

const pretextScript =
  readOptionalFile(new URL('./report-viewer-pretext.mjs', import.meta.url)) ??
  readOptionalFile(new URL('../dist/report-viewer-pretext.mjs', import.meta.url))

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

function ReportSource({
  report,
  script,
}: {
  report: StoredReport
  script?: string
}): React.ReactNode {
  if ('script' in report)
    return (
      <pre className="source-code">
        <code
          className="language-javascript"
          dangerouslySetInnerHTML={{
            __html: hljs.highlight(script ?? report.script, { language: 'javascript' }).value,
          }}
        />
      </pre>
    )
  return <LegacyReportQueries queries={report.queries} />
}

async function formatReportScript(script: string): Promise<string> {
  try {
    return await formatJavaScript(script, { parser: 'babel' })
  } catch {
    return script
  }
}

async function renderReportSource(report: StoredReport): Promise<string> {
  const script = 'script' in report ? await formatReportScript(report.script) : undefined
  return renderToStaticMarkup(<ReportSource report={report} script={script} />)
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
const reportToc = document.querySelector('[data-report-toc-container]');
const tocToggle = document.querySelector('[data-report-toc-toggle]');
const reportTocMenu = document.querySelector('[data-report-toc-menu]');
const tocList = document.querySelector('[data-report-toc-list]');
const tocCorridor = document.querySelector('[data-report-toc-corridor]');
const tocCorridorShape = document.querySelector('[data-report-toc-corridor-shape]');
let tocPinned = false;
let activeTocItem;
let tocHoverTimer;
let tocCorridorOrigin;
let tocPointer;
let tocSubmenuId = 0;
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

function setTocOpen(open) {
  if (!reportToc || !tocToggle) return;
  reportToc.dataset.open = String(open);
  tocToggle.setAttribute('aria-expanded', String(open));
  if (!open) closeTocSubmenus();
}

function directTocChild(item, selector) {
  return [...item.children].find((child) => child.matches(selector));
}

function directTocLink(item) {
  return directTocChild(item, '[data-report-toc-link]');
}

function directTocSubmenu(item) {
  return directTocChild(item, '[data-report-toc-submenu]');
}

function parentTocItem(item) {
  return item.parentElement?.closest('[data-report-toc-item]') || null;
}

function tocItemHasChildren(item) {
  return Boolean(directTocSubmenu(item));
}

function tocOpenPath(item) {
  const path = new Set();
  let current = item;
  while (current) {
    if (tocItemHasChildren(current)) path.add(current);
    current = parentTocItem(current);
  }
  return path;
}

function tocOwnerWithSubmenu(item) {
  let current = item;
  while (current) {
    if (tocItemHasChildren(current)) return current;
    current = parentTocItem(current);
  }
  return null;
}

function clearTocHoverTimer() {
  if (tocHoverTimer === undefined) return;
  clearTimeout(tocHoverTimer);
  tocHoverTimer = undefined;
}

function hideTocCorridor() {
  if (!tocCorridor) return;
  tocCorridor.dataset.active = 'false';
  tocCorridor.style.left = '0px';
  tocCorridor.style.top = '0px';
  tocCorridor.style.width = '0px';
  tocCorridor.style.height = '0px';
  tocCorridorShape?.setAttribute('points', '0,0 0,0 0,0');
}

function setTocSubmenuPlacement(item) {
  const submenu = directTocSubmenu(item);
  if (!submenu) return;

  const itemRect = item.getBoundingClientRect();
  const submenuRect = submenu.getBoundingClientRect();
  const panelOverlap = 6;
  const viewportPadding = 8;
  const opensLeft =
    itemRect.right - panelOverlap + submenuRect.width > window.innerWidth - viewportPadding;
  item.dataset.reportTocSubmenuPlacement = opensLeft ? 'left' : 'right';
}

function setTocSubmenuVerticalPlacement(item) {
  const submenu = directTocSubmenu(item);
  if (!submenu) return;

  submenu.style.removeProperty('top');
  if (getComputedStyle(submenu).position === 'static') return;

  const itemRect = item.getBoundingClientRect();
  const submenuRect = submenu.getBoundingClientRect();
  const viewportPadding = 8;
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const minTop = viewportPadding;
  const maxTop = Math.max(minTop, viewportHeight - viewportPadding - submenuRect.height);
  const top = Math.min(Math.max(submenuRect.top, minTop), maxTop);
  if (top !== submenuRect.top) submenu.style.top = top - itemRect.top + 'px';
}

function updateOpenTocSubmenus() {
  tocList?.querySelectorAll('[data-report-toc-item][data-open="true"]').forEach((item) => {
    setTocSubmenuPlacement(item);
    setTocSubmenuVerticalPlacement(item);
  });
}

function updateTocCorridor() {
  if (!tocCorridor || !tocCorridorShape || !reportTocMenu || !activeTocItem || !tocCorridorOrigin) {
    hideTocCorridor();
    return;
  }

  const submenu = directTocSubmenu(activeTocItem);
  if (!submenu) {
    hideTocCorridor();
    return;
  }

  setTocSubmenuPlacement(activeTocItem);
  const menuRect = reportTocMenu.getBoundingClientRect();
  const submenuRect = submenu.getBoundingClientRect();
  if (!submenuRect.width || !submenuRect.height) {
    hideTocCorridor();
    return;
  }

  const opensLeft = activeTocItem.dataset.reportTocSubmenuPlacement === 'left';
  const targetX = opensLeft ? submenuRect.right : submenuRect.left;
  const padding = 8;
  const bounds = {
    left: Math.min(tocCorridorOrigin.x, targetX) - padding,
    top: Math.min(tocCorridorOrigin.y, submenuRect.top) - padding,
    right: Math.max(tocCorridorOrigin.x, targetX) + padding,
    bottom: Math.max(tocCorridorOrigin.y, submenuRect.bottom) + padding,
  };
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const targetTop = submenuRect.top - bounds.top;
  const targetBottom = submenuRect.bottom - bounds.top;
  const points = [
    [tocCorridorOrigin.x - bounds.left, tocCorridorOrigin.y - bounds.top],
    [targetX - bounds.left, targetTop],
    [targetX - bounds.left, targetBottom],
  ];

  tocCorridor.style.left = bounds.left - menuRect.left + 'px';
  tocCorridor.style.top = bounds.top - menuRect.top + 'px';
  tocCorridor.style.width = width + 'px';
  tocCorridor.style.height = height + 'px';
  tocCorridor.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  tocCorridorShape.setAttribute('points', points.map((point) => point.join(',')).join(' '));
  tocCorridor.dataset.active = 'true';
}

function pointInTriangle(point, first, second, third) {
  const sign = (a, b, c) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
  const firstSign = sign(point, first, second);
  const secondSign = sign(point, second, third);
  const thirdSign = sign(point, third, first);
  const hasNegative = firstSign < 0 || secondSign < 0 || thirdSign < 0;
  const hasPositive = firstSign > 0 || secondSign > 0 || thirdSign > 0;
  return !(hasNegative && hasPositive);
}

function pointInTocCorridor(point) {
  if (!activeTocItem || !tocCorridorOrigin) return false;
  const submenu = directTocSubmenu(activeTocItem);
  if (!submenu) return false;

  const submenuRect = submenu.getBoundingClientRect();
  if (
    point.x >= submenuRect.left &&
    point.x <= submenuRect.right &&
    point.y >= submenuRect.top &&
    point.y <= submenuRect.bottom
  )
    return false;

  const opensLeft = activeTocItem.dataset.reportTocSubmenuPlacement === 'left';
  const targetX = opensLeft ? submenuRect.right : submenuRect.left;
  const edgePadding = 8;
  return pointInTriangle(
    point,
    tocCorridorOrigin,
    { x: targetX, y: submenuRect.top - edgePadding },
    { x: targetX, y: submenuRect.bottom + edgePadding },
  );
}

function closeTocSubmenus() {
  clearTocHoverTimer();
  activeTocItem = undefined;
  tocCorridorOrigin = undefined;
  hideTocCorridor();
  tocList?.querySelectorAll('[data-report-toc-item]').forEach((item) => {
    item.dataset.open = 'false';
    directTocSubmenu(item)?.style.removeProperty('top');
    const link = directTocLink(item);
    if (tocItemHasChildren(item)) link?.setAttribute('aria-expanded', 'false');
    else link?.removeAttribute('aria-expanded');
  });
}

function setTocOpenPath(item) {
  if (!tocList) return;
  const openPath = tocOpenPath(item);
  tocList.querySelectorAll('[data-report-toc-item]').forEach((candidate) => {
    const open = openPath.has(candidate);
    candidate.dataset.open = String(open);
    if (tocItemHasChildren(candidate)) {
      directTocLink(candidate)?.setAttribute('aria-expanded', String(open));
    }
  });
  activeTocItem = tocOwnerWithSubmenu(item);
  updateOpenTocSubmenus();
  if (activeTocItem && tocCorridorOrigin && activeTocItem === item) {
    updateTocCorridor();
  } else {
    hideTocCorridor();
  }
}

function enterTocItem(item, pointer, force = false) {
  clearTocHoverTimer();
  const previousItem = activeTocItem;
  const remainsInPreviousBranch = previousItem && previousItem.contains(item);
  if (
    !force &&
    previousItem &&
    previousItem !== item &&
    !remainsInPreviousBranch &&
    pointInTocCorridor(pointer)
  ) {
    tocHoverTimer = window.setTimeout(() => {
      tocHoverTimer = undefined;
      if (activeTocItem === previousItem) enterTocItem(item, tocPointer || pointer, true);
    }, 280);
    return;
  }

  tocCorridorOrigin = tocItemHasChildren(item) ? pointer : undefined;
  setTocOpenPath(item);
}

function wireTocItem(item) {
  const link = directTocLink(item);
  item.addEventListener('pointerenter', (event) => {
    tocPointer = { x: event.clientX, y: event.clientY };
    enterTocItem(item, tocPointer);
  });
  const focusItem = () => {
    clearTocHoverTimer();
    tocCorridorOrigin = undefined;
    setTocOpenPath(item);
  };
  item.addEventListener('focusin', focusItem);
  link?.addEventListener('focus', focusItem);
}

function createTocSubmenu(item) {
  const link = directTocLink(item);
  const submenu = document.createElement('ul');
  submenu.className = 'report-toc-submenu';
  submenu.dataset.reportTocSubmenu = '';
  submenu.id = 'report-toc-submenu-' + ++tocSubmenuId;
  submenu.setAttribute('role', 'menu');
  submenu.setAttribute(
    'aria-label',
    'Sections under ' + (link?.textContent || 'this section'),
  );
  item.dataset.reportTocHasChildren = '';
  item.dataset.open = 'false';
  link?.setAttribute('aria-haspopup', 'menu');
  link?.setAttribute('aria-expanded', 'false');
  link?.setAttribute('aria-controls', submenu.id);
  item.append(submenu);
  return submenu;
}

function setTocMenuWidth() {
  if (!reportTocMenu || !tocList) return;
  const links = [...tocList.children]
    .map((item) => item.firstElementChild)
    .filter((link) => link?.matches('[data-report-toc-link]'));
  if (!links.length) {
    reportTocMenu.style.removeProperty('--report-toc-menu-width');
    return;
  }

  const measureLabelWidth = globalThis.siloReportViewerPretext?.measureLabelWidth;
  if (!measureLabelWidth) return;

  try {
    const linkStyle = getComputedStyle(links[0]);
    const font = [linkStyle.fontWeight, linkStyle.fontSize, linkStyle.fontFamily].join(' ');
    const letterSpacing = parseFloat(linkStyle.letterSpacing);
    const menuStyle = getComputedStyle(reportTocMenu);
    const menuPadding =
      (parseFloat(menuStyle.paddingLeft) || 0) + (parseFloat(menuStyle.paddingRight) || 0);
    let contentWidth = 0;

    links.forEach((link) => {
      const style = getComputedStyle(link);
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const maxLinkWidth = parseFloat(style.maxWidth);
      const maxLabelWidth = Number.isFinite(maxLinkWidth)
        ? Math.max(0, maxLinkWidth - paddingLeft - paddingRight)
        : Number.POSITIVE_INFINITY;
      const measuredWidth = Math.min(
        measureLabelWidth(link.textContent || '', font, Number.isFinite(letterSpacing) ? letterSpacing : 0),
        maxLabelWidth,
      );
      contentWidth = Math.max(contentWidth, measuredWidth + paddingLeft + paddingRight);
    });

    reportTocMenu.style.setProperty(
      '--report-toc-menu-width',
      Math.ceil(contentWidth + menuPadding) + 'px',
    );
  } catch {
    reportTocMenu.style.removeProperty('--report-toc-menu-width');
  }
}

function buildTableOfContents() {
  if (!content || !tocList) return;
  closeTocSubmenus();
  tocList.replaceChildren();
  const headings = [...content.querySelectorAll('h2, h3, h4, h5')];
  const usedIds = new Set();
  const stack = [];
  tocSubmenuId = 0;

  headings.forEach((heading, index) => {
    const label = heading.textContent.trim();
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section-' + (index + 1);
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) id = base + '-' + suffix++;
    usedIds.add(id);
    heading.id = id;

    const level = Number(heading.tagName.slice(1));
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1]?.item;
    const item = document.createElement('li');
    item.className = 'report-toc-item';
    item.dataset.reportTocItem = '';
    item.dataset.reportTocLevel = String(level);
    item.setAttribute('role', 'none');

    const link = document.createElement('a');
    link.className = 'report-toc-link';
    link.dataset.reportTocLink = '';
    link.dataset.reportTocLevel = String(level);
    link.href = '#' + id;
    link.setAttribute('role', 'menuitem');
    link.textContent = label || 'Untitled section';
    link.addEventListener('click', () => {
      selectView('report');
      tocPinned = false;
      setTocOpen(false);
    });

    item.append(link);
    wireTocItem(item);
    const targetList = parent ? directTocSubmenu(parent) || createTocSubmenu(parent) : tocList;
    targetList.append(item);
    stack.push({ level, item });
  });

  if (!headings.length) {
    const empty = document.createElement('li');
    empty.className = 'report-toc-empty';
    empty.setAttribute('role', 'none');
    empty.textContent = 'No sections';
    tocList.append(empty);
  }
  setTocMenuWidth();
}

function selectView(view) {
  viewButtons.forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.reportView === view));
  });
  viewPanels.forEach((panel) => {
    panel.hidden = panel.dataset.reportPanel !== view;
  });
  if (view !== 'report') {
    tocPinned = false;
    setTocOpen(false);
  }
}

viewButtons.forEach((button) => {
  button.addEventListener('click', () => selectView(button.dataset.reportView));
});
if (reportToc && tocToggle) {
  reportToc.addEventListener('mouseenter', () => setTocOpen(true));
  reportToc.addEventListener('mouseleave', () => {
    if (!tocPinned && !reportToc.matches(':focus-within')) setTocOpen(false);
  });
  reportToc.addEventListener('focusin', () => setTocOpen(true));
  document.addEventListener('pointermove', (event) => {
    tocPointer = { x: event.clientX, y: event.clientY };
    const item = event.target instanceof Element
      ? event.target.closest('[data-report-toc-item]')
      : null;
    if (item && activeTocItem?.contains(item)) clearTocHoverTimer();
  });
  reportToc.addEventListener('focusout', (event) => {
    if (!event.relatedTarget || !reportToc.contains(event.relatedTarget)) {
      if (!tocPinned) setTocOpen(false);
    }
  });
  reportToc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      tocPinned = false;
      setTocOpen(false);
      tocToggle.focus();
    }
  });
  tocToggle.addEventListener('click', () => {
    tocPinned = !tocPinned;
    setTocOpen(tocPinned);
  });
  document.addEventListener('click', (event) => {
    if (!reportToc.contains(event.target)) {
      tocPinned = false;
      setTocOpen(false);
    }
  });
}
selectView('report');
buildTableOfContents();
if (globalThis.siloReportViewerPretext) {
  setTocMenuWidth();
} else {
  globalThis.siloReportViewerPretextReady = buildTableOfContents;
}
if (document.fonts) document.fonts.ready.then(setTocMenuWidth);
window.addEventListener('resize', () => {
  setTocMenuWidth();
  updateOpenTocSubmenus();
  updateTocCorridor();
});

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
    buildTableOfContents();
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

async function reportDocument(report: StoredReport, token: string, nonce: string): Promise<string> {
  const script = clientScript(report.slug, token)
  const sourceScript = 'script' in report ? await formatReportScript(report.script) : undefined
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
            <div className="report-toolbar">
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
              <div className="report-toc" data-report-toc-container data-open="false">
                <button
                  type="button"
                  className="report-menu-button"
                  aria-label="Open report table of contents"
                  aria-haspopup="menu"
                  aria-expanded="false"
                  aria-controls="report-toc-menu"
                  data-report-toc-toggle
                >
                  <svg
                    className="report-menu-icon"
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 6h16" />
                    <path d="M4 12h16" />
                    <path d="M4 18h16" />
                  </svg>
                </button>
                <div
                  id="report-toc-menu"
                  className="report-toc-menu"
                  role="menu"
                  aria-label="Report sections"
                  data-report-toc-menu
                >
                  <ul className="report-toc-list" role="none" data-report-toc-list />
                  <svg
                    className="report-toc-corridor"
                    aria-hidden="true"
                    focusable="false"
                    preserveAspectRatio="none"
                    data-report-toc-corridor
                  >
                    <polygon
                      fill="transparent"
                      points="0,0 0,0 0,0"
                      data-report-toc-corridor-shape
                    />
                  </svg>
                </div>
              </div>
            </div>
            <header className="report-heading">
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
              <ReportSource report={report} script={sourceScript} />
            </div>
          </main>
        </div>
        {pretextScript ? (
          <script type="module" nonce={nonce} src="/report-viewer-pretext.mjs" />
        ) : null}
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
      if (request.method === 'GET' && url.pathname === '/report-viewer-pretext.mjs') {
        if (pretextScript === undefined) {
          send(response, 404, 'text/plain; charset=utf-8', 'Not found.\n')
        } else {
          send(response, 200, 'text/javascript; charset=utf-8', pretextScript)
        }
        return
      }
      if (request.method === 'GET' && url.pathname === reportPath) {
        const report = closeDatabase(SiloDatabase.open(workspace), (database) =>
          database.getReport(slug),
        )
        const html = await reportDocument(report, token, nonce)
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
              source_html: await renderReportSource(report),
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
