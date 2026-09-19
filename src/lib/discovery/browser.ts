/**
 * Browser-assisted discovery.
 *
 * Reading a page and its bundles as text only finds URLs that appear literally
 * in the source. A modern map front-end does not keep them there: it assembles
 * them at runtime from a configuration object, a template string and a layer
 * id, so a server-side read of the same page sees nothing at all. That is the
 * single most common reason a scan of a working map site comes back empty.
 *
 * The fix is to let the site's own code run, in a real browser, and write down
 * every request it makes. Those URLs are then handed to the ordinary discovery
 * pipeline and fetched through the same SSRF-guarded, budgeted path as
 * everything else — the browser is used to *observe*, never to extract.
 *
 * What this deliberately does not do:
 *   - no stealth patches, no spoofed fingerprints, no user-agent disguise;
 *     the tool's own token is appended to the browser's user agent so the
 *     source can see exactly what visited it, and block it if it wants to;
 *   - no credentials, cookies, storage state or authentication of any kind;
 *   - no clicking through consent walls, captchas or login forms;
 *   - no retry storm: one visit, one settle period, then it closes.
 *
 * It is opt-in per scan, and it uses a browser already installed on the
 * machine rather than downloading one.
 */

import { existsSync } from 'node:fs';
import { platform, homedir } from 'node:os';
import { join } from 'node:path';

import { BROWSER, USER_AGENT } from '@/lib/config';
import { assertSafeUrl } from '@/lib/net/ssrf';
import type { ObservedRequest } from './types';

export type BrowserObservation =
  | {
      ok: true;
      executablePath: string;
      finalUrl: string;
      title: string;
      requests: ObservedRequest[];
      blockedCount: number;
      notes: string[];
    }
  | {
      ok: false;
      reason: string;
      /** What the person running the tool can do about it. */
      hint: string;
    };

export type BrowserScanOptions = {
  url: string;
  signal?: AbortSignal;
  settleMs?: number;
  executablePath?: string | null;
  headless?: boolean;
};

/**
 * Where Chrome, Chromium or Edge normally lives, per platform.
 *
 * Checked in order; the first that exists wins. An explicit `TPM_BROWSER_PATH`
 * always takes precedence over this list.
 */
export function browserCandidatePaths(): string[] {
  const home = homedir();
  switch (platform()) {
    case 'win32': {
      const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
      const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
      return [
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
      ];
    }
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ];
    default:
      return [
        '/opt/pw-browsers/chromium',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/microsoft-edge',
        '/snap/bin/chromium',
      ];
  }
}

/** The first installed browser this machine offers, or null. */
export function findBrowser(explicit?: string | null): string | null {
  const configured = explicit ?? BROWSER.executablePath;
  if (configured) return existsSync(configured) ? configured : null;
  return browserCandidatePaths().find((path) => existsSync(path)) ?? null;
}

const INSTALL_HINT =
  'Install the driver with `npm install playwright-core`, then make sure Google Chrome, Chromium or ' +
  'Microsoft Edge is installed. Set TPM_BROWSER_PATH to the executable if it lives somewhere unusual.';

/**
 * The first line of a driver error.
 *
 * Playwright appends a multi-line call log to its failures, which is useful in
 * a terminal and unreadable in a status panel.
 */
function briefly(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return (message.split('\n')[0] ?? message).replace(/\s*Call log:.*$/i, '').trim();
}

/** Whether a response body is worth classifying rather than ignoring. */
function isInteresting(resourceType: string): boolean {
  return resourceType === 'xhr' || resourceType === 'fetch' || resourceType === 'document' ||
    resourceType === 'other' || resourceType === 'script';
}

/**
 * Open a page in a locally installed browser and record what it loads.
 *
 * Every request the page makes is checked against the same SSRF rules the
 * server-side fetcher applies, and one that points at a private, loopback or
 * link-local address is aborted before it leaves the machine.
 */
export async function observeInBrowser(options: BrowserScanOptions): Promise<BrowserObservation> {
  const entry = await assertSafeUrl(options.url);
  if (!entry.ok) {
    return { ok: false, reason: entry.reason, hint: 'Point the tool at a public http(s) address.' };
  }

  let chromium: typeof import('playwright-core').chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return {
      ok: false,
      reason: 'The optional browser driver `playwright-core` is not installed.',
      hint: INSTALL_HINT,
    };
  }

  const executablePath = findBrowser(options.executablePath);
  if (!executablePath) {
    return {
      ok: false,
      reason: 'No Chrome, Chromium or Edge installation was found on this machine.',
      hint: INSTALL_HINT,
    };
  }

  const notes: string[] = [];
  const requests: ObservedRequest[] = [];
  const byKey = new Map<string, ObservedRequest>();
  let blockedCount = 0;

  const browser = await chromium.launch({
    headless: options.headless ?? BROWSER.headless,
    executablePath,
    args: ['--disable-dev-shm-usage'],
  });

  // A cancelled scan should not leave a browser sitting on a 45-second
  // navigation timeout. Closing it makes the pending call throw, which is
  // caught below and reported with whatever had already been recorded.
  const closeOnAbort = () => {
    void browser.close().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', closeOnAbort, { once: true });

  try {
    // Read the browser's own user agent so the tool's token can be appended to
    // it rather than replacing it with a fabricated one.
    let userAgent: string | undefined;
    try {
      const probeContext = await browser.newContext();
      const probePage = await probeContext.newPage();
      const base = await probePage.evaluate(() => navigator.userAgent);
      await probeContext.close();
      if (typeof base === 'string' && base.length > 0) userAgent = `${base} ${USER_AGENT}`;
    } catch {
      notes.push('The browser user agent could not be read, so its default was used unchanged.');
    }

    const context = await browser.newContext({
      userAgent,
      // No stored credentials, no cookies carried in, nothing that would make
      // this look like an authenticated session.
      storageState: undefined,
      ignoreHTTPSErrors: false,
    });
    context.setDefaultNavigationTimeout(BROWSER.navigationTimeoutMs);

    // One SSRF verdict per host, reused for the hundreds of requests a page
    // makes, so a visit does not turn into hundreds of DNS lookups.
    const hostVerdicts = new Map<string, { allowed: boolean; reason: string }>();

    await context.route('**/*', async (route) => {
      const url = route.request().url();
      let host: string;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          blockedCount += 1;
          await route.abort('blockedbyclient');
          return;
        }
        host = `${parsed.protocol}//${parsed.host}`;
      } catch {
        blockedCount += 1;
        await route.abort('blockedbyclient');
        return;
      }

      let verdict = hostVerdicts.get(host);
      if (!verdict) {
        const checked = await assertSafeUrl(host);
        verdict = checked.ok ? { allowed: true, reason: '' } : { allowed: false, reason: checked.reason };
        hostVerdicts.set(host, verdict);
      }

      if (!verdict.allowed) {
        blockedCount += 1;
        record({
          url,
          method: route.request().method(),
          resourceType: route.request().resourceType(),
          status: null,
          contentType: null,
          bytes: null,
          blockedReason: verdict.reason,
        });
        await route.abort('blockedbyclient');
        return;
      }

      await route.continue();
    });

    function record(observation: ObservedRequest): void {
      if (requests.length >= BROWSER.maxObservedRequests) return;
      const key = `${observation.method} ${observation.url}`;
      const existing = byKey.get(key);
      if (existing) {
        // Keep the richer record: a response tells us more than a bare request.
        if (existing.status === null && observation.status !== null) {
          existing.status = observation.status;
          existing.contentType = observation.contentType;
          existing.bytes = observation.bytes;
        }
        if (!existing.failureReason && observation.failureReason) {
          existing.failureReason = observation.failureReason;
        }
        return;
      }
      byKey.set(key, observation);
      requests.push(observation);
    }

    context.on('response', (response) => {
      const request = response.request();
      const headers = response.headers();
      const length = Number.parseInt(headers['content-length'] ?? '', 10);
      record({
        url: response.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: response.status(),
        contentType: headers['content-type'] ?? null,
        bytes: Number.isFinite(length) ? length : null,
      });
    });

    context.on('requestfailed', (request) => {
      const failure = request.failure();
      // A request this tool aborted is already recorded with its own reason;
      // anything else failed on the network, which is a different fact and is
      // not described as a refusal by this tool.
      record({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: null,
        contentType: null,
        bytes: null,
        ...(failure?.errorText && failure.errorText !== 'net::ERR_BLOCKED_BY_CLIENT'
          ? { failureReason: failure.errorText }
          : {}),
      });
    });

    const page = await context.newPage();

    let finalUrl = options.url;
    let title = '';
    try {
      const response = await page.goto(options.url, { waitUntil: 'domcontentloaded' });
      if (response && response.status() >= 400) {
        notes.push(`The page itself returned HTTP ${response.status()}.`);
      }
      if (response && (response.status() === 401 || response.status() === 403)) {
        notes.push(
          'The source refused the visit. No attempt was made to work around that refusal.',
        );
      }
    } catch (error) {
      notes.push(
        `The page did not finish its first load: ${briefly(error)}. ` +
          'Whatever it had already requested by then was still recorded.',
      );
    }

    // Let asynchronous data loads happen. A map front-end typically fetches its
    // configuration, then its layer list, then the layer data — three round
    // trips that all land after `domcontentloaded`.
    const settleMs = options.settleMs ?? BROWSER.settleMs;
    try {
      await page.waitForLoadState('networkidle', { timeout: settleMs });
    } catch {
      notes.push('The page was still making requests when the settle period ended.');
    }
    await page.waitForTimeout(Math.min(settleMs, 4_000));

    try {
      finalUrl = page.url();
      title = await page.title();
    } catch {
      /* The page may have navigated away or closed; the requests still stand. */
    }

    if (options.signal?.aborted) {
      notes.push('The scan was cancelled; only the requests recorded up to that point are listed.');
    }

    if (requests.length >= BROWSER.maxObservedRequests) {
      notes.push(
        `The cap of ${BROWSER.maxObservedRequests} recorded requests was reached; later requests were not listed.`,
      );
    }

    return { ok: true, executablePath, finalUrl, title, requests, blockedCount, notes };
  } finally {
    options.signal?.removeEventListener('abort', closeOnAbort);
    await browser.close().catch(() => undefined);
  }
}

/**
 * Whether an observed request is worth handing to the discovery pipeline.
 *
 * Everything the page fetched as data is a candidate — that is the point of
 * watching. Fonts, stylesheets, images and media are not.
 */
export function worthPursuing(observation: ObservedRequest): boolean {
  if (observation.blockedReason || observation.failureReason) return false;
  if (observation.status !== null && observation.status >= 400) return false;
  const type = observation.resourceType;
  if (type === 'stylesheet' || type === 'font' || type === 'media' || type === 'websocket') return false;
  if (type === 'image') {
    // A tile served as an image still matters: it tells us the map is raster,
    // and the template behind it is worth recording.
    return /\{[zxy]\}|\/\d+\/\d+\/\d+(\.\w+)?(\?|$)|(wms|wmts)/i.test(observation.url);
  }
  return isInteresting(type);
}
