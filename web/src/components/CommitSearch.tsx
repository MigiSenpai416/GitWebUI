import { useRef } from "react";
import { useCommitSearch } from "../state/commitSearch";
import "./CommitSearch.css";

export function CommitSearch() {
  const search = useCommitSearch();
  const input = useRef<HTMLInputElement>(null);
  if (!search.open) return null;

  const navigate = (direction: number) => {
    search.navigate(direction);
    input.current?.focus();
  };

  return (
    <div className="commit-find-row">
      <span className="commit-find-scope">All branches and tags · title and description</span>
      <div className="commit-find" role="search" aria-label="Search repository commits">
        <input
          ref={input}
          autoFocus
          aria-label="Find in commits"
          placeholder="Find in commits…"
          maxLength={1000}
          value={search.query}
          onChange={(e) => search.search(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              search.toggle();
            } else if (e.key === "Enter") {
              e.preventDefault();
              navigate(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <span className="commit-find-count" role="status" aria-live="polite">
          {search.loading ? "Searching…" : search.error ? "Search failed" : !search.query.trim() ? "" :
            search.matches.length ? `${search.current + 1} of ${search.matches.length}` : "No results"}
        </span>
        <button type="button" aria-label="Previous commit match" title="Previous match (Shift+Enter)" disabled={!search.matches.length || !!search.error} onClick={() => navigate(-1)}>↑</button>
        <button type="button" aria-label="Next commit match" title="Next match (Enter)" disabled={!search.matches.length || !!search.error} onClick={() => navigate(1)}>↓</button>
        <button type="button" aria-label="Close commit search" title="Close search (Escape)" onClick={search.toggle}>✕</button>
      </div>
      {search.error && <div className="commit-find-error" role="alert">{search.error} <button onClick={() => search.search(search.query, true)}>Retry</button></div>}
    </div>
  );
}
