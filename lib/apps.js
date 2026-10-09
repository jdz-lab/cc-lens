// 客户端应用识别：按 User-Agent / 特征头把请求归到具体应用。
// 内置规则按顺序匹配（先专用后通用），未命中时显示原始 UA 摘要。
const fs = require("fs");
const path = require("path");

// [应用名, 显示色, UA 小写子串列表]
const BUILT_IN = [
  ["Claude Code", "#d97757", ["claude-cli"]],
  ["Qoder", "#6c5ce7", ["qoder"]],
  ["Cursor", "#00b8d9", ["cursor/"]],
  ["Windsurf", "#00c853", ["windsurf"]],
  ["Cherry Studio", "#ff6b6b", ["cherry-studio"]],
  ["Chatbox", "#f39c12", ["chatbox"]],
  ["Cline", "#8e44ad", ["cline"]],
  ["Roo Code", "#e67e22", ["roo-code", "roovscode"]],
  ["Kilo Code", "#16a085", ["kilo"]],
  ["Continue", "#2980b9", ["continue/"]],
  ["VS Code", "#519aba", ["vscode", "visual studio code"]],
  ["JetBrains", "#fe640b", ["jetbrains"]],
  ["Dify", "#4f46e5", ["dify"]],
  ["LobeChat", "#7c3aed", ["lobechat", "lobe-chat"]],
  ["Open WebUI", "#059669", ["open-webui"]],
  ["curl", "#95a5a6", ["curl/"]],
  ["wget", "#95a5a6", ["wget/"]],
  ["Python", "#3572a5", ["python-requests", "python-httpx", "python/", "openai-python", "anthropic-python"]],
  ["Go", "#00add8", ["go-http-client"]],
  ["Java", "#b07219", ["java/", "okhttp"]],
  ["Rust", "#dea584", ["reqwest"]],
  ["Node.js", "#68a063", ["node", "undici", "axios"]],
];

let customRules = []; // data/apps.json：[{ "name": "...", "ua": ["子串", ...] }]
function loadCustom(dataDir) {
  try {
    const p = path.join(dataDir, "apps.json");
    if (fs.existsSync(p)) {
      const arr = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(arr)) customRules = arr.filter((r) => r && r.name && Array.isArray(r.ua));
    }
  } catch {
    /* 自定义规则解析失败则忽略 */
  }
}

// 返回 { name, color, raw }
function identify(headers) {
  const ua = (headers["user-agent"] || "").toString();
  for (const [name, uaList] of customRules.map((r) => [r.name, r.ua.map((s) => s.toLowerCase())])) {
    if (uaList.some((s) => ua.toLowerCase().includes(s))) return { name, color: "#8b5cf6", raw: ua };
  }
  for (const [name, color, uaList] of BUILT_IN) {
    if (uaList.some((s) => ua.toLowerCase().includes(s))) return { name, color, raw: ua };
  }
  return { name: ua ? "未知客户端" : "无 UA", color: "#6b7280", raw: ua };
}

module.exports = { identify, loadCustom, BUILT_IN };
