import { useEffect } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  pinned: boolean;
  onPin: () => void;
  onAttach: () => void;
  onInfo: () => void;
  onDelete: () => void;
}

export default function EditorMenu({
  open, onClose, pinned, onPin, onAttach, onInfo, onDelete,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: Event) => {
      const sheet = document.querySelector<HTMLElement>(".editor-sheet");
      if (sheet && !sheet.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, onClose]);

  const run = (fn: () => void) => () => { onClose(); fn(); };

  return (
    <>
      <div className={`editor-sheet-scrim ${open ? "visible" : ""}`} onClick={onClose} aria-hidden="true" />
      <div className={`editor-sheet ${open ? "open" : ""}`} role="dialog" aria-label="Note actions" aria-hidden={!open}>
        <button className="editor-sheet-item" onClick={run(onAttach)}>
          <span aria-hidden>📎</span> Attach files
        </button>
        <button className="editor-sheet-item" onClick={run(onInfo)}>
          <span aria-hidden>#</span> Tags
        </button>
        <button className="editor-sheet-item" onClick={run(onInfo)}>
          <span aria-hidden>ℹ️</span> Information
        </button>
        <button className="editor-sheet-item" onClick={run(onPin)}>
          <span aria-hidden>📌</span> {pinned ? "Unpin" : "Pin"}
        </button>
        <button className="editor-sheet-item danger" onClick={run(onDelete)}>
          <span aria-hidden>🗑</span> Move to bin
        </button>
      </div>
    </>
  );
}