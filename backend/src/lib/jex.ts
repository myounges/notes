// JEX (.jex) = Joplin's backup/export archive. It is a TAR of the "raw" sync
// export: each item is a top-level `<id>.md` file serialized via
// BaseItem.serialize, and resource binaries live under `resources/<id>.<ext>`.
//
// Serialized item format (mirrors Joplin's BaseItem.unserialize):
//
//   <title>
//
//   <body>            (only for notes)
//
//   id: <32-hex-id>
//   parent_id: ...
//   created_time: <ISO>
//   ...
//   type_: <N>
//
// ModelType values (Joplin BaseModel): Note=1, Folder=2, Setting=3,
// Resource=4, Tag=5, NoteTag=6.

export const JEX_TYPE_NOTE = 1;
export const JEX_TYPE_FOLDER = 2;
export const JEX_TYPE_RESOURCE = 4;
export const JEX_TYPE_TAG = 5;
export const JEX_TYPE_NOTE_TAG = 6;

export interface JexItem {
  type: number;
  title: string;
  body: string;
  props: Record<string, string>;
}

/** Parse a JEX serialized item (`<title>\n\n<body>\n\nkey: value...`). */
export function parseJexItem(content: string): JexItem {
  // Strip any trailing whitespace/newlines, then split
  const normalized = content.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const lines = normalized.split("\n");
  const props: Record<string, string> = {};
  let bodyLines: string[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") {
      bodyLines = lines.slice(0, i);
      break;
    }
    const sep = line.indexOf(":");
    if (sep < 0) continue; // malformed line within props block — skip
    props[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }

  const typeRaw = props["type_"];
  if (!typeRaw) throw new Error("Missing required property: type_");
  const type = Number(typeRaw);

  let title = "";
  let body = "";
  if (bodyLines.length) {
    title = (bodyLines[0] ?? "").trim();
    if (type === JEX_TYPE_NOTE) body = bodyLines.slice(2).join("\n");
  }

  return { type, title, body, props };
}

/** Parse an ISO (or ms-epoch) JEX timestamp into an ISO string; fallback otherwise. */
export function jexDate(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  let ms = Number(trimmed);
  if (!Number.isFinite(ms)) {
    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return fallback;
  }
  // Joplin writes timestamps as ms epoch in props when exporting via some tools
  if (ms > 1e12) ms = ms; // already ms
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

/** Extract a numeric coord prop (latitude/longitude) that is non-zero. */
export function jexCoord(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = Number(raw.trim());
  if (!Number.isFinite(v) || v === 0) return null;
  return v;
}