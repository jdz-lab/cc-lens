// Claude Code 客户端指纹 —— 实测许多中转平台（new-api / one-api 及其衍生）
// 以这 5 项特征联合判定请求是否来自 Claude Code，缺一不可：
//   1. user-agent: claude-cli/x.x.x (external, cli)   版本号任意
//   2. x-app: cli
//   3. anthropic-beta 含 claude-code-20250219
//   4. system[0].text 以 x-anthropic-billing-header 计费行开头
//   5. metadata.user_id 为含 device_id/session_id 的 JSON 字符串
// 平台升级检测后，优先更新这几个常量。
const crypto = require("crypto");

const CC_VERSION = "2.1.294";
const DEVICE_ID = "61314638cb1ce5bd350d02fa8aad25ed27e39fa0eb02f29f7686eeffdd807995";
const BETA_TAG = "claude-code-20250219";

const BILLING_BLOCK =
  "x-anthropic-billing-header: cc_version=" + CC_VERSION + ".0a5; cc_entrypoint=sdk-cli;\n\n" +
  "You are Claude Code, Anthropic's official CLI for Claude.";

// 注入/补全指纹请求头（headers 会被就地修改）
function patchHeaders(headers) {
  headers["user-agent"] = `claude-cli/${CC_VERSION} (external, sdk-cli)`;
  headers["x-app"] = "cli";
  // OpenAI 兼容客户端只带 Authorization: Bearer，补上 Anthropic 必需的两个头
  if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
  if (!headers["x-api-key"] && headers["authorization"]) {
    headers["x-api-key"] = String(headers["authorization"]).replace(/^Bearer\s+/i, "");
  }
  const betas = (headers["anthropic-beta"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!betas.includes(BETA_TAG)) betas.push(BETA_TAG);
  headers["anthropic-beta"] = betas.join(",");
  return headers;
}

// 注入/补全指纹请求体字段（body 为已解析的 JSON 对象，就地修改）
function patchBody(body) {
  if (body.system == null) {
    body.system = [{ type: "text", text: BILLING_BLOCK }];
  } else if (typeof body.system === "string") {
    body.system = [{ type: "text", text: BILLING_BLOCK }, { type: "text", text: body.system }];
  } else if (Array.isArray(body.system)) {
    body.system = [{ type: "text", text: BILLING_BLOCK }, ...body.system];
  }
  body.metadata = {
    user_id: JSON.stringify({
      device_id: DEVICE_ID,
      account_uuid: "",
      session_id: crypto.randomUUID(),
    }),
  };
  return body;
}

module.exports = { patchHeaders, patchBody, CC_VERSION, BETA_TAG, DEVICE_ID };
