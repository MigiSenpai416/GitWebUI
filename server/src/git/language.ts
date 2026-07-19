/**
 * Map a file path to a coarse language id the frontend uses to pick a
 * CodeMirror language extension. Unknown types return "plaintext".
 */
const BY_EXT: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  c: "cpp",
  h: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cc: "cpp",
  cxx: "cpp",
  cpp: "cpp",
  py: "python",
  pyw: "python",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  vue: "html",
  css: "css",
  scss: "css",
  less: "css",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "plaintext",
  makefile: "plaintext",
};

export function languageForPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const lower = base.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return "plaintext";
  const ext = lower.slice(dot + 1);
  return BY_EXT[ext] ?? "plaintext";
}
