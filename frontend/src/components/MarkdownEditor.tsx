import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { livePreview, livePreviewTheme, liveLinkClicks } from "../lib/livePreview";
import { decidePasteAction, type RichPasteData } from "../lib/richPaste";

interface Props {
  value: string;
  onChange: (v: string) => void;
  mode: "source" | "split" | "live";
  placeholder?: string;
  viewRef: MutableRefObject<EditorView | null>;
  resolveAttachment?: (href: string) => string;
  onPasteFiles?: (files: File[]) => void;
  onRichPaste?: (data: RichPasteData) => void;
}

function baseExtensions(
  onChange: (v: string) => void,
  onPasteFiles?: (files: File[]) => void,
  onRichPaste?: (data: RichPasteData) => void,
): Extension[] {
  return [
    lineNumbers(),
    EditorView.lineWrapping,
    highlightActiveLine(),
    drawSelection(),
    history(),
    bracketMatching(),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const cd = event.clipboardData;
        if (!cd) return false;
        const files: File[] = [];
        for (const item of cd.items) {
          if (item.kind !== "file") continue;
          const f = item.getAsFile();
          if (f && /^image\//.test(f.type)) files.push(f);
        }
        const html = cd.getData("text/html") ?? "";
        if (files.length === 0 && !html) return false;
        const decision = decidePasteAction({ files, html });
        if (decision === "rich") {
          const { from, to } = view.state.selection.main;
          event.preventDefault();
          onRichPaste?.({ html, from, to });
          return true;
        }
        if (decision === "files" && files.length > 0) {
          event.preventDefault();
          onPasteFiles?.(files);
          return true;
        }
        return false;
      },
    }),
    EditorView.theme({
      "&": { height: "100%", fontSize: "15px" },
      ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65", padding: "12px 14px" },
      ".cm-content": { caretColor: "var(--accent)", maxWidth: "72ch" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
      ".cm-gutters": { background: "transparent", border: "none", color: "var(--text-3)", fontFamily: "var(--font-mono)" },
      ".cm-activeLine": { background: "transparent" },
      "&.cm-focused": { outline: "none" },
    }),
  ];
}

export default function MarkdownEditor({ value, onChange, mode, placeholder, viewRef, resolveAttachment, onPasteFiles, onRichPaste }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onPasteRef = useRef(onPasteFiles);
  onPasteRef.current = onPasteFiles;
  const onRichPasteRef = useRef(onRichPaste);
  onRichPasteRef.current = onRichPaste;

  const extensions = useMemo<Extension[]>(() => {
    const base = baseExtensions(
      (v) => onChangeRef.current(v),
      (files) => onPasteRef.current?.(files),
      (data) => onRichPasteRef.current?.(data),
    );
    if (mode === "live") {
      base.push(livePreviewTheme, livePreview(resolveAttachment), liveLinkClicks(resolveAttachment));
    }
    return base;
  }, [mode, resolveAttachment]);

  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: value,
        extensions,
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // mount once; extension/mode changes handled below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep extensions in sync with mode changes without remount
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const next = EditorState.create({
      doc: current,
      extensions,
    });
    view.setState(next);
  }, [extensions]);

  // external value updates (e.g. after save, or switching notes via key)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (placeholder) {
      view.dom.dataset.placeholder = placeholder;
    }
  }, [placeholder]);

  return <div ref={containerRef} className="cm-root" />;
}

export function insertAtCursor(view: EditorView, text: string): void {
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

export function wrapSelection(view: EditorView, before: string, after: string): void {
  const { from, to } = view.state.selection.main;
  const selected = view.state.doc.sliceString(from, to);
  view.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: { anchor: from + before.length, head: to + before.length },
  });
  view.focus();
}