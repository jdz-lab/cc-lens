// 请求记录：内存环形缓冲 + JSONL 落盘 + 实时广播（SSE 用）+ 聚合统计
const fs = require("fs");
const path = require("path");

const MAX_MEMORY = 1000;
let records = []; // 新的在前
let filePath = null;
let config = { upstream: "", port: "" };
let listeners = new Set();

function init(dataDir, cfg) {
  config = { upstream: (cfg && cfg.upstream) || "", port: (cfg && cfg.port) || "" };
  fs.mkdirSync(dataDir, { recursive: true });
  filePath = path.join(dataDir, "requests.jsonl");
  try {
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      records = lines
        .slice(-MAX_MEMORY)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    }
  } catch {
    records = [];
  }
}

// API key 脱敏：只留前 6 后 4 位
function maskKey(k) {
  if (!k) return null;
  k = String(k);
  return k.length <= 12 ? k.slice(0, 2) + "****" : k.slice(0, 6) + "****" + k.slice(-4);
}

function add(entry) {
  records.unshift(entry);
  if (records.length > MAX_MEMORY) records.length = MAX_MEMORY;
  if (filePath) {
    try {
      fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
    } catch {
      /* 落盘失败不影响代理 */
    }
  }
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* 监听器异常忽略 */
    }
  }
}

function onRecord(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function recent(limit = 200) {
  return records.slice(0, limit);
}

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 面板聚合数据
function stats() {
  const t0 = todayStart();
  const today = records.filter((r) => r.ts >= t0);
  const ok = today.filter((r) => r.status >= 200 && r.status < 400).length;
  const byApp = {};
  const byModel = {};
  const hours = Array.from({ length: 24 }, () => 0);
  let tokensIn = 0;
  let tokensOut = 0;
  for (const r of today) {
    byApp[r.app] = (byApp[r.app] || 0) + 1;
    if (r.model) byModel[r.model] = (byModel[r.model] || 0) + 1;
    hours[Math.min(23, new Date(r.ts).getHours())] += 1;
    tokensIn += r.tokensIn || 0;
    tokensOut += r.tokensOut || 0;
  }
  return {
    now: Date.now(),
    upstream: config.upstream,
    port: config.port,
    today: today.length,
    okCount: ok,
    tokensIn,
    tokensOut,
    byApp,
    byModel,
    hours,
    totalFiles: records.length,
  };
}

module.exports = { init, add, recent, stats, onRecord, maskKey };
