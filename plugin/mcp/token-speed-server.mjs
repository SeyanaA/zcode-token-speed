#!/usr/bin/env node
// token-speed MCP server（stdio）：只读打开 ZCode agent 的 SQLite 用量库，
// 用 model_usage 的 duration_ms / time_to_first_token_ms / output_tokens 计算模型输出速度。
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const SERVER_NAME = "token-speed";
const SERVER_VERSION = "0.1.0";
const DEFAULT_DB_PATH = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const FALLBACK_PROTOCOL_VERSION = "2025-11-25";
const DAY_MS = 86_400_000;
const TOOL_NAME = "get_token_speed";

// 只统计能算出解码时长的已完成请求：缺 duration_ms / TTFT 或输出为 0 的样本会污染速度。
const SAMPLE_FILTER = [
  "status = 'completed'",
  "output_tokens > 0",
  "duration_ms is not null",
  "time_to_first_token_ms is not null",
  "duration_ms > time_to_first_token_ms",
];

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "统计本地 ZCode agent 数据库中的模型输出速度（tokens/秒）。返回综合加权平均速度、" +
    "单请求平均/中位速度、平均首 Token 延迟（TTFT）、样本量，以及按模型拆分的结果。" +
    "适用于回答“我的模型吐字速度多快”“哪个模型出字更快”“最近和之前相比变慢了吗”等问题。",
  inputSchema: {
    type: "object",
    properties: {
      range: {
        type: "string",
        enum: ["today", "7d", "30d", "all"],
        description: "统计时间范围，默认 7d。all 受本地数据库默认 30 天保留期限制。",
      },
      model: {
        type: "string",
        description: "可选。按 model_id 关键词过滤，不区分大小写，例如 deepseek 或 glm。",
      },
      dbPath: {
        type: "string",
        description:
          "可选。agent SQLite 数据库路径；默认 ~/.zcode/cli/db/db.sqlite，也可用环境变量 ZCODE_USAGE_DB 覆盖。",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const SERVER_INSTRUCTIONS =
  "当用户询问模型输出速度、吐字快慢、TTFT 或 tokens/秒时，调用 get_token_speed。" +
  "默认 range 为 7d；用户提到具体模型时传入 model 关键词。结果已按中文表格排版，直接展示即可。";

let inputBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newlineIndex = inputBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = inputBuffer.slice(0, newlineIndex).trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (line.length > 0) {
      void handleLine(line);
    }
    newlineIndex = inputBuffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});

function writeMessage(message) {
  // stdio 传输要求一条消息一行 JSON；stdout 不能有多余输出。
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    respondError(null, -32700, "Parse error");
    return;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const message of messages) {
    await handleMessage(message);
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize": {
      const requested =
        params && typeof params.protocolVersion === "string" && params.protocolVersion.trim()
          ? params.protocolVersion.trim()
          : FALLBACK_PROTOCOL_VERSION;
      respond(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      });
      return;
    }
    case "ping":
      if (isRequest) respond(id, {});
      return;
    case "tools/list":
      respond(id, { tools: [TOOL_DEFINITION] });
      return;
    case "tools/call": {
      const name = params && typeof params.name === "string" ? params.name : "";
      if (name !== TOOL_NAME) {
        respondError(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const result = await callTool(params && typeof params.arguments === "object" ? params.arguments : {});
      respond(id, result);
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    default:
      if (isRequest) respondError(id, -32601, `Method not found: ${String(method)}`);
      return;
  }
}

async function callTool(input) {
  try {
    const text = buildReport(input ?? {});
    return { content: [{ type: "text", text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text:
            `读取本地用量数据失败：${message}\n\n` +
            `排查建议：确认 agent 数据库路径存在（默认 ${DEFAULT_DB_PATH}），` +
            "或在工具参数里用 dbPath 指定实际路径，也可设置环境变量 ZCODE_USAGE_DB。",
        },
      ],
      isError: true,
    };
  }
}

function buildReport(input) {
  const range = normalizeRange(input.range);
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const dbPath = resolveDbPath(input.dbPath);
  const now = Date.now();
  const since = rangeSince(range, now);

  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
  try {
    const where = [...SAMPLE_FILTER];
    const params = [];
    if (since !== null) {
      where.push("started_at >= ?");
      params.push(since);
    }
    if (model.length > 0) {
      where.push("instr(lower(model_id), lower(?)) > 0");
      params.push(model);
    }
    const whereSql = where.join(" and ");

    const overall = db
      .prepare(
        `select
           count(*) as requests,
           coalesce(sum(output_tokens), 0) as outputTokens,
           coalesce(sum(duration_ms - time_to_first_token_ms), 0) as decodeMs,
           avg(time_to_first_token_ms) as avgTtftMs,
           avg(output_tokens * 1000.0 / (duration_ms - time_to_first_token_ms)) as avgSpeed
         from model_usage
         where ${whereSql}`,
      )
      .get(...params);

    const median = db
      .prepare(
        `select avg(speed) as medianSpeed
         from (
           select output_tokens * 1000.0 / (duration_ms - time_to_first_token_ms) as speed,
                  row_number() over (
                    order by output_tokens * 1000.0 / (duration_ms - time_to_first_token_ms)
                  ) as rn,
                  count(*) over () as cnt
           from model_usage
           where ${whereSql}
         )
         where rn in ((cnt + 1) / 2, (cnt + 2) / 2)`,
      )
      .get(...params);

    const models = db
      .prepare(
        `select
           model_id as modelId,
           count(*) as requests,
           sum(output_tokens) as outputTokens,
           sum(duration_ms - time_to_first_token_ms) as decodeMs,
           avg(time_to_first_token_ms) as avgTtftMs,
           avg(output_tokens * 1000.0 / (duration_ms - time_to_first_token_ms)) as avgSpeed,
           sum(output_tokens) * 1000.0 / sum(duration_ms - time_to_first_token_ms) as weightedSpeed
         from model_usage
         where ${whereSql}
         group by model_id
         order by outputTokens desc`,
      )
      .all(...params);

    return formatReport({
      range,
      model,
      dbPath,
      overall,
      medianSpeed: median ? median.medianSpeed : null,
      models,
    });
  } finally {
    db.close();
  }
}

function formatReport({ range, model, dbPath, overall, medianSpeed, models }) {
  const requests = Number(overall?.requests ?? 0);
  const outputTokens = Number(overall?.outputTokens ?? 0);
  const decodeMs = Number(overall?.decodeMs ?? 0);
  const weightedSpeed = decodeMs > 0 ? (outputTokens * 1000) / decodeMs : null;
  const avgTtftMs = overall?.avgTtftMs == null ? null : Number(overall.avgTtftMs);
  const avgSpeed = overall?.avgSpeed == null ? null : Number(overall.avgSpeed);

  const header = `## 平均 Token 速度（${rangeLabel(range)}${model ? ` · 模型含“${model}”` : ""}）`;

  if (requests === 0) {
    return [
      header,
      "",
      "没有可用的样本。",
      "",
      `统计口径：只统计已完成的请求，且必须同时记录 duration_ms、time_to_first_token_ms 和输出 tokens。`,
      `数据源：${dbPath}`,
      "可能的原因：时间范围内没有请求、数据库路径不对，或该版本没有采集请求时长。",
    ].join("\n");
  }

  const lines = [
    header,
    "",
    `- 综合速度（按输出 tokens ÷ 解码时长加权）：**${formatSpeed(weightedSpeed)}**`,
    `- 单请求平均速度：**${formatSpeed(avgSpeed)}**`,
    medianSpeed == null ? null : `- 单请求中位速度：**${formatSpeed(Number(medianSpeed))}**`,
    `- 平均首 Token 延迟（TTFT）：**${formatLatency(avgTtftMs)}**`,
    `- 样本：${formatInt(requests)} 次请求 · ${formatInt(outputTokens)} 输出 tokens · ${formatDuration(decodeMs)} 解码`,
    "",
    "### 按模型拆分",
    "",
    "| 模型 | 加权速度 | 单请求均值 | 平均 TTFT | 请求数 | 输出 tokens |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...models.map((row) => {
      const rowOutput = Number(row.outputTokens ?? 0);
      const rowDecode = Number(row.decodeMs ?? 0);
      const rowWeighted = rowDecode > 0 ? (rowOutput * 1000) / rowDecode : null;
      return `| ${escapeCell(String(row.modelId ?? "unknown"))} | ${formatSpeed(rowWeighted)} | ${formatSpeed(
        row.avgSpeed == null ? null : Number(row.avgSpeed),
      )} | ${formatLatency(row.avgTtftMs == null ? null : Number(row.avgTtftMs))} | ${formatInt(
        Number(row.requests ?? 0),
      )} | ${formatInt(rowOutput)} |`;
    }),
    "",
    "> 口径：解码时长 = duration_ms − time_to_first_token_ms，速度 = 输出 tokens ÷ 解码秒数；" +
      "只统计 status=completed 且时长字段齐全的本地请求。数据库默认只保留最近 30 天；" +
      "部分供应商会把 reasoning tokens 计入输出 tokens，速度会偏高。",
    `> 数据源：${dbPath}`,
  ];

  return lines.filter((line) => line !== null).join("\n");
}

function normalizeRange(value) {
  return value === "today" || value === "30d" || value === "all" || value === "7d" ? value : "7d";
}

function rangeSince(range, now) {
  if (range === "all") return null;
  if (range === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  if (range === "30d") return now - 30 * DAY_MS;
  return now - 7 * DAY_MS;
}

function rangeLabel(range) {
  switch (range) {
    case "today":
      return "今天";
    case "30d":
      return "最近 30 天";
    case "all":
      return "全部（数据库默认保留 30 天）";
    default:
      return "最近 7 天";
  }
}

function resolveDbPath(value) {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const fromEnv = process.env.ZCODE_USAGE_DB;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return DEFAULT_DB_PATH;
}

function formatSpeed(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)} tokens/秒`;
}

function formatLatency(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  return `${(value / 1000).toFixed(2)} 秒`;
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 秒";
  return `${(value / 1000).toLocaleString("zh-CN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} 秒`;
}

function formatInt(value) {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("zh-CN");
}

function escapeCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
