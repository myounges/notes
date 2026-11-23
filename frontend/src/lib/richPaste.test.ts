import { describe, expect, it } from "vitest";
import { convertRich, decidePasteAction, type DataImage } from "./richPaste";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const stubUpload =
  (name = "photo.png") =>
  (_img: DataImage): Promise<string> =>
    Promise.resolve(name);

describe("decidePasteAction", () => {
  it("returns none when the clipboard has neither files nor html", () => {
    expect(decidePasteAction({ files: [], html: "" })).toBe("none");
    expect(decidePasteAction({ files: [], html: "   " })).toBe("none");
  });

  it("returns files for image file items without html", () => {
    const file = new File(["x"], "a.png", { type: "image/png" });
    expect(decidePasteAction({ files: [file], html: "" })).toBe("files");
  });

  it("returns rich for formatted html", () => {
    expect(decidePasteAction({ files: [], html: "<p>Hello <b>world</b></p>" })).toBe("rich");
  });

  it("prefers files for image-only html with matching file items (no double upload)", () => {
    const file = new File(["x"], "a.png", { type: "image/png" });
    expect(decidePasteAction({ files: [file], html: `<img src="${PNG}" alt="x">` })).toBe("files");
  });

  it("still converts image-only html when file items are absent", () => {
    expect(decidePasteAction({ files: [], html: `<img src="${PNG}" alt="x">` })).toBe("rich");
  });

  it("bails to plain text when the html is oversized", () => {
    const html = "<p>" + "x".repeat(2_000_001) + "</p>";
    expect(decidePasteAction({ files: [], html })).toBe("none");
    const file = new File(["x"], "a.png", { type: "image/png" });
    expect(decidePasteAction({ files: [file], html })).toBe("files");
  });
});

describe("sanitize (via convertRich)", () => {
  it("strips scripts, inline handlers and javascript: links", async () => {
    const html = `<script>alert(1)</script><p onclick="evil()">Hi <a href="javascript:alert(1)">there</a><a href="https://ok.dev">ok</a></p>`;
    const { markdown } = await convertRich(html, stubUpload());
    expect(markdown).not.toContain("<script");
    expect(markdown).not.toContain("onclick");
    expect(markdown).not.toContain("javascript:");
    expect(markdown).toContain("there");
    expect(markdown).toContain("[ok](https://ok.dev)");
  });

  it("drops iframes and inline svg elements", async () => {
    const html = `<iframe src="https://x"></iframe><svg onload="evil()"><circle/></svg><p>ok</p>`;
    const { markdown } = await convertRich(html, stubUpload());
    expect(markdown).not.toContain("iframe");
    expect(markdown).not.toContain("<svg");
    expect(markdown).toContain("ok");
  });
});

describe("convertRich baseline", () => {
  it("converts headings, lists, bold/italic and links", async () => {
    const html =
      "<h2>Title</h2><ul><li><strong>bold</strong></li><li><em>ital</em></li></ul><p>see <a href='https://a.b'>A</a></p>";
    const { markdown } = await convertRich(html, stubUpload());
    expect(markdown).toContain("## Title");
    expect(markdown).toContain("- **bold**");
    expect(markdown).toContain("- _ital_");
    expect(markdown).toContain("[A](https://a.b)");
  });

  it("converts tables", async () => {
    const html = "<table><tr><th>H</th></tr><tr><td>1</td></tr></table>";
    const { markdown } = await convertRich(html, stubUpload());
    expect(markdown).toContain("| H |");
    expect(markdown).toContain("| 1 |");
  });

  it("converts task list items", async () => {
    const html = "<ul><li><input type='checkbox' checked> done</li><li>not</li></ul>";
    const { markdown } = await convertRich(html, stubUpload());
    expect(markdown).toContain("- [x] done");
  });
});

describe("editor junk cleanup", () => {
  it("removes Word/outlook artifacts, empty paragraphs and nbsp", async () => {
    const html = `<p class="MsoNormal"><o:p> </o:p>&nbsp;&nbsp;Hello</p><p> </p><p><img src="${PNG}" alt="pic"></p>`;
    const { markdown } = await convertRich(html, stubUpload());
    expect(markdown).not.toContain("Mso");
    expect(markdown).not.toContain("<o:p>");
    expect(markdown).not.toContain("\u00A0");
    expect(markdown).not.toContain("\n\n\n");
    expect(markdown).toContain("Hello");
  });
});

describe("convertRich images", () => {
  it("uploads data: images and rewrites them to attachment refs", async () => {
    const calls: DataImage[] = [];
    const upload = async (img: DataImage): Promise<string> => {
      calls.push(img);
      return "photo.png";
    };
    const html = `<p>Text <img src="${PNG}" alt="the alt"></p>`;
    const { markdown, uploaded } = await convertRich(html, upload);
    expect(uploaded).toBe(1);
    expect(calls[0]?.src).toBe(PNG);
    expect(calls[0]?.mime).toBe("image/png");
    expect(calls[0]?.alt).toBe("the alt");
    expect(markdown).toContain("![the alt](attachments/photo.png)");
  });

  it("keeps remote image urls untouched", async () => {
    const html = `<p>R<img src="https://cdn.example/a.jpg" alt="r">emote</p>`;
    const { markdown, uploaded } = await convertRich(html, stubUpload());
    expect(uploaded).toBe(0);
    expect(markdown).toContain("![r](https://cdn.example/a.jpg)");
  });

  it("never uploads svg data uris; keeps their alt text", async () => {
    const svg = "data:image/svg+xml;base64,PHN2Zy8+";
    const html = `<p>A <img src="${svg}" alt="shape"> B</p>`;
    const { markdown, uploaded } = await convertRich(html, stubUpload());
    expect(uploaded).toBe(0);
    expect(markdown).not.toContain("svg");
    expect(markdown).toContain("shape");
  });

  it("uploads multiple data: images sequentially", async () => {
    const html = `<p><img src="${PNG}" alt="one"><img src="${PNG}" alt="two"></p>`;
    const { uploaded, markdown } = await convertRich(html, stubUpload("multi.png"));
    expect(uploaded).toBe(2);
    expect(markdown).toMatch(/\[[^\]]+\]\(attachments\/multi\.png\)[\s\S]*\(attachments\/multi\.png\)/);
  });
});