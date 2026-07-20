import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import "./CommitContextMenu.css";

const MENU_W = 250;

/** Right-click menu for a file or folder in the changes panel. */
export function ChangesContextMenu() {
  const menu = useStore((s) => s.changesMenu);
  const close = useStore((s) => s.closeChangesMenu);
  const repo = useStore((s) => s.repo);
  const stage = useStore((s) => s.stage);
  const unstage = useStore((s) => s.unstage);
  const discardPaths = useStore((s) => s.discardPaths);
  const deleteFile = useStore((s) => s.deleteFile);
  const revealPath = useStore((s) => s.revealPath);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const setNotice = useStore((s) => s.setNotice);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    if (!menu) return;
    const h = ref.current?.offsetHeight ?? 180;
    const left = Math.min(menu.x, window.innerWidth - MENU_W - 8);
    const top = Math.min(menu.y, window.innerHeight - h - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, close]);

  if (!menu) return null;

  const confirmThen = async (message: string, label: string, run: () => void) => {
    close();
    if (await requestConfirm(message, label)) run();
  };

  const copyPath = async () => {
    close();
    const abs = joinPath(repo?.root ?? "", menu.filePath ?? "");
    try {
      await navigator.clipboard.writeText(abs);
      setNotice("Copied file path.");
    } catch {
      setNotice(abs);
    }
  };

  return (
    <div
      className="ctx-menu"
      ref={ref}
      style={{ left: pos.left, top: pos.top, width: MENU_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === "folder" ? (
        <>
          <button
            className="ctx-item"
            onClick={() => {
              close();
              stage(menu.paths);
            }}
          >
            <span className="ctx-icon">+</span>
            Stage folder
          </button>
          <button
            className="ctx-item"
            onClick={() =>
              confirmThen(
                `This is a destructive operation, are you sure you want to discard all changes in ${menu.label}/?`,
                "Discard",
                () => discardPaths(menu.paths),
              )
            }
          >
            <span className="ctx-icon ctx-revert">🗑</span>
            Discard all changes in folder
          </button>
          <div className="ctx-sep" />
          <button
            className="ctx-item"
            onClick={() => revealPath(menu.folderPath ?? "")}
          >
            <span className="ctx-icon">📂</span>
            Open folder
          </button>
        </>
      ) : (
        <>
          <button
            className="ctx-item"
            onClick={() => {
              close();
              menu.staged ? unstage(menu.paths) : stage(menu.paths);
            }}
          >
            <span className="ctx-icon">{menu.staged ? "−" : "+"}</span>
            {menu.staged ? "Unstage" : "Stage"}
          </button>
          <button
            className="ctx-item"
            onClick={() =>
              confirmThen(
                `This is a destructive operation, are you sure you want to discard changes to ${menu.label}?`,
                "Discard",
                () => discardPaths(menu.paths),
              )
            }
          >
            <span className="ctx-icon ctx-revert">🗑</span>
            Discard changes
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={copyPath}>
            <span className="ctx-icon">⧉</span>
            Copy file path
          </button>
          <button
            className="ctx-item"
            onClick={() =>
              confirmThen(
                `This is a destructive operation, are you sure you want to delete ${menu.label}?`,
                "Delete",
                () => deleteFile(menu.filePath ?? ""),
              )
            }
          >
            <span className="ctx-icon ctx-revert">✕</span>
            Delete file
          </button>
        </>
      )}
      <div className="ctx-footer">{menu.kind === "folder" ? `${menu.label}/` : menu.label}</div>
    </div>
  );
}

function joinPath(root: string, rel: string): string {
  if (!root) return rel;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[/\\]+$/, "") + sep + rel;
}
