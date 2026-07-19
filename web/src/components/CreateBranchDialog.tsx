import { useState } from "react";
import { useStore } from "../state/store";
import "./CreateBranchDialog.css";

export function CreateBranchDialog() {
  const hash = useStore((s) => s.branchDialogHash);
  const commits = useStore((s) => s.commits);
  const close = useStore((s) => s.closeBranchDialog);
  const createBranchAt = useStore((s) => s.createBranchAt);
  const [name, setName] = useState("");

  if (!hash) return null;
  const commit = commits.find((c) => c.hash === hash);

  const valid = /^[^\s~^:?*[\\]+$/.test(name.trim()) && name.trim().length > 0;

  const submit = () => {
    if (!valid) return;
    createBranchAt(name.trim(), hash);
    setName("");
  };

  return (
    <div className="dialog-backdrop" onMouseDown={close}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Create branch</div>
        <div className="dialog-sub">
          at <span className="dialog-hash">{commit?.shortHash ?? hash.slice(0, 7)}</span>
          {commit && <> — {commit.subject}</>}
        </div>
        <input
          autoFocus
          className="dialog-input"
          placeholder="new-branch-name"
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") close();
          }}
        />
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={close}>
            Cancel
          </button>
          <button className="dialog-btn dialog-btn-primary" disabled={!valid} onClick={submit}>
            Create &amp; checkout
          </button>
        </div>
      </div>
    </div>
  );
}
