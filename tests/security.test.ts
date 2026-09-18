import { describe, expect, it } from 'vitest';
import { safeFetch } from '@/lib/net/safe-fetch';
import { RequestBudget, BudgetExceededError } from '@/lib/net/budget';
import { safeParseXml } from '@/lib/xml/safe-parse';
import { sanitisePath } from '@/lib/kml/package';
import { classifyBody, classifyUrl, detectImageFormat } from '@/lib/geo/detect';

describe('safeFetch refuses unsafe targets', () => {
  it('refuses non-HTTP protocols without opening a socket', async () => {
    const budget = new RequestBudget();
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://x.test/']) {
      const result = await safeFetch(url, { budget });
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.kind).toBe('blocked');
    }
    // A blocked URL must not consume the request budget.
    expect(budget.requestsSpent).toBe(0);
  });

  it('refuses loopback and private addresses', async () => {
    const budget = new RequestBudget();
    for (const url of [
      'http://127.0.0.1:8080/',
      'http://localhost/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/internal',
      'http://[::1]:3000/',
    ]) {
      const result = await safeFetch(url, { budget });
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.kind, url).toBe('blocked');
    }
    expect(budget.requestsSpent).toBe(0);
  });

  it('refuses a URL carrying credentials', async () => {
    const result = await safeFetch('https://user:secret@example.com/', { budget: new RequestBudget() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/credentials/i);
  });
});

describe('RequestBudget', () => {
  it('stops spending once the budget is exhausted', async () => {
    const budget = new RequestBudget(2, 4, 0);
    await budget.spend('example.com', async () => 1);
    await budget.spend('example.com', async () => 2);
    expect(budget.exhausted).toBe(true);
    await expect(budget.spend('example.com', async () => 3)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('reports a budget exhaustion through safeFetch rather than throwing', async () => {
    const budget = new RequestBudget(0, 4, 0);
    const result = await safeFetch('https://example.com/', { budget });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('budget');
  });

  it('caps concurrency at the configured limit', async () => {
    const budget = new RequestBudget(100, 2, 0);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        budget.spend('example.com', async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('safeParseXml', () => {
  it('rejects a billion-laughs style entity bomb', () => {
    const bomb = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE lolz [',
      '  <!ENTITY lol "lol">',
      '  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">',
      ']>',
      '<kml><Document><name>&lol2;</name></Document></kml>',
    ].join('\n');
    const result = safeParseXml(bomb);
    expect(result.ok).toBe(false);
  });

  it('rejects an external entity reference (XXE)', () => {
    const xxe = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
      '<kml><Document><name>&xxe;</name></Document></kml>',
    ].join('\n');
    const result = safeParseXml(xxe);
    expect(result.ok).toBe(false);
  });

  it('rejects a document above the size limit', () => {
    const huge = `<kml>${'<a>x</a>'.repeat(10)}</kml>`;
    const result = safeParseXml(huge, { maxBytes: 16 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exceeds/i);
  });

  it('rejects malformed XML', () => {
    expect(safeParseXml('<kml><Document></kml>').ok).toBe(false);
  });

  it('accepts a normal document, and the literal word DOCTYPE inside content', () => {
    const fine = `<?xml version="1.0"?><kml><Document><name>${'x'.repeat(5000)} mentions DOCTYPE</name></Document></kml>`;
    expect(safeParseXml(fine).ok).toBe(true);
  });
});

describe('sanitisePath', () => {
  it('prevents zip-slip', () => {
    expect(sanitisePath('../../../etc/passwd')).not.toContain('..');
    expect(sanitisePath('KML/../../secret.kml')).toBe('KML/secret.kml');
    expect(sanitisePath('/absolute/path.kml')).toBe('absolute/path.kml');
  });

  it('keeps legitimate nesting and extensions', () => {
    expect(sanitisePath('Individual/Survey_125_2.kml')).toBe('Individual/Survey_125_2.kml');
    expect(sanitisePath('metadata.json')).toBe('metadata.json');
  });
});

describe('the vector/raster detector', () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it('identifies raster imagery by magic bytes even when the URL looks like data', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(detectImageFormat(png)).toBe('PNG');

    const detection = classifyBody(png, 'application/json', classifyUrl('https://example.org/data.geojson'));
    expect(detection.nature).toBe('raster');
    expect(detection.evidence.join(' ')).toMatch(/PNG signature/i);
  });

  it('identifies a JPEG', () => {
    expect(detectImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('JPEG');
  });

  it('identifies GeoJSON from the body, not the content type', () => {
    const body = encode('{"type":"FeatureCollection","features":[]}');
    const detection = classifyBody(body, 'text/plain', classifyUrl('https://example.org/unknown'));
    expect(detection.kind).toBe('geojson');
    expect(detection.nature).toBe('vector');
  });

  it('identifies KML from its root element', () => {
    const body = encode('<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>');
    const detection = classifyBody(body, 'application/octet-stream', classifyUrl('https://example.org/x'));
    expect(detection.kind).toBe('kml');
    expect(detection.nature).toBe('vector');
  });

  it('classifies WMS as raster and WFS as vector', () => {
    expect(classifyUrl('https://gis.example.org/geoserver/ows?service=WMS&request=GetMap').nature).toBe('raster');
    expect(classifyUrl('https://gis.example.org/geoserver/ows?service=WFS&request=GetFeature').nature).toBe('vector');
  });

  it('classifies ArcGIS service types', () => {
    expect(classifyUrl('https://x.test/arcgis/rest/services/Plan/FeatureServer/0').kind).toBe('arcgis-feature-server');
    expect(classifyUrl('https://x.test/arcgis/rest/services/Plan/MapServer').kind).toBe('arcgis-map-server');
    expect(classifyUrl('https://x.test/arcgis/rest/services/Sat/ImageServer').nature).toBe('raster');
  });

  it('classifies vector tiles as vector and raster tiles as raster', () => {
    expect(classifyUrl('https://x.test/tiles/{z}/{x}/{y}.pbf').nature).toBe('vector');
    expect(classifyUrl('https://x.test/tiles/{z}/{x}/{y}.png').nature).toBe('raster');
  });

  it('reports "unknown" rather than guessing when it cannot tell', () => {
    const detection = classifyBody(encode('some plain text'), 'text/plain', classifyUrl('https://x.test/thing'));
    expect(detection.nature).toBe('unknown');
  });
});
