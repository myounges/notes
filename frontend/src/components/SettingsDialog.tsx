import { useState } from "react";
import { api } from "../lib/api";
import type { Settings } from "../lib/types";

interface Props {
  settings: Settings;
  onClose: () => void;
  onSaved: (s: Settings) => void;
  onImport: () => void;
}

export default function SettingsDialog({ settings, onClose, onSaved, onImport }: Props) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [model, setModel] = useState(settings.model);
  const [whisperModel, setWhisperModel] = useState(settings.whisper_model);
  const [schedule, setSchedule] = useState(settings.schedule);
  const [busy, setBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [autoTagBusy, setAutoTagBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.updateSettings({ enabled, model, schedule, whisper_model: whisperModel });
      onSaved(res);
      setMessage("Settings saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't save settings");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setRunBusy(true);
    setMessage(null);
    try {
      const res = await api.runTranscription();
      setMessage(
        res.busy
          ? "Worker pass started — it's processing in the background. Check status in a bit."
          : `Worker responded: ${JSON.stringify(res.workerResponse).slice(0, 120)}`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't reach the AI worker");
    } finally {
      setRunBusy(false);
    }
  };

  const exportNow = async () => {
    setExportBusy(true);
    setMessage(null);
    try {
      await api.exportBackup();
      setMessage("Backup downloaded.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't export backup");
    } finally {
      setExportBusy(false);
    }
  };

  const autoTag = async () => {
    setAutoTagBusy(true);
    setMessage(null);
    try {
      const res = await api.runAutotag();
      setMessage(
        `Auto-tag done: ${res.tagged} tagged, ${res.untagged} no match, ${res.skipped} skipped, ${res.checked} checked (of ${res.total}).`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't reach the AI worker");
    } finally {
      setAutoTagBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <dialog open className="modal settings-modal" aria-labelledby="settings-title">
        <h2 id="settings-title">Settings</h2>

        <div className="setting-row">
          <label className="switch-label" htmlFor="set-enabled">
            <span>AI transcription (OCR + captioning)</span>
            <span className="switch">
              <input id="set-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span className="switch-track" />
            </span>
          </label>
        </div>

        <div className="setting-row">
          <label className="setting-label" htmlFor="set-model">Model</label>
          <select id="set-model" value={model} onChange={(e) => setModel(e.target.value as Settings["model"])} disabled={!enabled}>
            <option value="florence-2-base">Florence-2 base (OCR + captions, ~460MB)</option>
            <option value="florence-2-large">Florence-2 large (~1.5GB)</option>
            <option value="tesseract">Tesseract OCR (light, text only)</option>
          </select>
        </div>

        <div className="setting-row">
          <label className="setting-label" htmlFor="set-schedule">Schedule (cron, UTC)</label>
          <input id="set-schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)} disabled={!enabled} placeholder="0 2 * * *" />
        </div>

        <div className="setting-row">
          <label className="setting-label" htmlFor="set-whisper-model">Voice model (Whisper)</label>
          <select id="set-whisper-model" value={whisperModel} onChange={(e) => setWhisperModel(e.target.value as Settings["whisper_model"])}>
            <option value="base">Whisper base (~150MB, faster)</option>
            <option value="small">Whisper small (~500MB, better) — default</option>
            <option value="medium">Whisper medium (~1.5GB, most accurate)</option>
          </select>
          <span className="setting-hint">Voice notes (English/Spanish). Loads on demand, unloads after each transcription.</span>
        </div>

        {enabled && (
          <div className="setting-row">
            <button className="btn btn-secondary" onClick={() => void runNow()} disabled={runBusy || busy}>
              {runBusy ? "Running…" : "Run transcription now"}
            </button>
          </div>
        )}

        <div className="setting-row">
          <button className="btn btn-secondary" onClick={() => void autoTag()} disabled={autoTagBusy || busy || runBusy}>
            {autoTagBusy ? "Auto-tagging…" : "Auto Tag"}
          </button>
        </div>

        <hr className="settings-sep" />

        <h3 className="settings-heading">Data</h3>
        <div className="setting-row">
          <button className="btn btn-secondary" onClick={onImport}>
            ⇪ Bulk import (.zip / .jex)
          </button>
        </div>
        <div className="setting-row">
          <button className="btn btn-secondary" onClick={() => void exportNow()} disabled={busy || runBusy || exportBusy}>
            {exportBusy ? "Exporting…" : "⇩ Export backup (.jex)"}
          </button>
        </div>

        {message && <div className="settings-message" role="status">{message}</div>}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </dialog>
    </div>
  );
}