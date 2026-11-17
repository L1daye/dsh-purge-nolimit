// 补丁表共享常量 / shared patch constants.
//
// 从 core.js 逐字搬出（2.3.36 补丁表拆分）。语义零改动：
// 拆分后用 ALL_PATCHES 快照逐条比对，pattern / replace / flags 全部一致。

export const COMPLETE_PROMPT_WATERFALL_INJECT =
  "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n" +
  "\t\tconst dshPurgeSections = (transformed.sections || []).filter((s) => String(s && s.name || \"\").startsWith(\"dsh-purge\") && String(s.text || \"\").length > 0);\n" +
  "\t\tconst dshPurgeRest = (transformed.sections || []).filter((s) => !String(s && s.name || \"\").startsWith(\"dsh-purge\"));\n" +
  "\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, sections: [...dshPurgeSections, ...dshPurgeRest] }; // [dsh-purge] every mode keeps system inject\n" +
  "\t\treturn {\n" +
  "\t\t\t...transformed,\n" +
  "\t\t\tsections: completeSection === void 0 ? [...dshPurgeSections, ...dshPurgeRest] : (function (complete, purge, rest) {\n" +
  "\t\t\t\tconst base = { ...complete };\n" +
  "\t\t\t\tconst tail = rest.filter((s) => String(s?.name || \"\") !== String(base.name || \"\"));\n" +
  "\t\t\t\treturn [...purge, ...tail, base]; // [dsh-purge] complete prompt keeps inject + agent-instructions\n" +
  "\t\t\t})(completeSection, dshPurgeSections, dshPurgeRest),\n" +
  "\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts\n" +
	"\t\t};";


export const COMPLETE_PROMPT_WATERFALL_INJECT_022 =
  "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n" +
  "\t\tconst dshPurgeSections = (transformed.sections || []).filter((s) => String((s && s.name) || \"\").startsWith(\"dsh-purge\") && String(s.text || \"\").length > 0);\n" +
  "\t\tconst dshPurgeRest = (transformed.sections || []).filter((s) => !String((s && s.name) || \"\").startsWith(\"dsh-purge\"));\n" +
  "\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return { ...transformed, tools, sections: [...dshPurgeSections, ...dshPurgeRest] }; // [dsh-purge] complete prompt keeps waterfall inject\n" +
  "\t\tconst requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));\n" +
  "\t\treturn {\n" +
  "\t\t\t...transformed,\n" +
  "\t\t\ttools,\n" +
  "\t\t\tsections: completeSection === void 0 ? [...dshPurgeSections, ...dshPurgeRest] : (function (complete, purge, rest) {\n" +
  "\t\t\t\tconst base = { ...complete };\n" +
  "\t\t\t\tconst tail = rest.filter((s) => String((s?.name) || \"\") !== String((base.name) || \"\"));\n" +
  "\t\t\t\treturn [...purge, ...tail, base]; // [dsh-purge] complete prompt keeps inject + agent-instructions\n" +
  "\t\t\t})(completeSection, dshPurgeSections, dshPurgeRest),\n" +
  "\t\t\tcontexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts\n" +
  "\t\t};\n";

