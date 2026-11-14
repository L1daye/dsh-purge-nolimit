/**
 * Prompt snapshots — save/restore named prompt-inject.md snapshots under
 * $DSH_HOME/dsh-purge/prompt-snapshots/. Lets the operator swap full prompt
 * decks without touching the host packages. A snapshot is a verbatim copy of
 * the current prompt-inject.md text; restoring one writes it back atomically.
 */
import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import {
  findDshHome,
  defaultOverrideText,
  readPromptInjectFileSync,
  normalizeOverride,
  atomicWriteFile,
} from "./core.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
}

export function snapshotsDir(dshHome = findDshHome()) {
  return path.join(dshHome, "dsh-purge", "prompt-snapshots");
}

export function validSnapshotName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

export function snapshotPath(dshHome = findDshHome(), name) {
  return path.join(snapshotsDir(dshHome), name + ".md");
}

export function currentPromptText(dshHome = findDshHome()) {
  const disk = normalizeOverride(readPromptInjectFileSync(dshHome));
  if (disk) return disk;
  const fallback = normalizeOverride(defaultOverrideText());
  if (fallback) return fallback;
  return "";
}

export async function listSnapshots(dshHome = findDshHome()) {
  const dir = snapshotsDir(dshHome);
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    if (!validSnapshotName(name)) continue;
    const fp = path.join(dir, entry.name);
    let stat = null;
    try {
      stat = await fsp.stat(fp);
    } catch {
      continue;
    }
    let preview = "";
    try {
      preview = (await fsp.readFile(fp, "utf8")).replace(/\s+/g, " ").trim().slice(0, 120);
    } catch {
      /* keep empty preview */
    }
    out.push({
      name,
      path: fp,
      size: stat.size,
      mtime: stat.mtimeMs || stat.mtime?.getTime?.() || 0,
      preview,
    });
  }
  return out;
}

export async function saveSnapshot(dshHome = findDshHome(), name) {
  if (!validSnapshotName(name)) throw new Error(`invalid snapshot name: ${name}`);
  const text = currentPromptText(dshHome);
  if (!text) throw new Error("当前提示词为空，先 /purge edit 写好再保存");
  if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("prompt too large (max 1MB)");
  }
  await fsp.mkdir(snapshotsDir(dshHome), { recursive: true });
  await atomicWriteFile(snapshotPath(dshHome, name), text);
  const stat = await fsp.stat(snapshotPath(dshHome, name));
  return { name, path: snapshotPath(dshHome, name), size: stat.size };
}

export async function useSnapshot(dshHome = findDshHome(), name) {
  if (!validSnapshotName(name)) throw new Error(`invalid snapshot name: ${name}`);
  const fp = snapshotPath(dshHome, name);
  let text;
  try {
    text = fs.readFileSync(fp, "utf8");
  } catch {
    throw new Error(`snapshot not found: ${name}`);
  }
  const target = path.join(dshHome, "prompt-inject.md");
  await atomicWriteFile(target, text);
  return { name, path: fp, target, size: Buffer.byteLength(text, "utf8") };
}

export async function deleteSnapshot(dshHome = findDshHome(), name) {
  if (!validSnapshotName(name)) throw new Error(`invalid snapshot name: ${name}`);
  const fp = snapshotPath(dshHome, name);
  if (!fs.existsSync(fp)) throw new Error(`snapshot not found: ${name}`);
  await fsp.rm(fp, { force: true });
  return { name, path: fp };
}

/** 把某个快照导出到任意文件（用于分享/备份提示词卡组）。 */
export async function exportSnapshotToFile(dshHome = findDshHome(), name, targetPath) {
  if (!validSnapshotName(name)) throw new Error(`invalid snapshot name: ${name}`);
  if (!targetPath || !String(targetPath).trim()) throw new Error("目标路径不能为空");
  const fp = snapshotPath(dshHome, name);
  let text;
  try {
    text = fs.readFileSync(fp, "utf8");
  } catch {
    throw new Error(`snapshot not found: ${name}`);
  }
  const target = path.resolve(String(targetPath).trim());
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, text, "utf8");
  return { name, source: fp, target, size: Buffer.byteLength(text, "utf8") };
}

/** 从任意文件导入为快照（verbatim 复制）。 */
export async function importSnapshotFromFile(dshHome = findDshHome(), name, sourcePath) {
  if (!validSnapshotName(name)) throw new Error(`invalid snapshot name: ${name}`);
  if (!sourcePath || !String(sourcePath).trim()) throw new Error("源文件路径不能为空");
  const src = path.resolve(String(sourcePath).trim());
  let text;
  try {
    text = await fsp.readFile(src, "utf8");
  } catch {
    throw new Error(`source file not found: ${sourcePath}`);
  }
  if (!text.trim()) throw new Error("源文件为空");
  if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) throw new Error("prompt too large (max 1MB)");
  await fsp.mkdir(snapshotsDir(dshHome), { recursive: true });
  await atomicWriteFile(snapshotPath(dshHome, name), text);
  return { name, source: src, target: snapshotPath(dshHome, name), size: Buffer.byteLength(text, "utf8") };
}

export async function snapshotStatus(dshHome = findDshHome()) {
  const listed = await listSnapshots(dshHome);
  const current = currentPromptText(dshHome);
  return {
    snapshots_dir: snapshotsDir(dshHome),
    snapshots: listed,
    current_bytes: Buffer.byteLength(current, "utf8"),
    current_preview: current.replace(/\s+/g, " ").trim().slice(0, 120),
  };
}

export function renderSnapshotStatus(st) {
  const out = [];
  out.push("提示词快照 / Prompt Snapshots");
  out.push(`  目录 / dir  ${st.snapshots_dir}`);
  out.push(`  当前提示词 ${formatSize(st.current_bytes)}${st.current_preview ? ` — ${st.current_preview}` : ""}`);
  out.push("");
  if (!st.snapshots.length) {
    out.push("  (暂无快照 — /prompt save <名字> 保存当前提示词)");
    return out.join("\n");
  }
  for (const s of st.snapshots) {
    out.push(`  · ${s.name}  ${formatSize(s.size)}  ${s.preview || ""}`);
  }
  return out.join("\n");
}
