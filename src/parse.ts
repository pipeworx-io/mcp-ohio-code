/**
 * Ohio Revised Code chapter-page parser, used by scripts/bake-chapters.mjs (the refresh) and the unit tests.
 * `statuteText` is passed in so the bake script can run under plain Node without resolving the workspace package.
 */
export interface OhioSection {
  section: string;
  heading: string | null;
  text: string | null;
  effective: string | null;
}

/** Every section a chapter page lists, in page order. `text` is null when the page carries no body for it. */
export function parseOhioChapter(html: string, statuteText: (s: string) => string): OhioSection[] {
  const out: OhioSection[] = [];
  const parts = html.split(/<span id="content-head-\d+" class="content-head">/).slice(1);
  for (const part of parts) {
    const head = part.match(/<a href="section-([^"]+)">\s*Section\s+[^<]*<span[^>]*>\|<\/span>([\s\S]*?)<\/a>/);
    if (!head) continue;
    const eff = part.match(/<div class="label">Effective:<\/div>\s*<div class="value">([^<]*)<\/div>/);
    const body = part.match(/<section class="laws-body">([\s\S]*?)<\/section>/);
    const text = body ? statuteText(body[1]) : '';
    out.push({
      section: head[1],
      heading: statuteText(head[2]) || null,
      text: text.length > 0 ? text : null,
      effective: eff ? statuteText(eff[1]) || null : null,
    });
  }
  return out;
}
