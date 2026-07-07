import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const UPLOADS = path.join(ROOT, "uploads")
const OUTPUTS = path.join(ROOT, "outputs")
fs.mkdirSync(UPLOADS, { recursive: true })
fs.mkdirSync(OUTPUTS, { recursive: true })

const OC_URL = process.env.OC_URL || "http://127.0.0.1:4098"
const client = createOpencodeClient({ baseUrl: OC_URL })
const un = (r) => (r && r.data !== undefined ? r.data : r)
const [PID, MID] = (process.env.OC_MODEL || "deepseek/deepseek-v4-pro").split("/")
const MODEL = { providerID: PID, modelID: MID }
const PORT = Number(process.env.PORT || 3000)
const listOutputs = () => (fs.existsSync(OUTPUTS) ? fs.readdirSync(OUTPUTS).filter(f => !f.startsWith(".")) : [])
const send = (res, code, type, body) => { res.writeHead(code, { "Content-Type": type }); res.end(body) }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost")
  try {
    if (req.method === "GET" && u.pathname === "/")
      return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(__dirname, "index.html")))

    if (req.method === "POST" && u.pathname === "/api/upload") {
      const name = path.basename(u.searchParams.get("name") || "upload.bin")
      const chunks = []; for await (const c of req) chunks.push(c)
      const dest = path.join(UPLOADS, name); fs.writeFileSync(dest, Buffer.concat(chunks))
      return send(res, 200, "application/json", JSON.stringify({ ok: true, path: `uploads/${name}`, size: fs.statSync(dest).size }))
    }

    if (req.method === "GET" && u.pathname === "/api/files")
      return send(res, 200, "application/json", JSON.stringify(listOutputs()))

    if (req.method === "GET" && u.pathname === "/api/download") {
      const name = path.basename(u.searchParams.get("name") || "")
      const f = path.join(OUTPUTS, name)
      if (!name || !fs.existsSync(f)) return send(res, 404, "text/plain", "not found")
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"` })
      return fs.createReadStream(f).pipe(res)
    }

    if (req.method === "GET" && u.pathname === "/api/chat") {
      const q = u.searchParams.get("q") || ""
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      const sse = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)

      const session = un(await client.session.create({ body: { title: "web" } }))
      sse("session", { id: session.id })

      let done = false
      const events = await client.event.subscribe()
      ;(async () => {
        for await (const e of events.stream) {
          if (done) break
          const p = e?.properties?.part; if (!p) continue
          if (p.sessionID && p.sessionID !== session.id) continue
          if (p.type === "text" && typeof p.text === "string") sse("text", p.text)      // cumulative — browser replaces
          if (p.type === "tool" && p.state?.status) sse("tool", { tool: p.tool, status: p.state.status })
        }
      })().catch(() => {})

      const result = un(await client.session.prompt({
        path: { id: session.id },
        body: { model: MODEL, parts: [{ type: "text", text: q }] },
      }))
      const finalText = (result?.parts ?? []).filter(x => x.type === "text").map(x => x.text).join("\n")
      sse("final", { text: finalText })
      sse("files", listOutputs())
      sse("done", {})
      done = true; res.end()
      return
    }

    send(res, 404, "text/plain", "not found")
  } catch (err) {
    try { send(res, 500, "text/plain", String(err?.stack || err)) } catch {}
  }
})
server.listen(PORT, () => console.log(`gateway on http://localhost:${PORT}  (opencode=${OC_URL}, model=${MODEL.providerID}/${MODEL.modelID})`))
