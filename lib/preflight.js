/**
 * 补丁预检 / Patch preflight.
 *
 * 现状：`purge_apply` 一把打 82 条补丁，打完才从报告里看到 `pattern_not_found`。
 * 而宿主（app.asar）每次官方升级，锚点字符串就会漂移，于是「点了应用，重启，发现没生效」
 * 变成常态 —— 用户看到的是「已清洗」，实际有若干条根本没落下去。
 *
 * 预检把这件事提前：只读跑一遍 patchStatus，按「这次 apply 会发生什么」分桶，
 * 并把 anchor 已失配（unmatched）的条目标出来 —— 那是宿主升级导致的真漂移，
 * 不是配置问题，改配置没用，只能补新锚点或等插件更新。
 *
 * 只读：不写盘、不改任何文件、不碰备份。可以随便跑。
 */
import { ALL_PATCHES, patchStatus, findAiBase } from "./core.js";

/** 一条补丁在这次 apply 里会落到哪个桶。 */
const BUCKETS = [
  { key: "applied", label: "已就位", hint: "标记已在文件里，apply 会跳过" },
  { key: "pending", label: "待写入", hint: "锚点在、尚未改，apply 会写入" },
  { key: "unmatched", label: "锚点失配", hint: "锚点与标记都找不到：宿主升级导致漂移" },
  { key: "skipped", label: "不适用", hint: "当前宿主布局里没有这条要改的位置" },
  { key: "missing_file", label: "文件缺失", hint: "目标文件不在，宿主安装可能不全" },
  { key: "na", label: "无关", hint: "这条补丁不打在当前宿主上" },
];

const KNOWN = new Set(BUCKETS.map((b) => b.key));

function bucketOf(status) {
  const key = String(status || "").toLowerCase();
  return KNOWN.has(key) ? key : "na";
}

function layerOf(patch) {
  const zh = patch?.layer || "";
  const en = patch?.layer_en || "";
  if (zh && en) return `${zh}/${en}`;
  return zh || en || "未标注";
}

/**
 * 只读预检。
 *
 * @param {{ aiBase?: string, patches?: Array<object> }} [options]
 * @returns {Promise<object>}
 */
export async function runPreflight(options = {}) {
  const aiBase = options.aiBase || findAiBase();
  const patches = Array.isArray(options.patches) ? options.patches : ALL_PATCHES;

  if (!aiBase) {
    return {
      ok: false,
      reason: "no_ai_base",
      ai_base: "",
      total: patches.length,
      buckets: {},
      byLayer: {},
      drift: [],
      forecast: { applied: 0, already: 0, willFail: 0 },
      verdict: "unknown",
      notes: ["没定位到宿主安装目录（app.asar / 解开目录）。预检需要能读到目标文件。"],
    };
  }

  let status = {};
  try {
    status = await patchStatus(aiBase, patches);
  } catch (e) {
    return {
      ok: false,
      reason: "status_failed",
      ai_base: aiBase,
      total: patches.length,
      buckets: {},
      byLayer: {},
      drift: [],
      forecast: { applied: 0, already: 0, willFail: 0 },
      verdict: "unknown",
      notes: [`读取补丁状态失败：${e?.message || e}`],
    };
  }

  const buckets = {};
  const byLayer = {};
  const drift = [];
  let pending = 0;
  let applied = 0;
  let willFail = 0;

  for (const p of patches) {
    const bucket = bucketOf(status[p.id]);
    buckets[bucket] = (buckets[bucket] || 0) + 1;

    const layer = layerOf(p);
    if (!byLayer[layer]) byLayer[layer] = { total: 0, applied: 0, pending: 0, unmatched: 0 };
    byLayer[layer].total += 1;
    if (bucket === "applied") byLayer[layer].applied += 1;
    if (bucket === "pending") byLayer[layer].pending += 1;
    if (bucket === "unmatched") byLayer[layer].unmatched += 1;

    if (bucket === "applied") applied += 1;
    else if (bucket === "pending") pending += 1;
    else if (bucket === "unmatched") {
      willFail += 1;
      drift.push({
        id: p.id,
        name: p.name,
        layer,
        desc: p.desc || "",
        // 只报前两个锚点的开头，够定位是哪句。全文可能几千字符，塞进报告没意义。
        anchors: (Array.isArray(p.replacements) ? p.replacements : [])
          .slice(0, 2)
          .map((r) => {
            const raw = typeof r?.pattern === "string" ? r.pattern : String(r?.pattern || "");
            return raw.replace(/\s+/g, " ").slice(0, 80);
          })
          .filter(Boolean),
      });
    }
  }

  const relevant = pending + applied + willFail;
  let verdict = "clean";
  if (willFail > 0) verdict = "drift";
  else if (pending > 0) verdict = "pending";
  else if (relevant === 0) verdict = "unknown";

  const notes = [];
  if (willFail > 0) {
    notes.push(`${willFail} 条锚点在当前宿主上找不到：这是宿主升级导致的漂移，改配置无效，需要补新锚点。`);
  }
  if (pending > 0) {
    notes.push(`${pending} 条待写入：现在点 apply 会真正改动 ${pending} 处。`);
  }
  if (relevant === 0) {
    notes.push("没有一条补丁打在当前宿主上：确认选中的是 DSH 安装目录，不是别的包。");
  }

  return {
    ok: true,
    ai_base: aiBase,
    total: patches.length,
    buckets,
    byLayer,
    drift,
    forecast: { applied, already: applied, willWrite: pending, willFail },
    verdict,
    notes,
  };
}

export function renderPreflight(result) {
  const out = [];
  const mark = result.verdict === "clean" ? "✓" : result.verdict === "drift" ? "!" : result.verdict === "pending" ? "·" : "?";
  const label = result.verdict === "clean" ? "全部就位"
    : result.verdict === "drift" ? "存在锚点漂移"
    : result.verdict === "pending" ? "有待写入"
    : "无法判定";
  out.push(`补丁预检 / Preflight — ${mark} ${label}`);
  out.push(`  宿主 / host: ${result.ai_base || "(未定位)"}`);
  out.push(`  补丁总数: ${result.total}`);

  const counts = Object.entries(result.buckets || {});
  if (counts.length) {
    const shown = counts.map(([key, n]) => {
      const b = BUCKETS.find((x) => x.key === key);
      return `${b ? b.label : key} ${n}`;
    });
    out.push(`  分桶: ${shown.join(" · ")}`);
  }

  const f = result.forecast || {};
  out.push(`  预期: 已就位 ${f.already || 0} · 将写入 ${f.willWrite || 0} · 将失配 ${f.willFail || 0}`);

  const layers = Object.entries(result.byLayer || {});
  if (layers.length) {
    out.push("");
    out.push("  按层 / by layer:");
    for (const [layer, s] of layers) {
      const bits = [`${s.applied}/${s.total} 就位`];
      if (s.pending) bits.push(`${s.pending} 待写`);
      if (s.unmatched) bits.push(`${s.unmatched} 失配`);
      out.push(`    · ${layer}: ${bits.join(" · ")}`);
    }
  }

  if (Array.isArray(result.drift) && result.drift.length) {
    out.push("");
    out.push("  锚点漂移 / drift:");
    for (const row of result.drift) {
      out.push(`    ✗ [#${row.id}] ${row.name} — ${row.layer}`);
      if (row.desc) out.push(`        ${row.desc}`);
      for (const a of row.anchors) out.push(`        锚点: ${a}…`);
    }
  }

  if (Array.isArray(result.notes) && result.notes.length) {
    out.push("");
    for (const note of result.notes) out.push(`  ${note}`);
  }
  return out.join("\n");
}

export { BUCKETS };
