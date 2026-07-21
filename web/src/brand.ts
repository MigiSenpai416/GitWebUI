/**
 * GitWebUI's visual identity in one place: the mark's geometry and the per-repo
 * palette. The same mark is drawn three ways — as a React icon in the tab strip,
 * on the auth screen, and as the browser favicon — so the geometry lives here as
 * data rather than being redrawn (and drifting) in each.
 *
 * The mark is the app's own commit graph column: a lane with a node at each end
 * and one branch leaving the middle.
 */

/** Filled commit nodes, in the 24×24 icon viewBox. */
export const MARK_NODES = [
  { cx: 8, cy: 4.5 },
  { cx: 8, cy: 19.5 },
  { cx: 16.5, cy: 12 },
] as const;

/** The lane and the branch leaving it. */
export const MARK_LANES = ["M8 6.7v10.6", "M8 12h5.8"] as const;

export const MARK_NODE_R = 2.2;
export const MARK_STROKE = 1.8;

/** The graph lane's teal — the app's own accent for anything brand-level. */
export const MARK_COLOR = "#22b2a6";

/**
 * Colors a repo can be tagged with. Tuned for the dark chrome (similar
 * lightness, no muddy hues) and deliberately without red, which the UI already
 * spends on errors.
 */
const REPO_COLORS = [
  "#22b2a6", // teal
  "#3fb950", // green
  "#a5d64c", // lime
  "#d29922", // amber
  "#ff9d5c", // orange
  "#f778ba", // pink
  "#c678dd", // magenta
  "#7c8cf8", // indigo
  "#58a6ff", // blue
  "#56d4dd", // cyan
];

/**
 * A repo's color, derived from its path so it never changes between sessions or
 * machines — you learn a repo by its color instead of reading tab labels.
 */
export function repoColor(root: string | null): string {
  if (!root) return "";
  // FNV-1a over the normalized path: cheap, and well spread for short strings.
  let hash = 0x811c9dc5;
  const key = root.toLowerCase().replace(/[\\/]+$/, "");
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return REPO_COLORS[Math.abs(hash) % REPO_COLORS.length];
}

/**
 * The mark as a standalone SVG document, on the app's dark tile. Drawn a little
 * heavier than the in-app icon because a favicon renders at 16px, where the
 * chrome weight thins out to about one device pixel.
 */
export function markSvg(color: string): string {
  const nodes = MARK_NODES.map(
    (n) => `<circle cx="${n.cx}" cy="${n.cy}" r="2.6" fill="${color}"/>`,
  ).join("");
  const lanes = MARK_LANES.map(
    (d) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.3" stroke-linecap="round"/>`,
  ).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<rect width="24" height="24" rx="5" fill="#0e151d"/>${lanes}${nodes}</svg>`
  );
}

/**
 * Point the browser tab at the mark, tinted for the repo in view — so several
 * GitWebUI tabs are told apart by color the same way the in-app tabs are.
 */
export function applyFavicon(color: string): void {
  const href = `data:image/svg+xml,${encodeURIComponent(markSvg(color || MARK_COLOR))}`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = href;
}
