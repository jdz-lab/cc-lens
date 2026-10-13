// HTTP 服务：路由分发、上游转发、流式处理、记录
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const fp = require("./fingerprint");
const apps = require("./apps");
const store = require("./store");
const bridge = require("./openai-bridge");

const DASHBOARD = path.join(__dirname, "..", "public", "dashboard.html");

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, { "content-type": "application/json; charset=utf-8" }, JSON.stringify(obj));
}

// 安全报错：流式响应头已发出时不能再写头，只能截断连接
function replyError(res, status, message) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  json(res, status, { error: { message } });
}

// 从上游 SSE 原始字节流中逐行嗅探 Anthropic 事件（提取 usage 等），同时把原始字节交给 onChunk
// up.body 是 web ReadableStream，先转成 Node 流
function sniffSSE(webStream, onChunk, onEvent, onDone) {
  const upStream = Readable.fromWeb(webStream);
  let buf = "";
  let bytes = 0;
  upStream.on("data", (c) => {
    bytes += c.length;
    if (onChunk) onChunk(c);
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) {
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    }
  });
  upStream.on("end", () => onDone && onDone(bytes));
  upStream.on("error", () => onDone && onDone(bytes));
}

// 读请求体
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function upstreamHeaders(req, bodyLen) {
  const h = fp.patchHeaders({ ...req.headers });
  h["host"] = new URL(upstreamOf()).host;
  delete h["connection"];
  delete h["accept-encoding"]; // 上游返回未压缩内容，便于嗅探 usage
  if (bodyLen != null) h["content-length"] = String(bodyLen);
  return h;
}

let CONFIG = { port: 8787, upstream: "" };
function upstreamOf() {
  return CONFIG.upstream.replace(/\/+$/, "");
}

function createServer(cfg) {
  CONFIG = cfg;
  return http.createServer((req, res) => handle(req, res));
}

async function handle(req, res) {
  const url = req.url;
  try {
    if (url.startsWith("/cc-lens/api/stream")) return handleSSE(req, res);
    if (url.startsWith("/cc-lens/api/stats")) return json(res, 200, store.stats());
    if (url.startsWith("/cc-lens/api/requests")) {
      const limit = Math.min(1000, parseInt(new URL("http://x" + url).searchParams.get("limit") || "200", 10));
      return json(res, 200, store.recent(limit));
    }
    if (url === "/favicon.ico") return send(res, 204, {}, "");
    if (url === "/" || url === "/index.html" || url === "/dashboard") {
      return send(
        res,
        200,
        { "content-type": "text/html; charset=utf-8" },
        fs.readFileSync(DASHBOARD)
      );
    }
    if (!CONFIG.upstream) {
      return json(res, 503, {
        error: { message: "cc-lens: 未配置上游地址。启动时加 --upstream https://你的中转地址（面板不受影响）" },
      });
    }
    if (url.includes("/v1/messages")) return handleAnthropic(req, res);
    if (url.includes("/v1/chat/completions")) return handleOpenAI(req, res);
    return passthrough(req, res);
  } catch (e) {
    replyError(res, 502, "cc-lens: " + e.message);
  }
}

// ---------- Anthropic 原生流 ----------
async function handleAnthropic(req, res) {
  const started = Date.now();
  const app = apps.identify(req.headers);
  const bodyBuf = await readBody(req);
  let meta = { model: "", stream: false };
  let fwd = bodyBuf;
  try {
    const obj = JSON.parse(bodyBuf.toString());
    meta.model = obj.model || "";
    meta.stream = !!obj.stream;
    fp.patchBody(obj);
    fwd = Buffer.from(JSON.stringify(obj));
  } catch {
    /* 非法 JSON 原样转发让上游报错 */
  }
  const entry = baseEntry(req, app, bodyBuf.length, "anthropic", meta);
  try {
    const up = await fetch(upstreamOf() + req.url, {
      method: req.method,
      headers: upstreamHeaders(req, fwd.length),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : fwd,
    });
    const outHeaders = { ...Object.fromEntries(up.headers) };
    delete outHeaders["content-encoding"];
    delete outHeaders["content-length"];
    delete outHeaders["transfer-encoding"];
    entry.status = up.status;
    if (meta.stream && up.body) {
      res.writeHead(up.status, outHeaders);
      sniffSSE(
        up.body,
        (c) => {
          entry.bytesOut += c.length;
          res.write(c);
        },
        (evt) => {
          if (evt.type === "message_start") entry.tokensIn = evt.message?.usage?.input_tokens ?? entry.tokensIn;
          if (evt.type === "message_delta" && evt.usage?.output_tokens != null) entry.tokensOut = evt.usage.output_tokens;
          if (evt.type === "error") entry.error = JSON.stringify(evt.error || {}).slice(0, 300);
        },
        () => {
          res.end();
          finish(entry, started, res);
        }
      );
    } else {
      const buf = Buffer.from(await up.arrayBuffer());
      entry.bytesOut = buf.length;
      try {
        const j = JSON.parse(buf.toString());
        entry.tokensIn = j.usage?.input_tokens ?? entry.tokensIn;
        entry.tokensOut = j.usage?.output_tokens ?? entry.tokensOut;
        if (!up.ok) entry.error = (j.error?.message || "").slice(0, 300);
      } catch {
        /* 非 JSON 响应 */
      }
      send(res, up.status, outHeaders, buf);
      finish(entry, started, res);
    }
  } catch (e) {
    entry.status = 502;
    entry.error = e.message;
    replyError(res, 502, "cc-lens: 上游请求失败 " + e.message);
    finish(entry, started, res);
  }
}

// ---------- OpenAI 兼容流（转换后走 /v1/messages）----------
async function handleOpenAI(req, res) {
  const started = Date.now();
  const app = apps.identify(req.headers);
  const bodyBuf = await readBody(req);
  let meta = { model: "", stream: false };
  let fwd = null;
  let parseError = null;
  try {
    const oai = JSON.parse(bodyBuf.toString());
    meta.model = oai.model || "";
    meta.stream = !!oai.stream;
    const ab = bridge.toAnthropic(oai);
    fp.patchBody(ab);
    fwd = Buffer.from(JSON.stringify(ab));
  } catch (e) {
    parseError = e;
  }
  const entry = baseEntry(req, app, bodyBuf.length, "openai", meta);
  if (parseError) {
    entry.status = 400;
    entry.error = parseError.message;
    replyError(res, 400, "cc-lens: 请求体解析失败 " + parseError.message);
    return finish(entry, started, res);
  }
  try {
    const up = await fetch(upstreamOf() + "/v1/messages", {
      method: "POST",
      headers: upstreamHeaders(req, fwd.length),
      body: fwd,
    });
    const outHeaders = {
      "content-type": up.headers.get("content-type") || "application/json",
      "cache-control": "no-cache",
    };
    entry.status = up.status;
    if (!up.ok || !meta.stream) {
      const buf = Buffer.from(await up.arrayBuffer());
      entry.bytesOut = buf.length;
      let outBody = buf;
      try {
        const j = JSON.parse(buf.toString());
        entry.tokensIn = j.usage?.input_tokens ?? entry.tokensIn;
        entry.tokensOut = j.usage?.output_tokens ?? entry.tokensOut;
        if (!up.ok) entry.error = (j.error?.message || "").slice(0, 300);
        else outBody = Buffer.from(JSON.stringify(bridge.toOpenAI(j)));
      } catch {
        /* 非 JSON：原样返回 */
      }
      outHeaders["content-length"] = String(outBody.length);
      send(res, up.status, outHeaders, outBody);
      return finish(entry, started, res);
    }
    // 流式：Anthropic SSE → OpenAI chunk 流
    outHeaders["content-type"] = "text/event-stream; charset=utf-8";
    res.writeHead(up.status, outHeaders);
    const transformer = new bridge.StreamTransformer(meta.model);
    sniffSSE(
      up.body,
      null,
      (evt) => {
        for (const chunk of transformer.transform(evt)) {
          entry.bytesOut += Buffer.byteLength(chunk);
          res.write(chunk);
        }
      },
      () => {
        const u = transformer.usageInfo();
        entry.tokensIn = u.in;
        entry.tokensOut = u.out;
        res.end();
        finish(entry, started, res);
      }
    );
  } catch (e) {
    entry.status = 502;
    entry.error = e.message;
    replyError(res, 502, "cc-lens: 上游请求失败 " + e.message);
    finish(entry, started, res);
  }
}

// ---------- 其余路径透传（如 GET /v1/models）----------
async function passthrough(req, res) {
  const started = Date.now();
  const app = apps.identify(req.headers);
  const bodyBuf = await readBody(req);
  const entry = baseEntry(req, app, bodyBuf.length, "other", { model: "", stream: false });
  try {
    const up = await fetch(upstreamOf() + req.url, {
      method: req.method,
      headers: upstreamHeaders(req, ["GET", "HEAD"].includes(req.method) ? null : bodyBuf.length),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : bodyBuf,
    });
    const outHeaders = { ...Object.fromEntries(up.headers) };
    delete outHeaders["content-encoding"];
    delete outHeaders["transfer-encoding"];
    const buf = Buffer.from(await up.arrayBuffer());
    entry.status = up.status;
    entry.bytesOut = buf.length;
    send(res, up.status, outHeaders, buf);
  } catch (e) {
    entry.status = 502;
    entry.error = e.message;
    replyError(res, 502, "cc-lens: 上游请求失败 " + e.message);
  }
  finish(entry, started, res);
}

// ---------- 面板 SSE ----------
function handleSSE(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write("data: " + JSON.stringify({ hello: true }) + "\n\n");
  const off = store.onRecord((entry) => {
    try {
      res.write("data: " + JSON.stringify(entry) + "\n\n");
    } catch {
      /* 连接已断 */
    }
  });
  const beat = setInterval(() => res.write(": beat\n\n"), 15000);
  req.on("close", () => {
    off();
    clearInterval(beat);
  });
}

// ---------- 记录 ----------
function baseEntry(req, app, bytesIn, format, meta) {
  const key = (req.headers["x-api-key"] || "").toString() ||
    ((req.headers["authorization"] || "").toString().replace(/^Bearer\s+/i, ""));
  return {
    ts: Date.now(),
    app: app.name,
    color: app.color,
    ua: app.raw.slice(0, 200),
    method: req.method,
    path: req.url.split("?")[0],
    format,
    model: meta.model,
    stream: meta.stream,
    status: 0,
    ms: 0,
    bytesIn,
    bytesOut: 0,
    tokensIn: 0,
    tokensOut: 0,
    key: store.maskKey(key),
    error: null,
  };
}

function finish(entry, started) {
  entry.ms = Date.now() - started;
  store.add(entry);
}

module.exports = { createServer };
