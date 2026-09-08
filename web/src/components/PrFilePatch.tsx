import { useState } from "react";
import { parsePrPatch } from "./prPatch";

export interface PrLineComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

export function PrFilePatch({ path, patch, disabled, canComment, onComment, body, onBody }: {
  path: string; patch: string; disabled: boolean; canComment: boolean;
  onComment: (comment: PrLineComment) => Promise<void>;
  body: string; onBody: (path: string, body: string) => void;
}) {
  const [selected, setSelected] = useState<{ line: number; side: "LEFT" | "RIGHT" } | null>(null);
  const [error, setError] = useState("");
  return <div className="prv-file-patch">
    <div className="prv-patch prv-numbered-patch">
      {parsePrPatch(patch).map((row, i) => <div key={i} className={`prv-diff-line ${row.text.startsWith("+") ? "prv-added" : row.text.startsWith("-") ? "prv-removed" : ""}`}>
        <span className="prv-line-number">{row.oldLine}</span><span className="prv-line-number">{row.newLine}</span>
        <span className="prv-line-action">{canComment && (row.newLine !== undefined || row.oldLine !== undefined) && <button
          type="button" disabled={disabled} aria-label={`Comment on ${row.newLine !== undefined ? "new" : "old"} line ${row.newLine ?? row.oldLine} in ${path}`}
          title="Add a comment on this line" onClick={() => { setSelected({ line: row.newLine ?? row.oldLine!, side: row.newLine !== undefined ? "RIGHT" : "LEFT" }); setError(""); }}>+</button>}</span>
        <code>{row.text || " "}</code>
      </div>)}
    </div>
    {selected && <form className="prv-line-comment" onSubmit={async (e) => {
      e.preventDefault();
      if (disabled || !body.trim()) return;
      setError("");
      try { await onComment({ path, ...selected, body }); onBody(path, ""); setSelected(null); }
      catch (e) { setError(e instanceof Error ? e.message : "Couldn't post the code comment."); }
    }}>
      <div className="prv-section-title">{path} · {selected.side === "LEFT" ? "old" : "new"} line {selected.line}</div>
      <textarea aria-label={`Code comment on ${path}`} placeholder="Leave a comment on this line…" rows={3} value={body} onChange={(e) => onBody(path, e.target.value)} disabled={disabled} />
      {error && <div className="acct-error" role="alert">{error}</div>}
      <button className="dialog-btn dialog-btn-primary" type="submit" disabled={disabled || !body.trim()}>Add single comment</button>
      <button className="dialog-btn" type="button" disabled={disabled} onClick={() => setSelected(null)}>Cancel</button>
    </form>}
    {!selected && body && <p className="prv-muted">Your comment draft is saved. Select a line to continue.</p>}
  </div>;
}
