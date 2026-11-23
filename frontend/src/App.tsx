import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./lib/api";
import type { EditorMode, Note, NoteListEntry, SearchResult, Settings } from "./lib/types";
import LoginView from "./components/LoginView";
import NotesList from "./components/NotesList";
import EditorView from "./components/EditorView";
import ImportView from "./components/ImportView";
import SettingsDialog from "./components/SettingsDialog";
import TrashDialog from "./components/TrashDialog";
import MobileMenu from "./components/MobileMenu";

type View = "home" | "import";
type MobilePane = "list" | "editor";

const MODE_KEY = "notes:editor-mode";

function loadMode(): EditorMode {
  const stored = localStorage.getItem(MODE_KEY);
  return stored === "live" || stored === "split" || stored === "source" ? stored : "split";
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [view, setView] = useState<View>("home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // On phones the note opens in live preview; source editing is opt-in via the pencil button.
  useEffect(() => {
    if (isMobile) setModeState("live");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  useEffect(() => {
    api
      .session()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  const [notes, setNotes] = useState<NoteListEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState("updated");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tagList, setTagList] = useState<Array<{ name: string; count: number }>>([]);
  const [pinnedOnly, setPinnedOnly] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentNote, setCurrentNote] = useState<Note | null>(null);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const [mode, setModeState] = useState<EditorMode>(loadMode);
  const [mobilePane, setMobilePane] = useState<MobilePane>("list");

  const refreshList = useCallback(async () => {
    try {
      const res = await api.listNotes({ sort, order, limit: 200, tag: tagFilter ?? undefined, pinned: pinnedOnly ? "true" : undefined });
      setNotes(res.notes);
      setTotal(res.total);
      const tags = await api.tags();
      setTagList(tags.tags);
    } catch {
      /* keep stale list */
    }
  }, [sort, order, tagFilter, pinnedOnly]);

  const loadNote = useCallback(async (id: string) => {
    try {
      const note = await api.getNote(id);
      setCurrentNote(note);
      setCurrentId(id);
    } catch {
      setCurrentNote(null);
      setCurrentId(null);
    }
  }, []);

  useEffect(() => {
    if (authed) void refreshList();
  }, [authed, refreshList]);

  // Light polling so notes created/changed from other devices show up
  // eventually; also refresh whenever the tab becomes visible again.
  useEffect(() => {
    if (!authed) return;
    let inFlight = false;
    const poll = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      refreshList().finally(() => {
        inFlight = false;
      });
    };
    const timer = setInterval(poll, 5 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authed, refreshList]);

  useEffect(() => {
    if (authed) {
      api.settings().then(setSettings).catch(() => {});
    }
  }, [authed]);

  // search with debounce
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = searchQuery.trim();
    if (!q) {
      setSearching(false);
      setSearchResults([]);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await api.search(q);
        setSearchResults(res.results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQuery]);

  const openNote = useCallback(
    (id: string) => {
      // Switch panes immediately — don't wait on the note fetch. An awaiting
      // network call before the UI changes is what makes a normal tap on slow
      // connections look like nothing happened (and triggers a second, needless
      // tap). The fetch fills in the editor a moment later.
      setMobilePane("editor");
      if (isMobile) setModeState("live");
      void loadNote(id);
    },
    [isMobile, loadNote],
  );

  const createNote = useCallback(async () => {
    try {
      const note = await api.createNote({ title: "", body: "" });
      setJustCreatedId(note.id);
      await loadNote(note.id);
      await refreshList();
      setMobilePane("editor");
      // New notes open ready-to-edit (source view) instead of the live preview
      // so the body editor is immediately available for typing.
      if (isMobile) setModeState("source");
    } catch {
      /* surface? */
    }
  }, [loadNote, refreshList, isMobile]);

  const onNoteChanged = useCallback(() => {
    void refreshList();
  }, [refreshList]);

  const deleteNote = useCallback(
    async (id: string) => {
      try {
        await api.deleteNote(id);
        if (currentId === id) {
          setCurrentNote(null);
          setCurrentId(null);
          setMobilePane("list");
        }
        setSelected((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        await refreshList();
        if (searchQuery) {
          setSearchResults((r) => r.filter((x) => x.id !== id));
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : "Delete failed: " + String(err));
      }
    },
    [currentId, refreshList, searchQuery],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelected(new Set(ids));
  }, []);

  const deselectAll = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const clearSelect = useCallback(() => {
    setSelected(new Set());
    setBulkBusy(false);
  }, []);

  /** Apply a tag to (or remove one from) every selected note. */
  const bulkTag = useCallback(
    async (add: string[], remove: string[]) => {
      const ids = [...selected];
      if (ids.length === 0) return;
      setBulkBusy(true);
      try {
        const res = await api.batchTags(ids, add, remove);
        if (res.missing.length > 0) {
          alert(`Skipped ${res.missing.length} note(s) that could not be found.`);
        }
        setSelected(new Set());
        await refreshList();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Bulk tag failed: " + String(err));
      } finally {
        setBulkBusy(false);
      }
    },
    [selected, refreshList],
  );

  /** Move every selected note to the bin. */
  const bulkDelete = useCallback(async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await api.batchDelete(ids);
      const gone = res.missing.length > 0 ? ids.filter((id) => !res.missing.includes(id)) : ids;
      if (res.missing.length > 0) {
        alert(`Skipped ${res.missing.length} note(s) that could not be found.`);
      }
      if (currentId && gone.includes(currentId)) {
        setCurrentNote(null);
        setCurrentId(null);
        setMobilePane("list");
      }
      setSelected(new Set());
      await refreshList();
      if (searchQuery) {
        setSearchResults((r) => r.filter((x) => !gone.includes(x.id)));
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Bulk delete failed: " + String(err));
    } finally {
      setBulkBusy(false);
    }
  }, [selected, refreshList, currentId, searchQuery]);

  const setMode = useCallback((m: EditorMode) => {
    setModeState(m);
    localStorage.setItem(MODE_KEY, m);
  }, []);

  return (
    <div className="app">
      {authed === null ? (
        <div className="splash">Loading…</div>
      ) : !authed ? (
        <LoginView onLogin={() => setAuthed(true)} />
      ) : (
        <>
          {view === "home" ? (
            <div className="home-layout" data-pane={mobilePane}>
              <aside className="sidebar">
                <NotesList
                  notes={notes}
                  total={total}
                  sort={sort}
                  order={order}
                  onSortChange={(s) => setSort(s)}
                  onOrderChange={setOrder}
                  tagFilter={tagFilter}
                  onTagFilter={(t) => setTagFilter(t)}
                  tagCounts={tagList}
                  pinnedOnly={pinnedOnly}
                  onPinnedOnly={() => setPinnedOnly((v) => !v)}
                  searchQuery={searchQuery}
                  onSearch={(v) => setSearchQuery(v)}
                  searching={searching}
                  results={searchQuery.trim() ? searchResults : null}
                  currentId={currentId}
                  onOpen={openNote}
                  onCreate={createNote}
                  onDelete={deleteNote}
                  onMenu={() => setMenuOpen(true)}
                  selected={selected}
                  onToggleSelect={toggleSelect}
                  onSelectAll={selectAll}
                  onDeselectAll={deselectAll}
                  onClearSelect={clearSelect}
                  onBulkTag={(add, remove) => void bulkTag(add, remove)}
                  onBulkDelete={() => void bulkDelete()}
                  bulkBusy={bulkBusy}
                />
              </aside>

              <main className="main">
                {currentNote ? (
                  <EditorView
                    key={currentNote.id}
                    note={currentNote}
                    mode={mode}
                    allTags={tagList}
                    onMode={setMode}
                    onChanged={onNoteChanged}
                    brandNew={currentNote.id === justCreatedId}
                    onClose={() => {
                      setCurrentNote(null);
                      setCurrentId(null);
                      setMobilePane("list");
                      void refreshList();
                    }}
                    onDelete={() => void deleteNote(currentNote.id)}
                  />
) : (
                    <div className="empty-state">
                      <p>{notes.length === 0 ? "No notes yet — write your first one." : "Select a note from the list."}</p>
                      <button className="btn btn-primary" onClick={() => void createNote()}>
                        {notes.length === 0 ? "Write your first note" : "New note"}
                      </button>
                    </div>
                  )}
                </main>

                <button className="mobile-fab" aria-label="New note" onClick={() => void createNote()}>
                  +
                </button>
              </div>
          ) : (
            <ImportView onDone={() => { setView("home"); void refreshList(); }} onCancel={() => setView("home")} />
          )}

          <div className="topbar-actions">
            <button className="icon-btn" title="Bin" aria-label="Bin" onClick={() => setTrashOpen(true)}>
              🗑
            </button>
            <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
              ⚙
            </button>
          </div>

          <MobileMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            total={total}
            tagCounts={tagList}
            tagFilter={tagFilter}
            onTagFilter={(t) => setTagFilter(t)}
            pinnedOnly={pinnedOnly}
            onPinnedOnly={() => setPinnedOnly((v) => !v)}
            onSettings={() => { setMenuOpen(false); setSettingsOpen(true); }}
            onBin={() => { setMenuOpen(false); setTrashOpen(true); }}
          />
        </>
      )}

      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={setSettings}
          onImport={() => { setSettingsOpen(false); setView("import"); }}
        />
      )}

      {trashOpen && (
        <TrashDialog onClose={() => setTrashOpen(false)} onChanged={() => void refreshList()} />
      )}
    </div>
  );
}