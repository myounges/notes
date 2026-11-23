import { useEffect } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  total: number;
  tagCounts: Array<{ name: string; count: number }>;
  tagFilter: string | null;
  onTagFilter: (t: string | null) => void;
  pinnedOnly: boolean;
  onPinnedOnly: () => void;
  onSettings: () => void;
  onBin: () => void;
}

export default function MobileMenu({
  open, onClose, total, tagCounts, tagFilter, onTagFilter, pinnedOnly, onPinnedOnly, onSettings, onBin,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  return (
    <>
      <div className={`mobile-menu-scrim ${open ? "visible" : ""}`} onClick={onClose} aria-hidden="true" />
      <aside className={`mobile-menu ${open ? "open" : ""}`} role="dialog" aria-label="Menu" aria-hidden={!open}>
        <div className="mobile-menu-head">
          <span className="mobile-menu-title">Notes</span>
          <span className="mobile-menu-count">
            {total} note{total === 1 ? "" : "s"}
          </span>
        </div>

        <div className="mobile-menu-section-title">Tags</div>
        <button
          className={`mobile-menu-item ${tagFilter === null ? "active" : ""}`}
          onClick={() => { onTagFilter(null); onClose(); }}
        >
          All notes
        </button>
        {tagCounts.map((t) => (
          <button
            key={t.name}
            className={`mobile-menu-item ${tagFilter === t.name ? "active" : ""}`}
            onClick={() => { onTagFilter(t.name === tagFilter ? null : t.name); onClose(); }}
          >
            #{t.name}
            <span className="item-count">{t.count}</span>
          </button>
        ))}
        {tagCounts.length === 0 && <div className="mobile-menu-empty">No tags yet</div>}

        <label className="mobile-menu-toggle">
          <span>Pinned only</span>
          <span className="switch">
            <input type="checkbox" checked={pinnedOnly} onChange={onPinnedOnly} />
            <span className="switch-track" />
          </span>
        </label>

        <hr className="mobile-menu-sep" />
        <div className="mobile-menu-section-title">Settings</div>
        <button className="mobile-menu-item" onClick={onSettings}>
          <span aria-hidden>⚙</span> Configuration
        </button>
        <button className="mobile-menu-item" onClick={onBin}>
          <span aria-hidden>🗑</span> Bin
        </button>
      </aside>
    </>
  );
}