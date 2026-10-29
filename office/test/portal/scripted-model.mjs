// A chat model that follows a script, for the real-portal test (real-portal.test.mts): an OpenAI-compatible
// /v1/chat/completions that calls the tools a chat's message lists, one after another, and then answers "Done". The
// message carries its script as `SCRIPT#<id> <<<[{"name": "office_read", "arguments": {...}}, ...]>>>`; each tool result
// pi sends back is written to `<log>` (one JSON line per request), so the test reads what the tools answered. A script
// may end in `{"say": "<text>"}`, which is then its answer in place of "Done". `SLOW#<ms>` in the message holds the
// script's first answer back that long (a run that is still going while more messages come). Each line also names the
// scripts the chat's earlier messages carried (`seen`, what the model has of the chat's history) and the message's text
// (`prompt`), so the test sees what a chat was given and in which prompt. The pictures a request carries after a tool
// result (pi gives a model that takes images a tool's image parts as a message of the person's right after it, "Attached
// image(s) from tool result:") are written to `<log>.images/<sha256>.<ext>`, and the line names them (`images`, each with
// the number of the tool result it came with), so the test sees the very bytes the model got.
//
//   node scripted-model.mjs <port> <log>
//
// A plain .mjs with nothing but Node in it: the test runs it beside a portal on the machine, and inside the portal's
// own container for a portal in Docker, where only the portal's own loopback reaches it.
import http from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const [port, log] = process.argv.slice(2);
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("") : "");
/** The pictures of a message: `data:` URLs of its image parts. */
const picturesOf = (content) => (Array.isArray(content) ? content.filter((p) => p?.type === "image_url" && typeof p.image_url?.url === "string").map((p) => p.image_url.url) : []);

/** A picture the model was given, kept as a file by its hash: its file, type and size. */
function keep(url) {
  const found = /^data:([\w/+.-]+);base64,(.*)$/s.exec(url);
  if (!found) return { file: null, mimeType: null, bytes: 0 };
  const bytes = Buffer.from(found[2], "base64");
  const dir = `${log}.images`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${createHash("sha256").update(bytes).digest("hex")}.${found[1] === "image/jpeg" ? "jpg" : "bin"}`;
  if (!existsSync(file)) writeFileSync(file, bytes);
  return { file, mimeType: found[1], bytes: bytes.length };
}

/** What the request asks for: the script of its last message from the person, and the tool results after it. */
function reading(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    // A tool result's pictures, which pi gives as a message of the person's: part of the script's run, not a message.
    if (picturesOf(messages[i].content).length && !/SCRIPT#/.test(textOf(messages[i].content))) continue;
    const found = /SCRIPT#([\w-]+) <<<([\s\S]*?)>>>/.exec(textOf(messages[i].content));
    if (!found) return undefined;
    const after = messages.slice(i + 1);
    const results = after.filter((m) => m.role === "tool").map((m) => textOf(m.content));
    // Each picture with the tool result it follows (counted from 0).
    const images = [];
    let tools = 0;
    for (const m of after) {
      if (m.role === "tool") tools++;
      else if (m.role === "user") for (const url of picturesOf(m.content)) images.push({ result: tools - 1, ...keep(url) });
    }
    const seen = messages.filter((m) => m.role === "user").flatMap((m) => [...textOf(m.content).matchAll(/SCRIPT#([\w-]+)/g)].map((x) => x[1]));
    const slow = /SLOW#(\d+)/.exec(textOf(messages[i].content));
    return { id: found[1], calls: JSON.parse(found[2]), results, images, seen, prompt: textOf(messages[i].content).slice(-4000), slow: slow ? Number(slow[1]) : 0 };
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
    const next = script && script.results.length < script.calls.length ? script.calls[script.results.length] : undefined;
    const said = typeof next?.say === "string" ? next.say : undefined;
    const step = said === undefined ? next : undefined;
    appendFileSync(log, `${JSON.stringify({ at: Date.now(), id: script?.id ?? null, results: script?.results ?? [], images: script?.images ?? [], call: step ?? null, final: !!script && !step, tools: (ask.tools ?? []).map((t) => t.function?.name), seen: script?.seen ?? [], prompt: script?.prompt ?? "" })}\n`);
    if (script?.slow && !script.results.length) await new Promise((resolve) => setTimeout(resolve, script.slow));
    const deltas = step
      ? [chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }), chunk({}, "tool_calls")]
      : [chunk({ role: "assistant", content: said ?? (script ? `Done ${script.id}.` : "No script.") }), chunk({}, "stop")];
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
