import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown GFM additions", () => {
  it("renders task list checkboxes", () => {
    const html = renderMarkdown("- [ ] buy milk\n- [x] done");
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).not.toMatch(/<input[^>]*disabled/);
  });

  it("renders strikethrough", () => {
    const html = renderMarkdown("~~gone~~");
    expect(html).toContain("<s>gone</s>");
  });

  it("still renders tables", () => {
    const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<table>");
  });
});