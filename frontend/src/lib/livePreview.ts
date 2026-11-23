import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { RangeSetBuilder, StateField, type EditorState, type Text } from "@codemirror/state";

const mdMarks = {
  strong: Decoration.mark({ class: "cm-md-strong" }),
  em: Decoration.mark({ class: "cm-md-em" }),
  code: Decoration.mark({ class: "cm-md-code" }),
  link: Decoration.mark({ class: "cm-md-link" }),
  del: Decoration.mark({ class: "cm-md-del" }),
  heading: Decoration.mark({ class: "cm-md-heading" }),
  marker: Decoration.mark({ class: "cm-md-marker" }),
  checkbox: Decoration.mark({ class: "cm-md-checkbox" }),
  hr: Decoration.line({ class: "cm-md-hr" }),
};

interface RangeRec {
  from: number;
  to: number;
  deco: Decoration;
}

class AttachmentImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(o: AttachmentImageWidget) {
    return o.src === this.src && o.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-live-image";
    img.src = this.src;
    img.alt = this.alt || "attachment";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.style.display = "none";
    });
    return img;
  }
  ignoreEvent() {
    return true;
  }
}

// image alone on its (own) line, optionally inside a list item
const imageLineRe = /^\s*(?:[-*+] )?!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*$/;

function computeDecos(state: EditorState, resolveSrc?: (href: string) => string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: RangeRec[] = [];
  const imageWidgets: RangeRec[] = [];
  const text = state.doc.toString();

  // fenced code spans hide markdown syntax; skip decorations inside them
  const inCode = new Set<number>();
  let fence = false;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (/^\s*(?:```|~~~)/.test(line.text)) {
      fence = !fence;
      inCode.add(line.from + (line.text.indexOf("```") >= 0 ? line.text.indexOf("```") : line.text.indexOf("~~~")));
      continue;
    }
    if (fence) inCode.add(line.from);
  }

  // images on their own line render as real <img> blocks
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (inCode.has(line.from)) continue;
    if (/^\s{4}|\t/.test(line.text)) continue;
    const m = imageLineRe.exec(line.text);
    if (!m) continue;
    const src = resolveSrc ? resolveSrc(m[2]) : m[2];
    imageWidgets.push({
      from: line.from,
      to: line.to,
      deco: Decoration.replace({ widget: new AttachmentImageWidget(src, m[1]), block: true }),
    });
  }
  const coveredByImage = (from: number, to: number) =>
    imageWidgets.some((w) => (from >= w.from && from < w.to) || (to > w.from && to <= w.to));

  const pushMarker = (from: number, to: number) => ranges.push({ from, to, deco: mdMarks.marker });

  // headings: dim the # markers, style the content
  const headingRe = /^[ \t]*#{1,6}[ \t]+([^\n]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(text))) {
    const markerStart = m.index;
    const contentStart = markerStart + (m[0].match(/^[ \t]*#+[ \t]*/) ?? [""])[0].length;
    pushMarker(markerStart, contentStart);
    const to = contentStart + m[1].length;
    ranges.push({ from: contentStart, to, deco: mdMarks.heading });
  }

  // blockquotes: dim the >
  const quoteRe = /^[ \t]*>[ \t]?/gm;
  while ((m = quoteRe.exec(text))) {
    pushMarker(m.index, m.index + m[0].length);
  }

  // checkboxes
  const checkboxRe = /^[ \t]*-[ \t]+\[[ xX]\][ \t]?/gm;
  while ((m = checkboxRe.exec(text))) {
    const box = m[0].indexOf("[");
    pushMarker(m.index, m.index + box);
    ranges.push({ from: m.index + box, to: m.index + box + 3, deco: mdMarks.checkbox });
  }

  // bold **..**
  const boldRe = /\*\*([^*\n]+)\*\*/g;
  while ((m = boldRe.exec(text))) {
    pushMarker(m.index, m.index + 2);
    ranges.push({ from: m.index + 2, to: m.index + 2 + m[1].length, deco: mdMarks.strong });
    pushMarker(m.index + 2 + m[1].length, m.index + m[0].length);
  }

  // italic *..* (single star, non-nested)
  const emRe = /(^|[^*])\*([^*\n]+)\*/g;
  while ((m = emRe.exec(text))) {
    const contentStart = m.index + m[1].length + 1;
    ranges.push({ from: m.index + m[1].length, to: contentStart, deco: mdMarks.marker });
    ranges.push({ from: contentStart, to: contentStart + m[2].length, deco: mdMarks.em });
    pushMarker(contentStart + m[2].length, contentStart + m[2].length + 1);
  }

  // inline code
  const codeRe = /`([^`\n]+)`/g;
  while ((m = codeRe.exec(text))) {
    pushMarker(m.index, m.index + 1);
    ranges.push({ from: m.index + 1, to: m.index + 1 + m[1].length, deco: mdMarks.code });
    pushMarker(m.index + 1 + m[1].length, m.index + m[0].length);
  }

  // links [label](url)
  const linkRe = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  while ((m = linkRe.exec(text))) {
    pushMarker(m.index, m.index + 1);
    ranges.push({ from: m.index + 1, to: m.index + 1 + m[1].length, deco: mdMarks.link });
    pushMarker(m.index + 1 + m[1].length, m.index + m[0].length);
  }

  // strikethrough ~~..~~
  const delRe = /~~([^~\n]+)~~/g;
  while ((m = delRe.exec(text))) {
    pushMarker(m.index, m.index + 2);
    ranges.push({ from: m.index + 2, to: m.index + 2 + m[1].length, deco: mdMarks.del });
    pushMarker(m.index + 2 + m[1].length, m.index + m[0].length);
  }

  const content = ranges.filter((r) => !coveredByImage(r.from, r.to));
  for (const w of imageWidgets) content.push(w);

  content.sort((a, b) => a.from - b.from || b.to - a.to);

  const activeLine = currentLineRange(state);
  for (const r of content) {
    if (r.from >= r.to) continue;
    if (activeLine && r.from >= activeLine.from && r.to <= activeLine.to) continue;
    builder.add(r.from, r.to, r.deco);
  }
  return builder.finish();
}

function currentLineRange(state: EditorState): { from: number; to: number } | null {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { from: line.from, to: line.to };
}

export const livePreviewTheme = EditorView.baseTheme({
  ".cm-md-marker": { opacity: "0.35" },
  ".cm-md-heading": { fontWeight: "700", fontSize: "1.12em" },
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-code": { fontFamily: "var(--font-mono)", background: "var(--surface-2)", padding: "0 2px", borderRadius: "4px" },
  ".cm-md-link": { textDecoration: "underline", color: "var(--accent)", cursor: "pointer" },
  ".cm-md-del": { textDecoration: "line-through", opacity: "0.7" },
  ".cm-md-checkbox": { color: "var(--accent)", fontWeight: "700" },
  ".cm-md-hr": { textDecoration: "underline", opacity: "0.4" },
  ".cm-md-quote": { color: "var(--accent)" },
  ".cm-live-image": { display: "block", maxWidth: "100%", height: "auto", borderRadius: "var(--radius-md)", margin: "0.5em 0", cursor: "default" },
});

export function livePreview(resolveSrc?: (href: string) => string) {
  return StateField.define<DecorationSet>({
    create: (state) => computeDecos(state, resolveSrc),
    update: (prev, tr) => {
      if (!tr.docChanged && tr.startState.selection.eq(tr.state.selection)) return prev;
      return computeDecos(tr.state, resolveSrc);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

function lineInCodeBlock(doc: Text, lineNo: number): boolean {
  let fence = false;
  for (let n = 1; n < lineNo; n++) {
    if (/^\s*(?:```|~~~)/.test(doc.line(n).text)) fence = !fence;
  }
  return fence;
}

/** Make attachment / markdown links clickable in live mode (labels + own-line images). */
export function liveLinkClicks(resolveSrc?: (href: string) => string) {
  return EditorView.domEventHandlers({
    click(event, view) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
      if (!view.state.selection.main.empty) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos);
      if (/^\s{4}|\t/.test(line.text)) return false;
      if (lineInCodeBlock(view.state.doc, line.number)) return false;
      const offset = pos - line.from;
      const img = imageLineRe.exec(line.text);
      if (img) {
        window.open(resolveSrc ? resolveSrc(img[2]) : img[2], "_blank", "noopener");
        return false;
      }
      const re = /\[([^\]\n]+)\]\(([^)\s]+)[^)]*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line.text))) {
        const labelStart = m.index + 1;
        const labelEnd = labelStart + m[1].length;
        if (offset >= labelStart && offset <= labelEnd) {
          window.open(resolveSrc ? resolveSrc(m[2]) : m[2], "_blank", "noopener");
          break;
        }
      }
      return false;
    },
  });
}