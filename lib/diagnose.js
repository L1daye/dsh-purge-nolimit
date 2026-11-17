/**
 * 锚点漂移诊断 / anchor drift diagnostics.
 *
 * 宿主升级后补丁锚点会失配。`patchStatus` 只告诉你"这条没打上"，
 * 但不告诉你"为什么"和"可能该改成什么"。这里补上后者：
 *
 *   1. 先说清楚是哪条补丁、哪个文件、第几个 anchor 失配
 *   2. 给出失败锚点的首行（截断），方便肉眼比对
 *   3. 从锚点里挑一个**最具辨识度的片段**去宿主文件里搜，报出候选行号与上下文
 *   4. 用户可以照着候选行号 `--reanchor <id> --index <n> --lines A-B` 落地
 *
 * 只读：不改宿主文件、不写覆盖。落盘由 `anchors.writeOverride` 负责。
 */

import fs from "node:fs";

/** 从一个锚点里挑出最可能在宿主文件里唯一出现的片段。 */
export function pickToken(pattern) {
  const text = String(pattern || "");
  const candidates = [];
  // 反引号模板串（最常见：错误消息、reason）
  for (const m of text.matchAll(/`([^`]{8,120})`/g)) candidates.push(m[1]);
  // 双引号字面量
  for (const m of text.matchAll(/"([^"\\]{8,120})"/g)) candidates.push(m[1]);
  // 方法名 / 标识符调用
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{5,40})\s*\(/g)) candidates.push(m[1]);
  // 长一点的赋值目标
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{7,40})\s*=/g)) candidates.push(m[1]);
  if (!candidates.length) return "";
  // 越长越可能是唯一锚
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

/** 锚点首行，去掉前后空白，截断到可读长度。 */
function patternHead(pattern) {
  const first = String(pattern || "").split("\n")[0].trim();
  return first.length > 110 ? first.slice(0, 110) + "…" : first;
}

/** 在文件里搜 token，返回候选行（1-based）与上下文。 */
function findCandidates(fileText, token, max = 6) {
  if (!token) return [];
  const lines = fileText.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < max; i += 1) {
    if (!lines[i].includes(token)) continue;
    hits.push({
      line: i + 1,
      text: lines[i].trim().slice(0, 120),
    });
  }
  return hits;
}

/**
 * 逐条诊断未应用的补丁。
 *
 * @param {string} aiBase
 * @param {object[]} patches  ALL_PATCHES
 * @param {object} deps       { targetFiles, loadText, patchReplacements, matchesPattern }
 * @returns {object[]} 每条失配一行
 */
export function diagnoseAnchors(aiBase, patches, deps) {
  const { targetFiles, readFileSafe, patchReplacements, matchesPattern } = deps;
  const files = targetFiles(aiBase);
  const out = [];
  for (const patch of patches) {
    const keys = Array.isArray(patch.file) ? patch.file : patch.file ? [patch.file] : [];
    const reps = patchReplacements(patch);
    for (const key of keys) {
      const v = files[key];
      const paths = Array.isArray(v) ? v : v ? [v] : [];
      for (const fp of paths) {
        const text = readFileSafe(fp);
        if (text === null) continue;
        const hay = String(text).replace(/\r\n/g, "\n");
        reps.forEach((rep, index) => {
          const pattern = rep && rep.pattern;
          if (!pattern || typeof rep.replace !== "string") return;
          if (matchesPattern(hay, pattern)) return; // 还在 → 不是漂移
          const token = pickToken(pattern);
          const candidates = findCandidates(hay, token);
          out.push({
            patchId: patch.id,
            name: patch.name,
            file: fp,
            key,
            index,
            patternHead: patternHead(pattern),
            token,
            candidates,
            alreadyHasReplace: hay.includes(String(rep.replace).split("\n")[0]),
          });
        });
      }
    }
  }
  return out;
}

/** 可读报告。 */
export function renderDiagnosis(rows) {
  if (!rows.length) return "没有锚点漂移：所有补丁的锚点都能在宿主里找到。";
  const lines = [];
  for (const r of rows) {
    const short = r.file.replace(/^.*?resources[\\/]/, "resources/");
    lines.push(`[#${r.patchId}] ${r.name}  anchor#${r.index}`);
    lines.push(`  文件   ${short}`);
    lines.push(`  锚点   ${r.patternHead}`);
    if (!r.token) {
      lines.push("  候选   无法从锚点里提取辨识片段，需要人工比对");
    } else if (!r.candidates.length) {
      lines.push(`  候选   在文件里搜不到 "${r.token}" —— 这段代码可能整体被上游删了`);
    } else {
      lines.push(`  候选   搜 "${r.token}" 命中 ${r.candidates.length} 处：`);
      for (const c of r.candidates) lines.push(`          L${c.line}: ${c.text}`);
      lines.push(`  落地   dsh-purge --reanchor ${r.patchId} --index ${r.index} --lines A-B --yes`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * 从文件里按行号区间取一段，当作新锚点。
 * 这是 `--reanchor --lines A-B` 的实现：用户看着候选行确认后，
 * 直接把那段真实代码作为 pattern 存进覆盖文件。
 */
export function extractLines(filePath, from, to) {
  const text = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  // 文件末尾的换行会 split 出一个空元素；不剪掉的话 --lines N-M
  // 取到文件尾会多带一个空行，写进覆盖里就成了"锚点末尾有换行"的坑。
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const a = Math.max(1, Math.min(from, to));
  const b = Math.min(lines.length, Math.max(from, to));
  if (a > b) return "";
  return lines.slice(a - 1, b).join("\n");
}
