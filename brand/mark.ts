// The Parley mark (P3, chosen 2026-10-18): two voices, waves meeting in the
// middle. Shared by the intercom client and the console, so changing the
// logo is a change to this one file (plus the static icons beside it in
// public/, which are the same drawing). The P5 "bubble with a level meter"
// mark is kept in README's Brand section in case the product grows chat.
//
// Deliberately dependency-free (no React import): it sits outside both
// apps' package roots, so it can't resolve their node_modules. Each app
// renders the markup string itself. Colours come from CSS variables
// (--mark-a, the left voice; --mark-b, the right), so the mark follows
// each app's theme.

/** Below this size the full mark's thin outer waves blur together, so the
 * simplified one-thick-wave version is used instead. */
const SMALL_BELOW = 28;

const FULL =
  '<circle cx="8" cy="24" r="4.5" style="fill:var(--mark-a)"/>' +
  '<path d="M13.7 18.3 A8 8 0 0 1 13.7 29.7" style="stroke:var(--mark-a)" stroke-width="3.5"/>' +
  '<path d="M17.9 14.1 A14 14 0 0 1 17.9 33.9" style="stroke:var(--mark-a)" stroke-width="3.5"/>' +
  '<circle cx="40" cy="24" r="4.5" style="fill:var(--mark-b)"/>' +
  '<path d="M34.3 18.3 A8 8 0 0 0 34.3 29.7" style="stroke:var(--mark-b)" stroke-width="3.5"/>' +
  '<path d="M30.1 14.1 A14 14 0 0 0 30.1 33.9" style="stroke:var(--mark-b)" stroke-width="3.5"/>';

const SMALL =
  '<circle cx="9" cy="24" r="5.5" style="fill:var(--mark-a)"/>' +
  '<path d="M16.1 16.9 A10 10 0 0 1 16.1 31.1" style="stroke:var(--mark-a)" stroke-width="5"/>' +
  '<circle cx="39" cy="24" r="5.5" style="fill:var(--mark-b)"/>' +
  '<path d="M31.9 16.9 A10 10 0 0 0 31.9 31.1" style="stroke:var(--mark-b)" stroke-width="5"/>';

export const PRODUCT_NAME = 'Parley';

/** SVG markup for the mark at `size` px square. */
export function markSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" stroke-linecap="round" aria-hidden="true">` +
    (size < SMALL_BELOW ? SMALL : FULL) + '</svg>';
}
