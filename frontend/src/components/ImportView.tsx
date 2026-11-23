import { useCallback, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ImportSummary } from "../lib/types";

interface Props {
  onDone: () => void;
  onCancel: () => void;
}

export default function ImportView({ onDone, onCancel }: Props) {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const importFile = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const res = await api.importZip(file);
      setSummary(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="import-view">
      <div className="import-card">
        <div className="import-head">
          <h1>Bulk import</h1>
          <button className="icon-btn" onClick={onCancel} aria-label="Close import">×</button>
        </div>
        <p>
          Upload a <code>.zip</code> of existing markdown notes, or a Joplin backup file (<code>.jex</code>).
          Files referenced from a note (images, PDFs) living in the same folder are attached automatically;
          for <code>.jex</code> backups, attachments come from the <code>resources/</code> folder.
        </p>

        <button
          className="dropzone"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.jex,.tar,application/zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = "";
            }}
          />
          {busy ? "Importing…" : "Choose a .zip or .jex file"}
        </button>

        {error && <div className="import-error" role="alert">{error}</div>}

        {summary && (
          <div className="import-summary">
            <h2>
              {summary.imported > 0 ? "Imported" : "Imported nothing"}
            </h2>
            <p>
              Imported <strong>{summary.imported}</strong>, skipped <strong>{summary.skipped}</strong>, errors{" "}
              <strong>{summary.errors}</strong>.
            </p>
            {summary.entries.length > 0 && (
              <ul className="import-entries">
                {summary.entries.map((e, i) => (
                  <li key={i} data-action={e.action}>
                    <span className="imp-action">{e.action === "imported" ? "✓" : e.action === "error" ? "✕" : "–"}</span>
                    <span className="imp-path">{e.entry}</span>
                    {e.reason && <span className="imp-reason">{e.reason}</span>}
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setSummary(null)}>Import another</button>
              <button className="btn btn-primary" onClick={onDone}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}