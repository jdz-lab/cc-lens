// OpenAI Chat Completions ↔ Anthropic Messages 双向转换
// 请求侧：OpenAI 格式转成 Anthropic 格式（指纹注入由 fingerprint 在其后处理）
// 响应侧：Anthropic 响应 / SSE 流转回 OpenAI 格式

// ---------- 请求转换 ----------

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p.type === "text" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function mergeConsecutive(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = last.content.concat(m.content);
    else out.push({ role: m.role, content: [...m.content] });
  }
  return out;
}

// OpenAI /v1/chat/completions 请求体 → Anthropic /v1/messages 请求体
function toAnthropic(oai) {
  const sys = [];
  const msgs = [];
  for (const m of oai.messages || []) {
    if (m.role === "system" || m.role === "developer") {
      const t = contentToText(m.content);
      if (t) sys.push(t);
    } else if (m.role === "user") {
      msgs.push({ role: "user", content: [{ type: "text", text: contentToText(m.content) }] });
    } else if (m.role === "assistant") {
      const blocks = [];
      const t = contentToText(m.content);
      if (t) blocks.push({ type: "text", text: t });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try {
          input = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          /* 非法参数按空对象处理 */
        }
        blocks.push({ type: "tool_use", id: tc.id || "toolu_" + Math.random().toString(36).slice(2), name: tc.function?.name || "", input });
      }
      msgs.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
    } else if (m.role === "tool") {
      msgs.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id || "toolu_unknown",
            content: contentToText(m.content),
          },
        ],
      });
    }
  }
  const body = {
    model: oai.model,
    max_tokens: oai.max_tokens || oai.max_completion_tokens || 8192,
    messages: mergeConsecutive(msgs),
  };
  if (sys.length) body.system = sys.join("\n\n");
  if (oai.stream) body.stream = true;
  if (oai.temperature != null) body.temperature = oai.temperature;
  if (oai.top_p != null) body.top_p = oai.top_p;
  if (Array.isArray(oai.tools) && oai.tools.length) {
    body.tools = oai.tools.map((t) => ({
      name: t.function?.name || "",
      description: t.function?.description || "",
      input_schema: t.function?.parameters || { type: "object", properties: {} },
    }));
  }
  const tc = oai.tool_choice;
  if (tc === "auto") body.tool_choice = { type: "auto" };
  else if (tc === "required") body.tool_choice = { type: "any" };
  else if (tc && typeof tc === "object" && tc.function?.name) body.tool_choice = { type: "tool", name: tc.function.name };
  return body;
}

// ---------- 响应转换 ----------

function mapStop(reason) {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return "stop";
}

function baseChunk(model, id, partial) {
  return {
    id: "chatcmpl-" + (id || Math.random().toString(36).slice(2)),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, ...partial }],
  };
}

// Anthropic 非流式响应 → OpenAI 响应体
function toOpenAI(resp) {
  let text = "";
  const toolCalls = [];
  for (const b of resp.content || []) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use")
      toolCalls.push({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      });
  }
  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: "chatcmpl-" + (resp.id || Math.random().toString(36).slice(2)),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [{ index: 0, message, finish_reason: mapStop(resp.stop_reason) }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens || 0,
      completion_tokens: resp.usage?.output_tokens || 0,
      total_tokens: (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0),
    },
  };
}

// Anthropic SSE 事件流 → OpenAI chunk 流的状态机
class StreamTransformer {
  constructor(model) {
    this.model = model;
    this.toolCount = 0;
    this.finishReason = null;
    this.usage = { prompt_tokens: 0, completion_tokens: 0 };
    this.started = false;
  }
  // 传入一个 Anthropic SSE 事件对象，返回要写出的 OpenAI chunk 字符串数组
  transform(evt) {
    const out = [];
    const type = evt.type;
    if (type === "message_start") {
      this.started = true;
      const u = evt.message?.usage || {};
      this.usage.prompt_tokens = u.input_tokens || 0;
      out.push(sse(baseChunk(this.model, evt.message?.id, { delta: { role: "assistant", content: "" } })));
    } else if (type === "content_block_start" && evt.content_block?.type === "tool_use") {
      const idx = this.toolCount++;
      out.push(
        sse(
          baseChunk(this.model, null, {
            delta: {
              tool_calls: [
                {
                  index: idx,
                  id: evt.content_block.id,
                  type: "function",
                  function: { name: evt.content_block.name, arguments: "" },
                },
              ],
            },
          })
        )
      );
    } else if (type === "content_block_delta") {
      const d = evt.delta || {};
      if (d.type === "text_delta") {
        out.push(sse(baseChunk(this.model, null, { delta: { content: d.text } })));
      } else if (d.type === "input_json_delta") {
        out.push(
          sse(
            baseChunk(this.model, null, {
              delta: { tool_calls: [{ index: this.toolCount - 1, function: { arguments: d.partial_json || "" } }] },
            })
          )
        );
      }
      // thinking_delta 等其余增量：OpenAI 格式无对应概念，丢弃
    } else if (type === "message_delta") {
      if (evt.delta?.stop_reason) this.finishReason = mapStop(evt.delta.stop_reason);
      if (evt.usage?.output_tokens != null) this.usage.completion_tokens = evt.usage.output_tokens;
    } else if (type === "message_stop") {
      out.push(
        sse(baseChunk(this.model, null, { delta: {}, finish_reason: this.finishReason || "stop" }))
      );
      out.push("data: [DONE]\n\n");
    }
    return out;
  }
  usageInfo() {
    return { in: this.usage.prompt_tokens, out: this.usage.completion_tokens };
  }
}

function sse(obj) {
  return "data: " + JSON.stringify(obj) + "\n\n";
}

module.exports = { toAnthropic, toOpenAI, StreamTransformer, mapStop };
