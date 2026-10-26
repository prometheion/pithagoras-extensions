// A chat model that follows a script, for the real-portal test (real-portal.test.mts): an OpenAI-compatible
// /v1/chat/completions that calls the tools a chat's message lists, one after another, and then answers "Done". The
// message carries its script as `SCRIPT#<id> <<<[{"name": "office_read", "arguments": {...}}, ...]>>>`; each tool result
// pi sends back is written to `<log>` (one JSON line per request), so the test reads what the tools answered.
//
//   node scripted-model.mjs <port> <log>
//
// A plain .mjs with nothing but Node in it: the test runs it beside a portal on the machine, and inside the portal's
// own container for a portal in Docker, where only the portal's own loopback reaches it.
import http from "node:http";
import { appendFileSync } from "node:fs";

const [port, log] = process.argv.slice(2);
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("") : "");

/** What the request asks for: the script of its last message from the person, and the tool results after it. */
function reading(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const found = /SCRIPT#([\w-]+) <<<([\s\S]*?)>>>/.exec(textOf(messages[i].content));
    if (!found) return undefined;
    const results = messages.slice(i + 1).filter((m) => m.role === "tool").map((m) => textOf(m.content));
    return { id: found[1], calls: JSON.parse(found[2]), results };
  }
  return undefined;
}

let n = 0;
const chunk = (delta, finish = null) => ({ id: `scripted-${n}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] });

http
  .createServer(async (req, res) => {
    if (req.method === "GET" && /\/models$/.test(req.url ?? "")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model", owned_by: "test" }] }));
    }
    if (req.method !== "POST" || !/\/chat\/completions$/.test(req.url ?? "")) {
      res.statusCode = 404;
      return res.end();
    }
    let body = "";
    for await (const part of req) body += part;
    const ask = JSON.parse(body);
    n++;
    const script = reading(ask.messages ?? []);
    const step = script && script.results.length < script.calls.length ? script.calls[script.results.length] : undefined;
    appendFileSync(log, `${JSON.stringify({ at: Date.now(), id: script?.id ?? null, results: script?.results ?? [], call: step ?? null, final: !!script && !step, tools: (ask.tools ?? []).map((t) => t.function?.name) })}\n`);
    const deltas = step
      ? [chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }), chunk({}, "tool_calls")]
      : [chunk({ role: "assistant", content: script ? `Done ${script.id}.` : "No script." }), chunk({}, "stop")];
    if (ask.stream === false) {
      res.setHeader("content-type", "application/json");
      const message = step ? { role: "assistant", content: null, tool_calls: deltas[0].choices[0].delta.tool_calls.map(({ index: _i, ...c }) => c) } : { role: "assistant", content: deltas[0].choices[0].delta.content };
      return res.end(JSON.stringify({ id: `scripted-${n}`, object: "chat.completion", model: "scripted", choices: [{ index: 0, message, finish_reason: step ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const d of deltas) res.write(`data: ${JSON.stringify(d)}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`scripted model on 127.0.0.1:${port}`));
