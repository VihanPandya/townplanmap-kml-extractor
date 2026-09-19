/**
 * Link extraction from KML documents.
 *
 * A KML file is not necessarily a leaf. `<NetworkLink>` points at further KML,
 * which may point at more, and those documents are frequently never referenced
 * anywhere a page or its JavaScript would show them — the map loads the root
 * document, and the rest arrives because the KML itself asked for it. Following
 * those links is how the tool reaches geographic resources that exist but are
 * not exposed through the visible interface.
 *
 * Also collected, because they are part of the same published resource and a
 * preserved copy is incomplete without them:
 *   - `<Link>` / `<Url>` hrefs (the KML 2.0 and 2.2 spellings)
 *   - `<Icon>` hrefs, which carry the overlay imagery a document draws
 *   - `<styleUrl>` values pointing into another document
 *   - `<GroundOverlay>` and `<PhotoOverlay>` icon hrefs
 */

import { safeParseXml, asArray, pick, text } from '@/lib/xml/safe-parse';

export type KmlLinkKind =
  | 'network-link'
  | 'ground-overlay'
  | 'photo-overlay'
  | 'screen-overlay'
  | 'style'
  | 'icon'
  | 'model';

export type KmlLink = {
  href: string;
  kind: KmlLinkKind;
  /** The enclosing element's `<name>`, when it had one. */
  name: string | null;
  /**
   * `onInterval` / `onExpire` refresh modes mean the document is a live feed
   * rather than a static file, which is worth recording against a preserved
   * copy.
   */
  refreshMode: string | null;
  viewRefreshMode: string | null;
};

/** Elements whose child `<Link>`/`<Icon>` we care about, and what to call them. */
const LINK_HOLDERS: Array<{ element: string; kind: KmlLinkKind }> = [
  { element: 'NetworkLink', kind: 'network-link' },
  { element: 'GroundOverlay', kind: 'ground-overlay' },
  { element: 'PhotoOverlay', kind: 'photo-overlay' },
  { element: 'ScreenOverlay', kind: 'screen-overlay' },
  { element: 'Model', kind: 'model' },
];

/** Containers that can nest further containers. */
const CONTAINERS = ['Document', 'Folder'];

function readLinkNode(node: unknown, kind: KmlLinkKind, name: string | null): KmlLink | null {
  // KML 2.2 uses <Link>; KML 2.0 used <Url>; overlays use <Icon>.
  const link = pick(node, 'Link') ?? pick(node, 'Url') ?? pick(node, 'Icon');
  const href = text(pick(link, 'href')) ?? text(pick(node, 'href'));
  if (!href) return null;

  return {
    href,
    kind,
    name,
    refreshMode: text(pick(link, 'refreshMode')) ?? null,
    viewRefreshMode: text(pick(link, 'viewRefreshMode')) ?? null,
  };
}

function walk(node: unknown, out: KmlLink[], depth: number): void {
  if (!node || typeof node !== 'object' || depth > 32) return;
  const record = node as Record<string, unknown>;

  for (const { element, kind } of LINK_HOLDERS) {
    for (const holder of asArray(record[element] as unknown)) {
      const name = text(pick(holder, 'name')) ?? null;
      const link = readLinkNode(holder, kind, name);
      if (link) out.push(link);
      // An overlay or network link can itself contain containers.
      walk(holder, out, depth + 1);
    }
  }

  // A <styleUrl> with a path component points into another document.
  for (const styleUrl of asArray(record.styleUrl as unknown)) {
    const value = text(styleUrl);
    // A bare "#id" is a local reference and points at nothing external.
    if (!value || value.startsWith('#')) continue;
    out.push({ href: value, kind: 'style', name: null, refreshMode: null, viewRefreshMode: null });
  }

  for (const container of CONTAINERS) {
    for (const child of asArray(record[container] as unknown)) {
      walk(child, out, depth + 1);
    }
  }

  // Placemarks can carry their own icon styles.
  for (const placemark of asArray(record.Placemark as unknown)) {
    walk(placemark, out, depth + 1);
  }

  // <Style><IconStyle><Icon><href> — the imagery a document needs to render.
  for (const style of asArray(record.Style as unknown)) {
    const href = text(pick(style, 'IconStyle', 'Icon', 'href'));
    if (href && !href.startsWith('#')) {
      out.push({ href, kind: 'icon', name: null, refreshMode: null, viewRefreshMode: null });
    }
  }
}

export type LinkExtraction =
  | { ok: true; links: KmlLink[] }
  | { ok: false; reason: string };

/**
 * Extract every outbound link from a KML document.
 *
 * Goes through the hardened XML parser, so a hostile document cannot use this
 * path to smuggle an entity-expansion payload into the server.
 */
export function extractKmlLinks(xml: string): LinkExtraction {
  const parsed = safeParseXml(xml);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const root = pick(parsed.doc, 'kml');
  if (!root) return { ok: false, reason: 'Document has no <kml> root element.' };

  const links: KmlLink[] = [];
  walk(root, links, 0);

  // De-duplicate, keeping the first occurrence of each href.
  const seen = new Set<string>();
  return {
    ok: true,
    links: links.filter((link) => {
      const key = `${link.kind}:${link.href}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

/** Links that lead to more geographic data, as opposed to imagery or styling. */
export function geographicLinks(links: KmlLink[]): KmlLink[] {
  return links.filter(
    (link) =>
      link.kind === 'network-link' ||
      link.kind === 'style' ||
      (link.kind !== 'icon' && /\.km[lz](\?|#|$)/i.test(link.href)),
  );
}
