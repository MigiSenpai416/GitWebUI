import { useState, type DragEvent } from "react";
import { useStore } from "../state/store";
import { repoColor } from "../brand";
import { IconClose, IconMark, IconPlus, IconRepo } from "./icons";
import "./TabBar.css";

/** Workspace tab strip: one tab per open repo (or empty picker), plus a New Tab button. */
export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const selectTab = useStore((s) => s.selectTab);
  const closeTab = useStore((s) => s.closeTab);
  const moveTab = useStore((s) => s.moveTab);
  const newTab = useStore((s) => s.newTab);
  const status = useStore((s) => s.status);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: "before" | "after";
  } | null>(null);

  // Only the active repo's working tree is loaded, so only its tab can report
  // uncommitted changes.
  const activeDirty = status.staged.length + status.unstaged.length > 0;

  const clearDrag = () => {
    setDraggingTabId(null);
    setDropTarget(null);
  };

  const dragOverTab = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!draggingTabId || draggingTabId === id) {
      setDropTarget(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
    setDropTarget((current) =>
      current?.id === id && current.position === position ? current : { id, position },
    );
  };

  return (
    <div className="tabbar">
      <IconMark className="tabbar-brand" width={17} height={17} aria-hidden="true" />
      <div
        className="tabbar-tabs"
        onDragOver={(e) => {
          if (!(e.target as Element).closest(".tab")) setDropTarget(null);
        }}
        onDragLeave={(e) => {
          const next = e.relatedTarget;
          if (!(next instanceof Node) || !e.currentTarget.contains(next)) setDropTarget(null);
        }}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={
              "tab" +
              (tab.id === activeTabId ? " active" : "") +
              (tab.id === draggingTabId ? " dragging" : "") +
              (dropTarget?.id === tab.id ? ` drop-${dropTarget.position}` : "")
            }
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", tab.id);
              setDraggingTabId(tab.id);
              setDropTarget(null);
            }}
            onDragOver={(e) => dragOverTab(e, tab.id)}
            onDrop={(e) => {
              e.preventDefault();
              if (draggingTabId && draggingTabId !== tab.id) {
                const rect = e.currentTarget.getBoundingClientRect();
                const position = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
                moveTab(draggingTabId, tab.id, position);
              }
              clearDrag();
            }}
            onDragEnd={clearDrag}
            onClick={() => selectTab(tab.id)}
            onAuxClick={(e) => {
              // Middle-click closes, matching browser tabs.
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.id);
              }
            }}
            title={tab.root ?? "New tab"}
          >
            <span
              className="tab-icon"
              style={tab.root ? { color: repoColor(tab.root) } : undefined}
              title={tab.id === activeTabId && activeDirty ? "Uncommitted changes" : undefined}
            >
              <IconRepo width={15} height={15} />
              {tab.id === activeTabId && activeDirty && <span className="tab-dirty" />}
            </span>
            <span className="tab-name">{tab.root ? tab.name : "New Tab"}</span>
            <button
              className="tab-close"
              draggable={false}
              aria-label={`Close ${tab.name}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <IconClose />
            </button>
          </div>
        ))}
        <button
          className="tab-add"
          onDragEnter={() => setDropTarget(null)}
          onClick={() => newTab()}
          title="New tab"
          aria-label="New tab"
        >
          <IconPlus width={15} height={15} />
        </button>
      </div>
    </div>
  );
}
