import type { SVGProps } from "react";

/** Compact line-icon set approximating the GitKraken toolbar/sidebar glyphs. */
type P = SVGProps<SVGSVGElement>;
const base = (props: P) => ({
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export const IconUndo = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 7 4 12l5 5" />
    <path d="M4 12h11a5 5 0 0 1 0 10h-1" />
  </svg>
);
export const IconRedo = (p: P) => (
  <svg {...base(p)}>
    <path d="m15 7 5 5-5 5" />
    <path d="M20 12H9a5 5 0 0 0 0 10h1" />
  </svg>
);
export const IconPull = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);
export const IconPush = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 21V9" />
    <path d="m7 14 5-5 5 5" />
    <path d="M5 3h14" />
  </svg>
);
export const IconBranch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="7" r="2.4" />
    <path d="M6 8.4v7.2" />
    <path d="M18 9.4c0 4-3 4.6-6 5.6" />
  </svg>
);
export const IconStash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 8h16l-1.2 11a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8Z" />
    <path d="M4 8 6 4h12l2 4" />
    <path d="M12 12v5" />
    <path d="m9.5 14.5 2.5 2.5 2.5-2.5" />
  </svg>
);
export const IconPop = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 8h16l-1.2 11a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8Z" />
    <path d="M4 8 6 4h12l2 4" />
    <path d="M12 17v-5" />
    <path d="m9.5 14.5 2.5-2.5 2.5 2.5" />
  </svg>
);
export const IconTerminal = (p: P) => (
  <svg {...base(p)}>
    <path d="m5 8 4 4-4 4" />
    <path d="M12 16h7" />
  </svg>
);
export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-3.2-3.2" />
  </svg>
);
export const IconActions = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 8h10" />
    <path d="M4 16h6" />
    <circle cx="17" cy="8" r="2.3" />
    <circle cx="13" cy="16" r="2.3" />
  </svg>
);
export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h16" />
    <path d="M9 7V5h6v2" />
    <path d="M6 7l1 12a2 2 0 0 0 2 1.8h6a2 2 0 0 0 2-1.8L18 7" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);
export const IconSparkle = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3.5 13.6 9 19 10.6 13.6 12.2 12 17.7 10.4 12.2 5 10.6 10.4 9Z" />
    <path d="M18.5 4.5 19 6l1.5.5L19 7l-.5 1.5L18 7l-1.5-.5L18 6Z" />
  </svg>
);
export const IconSort = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 4v16" />
    <path d="m4 7 3-3 3 3" />
    <path d="M13 6h7M13 11h5M13 16h3" />
  </svg>
);
export const IconPath = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);
export const IconTree = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 5h6" />
    <path d="M8 5v14" />
    <path d="M8 10h6M8 17h6" />
    <path d="M14 5h6M14 10h6M14 17h6" />
  </svg>
);
export const IconChevron = (p: P) => (
  <svg {...base({ width: 12, height: 12, ...p })}>
    <path d="m8 5 8 7-8 7" />
  </svg>
);
export const IconChevronDown = (p: P) => (
  <svg {...base({ width: 12, height: 12, ...p })}>
    <path d="m5 8 7 8 7-8" />
  </svg>
);
export const IconFolder = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
  </svg>
);
export const IconPencil = (p: P) => (
  <svg {...base({ width: 14, height: 14, ...p })}>
    <path d="M14 4 20 10 9 21H3v-6Z" />
    <path d="m13 5 6 6" />
  </svg>
);
export const IconCommit = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3.4" />
    <path d="M4 12h4.6M15.4 12H20" />
  </svg>
);
export const IconCaretDown = (p: P) => (
  <svg {...base({ width: 10, height: 10, strokeWidth: 2.4, ...p })}>
    <path d="m5 8 7 8 7-8" />
  </svg>
);
export const IconCheck = (p: P) => (
  <svg {...base({ width: 13, height: 13, strokeWidth: 2.6, ...p })}>
    <path d="m4 12 5 5L20 6" />
  </svg>
);
export const IconMonitor = (p: P) => (
  <svg {...base({ width: 13, height: 13, ...p })}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M9 20h6M12 16v4" />
  </svg>
);
export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v4h-4" />
  </svg>
);
