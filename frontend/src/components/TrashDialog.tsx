import { useCallback, useEffect, useState } from "react";
import { api, formatDate } from "../lib/api";
import type { NoteListEntry } from "../lib/types";

interface Props {
  onClose: () => void;
  onChanged: () => void;
}

export default function TrashDialog({ onClose, onChanged }: Props) {
  const [notes, setNotes] = useState<NoteListEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listTrash();
      setNotes(res.notes);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't load bin");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.restoreTrashed(id);
      onChanged();
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't restore note");
    } finally {
      setBusy(false);
    }
  };

  const purge = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.purgeTrashed(id);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't permanently delete note");
    } finally {
      setBusy(false);
    }
  };

  const empty = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.emptyTrash();
      onChanged();
      setNotes([]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't empty bin");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <dialog open className="modal trash-modal" aria-labelledby="trash-title">
        <h2 id="trash-title">Bin</h2>
        <p>{notes.length === 0 ? "The bin is empty." : `${notes.length} note${notes.length === 1 ? "" : "s"} kept here until the bin is emptied.`}</p>

        {notes.length > 0 && (
          <ul className="trash-list" role="list">
            {notes.map((n) => (
              <li key={n.id} className="trash-item">
                <div className="trash-item-main">
                  <span className="trash-item-title">{n.title || "Untitled"}</span>
                  <span className="trash-item-meta">{formatDate(n.updated)}</span>
                </div>
                <div className="trash-item-actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => void restore(n.id)} disabled={busy}>
                    Restore
                  </button>
                  <button className="btn btn-secondary btn-sm trash-delete" title="Delete forever" onClick={() => void purge(n.id)} disabled={busy}>
                    Delete forever
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {notes.length > 0 && (
          <button className="btn btn-danger trash-empty" onClick={() => void empty()} disabled={busy}>
            Empty bin
          </button>
        )}

        {message && <div className="settings-message" role="status">{message}</div>}

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </dialog>
    </div>
  );
}