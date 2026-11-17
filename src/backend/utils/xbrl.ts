import * as cheerio from 'cheerio';

/**
 * Flat XBRL instance → { contextRef: { elementName: text } }.
 * Element names lose their namespace prefix ("in-bse-fin:RevenueFromOperations"
 * → "RevenueFromOperations"). The first fact for a (context, name) pair wins.
 */
export function xbrlFacts(xml: string): Record<string, Record<string, string>> {
  const $ = cheerio.load(xml, { xml: true });
  const out: Record<string, Record<string, string>> = {};
  $('*').each((_, el) => {
    const node = el as unknown as { name?: string; attribs?: Record<string, string> };
    const ctx = node.attribs?.contextRef;
    if (!ctx || !node.name) return;
    const text = $(el).text().trim();
    if (!text) return;
    const name = node.name.includes(':') ? node.name.split(':').pop()! : node.name;
    (out[ctx] ??= {});
    if (!(name in out[ctx])) out[ctx][name] = text;
  });
  return out;
}

export function num(v: string | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
