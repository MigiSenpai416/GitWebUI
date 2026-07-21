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
  const newTab = useStore((s) => s.newTab);
  const status = useStore((s) => s.status);

  // Only the active repo's working tree is loaded, so only its tab can report
  // uncommitted changes.
  const activeDirty = status.staged.length + status.unstaged.length > 0;

  return (
    <div className="tabbar">
      <IconMark className="tabbar-brand" width={17} height={17} aria-hidden="true" />
      <div className="tabbar-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={"tab" + (tab.id === activeTabId ? " active" : "")}
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
              <IconRepo width={13} height={13} />
              {tab.id === activeTabId && activeDirty && <span className="tab-dirty" />}
            </span>
            <span className="tab-name">{tab.root ? tab.name : "New Tab"}</span>
            <button
              className="tab-close"
              aria-label={`Close ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <IconClose />
            </button>
          </div>
        ))}
        <button className="tab-add" onClick={() => newTab()} title="New tab" aria-label="New tab">
          <IconPlus width={15} height={15} />
        </button>
      </div>
    </div>
  );
}
