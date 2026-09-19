/**
 * Preservation of original KML/KMZ, and the distinction that must never blur.
 *
 * The rule under test: a reconstructed document is never labelled as an
 * original source file, in any representation — the record, the stored bytes,
 * the download headers, or the file's own contents.
 */

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { extractKmlLinks, geographicLinks } from '@/lib/kml/links';
import { filenameFor, looksLikeKmlResource } from '@/lib/preservation/sweep';
import {
  ORIGIN_DESCRIPTIONS,
  ORIGIN_LABELS,
  UNEXPOSED_ROUTES,
  summariseRoutes,
  unexposedFiles,
  type SourceFileRecord,
} from '@/lib/preservation/types';
import { buildKmlDocument } from '@/lib/kml/builder';
import { parseKml } from '@/lib/kml/parse';
import { MemoryStore } from '@/lib/db/memory';
import { identifyCrs } from '@/lib/geo/crs';
import type { FeatureRecord } from '@/lib/discovery/types';

// --- fixtures -------------------------------------------------------------

/** A KML that reaches further documents the visible interface never offers. */
const KML_WITH_NETWORK_LINKS = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Ward index</name>
    <NetworkLink>
      <name>Ward 1 parcels</name>
      <Link>
        <href>wards/ward-1.kml</href>
        <refreshMode>onInterval</refreshMode>
        <refreshInterval>3600</refreshInterval>
      </Link>
    </NetworkLink>
    <NetworkLink>
      <name>Ward 2 parcels</name>
      <Url><href>https://gis.example.org/wards/ward-2.kmz</href></Url>
    </NetworkLink>
    <Folder>
      <name>Overlays</name>
      <GroundOverlay>
        <name>Scanned plan</name>
        <Icon><href>overlays/plan.png</href></Icon>
      </GroundOverlay>
      <NetworkLink>
        <name>Nested</name>
        <Link><href>deep/nested.kml</href></Link>
      </NetworkLink>
    </Folder>
    <Placemark>
      <name>Ward office</name>
      <styleUrl>https://gis.example.org/styles/shared.kml#office</styleUrl>
      <Point><coordinates>72.5,23.0</coordinates></Point>
    </Placemark>
  </Document>
</kml>`;

function makeFeature(): FeatureRecord {
  return {
    id: 'feat_1',
    layerId: 'layer_1',
    sourceFeatureId: '1',
    name: 'Survey 125/2',
    geometryType: 'Polygon',
    properties: { survey_no: '125/2' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [72.5, 23.0],
          [72.6, 23.0],
          [72.6, 23.1],
          [72.5, 23.0],
        ],
      ],
    },
    crs: identifyCrs(4326),
    provenance: 'source-geometry',
    provenanceNote: 'note',
    areaSquareMetres: 1000,
    bbox: [72.5, 23.0, 72.6, 23.1],
    kmlAvailable: true,
    kmlNote: 'ok',
    sourceUrl: 'https://gis.example.org/FeatureServer/0',
  };
}

function makeSourceFile(overrides: Partial<SourceFileRecord> = {}): SourceFileRecord {
  return {
    id: 'src_1',
    origin: 'original',
    url: 'https://gis.example.org/data/wards.kml',
    finalUrl: null,
    kind: 'kml',
    filename: 'wards.kml',
    contentType: 'application/vnd.google-earth.kml+xml',
    byteSize: 1234,
    sha256: 'a'.repeat(64),
    retrievedAt: '2026-09-19T00:00:00.000Z',
    lastModified: null,
    etag: null,
    discoveredIn: 'the landing page',
    route: 'page-markup',
    parentId: null,
    depth: 0,
    inspection: {
      documentName: 'Wards',
      placemarks: 3,
      withGeometry: 3,
      geometryTypes: ['Polygon'],
      folders: [],
      networkLinks: 0,
      hasRefreshingLinks: false,
      archiveEntries: [],
      parseError: null,
    },
    notes: [],
    ...overrides,
  };
}

// --- the distinction ------------------------------------------------------

describe('a reconstructed document is never labelled original', () => {
  it('stamps origin=reconstructed into every generated document', () => {
    const built = buildKmlDocument({ documentName: 'X', features: [makeFeature()] });

    // Both at document level and on the placemark.
    expect(built.kml).toContain('<Data name="origin">');
    expect(built.kml).toContain('<value>reconstructed</value>');
    expect(built.kml).not.toContain('<value>original</value>');
  });

  it('says in plain words that the document is not a source file', () => {
    const built = buildKmlDocument({ documentName: 'X', features: [makeFeature()] });
    expect(built.kml).toMatch(/RECONSTRUCTED DOCUMENT/);
    expect(built.kml).toMatch(/not a file published by/i);
  });

  it('keeps the statement after a round trip through a KML parser', () => {
    const built = buildKmlDocument({ documentName: 'X', features: [makeFeature()] });
    const parsed = parseKml(built.kml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.kml.placemarks[0]?.properties.origin).toBe('reconstructed');
  });

  it('gives the two origins different labels and descriptions', () => {
    expect(ORIGIN_LABELS.original).not.toBe(ORIGIN_LABELS.reconstructed);
    expect(ORIGIN_LABELS.original).toMatch(/original/i);
    expect(ORIGIN_LABELS.reconstructed).toMatch(/reconstructed/i);
    expect(ORIGIN_DESCRIPTIONS.reconstructed).toMatch(/must not be presented as one/i);
  });

  it('types a source file record so it can only ever be original', () => {
    const record = makeSourceFile();
    // The field is the literal type 'original'; this is the runtime half of a
    // guarantee the compiler makes statically.
    expect(record.origin).toBe('original');

    const assigned: 'original' = record.origin;
    expect(assigned).toBe('original');
  });
});

// --- preserving bytes -----------------------------------------------------

describe('preserved bytes are kept verbatim', () => {
  it('returns exactly what was stored', async () => {
    const store = new MemoryStore();
    const original = new TextEncoder().encode(KML_WITH_NETWORK_LINKS);

    await store.saveSourceFile(makeSourceFile(), original);
    const read = await store.getSourceFileBytes('src_1');

    expect(read).not.toBeNull();
    expect(Array.from(read!)).toEqual(Array.from(original));
    expect(new TextDecoder().decode(read!)).toBe(KML_WITH_NETWORK_LINKS);
  });

  it('is not affected by a caller mutating its own buffer afterwards', async () => {
    const store = new MemoryStore();
    const buffer = new Uint8Array([1, 2, 3, 4]);

    await store.saveSourceFile(makeSourceFile(), buffer);
    buffer[0] = 99;

    const read = await store.getSourceFileBytes('src_1');
    expect(read?.[0]).toBe(1);
  });

  it('does not let a reader mutate what is stored', async () => {
    const store = new MemoryStore();
    await store.saveSourceFile(makeSourceFile(), new Uint8Array([1, 2, 3]));

    const first = await store.getSourceFileBytes('src_1');
    first![0] = 99;

    const second = await store.getSourceFileBytes('src_1');
    expect(second?.[0]).toBe(1);
  });

  it('keeps originals out of the export listing and vice versa', async () => {
    const store = new MemoryStore();
    await store.saveSourceFile(makeSourceFile(), new Uint8Array([1]));

    // Two separate catalogs; nothing crosses between them.
    expect(await store.countSourceFiles()).toBe(1);
    expect(await store.listExports()).toHaveLength(0);
  });
});

// --- reaching what the UI does not expose ---------------------------------

describe('extractKmlLinks', () => {
  it('finds NetworkLinks in both the 2.2 and 2.0 spellings', () => {
    const result = extractKmlLinks(KML_WITH_NETWORK_LINKS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hrefs = result.links.filter((link) => link.kind === 'network-link').map((link) => link.href);
    expect(hrefs).toContain('wards/ward-1.kml'); // <Link>
    expect(hrefs).toContain('https://gis.example.org/wards/ward-2.kmz'); // <Url>
  });

  it('descends into folders to find nested links', () => {
    const result = extractKmlLinks(KML_WITH_NETWORK_LINKS);
    if (!result.ok) throw new Error('parse failed');
    expect(result.links.map((link) => link.href)).toContain('deep/nested.kml');
  });

  it('records a refresh mode, which marks the document as a live feed', () => {
    const result = extractKmlLinks(KML_WITH_NETWORK_LINKS);
    if (!result.ok) throw new Error('parse failed');
    const ward1 = result.links.find((link) => link.href === 'wards/ward-1.kml');
    expect(ward1?.refreshMode).toBe('onInterval');
  });

  it('collects overlay imagery and external style references', () => {
    const result = extractKmlLinks(KML_WITH_NETWORK_LINKS);
    if (!result.ok) throw new Error('parse failed');

    expect(result.links.some((link) => link.kind === 'ground-overlay')).toBe(true);
    expect(result.links.some((link) => link.kind === 'style')).toBe(true);
  });

  it('ignores a local style reference, which points at nothing external', () => {
    const local = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark><styleUrl>#localStyle</styleUrl></Placemark></Document></kml>`;
    const result = extractKmlLinks(local);
    if (!result.ok) throw new Error('parse failed');
    expect(result.links).toHaveLength(0);
  });

  it('narrows to the links that lead to more geographic data', () => {
    const result = extractKmlLinks(KML_WITH_NETWORK_LINKS);
    if (!result.ok) throw new Error('parse failed');

    const geographic = geographicLinks(result.links).map((link) => link.href);
    expect(geographic).toContain('wards/ward-1.kml');
    expect(geographic).toContain('https://gis.example.org/wards/ward-2.kmz');
    // A PNG overlay is imagery, not further geometry.
    expect(geographic).not.toContain('overlays/plan.png');
  });

  it('rejects a document carrying a DOCTYPE rather than parsing it', () => {
    const hostile = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>',
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>',
    ].join('\n');
    expect(extractKmlLinks(hostile).ok).toBe(false);
  });
});

// --- candidate recognition ------------------------------------------------

describe('looksLikeKmlResource', () => {
  it('accepts plain KML and KMZ paths', () => {
    expect(looksLikeKmlResource('https://x.test/data/wards.kml')).toBe(true);
    expect(looksLikeKmlResource('https://x.test/data/wards.KMZ')).toBe(true);
  });

  it('accepts service endpoints that emit KML on request', () => {
    expect(looksLikeKmlResource('https://x.test/MapServer/0/query?f=kmz')).toBe(true);
    expect(looksLikeKmlResource('https://x.test/ows?outputFormat=KML&service=WFS')).toBe(true);
    expect(looksLikeKmlResource('https://x.test/export/kml/wards')).toBe(true);
  });

  it('rejects everything else, so the sweep does not fetch the whole site', () => {
    expect(looksLikeKmlResource('https://x.test/app.js')).toBe(false);
    expect(looksLikeKmlResource('https://x.test/data/wards.geojson')).toBe(false);
    expect(looksLikeKmlResource('https://x.test/tiles/1/2/3.png')).toBe(false);
    expect(looksLikeKmlResource('not a url')).toBe(false);
  });
});

describe('filenameFor', () => {
  it('prefers the name the source declared', () => {
    expect(filenameFor('https://x.test/d?id=7', 'attachment; filename="Ward_1.kml"', 'kml')).toBe('Ward_1.kml');
  });

  it('reads the RFC 5987 extended form', () => {
    expect(
      filenameFor('https://x.test/d', "attachment; filename*=UTF-8''Ward%201.kml", 'kml'),
    ).toBe('Ward_1.kml');
  });

  it('falls back to the URL path', () => {
    expect(filenameFor('https://x.test/data/wards.kmz', null, 'kmz')).toBe('wards.kmz');
  });

  it('adds the extension when the path has none', () => {
    expect(filenameFor('https://x.test/export/wards', null, 'kml')).toBe('wards.kml');
  });

  it('sanitises a hostile filename from the source', () => {
    const name = filenameFor('https://x.test/d', 'attachment; filename="../../etc/passwd"', 'kml');
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
  });
});

// --- reporting ------------------------------------------------------------

describe('route reporting', () => {
  it('marks routes the visible interface does not offer', () => {
    expect(UNEXPOSED_ROUTES.has('network-link')).toBe(true);
    expect(UNEXPOSED_ROUTES.has('script-bundle')).toBe(true);
    // A plain link in the page markup is exposed by definition.
    expect(UNEXPOSED_ROUTES.has('page-markup')).toBe(false);
  });

  it('picks out the files that are only reachable indirectly', () => {
    const files = [
      makeSourceFile({ id: 'a', route: 'page-markup' }),
      makeSourceFile({ id: 'b', route: 'network-link' }),
      makeSourceFile({ id: 'c', route: 'script-bundle' }),
    ];
    expect(unexposedFiles(files).map((file) => file.id)).toEqual(['b', 'c']);
  });

  it('summarises how files were reached', () => {
    const files = [
      makeSourceFile({ id: 'a', route: 'network-link' }),
      makeSourceFile({ id: 'b', route: 'network-link' }),
      makeSourceFile({ id: 'c', route: 'page-markup' }),
    ];
    expect(summariseRoutes(files)).toEqual([
      { route: 'network-link', count: 2 },
      { route: 'page-markup', count: 1 },
    ]);
  });
});

// --- KMZ ------------------------------------------------------------------

describe('KMZ handling', () => {
  it('preserves the archive itself, not just the KML inside it', async () => {
    const zip = new JSZip();
    zip.file('doc.kml', KML_WITH_NETWORK_LINKS);
    zip.file('overlays/plan.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const archive = await zip.generateAsync({ type: 'uint8array' });

    const store = new MemoryStore();
    await store.saveSourceFile(
      makeSourceFile({ kind: 'kmz', filename: 'wards.kmz', byteSize: archive.byteLength }),
      archive,
    );

    const read = await store.getSourceFileBytes('src_1');
    // Byte-identical, so the overlay imagery inside survives too.
    expect(Array.from(read!)).toEqual(Array.from(archive));

    const reopened = await JSZip.loadAsync(read!);
    expect(Object.keys(reopened.files).sort()).toContain('overlays/plan.png');
  });
});
