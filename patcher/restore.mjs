#!/usr/bin/env node
// 还原外部补丁：恢复 asar header 与 zcode.cjs，并删除 unpacked 覆盖文件。
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
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
const STATE_PATH = join(WORK_DIR, "state.json");
const CONFIG_PATH = join(WORK_DIR, "config.json");
const BACKUPS_DIR = join(WORK_DIR, "backups");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return null;
  }
}

function latestBackup() {
  if (!existsSync(BACKUPS_DIR)) return null;
  const entries = readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      path: join(BACKUPS_DIR, entry.name),
      mtime: statSync(join(BACKUPS_DIR, entry.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.path ?? null;
}

const state = existsSync(STATE_PATH) ? readJson(STATE_PATH) : null;
if (!state) {
  console.error("找不到 state.json，无法确认备份对应哪个 ZCode 版本，已中止。");
  process.exit(1);
}

const config = existsSync(CONFIG_PATH) ? readJson(CONFIG_PATH) : null;
const APP_ROOT =
  (typeof state.appRoot === "string" && state.appRoot.trim()) ||
  process.env.ZCODE_APP_ROOT?.trim() ||
  (typeof config?.appRoot === "string" ? config.appRoot.trim() : "");
if (!APP_ROOT) {
  console.error("找不到 ZCode 安装目录。请检查 state.json / config.json 的 appRoot。");
  process.exit(1);
}

const ASAR_PATH = join(APP_ROOT, "resources", "app.asar");
const HOST_PATH = join(APP_ROOT, "resources", "glm", "zcode.cjs");
if (!existsSync(ASAR_PATH) || !existsSync(HOST_PATH)) {
  console.error(`在 ${APP_ROOT} 找不到 app.asar / zcode.cjs。`);
  process.exit(1);
}

const currentAsarSize = statSync(ASAR_PATH).size;
if (state.asarSize !== currentAsarSize) {
  console.error(
    `当前 app.asar（${currentAsarSize}B）与备份版本（${state.asarSize}B）不一致，ZCode 可能已更新；为避免损坏已中止还原。`,
  );
  process.exit(1);
}

const backupDir =
  (state.backupDir && existsSync(state.backupDir) ? state.backupDir : null) ??
  (state.asarSize
    ? readdirSync(BACKUPS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${state.asarSize}-`))
        .map((entry) => join(BACKUPS_DIR, entry.name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
    : null) ??
  latestBackup();

if (!backupDir) {
  console.error("找不到补丁备份，无法还原。");
  process.exit(1);
}

// 确认版本一致后再停用后台 watcher，避免还原后被自动重新打补丁。
writeFileSync(join(WORK_DIR, "disabled"), new Date().toISOString(), "utf8");
try {
  execFileSync(
    "reg",
    [
      "delete",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "ZCodeTokenSpeedWatch",
      "/f",
    ],
    { stdio: "ignore" },
  );
} catch {
  // 没有 Run 项时忽略。
}

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

const filesPath = join(backupDir, "files.json");
if (existsSync(filesPath)) {
  const files = JSON.parse(readFileSync(filesPath, "utf8"));
  for (const relativePath of files) {
    const target = join(`${ASAR_PATH}.unpacked`, ...relativePath.split("/"));
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

rmSync(STATE_PATH, { force: true });
console.log(`已还原补丁。备份保留在：${backupDir}`);
