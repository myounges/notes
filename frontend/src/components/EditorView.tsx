import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView as CMView } from "@codemirror/view";
import MarkdownEditor, { wrapSelection, insertAtCursor } from "./MarkdownEditor";
import Preview from "./Preview";
import AttachmentsPanel from "./AttachmentsPanel";
import VoiceRecorder from "./VoiceRecorder";
import MetadataPanel from "./MetadataPanel";
import EditorMenu from "./EditorMenu";
import { api } from "../lib/api";
import { reverseGeocode } from "../lib/api";
import { convertRich, type DataImage, type RichPasteData } from "../lib/richPaste";
import type { EditorMode, NoteLocation, Note } from "../lib/types";

interface Props {
  note: Note;
  mode: EditorMode;
  onMode: (m: EditorMode) => void;
  allTags: Array<{ name: string; count: number }>;
  onChanged: () => void;
  onClose: () => void;
  onDelete: () => void;
  brandNew?: boolean;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

const MODE_ORDER: EditorMode[] = ["source", "split", "live"];

export default function EditorView({ note, mode, onMode, allTags, onChanged, onClose, onDelete, brandNew }: Props) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState(note.tags);
  const [pinned, setPinned] = useState(note.pinned);
  const [location, setLocation] = useState<NoteLocation | null>(note.location ?? null);
  const [updated, setUpdated] = useState(note.updated);
  const [wordCount, setWordCount] = useState(note.word_count);
  const [noteSizeBytes, setNoteSizeBytes] = useState(note.note_size_bytes ?? 0);
  const [attachments, setAttachments] = useState<string[]>(note.attachments ?? []);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [convertingRich, setConvertingRich] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [attachTick, setAttachTick] = useState(0);

  const cmRef = useRef<CMView | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const resolveAttachment = useCallback(
    (href: string): string => {
      if (!/^attachments\//.test(href)) return href;
      return api.attachmentUrl(note.id, decodeURIComponent(href.slice("attachments/".length)));
    },
    [note.id],
  );
  const previewRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollTimer = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  const draft = useRef({ title: note.title, body: note.body, tags: note.tags, pinned: note.pinned, location: note.location ?? null });
  draft.current = { title, body, tags, pinned, location };

  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  // Refetch the note from disk. The AI worker appends the whisper transcript to
  // the note body directly, so after a voice transcription this is the only way
  // to reflect the new content in the editor. Also refreshes the attachments
  // list and bumps the notes-list refresh via onChanged.
  const reloadNote = useCallback(async () => {
    try {
      const fresh = await api.getNote(note.id);
      setTitle(fresh.title);
      setBody(fresh.body);
      setTags(fresh.tags);
      setPinned(fresh.pinned);
      setLocation(fresh.location ?? null);
      setUpdated(fresh.updated);
      setWordCount(fresh.word_count);
      setNoteSizeBytes(fresh.note_size_bytes ?? 0);
      setAttachments(fresh.attachments ?? []);
      onChangedRef.current();
    } catch {
      // note was deleted while transcribing — nothing to refresh
    }
  }, [note.id]);

  const handleTranscribed = useCallback(() => {
    setAttachTick((t) => t + 1);
    void reloadNote();
  }, [reloadNote]);

  const save = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const d = draft.current;
      setStatus("saving");
      try {
        const res = await api.updateNote(note.id, {
          title: d.title,
          body: d.body,
          tags: d.tags,
          pinned: d.pinned,
          location: d.location,
        });
        setUpdated(res.updated);
        setWordCount(res.word_count);
        setNoteSizeBytes(res.note_size_bytes ?? 0);
        setStatus("saved");
        onChangedRef.current();
      } catch (err) {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : "Save failed");
      }
    }, 700);
  }, [note.id]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const onBodyChange = useCallback(
    (v: string) => {
      setBody(v);
      setWordCount(v.trim() === "" ? 0 : countWords(v));
      void save();
    },
    [save],
  );

  const insert = useCallback(
    (text: string) => {
      const view = cmRef.current;
      if (view) {
        // block images must start on their own line to render embedded
        const sel = view.state.selection.main;
        const line = view.state.doc.lineAt(sel.from);
        const before = view.state.doc.sliceString(line.from, sel.from);
        const prefix = /^\s*!\[.*/.test(text) && before.trim() !== "" ? "\n" : "";
        insertAtCursor(view, prefix + text);
      } else setBody((b) => b + text);
      void save();
    },
    [save],
  );

  const block = useCallback(
    (marker: string) => {
      const view = cmRef.current;
      if (view) applyBlock(view, marker);
      void save();
    },
    [save],
  );

  const insertCodeBlock = useCallback(() => {
    const view = cmRef.current;
    if (!view) return;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const atStart = /^\s*$/.test(view.state.doc.sliceString(line.from, from));
    const pos = atStart ? line.from : line.to;
    const text = (atStart ? "" : "\n") + "```\n\n```";
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length - 3 },
    });
    view.focus();
    void save();
  }, [save]);

  const insertTable = useCallback(() => {
    const view = cmRef.current;
    if (!view) return;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const atStart = /^\s*$/.test(view.state.doc.sliceString(line.from, from));
    const pos = atStart ? line.from : line.to;
    const header = "| Header | Header |\n| --- | --- |\n";
    const text = (atStart ? "" : "\n") + header + "|  |  |\n|  |  |";
    const caret = pos + (atStart ? "" : "\n").length + header.length + "| ".length;
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: caret },
    });
    view.focus();
    void save();
  }, [save]);

  const insertTime = useCallback(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    insert(`${stamp} `);
  }, [insert]);

  const onFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files as File[])) {
        try {
          await api.uploadAttachment(note.id, file);
          const url = `attachments/${encodeURIComponent(file.name)}`;
          const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);
          insert(`${isImage ? "!" : ""}[${file.name}](${url})\n`);
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : `Couldn't upload ${file.name}`);
          setStatus("error");
        }
      }
      // refresh attachment list
      try {
        const fresh = await api.getNote(note.id);
        setAttachments(fresh.attachments ?? []);
        onChanged();
      } catch {
        // ignore
      }
    },
    [note.id, insert, onChanged],
  );

  const onClipboardPaste = useCallback(
    async (files: File[]) => {
      const taken = new Set(attachments);
      for (const src of files) {
        try {
          const name = uniqueAttachmentName(src, taken);
          const file = new File([src], name, { type: src.type });
          await api.uploadAttachment(note.id, file);
          taken.add(name);
          const url = `attachments/${encodeURIComponent(name)}`;
          const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
          insert(`${isImage ? "!" : ""}[${name}](${url})\n`);
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : `Couldn't upload pasted image`);
          setStatus("error");
        }
      }
      try {
        const fresh = await api.getNote(note.id);
        setAttachments(fresh.attachments ?? []);
        onChanged();
      } catch {
        // ignore
      }
    },
    [note.id, attachments, insert, onChanged],
  );

  // Rich-text paste: convert pasted HTML to Markdown, upload embedded images as
  // attachments, and insert the result at the position captured at paste time.
  const onRichPaste = useCallback(
    async ({ html, from, to }: RichPasteData) => {
      const taken = new Set(attachments);
      setConvertingRich(true);
      try {
        const { markdown, uploaded } = await convertRich(html, async (img) => {
          const draft = dataUriToFile(img, dataUriName(img.src, img.alt));
          const file = new File([draft], uniqueAttachmentName(draft, taken), { type: draft.type });
          await api.uploadAttachment(note.id, file);
          taken.add(file.name);
          return file.name;
        });
        const view = cmRef.current;
        if (view) {
          view.dispatch({
            changes: { from, to, insert: markdown },
            selection: { anchor: from + markdown.length },
          });
          view.focus();
        } else {
          setBody((b) => b.slice(0, from) + markdown + b.slice(to));
        }
        if (uploaded > 0) {
          try {
            const fresh = await api.getNote(note.id);
            setAttachments(fresh.attachments ?? []);
            onChanged();
          } catch {
            // ignore
          }
        }
      } catch (err) {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : "Couldn't convert pasted rich text");
      } finally {
        setConvertingRich(false);
      }
    },
    [note.id, attachments, onChanged],
  );

  // scroll-sync from editor to preview
  useEffect(() => {
    const cme = cmRef.current;
    if (!cme) return;
    const scrollEl: HTMLElement = (cme as unknown as { scrollDOM: HTMLElement }).scrollDOM;
    const handler = () => {
      if (scrollTimer.current) cancelAnimationFrame(scrollTimer.current);
      scrollTimer.current = requestAnimationFrame(() => {
        const pv = previewRef.current;
        if (!pv) return;
        const max = scrollEl.scrollHeight - scrollEl.clientHeight;
        const frac = max > 0 ? scrollEl.scrollTop / max : 0;
        pv.scrollTop = frac * (pv.scrollHeight - pv.clientHeight);
      });
    };
    scrollEl.addEventListener("scroll", handler, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", handler);
      if (scrollTimer.current) cancelAnimationFrame(scrollTimer.current);
    };
  }, [mode]);

  const resolveLocation = useCallback(
    (onDone: (loc: NoteLocation | null) => void, onError?: () => void) => {
      if (!("geolocation" in navigator)) {
        onError?.();
        return;
      }
      setGeocoding(true);
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude, longitude } = pos.coords;
          const name = await reverseGeocode(latitude, longitude);
          const loc = { lat: Number(latitude.toFixed(6)), lon: Number(longitude.toFixed(6)), name };
          setGeocoding(false);
          onDone(loc);
        },
        () => {
          setGeocoding(false);
          onError?.();
        },
        { enableHighAccuracy: false, timeout: 10000 },
      );
    },
    [],
  );

  const tagLocation = useCallback(() => {
    resolveLocation(
      (loc) => {
        if (loc) {
          setLocation(loc);
          void save();
        }
      },
      () => {
        setErrorMsg("Location permission denied — nothing was stored.");
      },
    );
  }, [resolveLocation, save]);

  // auto-tag the current location on brand-new notes (non-blocking)
  useEffect(() => {
    if (!brandNew || location) return;
    resolveLocation((loc) => {
      if (loc) {
        setLocation(loc);
        void save();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandNew]);

  useEffect(() => {
    // keep attachments in sync if App re-fetches current note
    if (note.attachments) setAttachments(note.attachments);
  }, [note.attachments]);

  useEffect(() => {
    // brand-new notes land in the editor with focus on the title so typing starts
    // immediately. A short delay keeps the programmatic focus from being dropped
    // on mobile browsers right after the asynchronous note creation.
    if (!brandNew) return;
    const t = setTimeout(() => titleInputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [brandNew]);

  const modeLabel = `Mode: ${mode}`;

  return (
    <div className="editor-view" data-mode={mode}>
      {/* Header */}
      <header className="editor-header">
        <button className="icon-btn mobile-only" onClick={onClose} aria-label="Back to notes">
          ←
        </button>
        <input
          ref={titleInputRef}
          className="title-input"
          value={title}
          placeholder="Note title"
          aria-label="Note title"
          onChange={(e) => {
            setTitle(e.target.value);
            void save();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Tab") {
              // Move focus into the source editor so typing continues there.
              // In "live" mode the source pane is hidden, so switch to source view.
              e.preventDefault();
              if (mode === "live") onMode("source");
              requestAnimationFrame(() => cmRef.current?.focus());
            }
          }}
        />
        <span className="save-status desktop-only" role="status" aria-live="polite">
          {convertingRich
            ? "Converting rich text…"
            : status === "saving"
              ? "Saving…"
              : status === "saved"
                ? "Saved"
                : status === "error"
                  ? (errorMsg ?? "Save failed")
                  : ""}
        </span>
        {mode === "live" && tags.length > 0 && (
          <span className="header-tags mobile-only" aria-label={`Tags: ${tags.join(", ")}`}>
            <span className="tag-bubble">#{tags[0]}</span>
            {tags.length > 1 && <span className="tag-bubble">+{tags.length - 1}</span>}
          </span>
        )}
        <button
          className={`icon-btn mobile-only mode-edit-btn ${mode === "live" ? "" : "on"}`}
          title={mode === "live" ? "Edit source" : "Back to live preview"}
          aria-label={mode === "live" ? "Edit source" : "Back to live preview"}
          onClick={() => onMode(mode === "live" ? "source" : "live")}
        >
          {mode === "live" ? "✏️" : "👁"}
        </button>
        <button
          className="icon-btn mobile-only more-btn"
          title="More actions"
          aria-label="More actions"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋯
        </button>
        <button
          className={`icon-btn desktop-only ${pinned ? "pinned" : ""}`}
          title={pinned ? "Unpin" : "Pin"}
          aria-label={pinned ? "Unpin note" : "Pin note"}
          onClick={() => {
            setPinned((v) => !v);
            void save();
          }}
        >
          📌
        </button>
        <button className="icon-btn desktop-only" title="Note info & location" aria-label="Note info" onClick={() => setMetaOpen((v) => !v)} aria-pressed={metaOpen}>
          ℹ️
        </button>
        <div className="mode-toggle desktop-only" role="tablist" aria-label="Editor mode">
          {MODE_ORDER.map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "active" : ""}
              onClick={() => onMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <button className="icon-btn danger desktop-only" title="Delete note" aria-label="Delete note" onClick={() => setDeleteDialog(true)}>
          🗑
        </button>
      </header>

      {/* Toolbar */}
      {mode !== "live" && (
        <div className="editor-toolbar">
          <span className="mode-label" aria-hidden>{modeLabel}</span>
          <ToolButton label="B" title="Bold" onClick={() => cmRef.current && wrapSelection(cmRef.current, "**", "**")} />
          <ToolButton label="I" title="Italic" onClick={() => cmRef.current && wrapSelection(cmRef.current, "_", "_")} />
          <ToolButton label="`" title="Code" onClick={() => cmRef.current && wrapSelection(cmRef.current, "`", "`")} />
          <ToolButton label="{ }" title="Code block" onClick={() => insertCodeBlock()} />
          <ToolButton label="¶" title="Link" onClick={() => cmRef.current && wrapSelection(cmRef.current, "[", "](https://)")} />
          <select
            className="tool-btn tool-select"
            value=""
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n >= 1 && n <= 6) block("#".repeat(n) + " ");
            }}
            title="Header"
            aria-label="Header"
          >
            <option value="" disabled>H</option>
            {HEADINGS.map((n) => (
              <option key={n} value={n}>H{n}</option>
            ))}
          </select>
          <ToolButton label="•" title="Bullet list" onClick={() => block("- ")} />
          <ToolButton label="1." title="Numbered list" onClick={() => block("1. ")} />
          <ToolButton label="▦" title="Checklist" onClick={() => block("- [ ] ")} />
          <ToolButton label="—" title="Horizontal rule" onClick={() => block("---\n")} />
          <ToolButton label="⊞" title="Insert table" onClick={() => insertTable()} />
          <ToolButton label="🕒" title="Insert date & time" onClick={() => insertTime()} />
          <ToolButton label="＋" title="Attach file" onClick={() => fileRef.current?.click()} />
          <ToolButton label="●" title="Record voice note" onClick={() => setMetaOpen(true)} />
          <button
            className="tool-btn more-btn mobile-only"
            title="More actions"
            aria-label="More actions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void onFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Body */}
      <div className="editor-body" data-panes={mode === "split" ? 2 : 1}>
        <div className="pane-source" style={mode === "live" ? { display: "none" } : undefined}>
          <MarkdownEditor value={body} onChange={onBodyChange} mode={mode} viewRef={cmRef} resolveAttachment={resolveAttachment} onPasteFiles={(files) => void onClipboardPaste(files)} onRichPaste={(data) => void onRichPaste(data)} placeholder="Write in markdown…" />
        </div>
        {(mode === "split" || mode === "live") && (
          <div className="pane-preview" ref={previewRef}>
            <Preview source={body} resolveHref={resolveAttachment} />
          </div>
        )}
        <div className={`side-info ${metaOpen ? "open" : ""}`}>
          <button className="icon-btn side-info-close mobile-only" onClick={() => setMetaOpen(false)} aria-label="Close note info">
            ✕
          </button>
          <MetadataPanel
            noteId={note.id}
            tags={tags}
            onTags={setTags}
            allTags={allTags}
            pinned={pinned}
            onPinned={setPinned}
            location={location}
            onLocation={setLocation}
            onTagLocation={tagLocation}
            geocoding={geocoding}
            created={note.created}
            updated={updated}
            wordCount={wordCount}
            sizeBytes={noteSizeBytes}
            device={note.device ?? null}
            onSaved={() => void save()}
          />
          <AttachmentsPanel noteId={note.id} attachments={attachments} onChanged={() => void save()} onInsert={insert} onTranscribed={handleTranscribed} refreshTick={attachTick} />
          <div id="voice-anchor" className="voice-anchor">
            <VoiceRecorder noteId={note.id} onRecorded={(url, name) => insert(`[${name}](${url})\n`)} onTranscribed={handleTranscribed} />
          </div>
        </div>
      </div>

      {status === "error" && errorMsg && (
        <div className="save-error-bar" role="alert">
          {errorMsg}
          <button className="btn btn-secondary btn-sm" onClick={() => { setStatus("idle"); void save(); }}>
            Retry
          </button>
        </div>
      )}

      {deleteDialog && (
        <div className="modal-backdrop">
          <dialog open={deleteDialog} className="modal" aria-labelledby="delete-title">
            <h2 id="delete-title">Move “{title || "Untitled"}” to the bin?</h2>
            <p>The note and its attachments are kept in the bin until you empty it. You can restore it anytime.</p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDeleteDialog(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={() => { setDeleteDialog(false); onDelete(); }} autoFocus>
                Move to bin
              </button>
            </div>
          </dialog>
        </div>
      )}

      <EditorMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        pinned={pinned}
        onPin={() => { setPinned((v) => !v); void save(); }}
        onAttach={() => fileRef.current?.click()}
        onInfo={() => setMetaOpen(true)}
        onDelete={() => setDeleteDialog(true)}
      />
    </div>
  );
}

function ToolButton({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button className="tool-btn" title={title} aria-label={title} onClick={onClick}>
      {label}
    </button>
  );
}

const HEADINGS = [1, 2, 3, 4, 5, 6] as const;

/**
 * Toggle a block-level markdown marker at the caret.
 * - If the current line already starts with the marker, remove it.
 * - Otherwise insert the marker at the line start (or on a fresh line if the
 *   caret sits mid-line) and place the caret after it.
 */
function applyBlock(view: CMView, marker: string): void {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const before = view.state.doc.sliceString(line.from, from);
  const atStart = /^\s*$/.test(before);
  if (line.text.startsWith(marker)) {
    view.dispatch({
      changes: { from: line.from, to: line.from + marker.length, insert: "" },
      selection: { anchor: line.from },
    });
    return;
  }
  const pos = atStart ? line.from : line.to;
  const text = (atStart ? "" : "\n") + marker;
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
}

function countWords(text: string): number {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~|`-]/g, " ");
  const m = cleaned.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  return m.length;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
};

/** A short, collision-resistant filename for a pasted data-URI image. */
function dataUriName(src: string, alt: string): string {
  const mime = src.match(/^data:([^;,]+)/)?.[1] ?? "image/png";
  const ext = MIME_EXT[mime] ?? "img";
  const base =
    alt
      .trim()
      .replace(/[^\w\u00C0-\uFFFF-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "clipboard";
  return `${base}-${Date.now().toString(36)}.${ext}`;
}

/** Decode a pasted `data:` image URI into a File (handles base64 and percent-encoded payloads). */
function dataUriToFile({ src, mime }: DataImage, name: string): File {
  const comma = src.indexOf(",");
  const meta = comma >= 0 ? src.slice(0, comma) : "";
  const payload = comma >= 0 ? src.slice(comma + 1) : src;
  let bytes: Uint8Array<ArrayBuffer>;
  if (/;base64/i.test(meta)) {
    const bin = atob(payload);
    const buffer = new ArrayBuffer(bin.length);
    bytes = new Uint8Array(buffer);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return new File([bytes.buffer as ArrayBuffer], name, { type: mime });
}

/** Pick a collision-free attachment name for the given `src` against a set of taken names. */
function uniqueAttachmentName(src: File, taken: Set<string>): string {
  const base = src.name.trim() || "clipboard.png";
  if (!taken.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!taken.has(cand)) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}