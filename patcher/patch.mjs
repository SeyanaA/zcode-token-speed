#!/usr/bin/env node
// ZCode「平均 Token 速度 + 每日曲线」外部补丁器。
// 设计目标：补丁代码放在应用外；每次启动前运行，检测到 ZCode 更新后自动重新注入。
// 不使用任何第三方依赖：自带 asar header 读写。
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const WORK_DIR =
  process.env.ZCODE_TOKEN_SPEED_HOME?.trim() ||
  join(homedir(), ".zcode", "token-speed-live");
mkdirSync(WORK_DIR, { recursive: true });

const LOG_PATH = join(WORK_DIR, "patch.log");
const STATE_PATH = join(WORK_DIR, "state.json");
const LOCK_PATH = join(WORK_DIR, "patch.lock");
const CONFIG_PATH = join(WORK_DIR, "config.json");
const WATCH_MODE = process.env.ZCODE_PATCH_WATCH === "1";

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return {};
  }
}

const config = readConfig();
const APP_ROOT =
  process.env.ZCODE_APP_ROOT?.trim() ||
  (typeof config.appRoot === "string" ? config.appRoot.trim() : "");
if (!APP_ROOT) {
  console.error(
    `缺少 ZCode 安装目录。请创建 ${CONFIG_PATH}，内容为 {"appRoot":"<ZCode 安装目录>"}，或设置环境变量 ZCODE_APP_ROOT。`,
  );
  process.exit(2);
}
const ASAR_PATH = join(APP_ROOT, "resources", "app.asar");
const HOST_PATH = join(APP_ROOT, "resources", "glm", "zcode.cjs");
if (!existsSync(ASAR_PATH) || !existsSync(HOST_PATH)) {
  console.error(`在 ${APP_ROOT} 找不到 ZCode 的 app.asar / zcode.cjs，请检查 config.json 的 appRoot。`);
  process.exit(2);
}
if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 5 * 1024 * 1024) {
  rmSync(LOG_PATH, { force: true });
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(LOG_PATH, line, "utf8");
}

function fail(message) {
  throw new Error(message);
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

function replaceOnce(text, label, from, to) {
  const occurrences = count(text, from);
  if (occurrences !== 1) {
    fail(`${label}: expected 1 occurrence, found ${occurrences}`);
  }
  return text.replace(from, to);
}

function replaceRegexOnce(text, label, regex, replacer) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const matches = [...text.matchAll(new RegExp(regex.source, flags))];
  if (matches.length !== 1) {
    fail(`${label}: expected 1 occurrence, found ${matches.length}`);
  }
  return text.replace(regex, replacer);
}

// ── asar ────────────────────────────────────────────────────────────────

function readAsarHeader(path) {
  const fd = openSync(path, "r");
  try {
    const pre = Buffer.alloc(8);
    if (readSync(fd, pre, 0, 8, 0) !== 8) fail("cannot read asar header size");
    const headerSize = pre.readUInt32LE(4);
    const headerBuffer = Buffer.alloc(headerSize);
    if (readSync(fd, headerBuffer, 0, headerSize, 8) !== headerSize) {
      fail("cannot read asar header");
    }
    const stringLength = headerBuffer.readUInt32LE(4);
    const json = headerBuffer.subarray(8, 8 + stringLength).toString("utf8");
    let header;
    try {
      header = JSON.parse(json);
    } catch (error) {
      fail(`asar header is not valid JSON: ${error.message}`);
    }
    return {
      path,
      header,
      headerSize,
      stringLength,
      dataStart: 8 + headerSize,
    };
  } finally {
    closeSync(fd);
  }
}

function getEntry(header, relativePath) {
  let node = header;
  for (const segment of relativePath.split("/")) {
    if (!node || !node.files || !node.files[segment]) return null;
    node = node.files[segment];
  }
  return node && typeof node.size === "number" ? node : null;
}

function listFiles(header, prefix) {
  const result = [];
  function walk(node, currentPath) {
    if (!node || typeof node !== "object") return;
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) {
        walk(child, currentPath ? `${currentPath}/${name}` : name);
      }
      return;
    }
    if (typeof node.size === "number" && !node.link) {
      if (currentPath.startsWith(prefix)) {
        result.push({ path: currentPath, size: node.size, entry: node });
      }
    }
  }
  walk(header, "");
  return result;
}

function readEntry(asar, relativePath) {
  const entry = getEntry(asar.header, relativePath);
  if (!entry) fail(`asar entry missing: ${relativePath}`);
  if (entry.unpacked) {
    return readFileSync(join(`${asar.path}.unpacked`, ...relativePath.split("/")));
  }
  const fd = openSync(asar.path, "r");
  try {
    const buffer = Buffer.alloc(entry.size);
    const read = readSync(fd, buffer, 0, entry.size, asar.dataStart + Number(entry.offset));
    if (read !== entry.size) fail(`short read for ${relativePath}`);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function writeUnpacked(asar, relativePath, content) {
  const target = join(`${asar.path}.unpacked`, ...relativePath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function markUnpacked(asar, relativePath, content) {
  const entry = getEntry(asar.header, relativePath);
  if (!entry) fail(`asar entry missing while marking unpacked: ${relativePath}`);
  delete entry.integrity;
  entry.unpacked = true;
  entry.size = Buffer.byteLength(content, "utf8");
}

function writeAsarHeader(asar) {
  const json = JSON.stringify(asar.header);
  const rawBytes = Buffer.byteLength(json, "utf8");
  if (rawBytes > asar.stringLength) {
    fail(`asar header grew beyond original size: ${rawBytes} > ${asar.stringLength}`);
  }
  const paddedBytes = asar.stringLength;
  const aligned = (value) => value + ((4 - (value % 4)) % 4);
  const payloadSize = 4 + aligned(paddedBytes);
  const total = 4 + payloadSize;
  if (total !== asar.headerSize) {
    fail(`asar header size mismatch: ${total} !== ${asar.headerSize}`);
  }
  const buffer = Buffer.alloc(asar.headerSize, 0);
  buffer.writeUInt32LE(payloadSize, 0);
  buffer.writeUInt32LE(paddedBytes, 4);
  buffer.write(json, 8, "utf8");
  buffer.fill(0x20, 8 + rawBytes, 8 + paddedBytes);
  const fd = openSync(asar.path, "r+");
  try {
    writeSync(fd, buffer, 0, buffer.length, 8);
  } finally {
    closeSync(fd);
  }
}

function getEntryContent(asar, relativePath) {
  return readEntry(asar, relativePath).toString("utf8");
}

// ── 代码签名/语法检查 ───────────────────────────────────────────────────

function looksEsm(text) {
  return (
    text.includes("import{") ||
    text.includes("export{") ||
    /(?:^|\n)\s*(?:import|export)\b/u.test(text)
  );
}

function checkSyntax(label, text, esm) {
  const temp = join(WORK_DIR, `syntax-${process.pid}-${Date.now()}${esm ? ".mjs" : ".cjs"}`);
  writeFileSync(temp, text, "utf8");
  try {
    execFileSync(process.execPath, ["--check", temp], {
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error.stderr?.toString?.() ?? error.message;
    const tail = stderr.slice(Math.max(0, stderr.length - 1200));
    fail(`${label}: syntax check failed: ${tail}`);
  } finally {
    rmSync(temp, { force: true });
  }
}

// ── host 补丁 ───────────────────────────────────────────────────────────

const TOTALS_SQL_FROM = `         avg(time_to_first_token_ms) as avgTimeToFirstTokenMs
       from model_usage`;
const TOTALS_SQL_TO = `         avg(time_to_first_token_ms) as avgTimeToFirstTokenMs,
         sum(case when status = 'completed' and duration_ms is not null and time_to_first_token_ms is not null and duration_ms > time_to_first_token_ms then duration_ms - time_to_first_token_ms else 0 end) as totalDecodeMs
       from model_usage`;

const DAILY_SQL_FROM = `         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex\`).all(`;
const DAILY_SQL_TO = `         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         sum(case when status = 'completed' and duration_ms is not null and time_to_first_token_ms is not null and duration_ms > time_to_first_token_ms then duration_ms - time_to_first_token_ms else 0 end) as decodeMs
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex\`).all(`;

function patchHost(original) {
  if (original.includes("avgOutputTokensPerSecond") && original.includes("__tsDailySpeed")) {
    return { text: original, changed: false };
  }

  let text = replaceOnce(original, "host totals sql", TOTALS_SQL_FROM, TOTALS_SQL_TO);

  text = replaceRegexOnce(
    text,
    "host totals mapping",
    /avgTimeToFirstTokenMs:([A-Za-z_$][\w$]*)\.avgTimeToFirstTokenMs==null\?null:Number\(\1\.avgTimeToFirstTokenMs\)\}/u,
    (_match, valueVar) =>
      `avgTimeToFirstTokenMs:${valueVar}.avgTimeToFirstTokenMs==null?null:Number(${valueVar}.avgTimeToFirstTokenMs),totalDecodeMs:Number(${valueVar}.totalDecodeMs??0)}`,
  );

  text = replaceOnce(text, "host daily sql", DAILY_SQL_FROM, DAILY_SQL_TO);

  text = replaceRegexOnce(
    text,
    "host day map init",
    /for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)([A-Za-z_$][\w$]*)\.set\(\1\.dayIndex,\{dayIndex:\1\.dayIndex,totalTokens:Number\(\1\.totalTokens\),turnCount:0,toolCallCount:0\}\);/u,
    (_match, rowVar, arrayVar, mapVar) =>
      `for(let ${rowVar} of ${arrayVar})${mapVar}.set(${rowVar}.dayIndex,{dayIndex:${rowVar}.dayIndex,totalTokens:Number(${rowVar}.totalTokens),outputTokens:Number(${rowVar}.outputTokens),decodeMs:Number(${rowVar}.decodeMs),turnCount:0,toolCallCount:0});`,
  );

  const defaultsRegex = /\{dayIndex:([A-Za-z_$][\w$]*)\.dayIndex,totalTokens:0,turnCount:0,toolCallCount:0\}/gu;
  const defaultsMatches = [...text.matchAll(new RegExp(defaultsRegex.source, "gu"))];
  if (defaultsMatches.length < 2) {
    fail(`host day map defaults: expected >=2 occurrences, found ${defaultsMatches.length}`);
  }
  text = text.replace(
    defaultsRegex,
    "{dayIndex:$1.dayIndex,totalTokens:0,outputTokens:0,decodeMs:0,turnCount:0,toolCallCount:0}",
  );

  const builderMapRegex =
    /for\(let ([A-Za-z_$][\w$]*) of e\.days\)([A-Za-z_$][\w$]*)\.set\(\1\.dayIndex,\{totalTokens:\1\.totalTokens,turnCount:\1\.turnCount,toolCallCount:\1\.toolCallCount\}\);/u;
  const builderMapMatch = text.match(builderMapRegex);
  if (!builderMapMatch) fail("host builder day map: anchor not found");
  const dayMapVar = builderMapMatch[2];
  const builderStart = builderMapMatch.index;

  // 在替换 builder day map 之前先取 start/end 变量与日期函数，替换会改变后续下标。
  const rangeLoopMatch = text
    .slice(builderStart)
    .match(/for\(let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*);\1<=([A-Za-z_$][\w$]*);\1\+\+\)/u);
  if (!rangeLoopMatch) fail("host builder range loop: anchor not found");
  const startVar = rangeLoopMatch[2];
  const endVar = rangeLoopMatch[3];

  const dateFnMatch = text.slice(builderStart).match(/date:([A-Za-z_$][\w$]*)\(/u);
  if (!dateFnMatch) fail("host builder date function: anchor not found");
  const dateFn = dateFnMatch[1];

  text = text.replace(
    builderMapRegex,
    `for(let $1 of e.days)$2.set($1.dayIndex,{totalTokens:$1.totalTokens,outputTokens:$1.outputTokens,decodeMs:$1.decodeMs,turnCount:$1.turnCount,toolCallCount:$1.toolCallCount});`,
  );

  text = replaceRegexOnce(
    text,
    "host builder dailySpeed",
    /avgDurationMs:([A-Za-z_$][\w$]*)\.avgDurationMs\}\)\);return\{range:t\.range,/u,
    (_match, toolVar) =>
      `avgDurationMs:${toolVar}.avgDurationMs}));let __tsDailySpeed=[];for(let __tsIndex=${startVar};__tsIndex<=${endVar};__tsIndex++){let __tsRow=${dayMapVar}.get(__tsIndex),__tsOut=__tsRow?.outputTokens??0,__tsDec=__tsRow?.decodeMs??0;__tsDailySpeed.push({date:${dateFn}(__tsIndex),outputTokens:__tsOut,decodeMs:__tsDec,tokensPerSecond:__tsDec>0?__tsOut*1e3/__tsDec:null})}return{range:t.range,`,
  );

  text = replaceOnce(
    text,
    "host builder return",
    "heatmap:z,dailyModelUsage:q",
    "heatmap:z,dailySpeed:__tsDailySpeed,dailyModelUsage:q",
  );

  text = replaceRegexOnce(
    text,
    "host builder summary field",
    /avgTurnDurationMs:([A-Za-z_$][\w$]*)\.avgTurnDurationMs,/u,
    (_match, turnVar) =>
      `avgTurnDurationMs:${turnVar}.avgTurnDurationMs,avgOutputTokensPerSecond:n.totalDecodeMs>0?n.outputTokens*1e3/n.totalDecodeMs:null,`,
  );

  let zodAlias = null;
  text = replaceRegexOnce(
    text,
    "host summary schema",
    /avgTurnDurationMs:([A-Za-z_$][\w$]*)\.number\(\)\.nullable\(\),activeDays:/u,
    (_match, alias) => {
      zodAlias = alias;
      return `avgTurnDurationMs:${alias}.number().nullable(),avgOutputTokensPerSecond:${alias}.number().nullable().optional(),activeDays:`;
    },
  );

  text = replaceRegexOnce(
    text,
    "host snapshot schema",
    /heatmap:([A-Za-z_$][\w$]*),dailyModelUsage:([A-Za-z_$][\w$]*)\.array\(([A-Za-z_$][\w$]*)\)/u,
    (_match, heatmapVar, arrayVar, itemVar) =>
      `heatmap:${heatmapVar},dailySpeed:${zodAlias}.array(${zodAlias}.object({date:${zodAlias}.string(),outputTokens:${zodAlias}.number(),decodeMs:${zodAlias}.number(),tokensPerSecond:${zodAlias}.number().nullable()})).optional(),dailyModelUsage:${arrayVar}.array(${itemVar})`,
  );

  if (!text.includes("totalDecodeMs") || !text.includes("dailySpeed:__tsDailySpeed")) {
    fail("host patch verification failed");
  }
  return { text, changed: true };
}

// ── renderer 主 bundle ─────────────────────────────────────────────────

const CHART_FUNCTION = "function TokenSpeedDailyChart({snapshot:e}){\n  const rawRows=Array.isArray(e?.dailySpeed)?e.dailySpeed:[];\n  const rows=rawRows.filter((row)=>row&&typeof row.date===`string`);\n  const speeds=rows.map((row)=>typeof row.tokensPerSecond===`number`&&Number.isFinite(row.tokensPerSecond)?row.tokensPerSecond:null);\n  const points=rows.map((row,index)=>({index,value:speeds[index]})).filter((item)=>item.value!==null);\n  if(points.length<1)return null;\n  const width=640,height=190,padLeft=46,padRight=16,padTop=14,padBottom=28;\n  const rawMax=Math.max(...points.map((item)=>item.value));\n  const step=rawMax<=20?5:rawMax<=50?10:rawMax<=100?20:rawMax<=200?50:100;\n  const yMax=Math.max(step,Math.ceil(rawMax/step)*step);\n  const xAt=(index)=>rows.length<=1?padLeft+(width-padLeft-padRight)/2:padLeft+((width-padLeft-padRight)*index)/Math.max(1,rows.length-1);\n  const yAt=(value)=>padTop+(height-padTop-padBottom)*(1-Math.min(value,yMax)/yMax);\n  const ticks=[0,yMax/2,yMax].map((value)=>{\n    const y=yAt(value).toFixed(1);\n    return `<line x1=\"${padLeft}\" y1=\"${y}\" x2=\"${width-padRight}\" y2=\"${y}\" stroke=\"currentColor\" stroke-opacity=\"0.12\"/><text x=\"${padLeft-8}\" y=\"${Number(y)+4}\" text-anchor=\"end\" font-size=\"11\" fill=\"currentColor\" fill-opacity=\"0.55\">${Math.round(value)}</text>`;\n  }).join(\"\");\n  const labelIndexes=new Set([0,rows.length-1]);\n  for(let index=7;index<rows.length-1;index+=7)labelIndexes.add(index);\n  const labels=[...labelIndexes].sort((a,b)=>a-b).map((index)=>{\n    const isFirst=index===0;\n    const isLast=index===rows.length-1;\n    const anchor=isFirst?\"start\":isLast?\"end\":\"middle\";\n    const x=isFirst?padLeft:isLast?width-padRight:xAt(index).toFixed(1);\n    return `<text x=\"${x}\" y=\"${height-8}\" text-anchor=\"${anchor}\" font-size=\"11\" fill=\"currentColor\" fill-opacity=\"0.55\">${String(rows[index].date).slice(5)}</text>`;\n  }).join(\"\");\n  const line=points.map((item,index)=>`${index===0?\"M\":\"L\"}${xAt(item.index).toFixed(1)},${yAt(item.value).toFixed(1)}`).join(\" \");\n  const dots=points.map((item)=>`<circle cx=\"${xAt(item.index).toFixed(1)}\" cy=\"${yAt(item.value).toFixed(1)}\" r=\"2.6\" fill=\"currentColor\"></circle>`).join(\"\");\n  const bands=rows.map((row,index)=>{\n    const value=speeds[index];\n    const left=index===0?padLeft:(xAt(index-1)+xAt(index))/2;\n    const right=index===rows.length-1?width-padRight:(xAt(index)+xAt(index+1))/2;\n    const text=value===null?`${String(row.date).slice(5)} · 无数据`:`${String(row.date).slice(5)} · ${value.toFixed(1)} tokens/秒`;\n    const tipWidth=Math.max(84,text.length*6.6);\n    const tipX=Math.min(Math.max(xAt(index),padLeft+tipWidth/2),width-padRight-tipWidth/2);\n    return `<g class=\"ts-day\"><rect x=\"${left.toFixed(1)}\" y=\"0\" width=\"${(right-left).toFixed(1)}\" height=\"${height-padBottom+8}\" fill=\"transparent\" pointer-events=\"all\"></rect><line class=\"ts-cursor\" x1=\"${xAt(index).toFixed(1)}\" y1=\"${padTop}\" x2=\"${xAt(index).toFixed(1)}\" y2=\"${height-padBottom}\" stroke=\"currentColor\" stroke-opacity=\"0.25\" stroke-dasharray=\"3 3\" opacity=\"0\" pointer-events=\"none\"></line><g class=\"ts-tip\" opacity=\"0\" pointer-events=\"none\"><rect x=\"${(tipX-tipWidth/2).toFixed(1)}\" y=\"1\" width=\"${tipWidth.toFixed(1)}\" height=\"18\" rx=\"4\" fill=\"currentColor\" fill-opacity=\"0.1\"></rect><text x=\"${tipX.toFixed(1)}\" y=\"14\" text-anchor=\"middle\" font-size=\"11\" fill=\"currentColor\">${text}</text></g></g>`;\n  }).join(\"\");\n  const svg=`<svg viewBox=\"0 0 ${width} ${height}\" class=\"h-48 w-full text-foreground\" role=\"img\" aria-label=\"每日 Token 速度\"><style>.ts-tip{transition:opacity .1s ease}.ts-day:hover .ts-tip{opacity:1}.ts-day:hover .ts-cursor{opacity:1}</style>${ticks}<path d=\"${line}\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linejoin=\"round\" stroke-linecap=\"round\"></path>${dots}${bands}${labels}</svg>`;\n  return (0,$.jsxs)(\"section\",{className:\"space-y-3\",children:[\n    (0,$.jsxs)(\"div\",{className:\"flex flex-wrap items-center justify-between gap-2\",children:[\n      (0,$.jsx)(\"div\",{className:\"text-ui-base font-medium text-foreground\",children:\"每日 Token 速度\"}),\n      (0,$.jsx)(\"div\",{className:\"text-ui-xs text-foreground-subtle\",children:\"输出 tokens ÷ 解码时长 · 按日\"})\n    ]}),\n    (0,$.jsx)(\"div\",{className:\"rounded-xl bg-surface p-4\",dangerouslySetInnerHTML:{__html:svg}})\n  ]});\n}\n";

function patchRendererMain(original) {
  if (original.includes("function TokenSpeedDailyChart")) {
    return { text: original, changed: false };
  }
  let text = original;

  const streakIndex = text.indexOf("settings.usage.longestStreak");
  if (streakIndex < 0) fail("renderer summary strip: longestStreak anchor not found");
  const itemStart = text.lastIndexOf("{label:", streakIndex);
  const mapIndex = text.indexOf("].map(", streakIndex);
  if (itemStart < 0 || mapIndex < 0) fail("renderer summary strip: item bounds not found");
  const itemText = text.slice(itemStart, mapIndex);
  if (!itemText.includes("settings.usage.longestStreak")) {
    fail("renderer summary strip: longestStreak item not isolated");
  }
  const snapshotVarMatch = itemText.match(/value:([A-Za-z_$][\w$]*)\?/u);
  if (!snapshotVarMatch) fail("renderer summary strip: snapshot variable not found");
  const snapshotVar = snapshotVarMatch[1];
  const newItem =
    ',{label:"平均 Token 速度",value:' +
    snapshotVar +
    "?" +
    snapshotVar +
    ".summary.avgOutputTokensPerSecond==null?`--`:`${" +
    snapshotVar +
    ".summary.avgOutputTokensPerSecond.toFixed(1)} tokens/秒`:`--`}";
  text = text.slice(0, mapIndex) + newItem + text.slice(mapIndex);

  const pieIndex = text.indexOf("settings.usage.app-model-pie-chart");
  if (pieIndex < 0) fail("renderer panel: pie chart anchor not found");
  const pieWindow = text.slice(pieIndex, pieIndex + 3000);
  const rangeVarMatch = pieWindow.match(
    /children:\(0,\$\.jsx\)\([A-Za-z_$][\w$]*,\{snapshot:([A-Za-z_$][\w$]*)\}\)/u,
  );
  if (!rangeVarMatch) fail("renderer panel: range snapshot variable not found");
  const rangeVar = rangeVarMatch[1];
  const refreshAnchor = "(0,$.jsx)(`div`,{className:`flex justify-end`";
  const refreshIndex = text.indexOf(refreshAnchor, pieIndex);
  if (refreshIndex < 0) fail("renderer panel: refresh button anchor not found");
  text =
    text.slice(0, refreshIndex) +
    `(0,$.jsx)(TokenSpeedDailyChart,{snapshot:${rangeVar}}),` +
    text.slice(refreshIndex);

  const summaryKeyIndex = text.indexOf("settings.usage.lifetimeTotalTokens");
  if (summaryKeyIndex < 0) fail("renderer summary strip: lifetimeTotalTokens anchor not found");
  const functionIndex = text.lastIndexOf("function ", summaryKeyIndex);
  if (functionIndex < 0) fail("renderer summary strip: function start not found");
  text = text.slice(0, functionIndex) + CHART_FUNCTION + text.slice(functionIndex);

  if (!text.includes("每日 Token 速度") || !text.includes("TokenSpeedDailyChart")) {
    fail("renderer main patch verification failed");
  }
  return { text, changed: true };
}

// ── renderer 校验 schema ────────────────────────────────────────────────

function patchValidation(original) {
  if (original.includes("avgOutputTokensPerSecond") && original.includes("dailySpeed:")) {
    return { text: original, changed: false };
  }
  let text = original;

  let numberAlias = null;
  text = replaceRegexOnce(
    text,
    "validation summary schema",
    /avgTurnDurationMs:([A-Za-z_$][\w$]*)\(\)\.nullable\(\),activeDays:/u,
    (_match, alias) => {
      numberAlias = alias;
      return `avgTurnDurationMs:${alias}().nullable(),avgOutputTokensPerSecond:${alias}().nullable().optional(),activeDays:`;
    },
  );

  text = replaceRegexOnce(
    text,
    "validation snapshot schema",
    /heatmap:([A-Za-z_$][\w$]*),dailyModelUsage:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)/u,
    (_match, heatmapVar, arrayAlias, itemVar) => {
      const elementRe = new RegExp(
        `\\b${itemVar}=([A-Za-z_$][\\w$]*)\\(\\{date:([A-Za-z_$][\\w$]*)\\(\\)`,
        "u",
      );
      const elementMatch = text.match(elementRe);
      if (!elementMatch) fail("validation snapshot element schema: aliases not found");
      const objectAlias = elementMatch[1];
      const stringAlias = elementMatch[2];
      return `heatmap:${heatmapVar},dailySpeed:${arrayAlias}(${objectAlias}({date:${stringAlias}(),outputTokens:${numberAlias}(),decodeMs:${numberAlias}(),tokensPerSecond:${numberAlias}().nullable()})).optional(),dailyModelUsage:${arrayAlias}(${itemVar})`;
    },
  );

  return { text, changed: true };
}

// ── host/main/preload/scheduler 中的 schema 副本 ────────────────────────

function patchSchemaCopy(original) {
  if (original.includes("avgOutputTokensPerSecond") && original.includes("dailySpeed:")) {
    return { text: original, changed: false };
  }
  let text = original;
  let zodAlias = null;
  text = replaceRegexOnce(
    text,
    "schema copy summary",
    /avgTurnDurationMs:([A-Za-z_$][\w$]*)\.number\(\)\.nullable\(\),activeDays:/u,
    (_match, alias) => {
      zodAlias = alias;
      return `avgTurnDurationMs:${alias}.number().nullable(),avgOutputTokensPerSecond:${alias}.number().nullable().optional(),activeDays:`;
    },
  );
  text = replaceRegexOnce(
    text,
    "schema copy snapshot",
    /heatmap:([A-Za-z_$][\w$]*),dailyModelUsage:([A-Za-z_$][\w$]*)\.array\(([A-Za-z_$][\w$]*)\)/u,
    (_match, heatmapVar, arrayVar, itemVar) =>
      `heatmap:${heatmapVar},dailySpeed:${zodAlias}.array(${zodAlias}.object({date:${zodAlias}.string(),outputTokens:${zodAlias}.number(),decodeMs:${zodAlias}.number(),tokensPerSecond:${zodAlias}.number().nullable()})).optional(),dailyModelUsage:${arrayVar}.array(${itemVar})`,
  );
  return { text, changed: true };
}

// ── 目标发现 ───────────────────────────────────────────────────────────

function findRendererMain(asar) {
  const candidates = listFiles(asar.header, "out/renderer/assets/")
    .filter((file) => file.path.endsWith(".js") && file.size > 1_000_000)
    .sort((a, b) => b.size - a.size);
  for (const candidate of candidates) {
    const text = getEntryContent(asar, candidate.path);
    if (
      text.includes("settings.usage.lifetimeTotalTokens") &&
      text.includes("settings.usage.app-model-pie-chart")
    ) {
      return { path: candidate.path, text };
    }
  }
  fail("renderer main bundle not found");
}

function findValidation(asar) {
  const candidates = listFiles(asar.header, "out/renderer/assets/")
    .filter((file) => file.path.endsWith(".js") && file.size > 150_000 && file.size < 2_000_000)
    .sort((a, b) => Math.abs(a.size - 340_000) - Math.abs(b.size - 340_000));
  for (const candidate of candidates) {
    const text = getEntryContent(asar, candidate.path);
    if (
      text.includes("avgTurnDurationMs") &&
      text.includes("dailyModelUsage") &&
      text.includes("activeDays")
    ) {
      return { path: candidate.path, text };
    }
  }
  fail("renderer validation schema bundle not found");
}

function findSchemaCopies(asar) {
  const files = [
    ...listFiles(asar.header, "out/host/"),
    ...listFiles(asar.header, "out/main/"),
    ...listFiles(asar.header, "out/preload/"),
    ...listFiles(asar.header, "out/scheduler/"),
  ].filter(
    (file) =>
      (file.path.endsWith(".js") || file.path.endsWith(".cjs")) &&
      file.size < 2_000_000,
  );
  const copies = [];
  for (const file of files) {
    const text = getEntryContent(asar, file.path);
    if (
      text.includes("avgTurnDurationMs") &&
      text.includes("dailyModelUsage") &&
      text.includes("activeDays") &&
      text.includes(".number().nullable()")
    ) {
      copies.push({ path: file.path, text });
    }
  }
  return copies;
}

// ── 主流程 ─────────────────────────────────────────────────────────────

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return null;
  }
}

function stateMatches(asarStat, hostStat) {
  const state = readState();
  if (!state) return false;
  if (state.asarSize !== asarStat.size) return false;
  if (Math.abs((state.asarMtimeMs ?? 0) - asarStat.mtimeMs) > 2) return false;
  if (state.hostSize !== hostStat.size) return false;
  if (Math.abs((state.hostMtimeMs ?? 0) - hostStat.mtimeMs) > 2) return false;
  if (!Array.isArray(state.files) || state.files.length === 0) return false;
  const asar = readAsarHeader(ASAR_PATH);
  return state.files.every((relativePath) => {
    const entry = getEntry(asar.header, relativePath);
    return entry?.unpacked === true;
  });
}

function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    const age = Date.now() - statSync(LOCK_PATH).mtimeMs;
    if (age < 5 * 60 * 1000) {
      log("another patch run is active; skip");
      return false;
    }
    rmSync(LOCK_PATH, { force: true });
  }
  writeFileSync(LOCK_PATH, String(process.pid), "utf8");
  return true;
}

function main() {
  const asar = readAsarHeader(ASAR_PATH);
  const asarStat = statSync(ASAR_PATH);
  const hostStat = statSync(HOST_PATH);

  if (WATCH_MODE) {
    const newest = Math.max(asarStat.mtimeMs, hostStat.mtimeMs);
    if (Date.now() - newest < 120_000) {
      log("recent app file change; skip watcher run");
      return;
    }
  }

  if (stateMatches(asarStat, hostStat)) {
    log("state matches; already patched");
    return;
  }

  const hostOriginal = readFileSync(HOST_PATH, "utf8");
  log(
    `check app=${asarStat.size}B host=${hostStat.size}B header=${asar.headerSize}B`,
  );

  const host = patchHost(hostOriginal);
  const rendererMain = findRendererMain(asar);
  const validation = findValidation(asar);
  const schemaCopies = findSchemaCopies(asar);

  const mainPatch = patchRendererMain(rendererMain.text);
  const validationPatch = patchValidation(validation.text);
  const schemaPatches = schemaCopies.map((copy) => ({
    ...copy,
    ...patchSchemaCopy(copy.text),
  }));

  const modifications = [];
  if (mainPatch.changed) modifications.push({ path: rendererMain.path, text: mainPatch.text });
  if (validationPatch.changed) {
    modifications.push({ path: validation.path, text: validationPatch.text });
  }
  for (const copy of schemaPatches) {
    if (copy.changed) modifications.push({ path: copy.path, text: copy.text });
  }

  if (!host.changed && modifications.length === 0) {
    const existing = readState();
    log("already patched; nothing to do");
    writeState(asar, existing?.files ?? [], existing?.backupDir ?? null);
    return;
  }

  checkSyntax("zcode.cjs", host.text, false);
  for (const modification of modifications) {
    const esm = modification.path.endsWith(".cjs")
      ? false
      : looksEsm(modification.text);
    checkSyntax(modification.path, modification.text, esm);
  }

  const backupDir = createBackup(asar, host.changed ? hostOriginal : null, modifications);

  try {
    if (host.changed) {
      writeFileSync(HOST_PATH, host.text, "utf8");
      log("host patched");
    }
    for (const modification of modifications) {
      writeUnpacked(asar, modification.path, modification.text);
      markUnpacked(asar, modification.path, modification.text);
    }
    if (modifications.length > 0) {
      writeAsarHeader(asar);
      log(`asar patched: ${modifications.length} bundle(s)`);
    }
    verify(asar, host.text, modifications);
    writeState(asar, modifications.map((item) => item.path), backupDir);
    log(`done (backup: ${backupDir})`);
  } catch (error) {
    log(`FAILED: ${error.message}; rolling back`);
    rollback(backupDir, modifications.map((item) => item.path));
    throw error;
  }
}

function verify(asar, hostText, modifications) {
  const current = readAsarHeader(ASAR_PATH);
  for (const modification of modifications) {
    const entry = getEntry(current.header, modification.path);
    if (!entry || entry.unpacked !== true) {
      fail(`verification failed: ${modification.path} is not unpacked`);
    }
    const content = getEntryContent(current, modification.path);
    const marker =
      modification.path.includes("renderer/assets/") &&
      modification.path.includes("styles-")
        ? "TokenSpeedDailyChart"
        : "avgOutputTokensPerSecond";
    if (!content.includes(marker)) {
      fail(`verification failed: marker missing in ${modification.path}`);
    }
  }
  if (!hostText.includes("dailySpeed:__tsDailySpeed")) {
    fail("verification failed: host patch missing");
  }
}

function createBackup(asar, hostOriginal, modifications) {
  const stamp = `${statSync(ASAR_PATH).size}-${statSync(ASAR_PATH).mtimeMs.toFixed(0)}-${statSync(HOST_PATH).size}`;
  const backupDir = join(WORK_DIR, "backups", stamp);
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const headerPath = join(backupDir, "app.asar.header");
  if (!existsSync(headerPath)) {
    const prefix = readFileSync(ASAR_PATH).subarray(0, 8 + asar.headerSize);
    writeFileSync(headerPath, prefix);
  }
  if (hostOriginal !== null) {
    const hostBackup = join(backupDir, "zcode.cjs");
    if (!existsSync(hostBackup)) writeFileSync(hostBackup, hostOriginal, "utf8");
  }
  writeFileSync(
    join(backupDir, "files.json"),
    JSON.stringify(modifications.map((item) => item.path), null, 2),
    "utf8",
  );
  return backupDir;
}

function rollback(backupDir, files) {
  try {
    const headerPath = join(backupDir, "app.asar.header");
    if (existsSync(headerPath)) {
      const prefix = readFileSync(headerPath);
      const fd = openSync(ASAR_PATH, "r+");
      try {
        writeSync(fd, prefix, 0, prefix.length, 0);
      } finally {
        closeSync(fd);
      }
    }
    const hostBackup = join(backupDir, "zcode.cjs");
    if (existsSync(hostBackup)) copyFileSync(hostBackup, HOST_PATH);
    for (const relativePath of files) {
      const target = join(`${ASAR_PATH}.unpacked`, ...relativePath.split("/"));
      if (existsSync(target)) rmSync(target, { force: true });
    }
  } catch (error) {
    log(`rollback failed: ${error.message}`);
  }
}

function writeState(asar, files, backupDir) {
  const asarStat = statSync(ASAR_PATH);
  const hostStat = statSync(HOST_PATH);
  writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        patchedAt: new Date().toISOString(),
        appRoot: APP_ROOT,
        workDir: WORK_DIR,
        asarSize: asarStat.size,
        asarMtimeMs: asarStat.mtimeMs,
        hostSize: hostStat.size,
        hostMtimeMs: hostStat.mtimeMs,
        headerSize: asar.headerSize,
        backupDir,
        files,
      },
      null,
      2,
    ),
    "utf8",
  );
}

if (!acquireLock()) {
  process.exitCode = 0;
} else {
  try {
    main();
    log("ok");
  } catch (error) {
    log(`error: ${error.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(LOCK_PATH, { force: true });
  }
}
