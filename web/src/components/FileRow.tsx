import type { ChangeStatus, FileChange } from "../types";
import "./FileRow.css";

interface Props {
  file: Pick<FileChange, "path" | "status" | "oldPath">;
  active: boolean;
  onOpen: () => void;
  /** Indentation depth for Tree view. */
  depth?: number;
  /** Show full directory path (Path view) vs just the file name (Tree view). */
  showDir?: boolean;
  /** Optional inline action (Stage / Unstage) shown on hover. */
  actionLabel?: string;
  onAction?: () => void;
}

export function FileRow({ file, active, onOpen, depth = 0, showDir = true, actionLabel, onAction }: Props) {
  const { dir, name } = splitPath(file.path);
  return (
    <div
      className={"file-row" + (active ? " active" : "")}
      style={{ paddingLeft: 12 + depth * 15 }}
      onClick={onOpen}
    >
      <StatusGlyph status={file.status} />
      <span className="file-name">{name}</span>
      {showDir && dir && <span className="file-dir">{dir}</span>}
      <div className="spacer" />
      {actionLabel && onAction && (
        <button
          className="file-action"
          title={actionLabel}
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/** GitKraken-style leading glyph: pencil (modified), + (added), − (deleted), etc. */
function StatusGlyph({ status }: { status: ChangeStatus }) {
  const g = glyph(status);
  return (
    <span className={"file-glyph fg-" + g.cls} title={g.title}>
      {g.char}
    </span>
  );
}

function glyph(s: ChangeStatus): { char: string; cls: string; title: string } {
  switch (s) {
    case "A":
    case "?":
      return { char: "+", cls: "add", title: s === "?" ? "Untracked" : "Added" };
    case "D":
      return { char: "−", cls: "del", title: "Deleted" };
    case "R":
      return { char: "→", cls: "ren", title: "Renamed" };
    case "C":
      return { char: "⧉", cls: "ren", title: "Copied" };
    case "U":
      return { char: "!", cls: "del", title: "Unmerged" };
    default:
      return { char: "✎", cls: "mod", title: "Modified" };
  }
}

function splitPath(p: string): { dir: string; name: string } {
  const parts = p.split("/");
  const name = parts.pop() ?? p;
  return { dir: parts.join("/"), name };
}
