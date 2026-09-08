import type { PrActivity } from "../types";

export interface PrThread {
  comment: PrActivity;
  replies: PrActivity[];
}

export interface PrConversationEntry {
  kind: "comment" | "review" | "thread";
  item: PrActivity;
  threads: PrThread[];
}

function time(item: PrActivity): number {
  return Date.parse(item.submitted_at || item.created_at || "") || 0;
}

export function buildConversation(comments: PrActivity[], reviews: PrActivity[], codeComments: PrActivity[]): PrConversationEntry[] {
  const threads = new Map<number, PrThread>();
  const entries: PrConversationEntry[] = comments.map((item) => ({ kind: "comment", item, threads: [] }));
  const reviewEntries = new Map<number, PrConversationEntry>();
  for (const item of reviews) {
    const entry: PrConversationEntry = { kind: "review", item, threads: [] };
    entries.push(entry);
    if (item.id !== undefined) reviewEntries.set(item.id, entry);
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
    thread.replies.sort((a, b) => time(a) - time(b));
    const review = reviewEntries.get(thread.comment.pull_request_review_id ?? -1);
    if (review) review.threads.push(thread);
    else entries.push({ kind: "thread", item: thread.comment, threads: [thread] });
  }
  return entries.sort((a, b) => time(a.item) - time(b.item));
}
