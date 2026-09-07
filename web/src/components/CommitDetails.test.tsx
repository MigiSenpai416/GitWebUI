import type { ComponentProps, FunctionComponent, MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { describe, expect, it, vi } from "vitest";
import { openExternal } from "../desktop";
import { useStore } from "../state/store";
import { CommitDetails } from "./CommitDetails";

vi.mock("../state/store", () => ({ useStore: vi.fn() }));
vi.mock("../desktop", () => ({ openExternal: vi.fn() }));
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return { ...actual, default: vi.fn(actual.default) };
});

function render(body: string) {
  const state = {
    selectedCommitHash: "head",
    commits: [{
      hash: "head",
      shortHash: "head",
      subject: "Keep **subject** literal",
      body,
      author: "Ann",
      email: "ann@example.com",
      dateISO: "2026-01-01T00:00:00Z",
      parents: [],
    }],
    commitFiles: [],
    loadingCommitFiles: false,
    status: { staged: [], unstaged: [] },
    selectedFile: null,
    fileLayout: "path",
  };
  vi.mocked(useStore).mockImplementation((selector) => selector(state as never));
  return renderToStaticMarkup(<CommitDetails />);
}

describe("commit description Markdown", () => {
  it("renders formatting and GFM while leaving the subject literal", () => {
    const html = render("**Summary**\n\n- Fix `handler`\n- ~~Old~~\n\n| File | Status |\n| --- | --- |\n| main.ts | Fixed |\n\n```ts\nconst ok = true;\n```");
    expect(html).toContain("Keep **subject** literal");
    expect(html).toContain("<strong>Summary</strong>");
    expect(html).toContain("<li>Fix <code>handler</code></li>");
    expect(html).toContain("<del>Old</del>");
    expect(html).toContain("<table>");
    expect(html).toContain('<pre><code class="language-ts">const ok = true;');
  });

  it("keeps raw HTML inert and removes executable link URLs", () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[Run](javascript:alert%281%29)');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img ");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;");
  });

  it("preserves link destinations and titles", () => {
    const html = render('[Issue](https://example.com/issue "Issue details")');
    expect(html).toContain('href="https://example.com/issue"');
    expect(html).toContain('title="Issue details"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("omits an empty description without losing commit metadata", () => {
    const html = render("");
    expect(html).not.toContain('class="cd-body"');
    expect(html).toContain('class="cd-meta"');
    expect(html).toContain("ann@example.com");
  });

  it("preserves footnote reference IDs and return links", () => {
    const html = render("See note[^1].\n\n[^1]: Details.");
    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('id="user-content-fnref-1"');
    expect(html).toContain('id="user-content-fn-1"');
    expect(html).toContain('href="#user-content-fnref-1"');
    expect(html).toContain('aria-describedby="footnote-label"');
  });

  it("scrolls footnotes locally and opens external links through the bridge", () => {
    render("See note[^1].\n\n[^1]: Details.");
    const calls = vi.mocked(Markdown).mock.calls;
    const Anchor = calls[calls.length - 1][0].components!.a as FunctionComponent<ComponentProps<"a">>;
    const target = { id: "user-content-fn-1", scrollIntoView: vi.fn() };
    const event = {
      preventDefault: vi.fn(),
      currentTarget: {
        closest: vi.fn(() => ({ querySelectorAll: () => [target] })),
      },
    } as unknown as MouseEvent<HTMLAnchorElement>;
    const click = (href: string) => {
      const anchor = Anchor({ href }) as ReactElement<ComponentProps<"a">>;
      anchor.props.onClick!(event);
    };
    vi.mocked(openExternal).mockClear();
    click("#user-content-fn-1");
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(openExternal).not.toHaveBeenCalled();
    click("#missing");
    click("#%invalid");
    click("");
    expect(openExternal).not.toHaveBeenCalled();
    click("https://example.com/issue");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/issue");
  });
});
