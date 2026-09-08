import { describe, expect, it } from "vitest";
import { buildConversation } from "./prConversation";

describe("pull request conversation", () => {
  it("orders comments and reviews and nests code replies under the original review", () => {
    const result = buildConversation(
      [{ id: 1, created_at: "2026-09-08T01:00:00Z" }],
      [{ id: 2, submitted_at: "2026-09-08T02:00:00Z", state: "COMMENTED" }],
      [{ id: 4, in_reply_to_id: 3, pull_request_review_id: 9, created_at: "2026-09-08T04:00:00Z" },
        { id: 3, pull_request_review_id: 2, path: "file.ts", created_at: "2026-09-08T02:00:00Z" }],
    );
    expect(result.map((entry) => entry.kind)).toEqual(["comment", "review"]);
    expect(result[1].threads).toMatchObject([{ comment: { id: 3 }, replies: [{ id: 4 }] }]);
  });

  it("keeps code comments visible before their review or parent page loads", () => {
    const result = buildConversation([], [], [
      { id: 3, pull_request_review_id: 2 }, { id: 5, in_reply_to_id: 4, body: "Reply from another page" },
    ]);
    expect(result.map((entry) => entry.item.id)).toEqual([3, 5]);
  });

  it("does not drop approvals or dismissed reviews that have no message", () => {
    const result = buildConversation([], [{ id: 1, state: "APPROVED", body: "" }, { id: 2, state: "DISMISSED" }], []);
    expect(result).toHaveLength(2);
  });
});
