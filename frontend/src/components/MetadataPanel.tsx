import { useEffect, useRef, useState } from "react";
import type { NoteLocation } from "../lib/types";
import { formatDate } from "../lib/api";

interface Props {
  noteId: string;
  tags: string[];
  onTags: (t: string[]) => void;
  allTags: Array<{ name: string; count: number }>;
  pinned: boolean;
  onPinned: (v: boolean) => void;
  location: NoteLocation | null;
  onLocation: (l: NoteLocation | null) => void;
  onTagLocation: () => void;
  geocoding: boolean;
  created: string;
  updated: string;
  wordCount: number;
  sizeBytes: number;
  device: string | null;
  onSaved: () => void;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export default function MetadataPanel({
  noteId, tags, onTags, allTags, pinned, onPinned, location, onLocation, onTagLocation, geocoding,
  created, updated, wordCount, sizeBytes, device, onSaved,
}: Props) {
  const [tagInput, setTagInput] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const tagsRef = useRef<HTMLDivElement>(null);

  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, "");
    if (t && !tags.includes(t)) {
      const next = [...tags, t].sort();
      onTags(next);
      onSaved();
    }
    setTagInput("");
  };

  const removeTag = (t: string) => {
    onTags(tags.filter((x) => x !== t));
    onSaved();
  };

  const toggleTag = (t: string) => {
    onTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t].sort());
    onSaved();
  };

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      if (tagsRef.current && !tagsRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [pickerOpen]);

  const q = tagSearch.trim().toLowerCase();
  const filtered = allTags
    .filter((t) => t.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="metadata-panel" data-has-location={!!location}>
      <h3>Note info</h3>

      <div className="meta-block">
        <label className="meta-label" htmlFor={`tags-${noteId}`}>Tags</label>
        <div className="tags-editor" ref={tagsRef}>
          {tags.map((t) => (
            <span key={t} className="meta-tag">
              #{t}
              <button className="tag-remove" aria-label={`Remove tag ${t}`} onClick={() => removeTag(t)}>
                ×
              </button>
            </span>
          ))}
          <div className="tag-add-row">
            <input
              id={`tags-${noteId}`}
              value={tagInput}
              placeholder={tags.length ? "+ Add tag" : "Add a tag…"}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTag();
                if (e.key === "Backspace" && tagInput === "" && tags.length) removeTag(tags[tags.length - 1]!);
              }}
              onBlur={() => tagInput && addTag()}
            />
            <button
              type="button"
              className="tag-picker-toggle"
              title="Apply existing tags"
              aria-label="Apply existing tags"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((v) => !v)}
            >
              ▾
            </button>
          </div>
          {pickerOpen && (
            <div className="tag-picker">
              <input
                className="tag-search"
                value={tagSearch}
                placeholder="Filter tags…"
                aria-label="Filter tags"
                onChange={(e) => setTagSearch(e.target.value)}
              />
              <div className="tag-picker-list">
                {filtered.length === 0 && <div className="tag-menu-empty">No matching tags</div>}
                {filtered.map(({ name, count }) => (
                  <label key={name} className="tag-picker-item">
                    <input
                      type="checkbox"
                      checked={tags.includes(name)}
                      onChange={() => toggleTag(name)}
                    />
                    <span className="tag-picker-name">#{name}</span>
                    <span className="tag-count">{count}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="meta-block">
        <span className="meta-label">Pinned</span>
        <label className="switch">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => {
              onPinned(e.target.checked);
              onSaved();
            }}
          />
          <span className="switch-track" />
        </label>
      </div>

      <div className="meta-block">
        <span className="meta-label">Location</span>
        {location ? (
          <div className="location-chip">
            <span>
              📍 {location.name ?? `${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}`}
            </span>
            <button className="tag-remove" aria-label="Remove location" onClick={() => { onLocation(null); onSaved(); }}>
              ×
            </button>
          </div>
        ) : (
          <button className="btn btn-secondary btn-sm" onClick={onTagLocation} disabled={geocoding}>
            {geocoding ? "Locating…" : "📍 Tag current location"}
          </button>
        )}
      </div>

      <dl className="meta-readonly">
        {device && (
          <div className="meta-row">
            <dt>Device</dt>
            <dd>{device}</dd>
          </div>
        )}
        <div className="meta-row">
          <dt>Words</dt>
          <dd>{wordCount}</dd>
        </div>
        <div className="meta-row">
          <dt>Size</dt>
          <dd title={`note.md + attachments`}>{formatBytes(sizeBytes)}</dd>
        </div>
        <div className="meta-row">
          <dt>Created</dt>
          <dd>{formatDate(created)}</dd>
        </div>
        <div className="meta-row">
          <dt>Updated</dt>
          <dd>{formatDate(updated)}</dd>
        </div>
      </dl>
    </div>
  );
}