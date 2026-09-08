import type { PrActivity } from "../types";

export interface PrThread {
  comment: PrActivity;
  replies: PrActivity[];
}

export interface PrConversationEntry {
  kind: "comment" | "review" | "thread" | "event" | "commits";
  item: PrActivity;
  threads: PrThread[];
  commits?: PrActivity[];
}

export function activityKey(item: PrActivity): string {
  return `${item.event ?? "thread"}:${item.node_id ?? item.id ?? item.sha ?? (item.source?.issue ? JSON.stringify([item.source.issue.html_url, item.created_at, item.actor?.login]) : JSON.stringify(item))}`;
}

export function buildConversation(timeline: PrActivity[], codeComments: PrActivity[], complete = true): PrConversationEntry[] {
  const threads = new Map<number, PrThread>();
  const entries: PrConversationEntry[] = [];
  const reviewEntries = new Map<number, PrConversationEntry>();
  for (const item of timeline) {
    if (["mentioned", "subscribed", "unsubscribed"].includes(item.event ?? "")) continue;
    const kind = item.event === "commented" ? "comment" : item.event === "reviewed" ? "review" : item.event === "committed" ? "commits" : "event";
    const previous = entries[entries.length - 1];
    if (kind === "commits" && previous?.kind === "commits"
      && (previous.item.author?.email ?? previous.item.author?.name) === (item.author?.email ?? item.author?.name)) {
      previous.commits!.push(item);
      continue;
    }
    const entry: PrConversationEntry = { kind, item, threads: [], ...(kind === "commits" ? { commits: [item] } : {}) };
    entries.push(entry);
    if (kind === "review" && item.id !== undefined) reviewEntries.set(item.id, entry);
  }
  for (const comment of codeComments) {
    if (comment.id !== undefined && !comment.in_reply_to_id) threads.set(comment.id, { comment, replies: [] });
  }
  for (const comment of codeComments) {
    if (!comment.in_reply_to_id) continue;
    const thread = threads.get(comment.in_reply_to_id);
    if (thread) thread.replies.push(comment);
    else if (comment.id !== undefined) threads.set(comment.id, { comment, replies: [] });
  }
  for (const thread of threads.values()) {
    thread.replies.sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""));
    const review = reviewEntries.get(thread.comment.pull_request_review_id ?? -1);
    if (review) review.threads.push(thread);
    else if (complete) entries.push({ kind: "thread", item: thread.comment, threads: [thread] });
  }
  return entries;
}
