import { useEffect, useRef, useState } from "react";
import type { NoteListEntry, SearchResult } from "../lib/types";
import { formatDate } from "../lib/api";

interface Props {
  notes: NoteListEntry[];
  total: number;
  sort: string;
  order: "asc" | "desc";
  onSortChange: (s: string) => void;
  onOrderChange: (o: "asc" | "desc") => void;
  tagFilter: string | null;
  onTagFilter: (t: string | null) => void;
  tagCounts: Array<{ name: string; count: number }>;
  pinnedOnly: boolean;
  onPinnedOnly: () => void;
  searchQuery: string;
  onSearch: (q: string) => void;
  searching: boolean;
  results: SearchResult[] | null;
  currentId: string | null;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onMenu: () => void;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: (ids: string[]) => void;
  onDeselectAll: (ids: string[]) => void;
  onClearSelect: () => void;
  onBulkTag: (add: string[], remove: string[]) => void;
  onBulkDelete: (ids: string[]) => void;
  bulkBusy: boolean;
}

const SORTS = [
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
  { value: "title", label: "Title" },
];

export default function NotesList({
  notes, total, sort, order, onSortChange, onOrderChange, tagFilter, onTagFilter, tagCounts,
  pinnedOnly, onPinnedOnly, searchQuery, onSearch, searching, results, currentId, onOpen, onCreate, onDelete, onMenu,
  selected, onToggleSelect, onSelectAll, onDeselectAll, onClearSelect, onBulkTag, onBulkDelete, bulkBusy,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagMode, setBulkTagMode] = useState<"add" | "remove">("add");
  const [bulkTagValue, setBulkTagValue] = useState("");
  const [confirmBulkBin, setConfirmBulkBin] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const bulkRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && selected.size > 0) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        onClearSelect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size, onClearSelect]);

  // Close the tags menu when clicking anywhere outside it, or pressing Escape.
  useEffect(() => {
    if (!tagMenuOpen) return;
    const onDown = (e: Event) => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) {
        setTagMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTagMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [tagMenuOpen]);

  // Close the bulk tag popover on outside click / Escape too.
  useEffect(() => {
    if (!bulkTagOpen) return;
    const onDown = (e: Event) => {
      if (bulkRef.current && !bulkRef.current.contains(e.target as Node)) {
        setBulkTagOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBulkTagOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [bulkTagOpen]);

  const showingSearch = searchQuery.trim().length > 0 && results !== null;
  const visibleIds = showingSearch ? (results ?? []).map((r) => r.id) : notes.map((n) => n.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const applyBulkTag = (add: string[], remove: string[]) => {
    onBulkTag(add, remove);
    setBulkTagOpen(false);
    setBulkTagValue("");
  };

  const applyInputBulkTag = () => {
    const t = bulkTagValue.trim().replace(/^#/, "");
    if (!t) return;
    applyBulkTag(bulkTagMode === "add" ? [t] : [], bulkTagMode === "remove" ? [t] : []);
  };

  return (
    <div className="notes-list" onMouseDown={(e) => e.stopPropagation()}>
      <div className="notes-list-header">
        <button className="icon-btn menu-btn mobile-only" onClick={onMenu} aria-label="Open menu" aria-haspopup="true">
          ☰
        </button>
        {visibleIds.length > 0 && (
          <label className="note-check note-check-all note-check-mobile" title="Select all in list">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={() => (allVisibleSelected ? onDeselectAll(visibleIds) : onSelectAll(visibleIds))}
              aria-label="Select all notes in list"
            />
          </label>
        )}
        <h1 className="app-title">Notes</h1>
        <div className="search-row">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            className="search-input"
            type="search"
            placeholder="Search notes"
            value={searchQuery}
            onChange={(e) => onSearch(e.target.value)}
            aria-label="Search notes"
          />
          {searchQuery && (
            <button className="clear-btn" onClick={() => onSearch("")} aria-label="Clear search">
              ×
            </button>
          )}
        </div>
        <div className="list-controls">
          {visibleIds.length > 0 && (
            <label className="note-check note-check-all note-check-desktop" title="Select all in list">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={() => (allVisibleSelected ? onDeselectAll(visibleIds) : onSelectAll(visibleIds))}
                aria-label="Select all notes in list"
              />
            </label>
          )}
          <label className="select-wrap">
            <span className="visually-hidden">Sort by</span>
            <select value={sort} onChange={(e) => onSortChange(e.target.value)}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
          <button className="icon-btn" onClick={() => onOrderChange(order === "desc" ? "asc" : "desc")} title={order === "desc" ? "Newest first" : "Oldest first"} aria-label="Toggle sort direction">
            {order === "desc" ? "↓" : "↑"}
          </button>
          <button className={`chip ${pinnedOnly ? "active" : ""}`} onClick={onPinnedOnly} title="Only pinned">
            📌
          </button>
          <div className="tag-menu-wrap" ref={tagMenuRef}>
            <button className={`chip ${tagFilter ? "active" : ""}`} onClick={() => setTagMenuOpen((v) => !v)} aria-expanded={tagMenuOpen}>
              {tagFilter ? `#${tagFilter}` : "Tags"}
            </button>
            {tagMenuOpen && (
              <div className="tag-menu" role="menu">
                <button role="menuitem" className="tag-option" onClick={() => { onTagFilter(null); setTagMenuOpen(false); }}>
                  All tags
                </button>
                {tagCounts.map((t) => (
                  <button key={t.name} role="menuitem" className="tag-option" onClick={() => { onTagFilter(t.name === tagFilter ? null : t.name); setTagMenuOpen(false); }}>
                    <span>#{t.name}</span>
                    <span className="tag-count">{t.count}</span>
                  </button>
                ))}
                {tagCounts.length === 0 && <div className="tag-menu-empty">No tags yet</div>}
              </div>
            )}
          </div>
        </div>
        <div className="list-total">
          {showingSearch
            ? `${results!.length} match${results!.length === 1 ? "" : "es"}`
            : `${total} note${total === 1 ? "" : "s"}`}
          {searching && <span className="searching">…</span>}
        </div>
      </div>

      <ul className="note-items" role="list">
        {showingSearch
          ? results!.map((r) => (
              <NoteRow
                key={r.id}
                id={r.id}
                title={r.title}
                tags={r.tags}
                updated={r.updated}
                pinned={r.pinned}
                excerpt={r.matchedField === "attachments" ? `📎 ${r.attachmentFilename}: ${r.snippet}` : r.snippet}
                highlight
                matched={r.matchedField}
                current={currentId === r.id}
                selected={selected.has(r.id)}
                onToggle={onToggleSelect}
                onOpen={onOpen}
                confirm={confirmDelete}
                onAsk={setConfirmDelete}
                onDelete={onDelete}
              />
            ))
          : notes.map((n) => (
              <NoteRow
                key={n.id}
                id={n.id}
                title={n.title}
                tags={n.tags}
                updated={n.updated}
                pinned={n.pinned}
                excerpt={n.excerpt}
                current={currentId === n.id}
                selected={selected.has(n.id)}
                onToggle={onToggleSelect}
                onOpen={onOpen}
                confirm={confirmDelete}
                onAsk={setConfirmDelete}
                onDelete={onDelete}
              />
            ))}
      </ul>

      {!showingSearch && notes.length === 0 && (
        <div className="list-empty">
          {tagFilter || pinnedOnly
            ? "Nothing matches this filter."
            : "Empty. Write your first note below."}
        </div>
      )}

      {selected.size > 0 && (
        <div className="bulk-bar">
          <div className="bulk-actions">
            <span className="bulk-count" role="status">
              {selected.size} selected
            </span>
            <div className="bulk-tag-wrap" ref={bulkRef}>
              <button className="btn btn-secondary btn-sm" onClick={() => setBulkTagOpen((v) => !v)} disabled={bulkBusy} aria-expanded={bulkTagOpen}>
                Tag…
              </button>
              {bulkTagOpen && (
                <div className="bulk-tag-popover">
                  <div className="bulk-tag-mode">
                    <button className={bulkTagMode === "add" ? "active" : ""} onClick={() => setBulkTagMode("add")}>
                      Add tag
                    </button>
                    <button className={bulkTagMode === "remove" ? "active" : ""} onClick={() => setBulkTagMode("remove")}>
                      Remove tag
                    </button>
                  </div>
                  <div className="bulk-tag-input-row">
                    <input
                      value={bulkTagValue}
                      placeholder={bulkTagMode === "add" ? "Tag to add…" : "Tag to remove…"}
                      onChange={(e) => setBulkTagValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") applyInputBulkTag();
                      }}
                      aria-label="Tag name"
                    />
                    <button className="btn btn-primary btn-sm" onClick={applyInputBulkTag} disabled={!bulkTagValue.trim() || bulkBusy}>
                      Apply
                    </button>
                  </div>
                  {tagCounts.length > 0 && (
                    <div className="bulk-tag-chips">
                      {tagCounts.slice(0, 14).map((t) => (
                        <button
                          key={t.name}
                          className="bulk-tag-chip"
                          title={bulkTagMode === "add" ? `Add #${t.name}` : `Remove #${t.name}`}
                          onClick={() => applyBulkTag(bulkTagMode === "add" ? [t.name] : [], bulkTagMode === "remove" ? [t.name] : [])}
                          disabled={bulkBusy}
                        >
                          #{t.name}
                          <span className="tag-count">{t.count}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {confirmBulkBin ? (
              <span className="bulk-confirm">
                Move {selected.size} to bin?
                <button className="btn btn-danger btn-sm" onClick={() => { onBulkDelete([...selected]); setConfirmBulkBin(false); }} disabled={bulkBusy}>
                  Yes
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setConfirmBulkBin(false)} disabled={bulkBusy}>
                  No
                </button>
              </span>
            ) : (
              <button className="btn btn-secondary btn-sm" onClick={() => setConfirmBulkBin(true)} disabled={bulkBusy}>
                Move to bin
              </button>
            )}
            <button className="icon-btn bulk-clear" title="Clear selection" aria-label="Clear selection" onClick={onClearSelect} disabled={bulkBusy}>
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="list-footer">
        <button className="btn btn-primary new-note-btn" onClick={onCreate}>
          New note
        </button>
      </div>
    </div>
  );
}

function NoteRow({ id, title, tags, updated, pinned, excerpt, highlight, matched, current, selected, onToggle, onOpen, confirm, onAsk, onDelete }: {
  id: string;
  title: string;
  tags: string[];
  updated: string;
  pinned: boolean;
  excerpt: string;
  highlight?: boolean;
  matched?: string;
  current: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  confirm: string | null;
  onAsk: (id: string | null) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <li className={`note-item-wrap ${selected ? "selected" : ""}`}>
      <div className="note-row">
        <label className="note-check" title="Select note">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggle(id)}
            aria-label={`Select ${title || "untitled"} note`}
          />
        </label>
        <button className={`note-item ${current ? "active" : ""}`} onClick={() => onOpen(id)}>
          <NoteItemContent
            title={title}
            tags={tags}
            updated={updated}
            pinned={pinned}
            excerpt={excerpt}
            highlight={highlight}
            matched={matched}
          />
        </button>
      </div>
      <DeleteAction id={id} confirm={confirm} onAsk={onAsk} onDelete={onDelete} />
    </li>
  );
}

function NoteItemContent({ title, tags, updated, pinned, excerpt, highlight, matched }: {
  title: string; tags: string[]; updated: string; pinned: boolean; excerpt: string;
  highlight?: boolean; matched?: string;
}) {
  return (
    <span className="note-item-inner">
      <span className="note-item-title">
        {title || "Untitled"}
        {pinned && <span className="pin-flag" aria-label="Pinned">📌</span>}
      </span>
      {tags.length > 0 && <TagBubbles tags={tags} />}
      <span className={`note-item-excerpt ${matched ? `match-${matched}` : ""}`}>
        {highlight && matched === "title" ? null : excerpt}
      </span>
      <span className="note-item-meta">
        <span>{formatDate(updated)}</span>
      </span>
      {highlight && matched === "attachments" && <span className="match-badge">Attachment match</span>}
    </span>
  );
}

function TagBubbles({ tags, limit = 2 }: { tags: string[]; limit?: number }) {
  const shown = tags.slice(0, limit);
  const rest = tags.length - shown.length;
  return (
    <span className="tag-bubbles" aria-label={`Tags: ${tags.join(", ")}`}>
      {shown.map((t) => (
        <span key={t} className="tag-bubble">#{t}</span>
      ))}
      {rest > 0 && <span className="tag-bubble">+{rest}</span>}
    </span>
  );
}

function DeleteAction({ id, confirm, onAsk, onDelete }: {
  id: string; confirm: string | null; onAsk: (id: string | null) => void; onDelete: (id: string) => void;
}) {
  if (confirm === id) {
    return (
      <div className="confirm-delete" onClick={() => onAsk(null)}>
        <span>Move to bin?</span>
        <button className="confirm-yes" onClick={(e) => { e.stopPropagation(); onDelete(id); onAsk(null); }}>
          Move to bin
        </button>
        <button className="confirm-no" onClick={(e) => { e.stopPropagation(); onAsk(null); }}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      className="note-delete"
      aria-label="Delete note"
      title="Delete"
      onClick={(e) => {
        e.stopPropagation();
        onAsk(confirm === null ? id : null);
      }}
    >
      ✕
    </button>
  );
}