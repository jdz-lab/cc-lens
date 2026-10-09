#!/usr/bin/env node
// cc-lens — 给任意 Anthropic/OpenAI 兼容客户端加上 Claude Code 客户端指纹，
// 转发到你的中转平台，并内置请求观测面板。零依赖，Node >= 18。
//
// 用法：
//   node cc-lens.js --upstream https://你的中转地址 [--port 8787] [--data-dir ./data]
//   环境变量 CCLENS_UPSTREAM / CCLENS_PORT / CCLENS_DATA 可替代对应参数。
//   启动后浏览器打开 http://127.0.0.1:<port>/ 查看面板。
const path = require("path");
const store = require("./lib/store");
const apps = require("./lib/apps");
const { createServer } = require("./lib/proxy");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--upstream") args.upstream = argv[++i];
    else if (a === "--port") args.port = parseInt(argv[++i], 10);
    else if (a === "--data-dir") args.dataDir = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`cc-lens — Claude Code 指纹代理 + 请求观测面板

用法:
  node cc-lens.js --upstream https://你的中转地址 [--port 8787] [--data-dir ./data]

参数:
  --upstream   中转平台地址（也可用环境变量 CCLENS_UPSTREAM）
  --port       监听端口，默认 8787（CCLENS_PORT）
  --data-dir   数据目录，默认 ./data（CCLENS_DATA）
  -h           显示帮助`);
    process.exit(0);
  }
  const cfg = {
    upstream: (args.upstream || process.env.CCLENS_UPSTREAM || "").replace(/\/+$/, ""),
    port: args.port || parseInt(process.env.CCLENS_PORT || "8787", 10),
    // pkg 打包成 exe 后 __dirname 在快照里不可写，数据目录改用 exe 所在目录
    dataDir: path.resolve(
      args.dataDir ||
        process.env.CCLENS_DATA ||
        path.join(process.pkg ? path.dirname(process.execPath) : __dirname, "data")
    ),
  };

  store.init(cfg.dataDir, cfg);
  apps.loadCustom(cfg.dataDir);
  const server = createServer(cfg);

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`端口 ${cfg.port} 已被占用。换个端口：node cc-lens.js --port 8788`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(cfg.port, () => {
    console.log("cc-lens 已启动");
    console.log(`  面板     http://127.0.0.1:${cfg.port}/`);
    console.log(`  上游     ${cfg.upstream || "（未配置！代理接口会返回 503，面板不受影响）"}`);
    console.log(`  数据目录 ${cfg.dataDir}`);
    console.log("  客户端配置：Anthropic 地址 http://127.0.0.1:" + cfg.port +
      " ；OpenAI 兼容地址 http://127.0.0.1:" + cfg.port + "/v1");
  });
}

main();
