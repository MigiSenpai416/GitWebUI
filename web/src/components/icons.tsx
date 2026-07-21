import type { ReactNode, SVGProps } from "react";
import { MARK_LANES, MARK_NODES, MARK_NODE_R, MARK_STROKE } from "../brand";

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

/**
 * The GitWebUI mark: a commit lane with one branch leaving it. Drawn from the
 * shared geometry in brand.ts, so the favicon can't drift from the app's.
 */
export const IconMark = (p: P) => (
  <svg {...base(p)} strokeWidth={MARK_STROKE}>
    {MARK_LANES.map((d) => (
      <path key={d} d={d} />
    ))}
    {MARK_NODES.map((n) => (
      <circle key={`${n.cx}-${n.cy}`} cx={n.cx} cy={n.cy} r={MARK_NODE_R} fill="currentColor" stroke="none" />
    ))}
  </svg>
);
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
export const IconPullRequest = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="18" r="2.4" />
    <path d="M6 8.4v7.2" />
    <path d="M18 15.6V9a3 3 0 0 0-3-3h-3" />
    <path d="m14 3.5-2.5 2.5 2.5 2.5" />
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
/** Indeterminate activity ring — shown while the action a control started runs. */
export const IconSpinner = (p: P) => (
  <svg {...base(p)} className={"spin" + (p.className ? ` ${p.className}` : "")}>
    <circle cx="12" cy="12" r="8.5" opacity="0.25" />
    <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" />
  </svg>
);
/** Spinner + text for a button waiting on the network, e.g. "Cloning…". */
export const BusyLabel = ({ children }: { children: ReactNode }) => (
  <span className="btn-busy">
    <IconSpinner width={13} height={13} />
    {children}
  </span>
);
export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v4h-4" />
  </svg>
);
export const IconPlus = (p: P) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...base({ width: 15, height: 15, strokeWidth: 2.4, ...p })}>
    <path d="M4.5 4.5 19.5 19.5M19.5 4.5 4.5 19.5" />
  </svg>
);
export const IconCloud = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 18a4 4 0 0 1-.6-7.95 5 5 0 0 1 9.7-1.2A3.5 3.5 0 0 1 18 18Z" />
    <path d="M12 12v6" />
    <path d="m9.5 15.5 2.5 2.5 2.5-2.5" />
  </svg>
);
export const IconEye = (p: P) => (
  <svg {...base({ strokeWidth: 1.7, ...p })}>
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);
export const IconEyeOff = (p: P) => (
  <svg {...base({ strokeWidth: 1.7, ...p })}>
    <path d="M4 4 20 20" />
    <path d="M9.6 5.6A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3 3.6" />
    <path d="M6 7.2A16.6 16.6 0 0 0 2 12s3.6 6.5 10 6.5a9.7 9.7 0 0 0 3-.5" />
    <path d="M9.9 9.9a2.6 2.6 0 0 0 3.7 3.7" />
  </svg>
);
export const IconDots = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <circle cx="5" cy="12" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="19" cy="12" r="1.7" />
  </svg>
);
export const IconMerge = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="18" cy="6" r="2.4" />
    <path d="M6 8.4v7.2" />
    <path d="M18 8.4v1.2c0 3.4-3.4 3.8-6.6 5.4" />
  </svg>
);
export const IconWarning = (p: P) => (
  <svg {...base({ strokeWidth: 1.9, ...p })}>
    <path d="M10.3 3.9 2.5 17.5A2 2 0 0 0 4.2 20.5h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4.5" />
    <path d="M12 17h.01" />
  </svg>
);
export const IconExternal = (p: P) => (
  <svg {...base({ width: 14, height: 14, ...p })}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </svg>
);
export const IconClipboard = (p: P) => (
  <svg {...base({ width: 14, height: 14, ...p })}>
    <rect x="6" y="4" width="12" height="17" rx="2" />
    <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
  </svg>
);
export const IconHome = (p: P) => (
  <svg {...base({ strokeWidth: 1.7, ...p })}>
    <path d="M4 11.5 12 4l8 7.5" />
    <path d="M6 10v9h12v-9" />
    <path d="M10 19v-5h4v5" />
  </svg>
);
export const IconWorktree = (p: P) => (
  <svg {...base(p)}>
    <circle cx="7" cy="5" r="2.2" />
    <path d="M7 7.2v9.6" />
    <circle cx="7" cy="19" r="2.2" />
    <path d="M7 12h6a3 3 0 0 0 3-3V7.5" />
    <circle cx="16" cy="5" r="2.2" />
  </svg>
);
export const IconRepo = (p: P) => (
  <svg {...base({ strokeWidth: 1.7, ...p })}>
    <path d="M6 4h11a1 1 0 0 1 1 1v13H7a1 1 0 0 1-1-1Z" />
    <path d="M6 15h12" />
    <path d="M9 4v9l2-1.5L13 13V4" />
  </svg>
);
