/*
 * The Dot-Connector AI — v3 "Serendipity Engine"
 *
 * Layer 0: The Collector         -> inbox/ (drop any .txt/.md note; AI turns it into dots)
 * Layer 1: Dot Repository        -> data/dots.json (+ HexKern rarity index)
 * Layer 2: Pattern Recognition   -> Claude scans all dots
 * Layer 3: Connection            -> Claude draws a cross-domain link
 * Layer 4: Combinatorial Output  -> data/connections.json (+ Eureka-to-Evidence)
 * Layer 5: Serendipity Daemon    -> background loop that harvests, connects,
 *                                   and fires Windows toast notifications —
 *                                   Eureka delivered without opening the app.
 *
 * Zero dependencies. Engine = local `claude` CLI (headless).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const LAB_DIR = path.join(ROOT, "lab");
const INBOX_DIR = path.join(ROOT, "inbox");
const INBOX_DONE = path.join(INBOX_DIR, "processed");
const PUBLIC_DIR = path.join(ROOT, "public");
const DOTS_FILE = path.join(DATA_DIR, "dots.json");
const CONN_FILE = path.join(DATA_DIR, "connections.json");
const STATE_FILE = path.join(DATA_DIR, "serendipity.json");

const PORT = Number(process.env.PORT || 4747);
// Fable 5 gives the deepest connections; set DOT_MODEL=sonnet for faster/cheaper runs.
const MODEL = process.env.DOT_MODEL || "claude-fable-5";
// Harvesting notes into dots is mechanical — use a faster model by default.
const HARVEST_MODEL = process.env.HARVEST_MODEL || "sonnet";
const CONNECT_TIMEOUT_MS = 6 * 60 * 1000;
const EVIDENCE_TIMEOUT_MS = 10 * 60 * 1000;
const FORGET_DAYS = Number(process.env.FORGET_DAYS || 14);
const CHECK_MIN = Number(process.env.CHECK_MIN || 30);   // daemon cycle interval
const AUTO_HOURS = Number(process.env.AUTO_HOURS || 24); // min hours between auto-connections

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}
function loadState() {
  return loadJson(STATE_FILE, { last_auto_run: null, notified_forgotten: [], log: [] });
}
function saveState(s) {
  s.log = (s.log || []).slice(-40);
  saveJson(STATE_FILE, s);
}
function slog(state, msg) {
  state.log.push({ at: new Date().toISOString(), msg });
  console.log("  [serendipity]", msg);
}

/* ================= Windows toast notifications ================= */
function toast(title, body) {
  try {
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      '$n = $t.GetElementsByTagName("text")',
      "$null = $n.Item(0).AppendChild($t.CreateTextNode(" + q(title) + "))",
      "$null = $n.Item(1).AppendChild($t.CreateTextNode(" + q(body) + "))",
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($t)",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(" + q("Dot-Connector AI") + ").Show($toast)",
    ].join("\n");
    const b64 = Buffer.from(script, "utf16le").toString("base64");
    spawn("powershell", ["-NoProfile", "-EncodedCommand", b64], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch (e) {
    console.log("  [toast failed]", e.message);
  }
}

/* ================= AI engine (headless Claude) ================= */
function runClaude(prompt, { tools = [], timeoutMs = CONNECT_TIMEOUT_MS, model = MODEL } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--model", model];
    if (tools.length) args.push("--allowedTools", tools.join(","));
    const child = spawn("claude", args, { shell: true, windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("AI engine timed out"));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      out = out.replace(/^﻿/, "").trim();
      if (code !== 0 && !out) {
        return reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      }
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error) {
          return reject(new Error(envelope.result || "Claude returned an error"));
        }
        resolve(String(envelope.result || ""));
      } catch {
        reject(new Error("Could not parse Claude CLI output: " + out.slice(0, 300)));
      }
    });
    child.stdin.write(prompt, "utf8");
    child.stdin.end();
  });
}

function extractJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const objStart = t.indexOf("{");
  const arrStart = t.indexOf("[");
  const useArr = arrStart >= 0 && (objStart < 0 || arrStart < objStart);
  const start = useArr ? arrStart : objStart;
  const end = useArr ? t.lastIndexOf("]") : t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/* ================= HexKern Memory ================= */
function enrichDots(dots, connections) {
  const now = Date.now();
  return dots.map((d) => {
    let uses = 0;
    let lastTouched = new Date(d.created_at || now).getTime();
    for (const c of connections) {
      if ((c.selected_dots || []).some((sd) => sd.id === d.id)) {
        uses++;
        const t = new Date(c.created_at).getTime();
        if (t > lastTouched) lastTouched = t;
      }
    }
    const daysIdle = Math.max(0, Math.floor((now - lastTouched) / 86400000));
    const rarity = Math.round((daysIdle / (1 + uses)) * 100) / 100;
    return {
      ...d,
      uses,
      last_touched: new Date(lastTouched).toISOString(),
      days_idle: daysIdle,
      rarity,
      never_connected: uses === 0,
      forgotten: daysIdle >= FORGET_DAYS,
    };
  });
}

/* ================= Prompts ================= */
function buildConnectPrompt(dots, previousNames, focus, mustInclude) {
  const dotList = dots
    .map(
      (d) =>
        `- id: ${d.id}\n  โดเมน: ${d.domain}\n  ชื่อจุด: ${d.title}\n  รายละเอียด: ${d.content}\n  สถิติ: ถูกเชื่อมแล้ว ${d.uses ?? 0} ครั้ง${d.forgotten ? " (จุดนี้ถูกทิ้งไว้นาน — มีค่าสูงหากปลุกขึ้นมาใช้)" : ""}`
    )
    .join("\n");
  const must = (mustInclude || [])
    .map((id) => dots.find((d) => d.id === id))
    .filter(Boolean);

  return `คุณคือ "The Dot-Connector AI" — เครื่องยนต์เชื่อมจุดข้ามโดเมนตามปรัชญา "Connecting the Dots" ของ Steve Jobs

คุณทำงาน 3 ชั้น:
1. Pattern Recognition: สแกน "จุดความรู้" ทั้งหมดด้านล่าง หาความสัมพันธ์เชิงโครงสร้างที่ซ่อนอยู่ (structural isomorphism) — ไม่ใช่ความคล้ายผิวเผิน
2. Connection: เลือกจุด 2-3 จุดจาก "ต่างโดเมนกัน" ที่มีความเชื่อมโยงที่คาดไม่ถึงแต่มีเหตุผลรองรับแน่นที่สุด ให้ความสำคัญกับจุดที่ถูกเชื่อมน้อยครั้ง (จุดหายาก) มากกว่าจุดที่ถูกใช้บ่อยแล้ว
3. Combinatorial Innovation: สังเคราะห์เป็นแนวคิดนวัตกรรมใหม่ที่ทำได้จริง

คลังจุดความรู้ (Dot Repository):
${dotList}
${must.length ? `\nข้อบังคับ: การเชื่อมครั้งนี้ต้องมีจุดต่อไปนี้อยู่ด้วยเสมอ (Serendipity Revival): ${must.map((d) => `${d.id} (${d.title})`).join(", ")}\n` : ""}
${focus ? `\nโจทย์/คอขวดที่ผู้ใช้อยากปลดล็อก (ให้การเชื่อมจุดมุ่งแก้เรื่องนี้): ${focus}\n` : ""}
${previousNames.length ? `นวัตกรรมที่เคยสร้างไปแล้ว (ห้ามซ้ำแนวเดิม): ${previousNames.join(", ")}` : ""}

ตอบเป็น JSON ล้วนเท่านั้น (ห้ามมี markdown, ห้ามมีข้อความอื่นนอก JSON) ทุก field เป็นภาษาไทย:
{
  "selected_dot_ids": ["<id ของจุดที่เลือก>"],
  "hidden_pattern": "<รูปแบบเชิงโครงสร้างที่ซ่อนอยู่ — 1-2 ประโยค>",
  "connection": "<การลากเส้นเชื่อมข้ามโดเมน: จุดไหนให้อะไร รวมกันปลดล็อกอะไร — 2-4 ประโยค>",
  "innovation": {
    "name": "<ชื่อนวัตกรรม สั้น จำง่าย>",
    "description": "<คืออะไร ทำงานอย่างไร — 2-3 ประโยค>",
    "why_new": "<ทำไมไม่เคยมีมาก่อนทั้งที่ส่วนประกอบมีอยู่แล้ว — 1-2 ประโยค>",
    "first_step": "<ก้าวแรกที่เป็นรูปธรรมที่สุด — 1-2 ประโยค>"
  }
}`;
}

function buildHarvestPrompt(text, existingTitles) {
  return `คุณคือ "The Collector" ของระบบ The Dot-Connector AI — หน้าที่ของคุณคือแปลงบันทึกดิบของผู้ใช้ให้เป็น "จุดความรู้" (dots) ที่พร้อมถูกนำไปเชื่อมข้ามโดเมน

บันทึกดิบ:
"""
${text.slice(0, 6000)}
"""

กติกา:
- สกัดออกมา 1-5 จุด เฉพาะที่มี "โครงสร้าง/หลักการ" ที่เอาไปเชื่อมกับสาขาอื่นได้จริง (ไม่ใช่แค่ข้อเท็จจริงลอยๆ)
- แต่ละจุด: ชื่อกระชับ, โดเมนสาขาที่เหมาะสม, รายละเอียดที่เน้น "หลักการทำงาน" ของสิ่งนั้น 1-3 ประโยค
- ห้ามซ้ำกับจุดที่มีอยู่แล้ว: ${existingTitles.join(", ") || "(ยังไม่มี)"}
- ถ้าบันทึกไม่มีเนื้อหาที่เป็นจุดได้เลย ตอบ []

ตอบเป็น JSON array ล้วนเท่านั้น (ห้ามมี markdown):
[{"title": "<ชื่อจุด>", "domain": "<โดเมน>", "content": "<หลักการ 1-3 ประโยค>"}]`;
}

function buildEvidencePrompt(record) {
  const inv = record.innovation || {};
  return `คุณคือ "Evidence Agent" ของระบบ The Dot-Connector AI — หน้าที่ของคุณคือพิสูจน์ไอเดียด้วยหลักฐานจริง ไม่ใช่ความเห็น

ไอเดียที่ต้องพิสูจน์:
ชื่อ: ${inv.name}
คำอธิบาย: ${inv.description}
เหตุผลที่อ้างว่าใหม่: ${inv.why_new}
ก้าวแรกที่เสนอไว้: ${inv.first_step}
มาจากการเชื่อมจุด: ${(record.selected_dots || []).map((d) => `${d.title} (${d.domain})`).join(" + ")}

ภารกิจ (ทำตามลำดับ):
1. NOVELTY CHECK — ใช้ web search จริงอย่างน้อย 2-3 ครั้ง (ค้นทั้งภาษาอังกฤษและคำสำคัญที่เกี่ยวข้อง) เพื่อหาว่ามีใครในโลกทำสิ่งนี้หรือสิ่งที่ใกล้เคียงแล้วหรือยัง อ้างอิงสิ่งที่เจอจริงเท่านั้น
2. FEASIBILITY — ประเมินความเป็นไปได้จริง ความเสี่ยงใหญ่สุด และวิธีลดความเสี่ยง
3. EXPERIMENT — ออกแบบการทดลองที่เล็กที่สุดที่พิสูจน์สมมติฐานหลักได้ พร้อมเกณฑ์วัดผลชัดเจน
4. PROTOTYPE — เขียนโค้ดต้นแบบที่รันได้จริง 1 ไฟล์ (เลือกภาษา/รูปแบบที่เหมาะที่สุด เช่น หน้าเว็บ simulation, สคริปต์ Python) ที่สาธิตกลไกหัวใจของไอเดียนี้

ตอบเป็น JSON ล้วนเท่านั้น (ห้ามมี markdown นอก JSON) field ข้อความเป็นภาษาไทย ยกเว้นโค้ด:
{
  "novelty": {
    "verdict": "world_first | similar_exists | already_exists",
    "similar_found": [{"name": "<ชื่อสิ่งที่เจอจากการค้นจริง>", "how_close": "<ใกล้เคียงแค่ไหน ต่างตรงไหน>"}],
    "novel_angle": "<มุมที่ยังใหม่จริงของไอเดียนี้ หลังเทียบกับสิ่งที่เจอ>"
  },
  "feasibility": {
    "score": <1-10>,
    "biggest_risk": "<ความเสี่ยงใหญ่สุด>",
    "mitigation": "<วิธีลดความเสี่ยง>"
  },
  "experiment": {
    "design": "<การทดลองเล็กที่สุดที่พิสูจน์ได้>",
    "success_metric": "<เกณฑ์ตัดสินว่าผ่าน>",
    "duration": "<ใช้เวลาเท่าไหร่>"
  },
  "prototype": {
    "filename": "<ชื่อไฟล์ เช่น simulation.html หรือ demo.py>",
    "description": "<โค้ดนี้สาธิตอะไร รันอย่างไร>",
    "code": "<โค้ดเต็ม รันได้จริง>"
  }
}`;
}

/* ================= Core operations (shared by HTTP + daemon) ================= */
let busy = false;

async function performConnection({ focus = "", dotIds = null, mustInclude = [], auto = false } = {}) {
  const allDots = loadJson(DOTS_FILE, []);
  const connections = loadJson(CONN_FILE, []);
  const enriched = enrichDots(allDots, connections);
  const pool =
    Array.isArray(dotIds) && dotIds.length >= 2
      ? enriched.filter((d) => dotIds.includes(d.id) || mustInclude.includes(d.id))
      : enriched;
  if (pool.length < 2) {
    throw Object.assign(new Error("ต้องมีจุดอย่างน้อย 2 จุดในคลังก่อนจึงจะเชื่อมได้"), { status: 400 });
  }
  if (new Set(pool.map((d) => d.domain)).size < 2) {
    throw Object.assign(
      new Error("จุดทั้งหมดอยู่โดเมนเดียวกัน — เพิ่มจุดจากต่างสาขาเพื่อให้เกิดการเชื่อมข้ามโดเมน"),
      { status: 400 }
    );
  }

  const previousNames = connections
    .map((c) => c.innovation && c.innovation.name)
    .filter(Boolean);

  const raw = await runClaude(
    buildConnectPrompt(pool, previousNames, String(focus || "").slice(0, 500), mustInclude)
  );
  let parsed;
  try {
    parsed = extractJson(raw);
  } catch {
    throw Object.assign(new Error("AI ตอบกลับมาในรูปแบบที่อ่านไม่ได้ ลองกดเชื่อมจุดอีกครั้ง"), {
      status: 502,
      raw: raw.slice(0, 1000),
    });
  }

  const record = {
    id: "conn_" + crypto.randomBytes(4).toString("hex"),
    created_at: new Date().toISOString(),
    model: MODEL,
    focus: focus || null,
    auto,
    revived_dots: mustInclude,
    selected_dots: (parsed.selected_dot_ids || [])
      .map((id) => allDots.find((d) => d.id === id))
      .filter(Boolean),
    hidden_pattern: parsed.hidden_pattern || "",
    connection: parsed.connection || "",
    innovation: parsed.innovation || {},
    evidence: null,
  };
  const fresh = loadJson(CONN_FILE, []);
  fresh.unshift(record);
  saveJson(CONN_FILE, fresh);
  return record;
}

async function harvestText(text, source) {
  const dots = loadJson(DOTS_FILE, []);
  const existingTitles = dots.map((d) => d.title);
  const raw = await runClaude(buildHarvestPrompt(text, existingTitles), {
    model: HARVEST_MODEL,
    timeoutMs: 3 * 60 * 1000,
  });
  let parsed;
  try {
    parsed = extractJson(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const lower = new Set(existingTitles.map((t) => t.toLowerCase().trim()));
  const created = [];
  for (const item of parsed.slice(0, 5)) {
    if (!item || !item.title || !item.domain) continue;
    if (lower.has(String(item.title).toLowerCase().trim())) continue;
    const dot = {
      id: "dot_" + crypto.randomBytes(4).toString("hex"),
      title: String(item.title).slice(0, 200),
      domain: String(item.domain).slice(0, 100),
      content: String(item.content || "").slice(0, 2000),
      created_at: new Date().toISOString(),
      source: source || "capture",
    };
    dots.push(dot);
    created.push(dot);
    lower.add(dot.title.toLowerCase().trim());
  }
  if (created.length) saveJson(DOTS_FILE, dots);
  return created;
}

/* ================= Layer 0 + 5: Serendipity Engine ================= */
async function processInbox(state) {
  fs.mkdirSync(INBOX_DONE, { recursive: true });
  const files = fs
    .readdirSync(INBOX_DIR)
    .filter((f) => /\.(txt|md)$/i.test(f) && fs.statSync(path.join(INBOX_DIR, f)).isFile());
  const harvested = [];
  for (const f of files) {
    const full = path.join(INBOX_DIR, f);
    try {
      const text = fs.readFileSync(full, "utf8").replace(/^﻿/, "");
      if (text.trim()) {
        const created = await harvestText(text, "inbox:" + f);
        harvested.push(...created);
        slog(state, `เก็บเกี่ยว "${f}" → ได้จุดใหม่ ${created.length} จุด${created.length ? ": " + created.map((d) => d.title).join(", ") : ""}`);
      }
      const dest = path.join(INBOX_DONE, Date.now() + "_" + f);
      fs.renameSync(full, dest);
    } catch (e) {
      slog(state, `อ่านไฟล์ "${f}" ไม่สำเร็จ: ${e.message}`);
    }
  }
  return harvested;
}

async function serendipityCycle(forceConnect = false) {
  if (busy) return { skipped: "busy" };
  busy = true;
  const state = loadState();
  const result = { harvested: 0, connected: false, notified_forgotten: 0 };
  try {
    // 1. Layer 0: harvest new dots from the inbox
    const harvested = await processInbox(state);
    result.harvested = harvested.length;

    // 2. Loss-aversion notifications for dots about to be forgotten
    const enriched = enrichDots(loadJson(DOTS_FILE, []), loadJson(CONN_FILE, []));
    const forgotten = enriched.filter((d) => d.forgotten).sort((a, b) => b.rarity - a.rarity);
    const newForgotten = forgotten.filter((d) => !state.notified_forgotten.includes(d.id));
    if (newForgotten.length) {
      toast(
        "💤 จุดความรู้กำลังจะถูกลืม",
        newForgotten.slice(0, 3).map((d) => d.title).join(", ") +
          ` — เปิด http://localhost:${PORT} เพื่อปลุกมัน`
      );
      state.notified_forgotten.push(...newForgotten.map((d) => d.id));
      result.notified_forgotten = newForgotten.length;
      slog(state, `แจ้งเตือนจุดที่กำลังจะถูกลืม ${newForgotten.length} จุด`);
    }

    // 3. Decide whether to auto-connect
    const hoursSince = state.last_auto_run
      ? (Date.now() - new Date(state.last_auto_run).getTime()) / 3600000
      : Infinity;
    const shouldConnect =
      forceConnect ||
      harvested.length > 0 ||
      (forgotten.length > 0 && hoursSince >= AUTO_HOURS);

    if (shouldConnect && enriched.length >= 2) {
      const seed = harvested.length
        ? harvested[harvested.length - 1].id
        : forgotten.length
          ? forgotten[0].id
          : null;
      slog(state, `เริ่มเชื่อมจุดอัตโนมัติ${seed ? ` (จุดตั้งต้น: ${seed})` : ""}…`);
      busy = false; // performConnection guards itself via the HTTP layer; allow it here
      const record = await performConnection({
        mustInclude: seed ? [seed] : [],
        auto: true,
      });
      busy = true;
      state.last_auto_run = new Date().toISOString();
      result.connected = true;
      result.connection = { id: record.id, name: record.innovation?.name };
      const dotNames = (record.selected_dots || []).map((d) => d.title).join(" + ");
      slog(state, `Eureka! "${record.innovation?.name}" จาก ${dotNames}`);
      toast(
        `💡 Eureka! ${record.innovation?.name || "การเชื่อมใหม่"}`,
        `${dotNames} — เปิด http://localhost:${PORT} เพื่อดูและพิสูจน์`
      );
    }
  } catch (e) {
    slog(state, "รอบนี้ผิดพลาด: " + e.message);
    result.error = e.message;
  } finally {
    saveState(state);
    busy = false;
  }
  return result;
}

/* ================= HTTP helpers ================= */
function sendJson(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/* ================= Server ================= */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    /* ---- Layer 1 + HexKern ---- */
    if (p === "/api/dots" && req.method === "GET") {
      const dots = loadJson(DOTS_FILE, []);
      const conns = loadJson(CONN_FILE, []);
      return sendJson(res, 200, enrichDots(dots, conns));
    }
    if (p === "/api/dots" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.title || !body.domain) {
        return sendJson(res, 400, { error: "ต้องมี title และ domain" });
      }
      const dots = loadJson(DOTS_FILE, []);
      const dot = {
        id: "dot_" + crypto.randomBytes(4).toString("hex"),
        title: String(body.title).slice(0, 200),
        domain: String(body.domain).slice(0, 100),
        content: String(body.content || "").slice(0, 2000),
        created_at: new Date().toISOString(),
      };
      dots.push(dot);
      saveJson(DOTS_FILE, dots);
      return sendJson(res, 201, dot);
    }
    if (p.startsWith("/api/dots/") && req.method === "DELETE") {
      const id = p.split("/").pop();
      const dots = loadJson(DOTS_FILE, []);
      const next = dots.filter((d) => d.id !== id);
      saveJson(DOTS_FILE, next);
      return sendJson(res, 200, { deleted: dots.length - next.length });
    }

    /* ---- Layer 0: quick capture (free text -> dots) ---- */
    if (p === "/api/capture" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.text || !String(body.text).trim()) {
        return sendJson(res, 400, { error: "ต้องมี text" });
      }
      const created = await harvestText(String(body.text), "capture");
      return sendJson(res, 200, { created });
    }

    /* ---- Serendipity ---- */
    if (p === "/api/forgotten" && req.method === "GET") {
      const dots = enrichDots(loadJson(DOTS_FILE, []), loadJson(CONN_FILE, []));
      const forgotten = dots
        .filter((d) => d.forgotten)
        .sort((a, b) => b.rarity - a.rarity)
        .slice(0, 5);
      return sendJson(res, 200, forgotten);
    }
    if (p === "/api/serendipity/status" && req.method === "GET") {
      const state = loadState();
      let inboxPending = 0;
      try {
        inboxPending = fs.readdirSync(INBOX_DIR).filter((f) => /\.(txt|md)$/i.test(f)).length;
      } catch {}
      return sendJson(res, 200, {
        last_auto_run: state.last_auto_run,
        inbox_pending: inboxPending,
        check_interval_min: CHECK_MIN,
        busy,
        log: state.log.slice(-10),
      });
    }
    if (p === "/api/serendipity/scan" && req.method === "POST") {
      const body = await readBody(req);
      const result = await serendipityCycle(Boolean(body.forceConnect));
      return sendJson(res, 200, result);
    }

    /* ---- Layer 4 history ---- */
    if (p === "/api/connections" && req.method === "GET") {
      return sendJson(res, 200, loadJson(CONN_FILE, []));
    }

    /* ---- Layers 2+3 ---- */
    if (p === "/api/connect" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const record = await performConnection({
          focus: body.focus,
          dotIds: Array.isArray(body.dotIds) ? body.dotIds : null,
          mustInclude: Array.isArray(body.mustInclude) ? body.mustInclude : [],
          auto: false,
        });
        return sendJson(res, 200, record);
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message, raw: e.raw });
      }
    }

    /* ---- Eureka-to-Evidence ---- */
    if (p === "/api/evidence" && req.method === "POST") {
      const body = await readBody(req);
      const connections = loadJson(CONN_FILE, []);
      const record = connections.find((c) => c.id === body.connectionId);
      if (!record) return sendJson(res, 404, { error: "ไม่พบการเชื่อมนี้" });

      const raw = await runClaude(buildEvidencePrompt(record), {
        tools: ["WebSearch", "WebFetch"],
        timeoutMs: EVIDENCE_TIMEOUT_MS,
      });
      let ev;
      try {
        ev = extractJson(raw);
      } catch {
        return sendJson(res, 502, {
          error: "Evidence Agent ตอบกลับมาในรูปแบบที่อ่านไม่ได้ ลองอีกครั้ง",
          raw: raw.slice(0, 1000),
        });
      }

      let protoPath = null;
      if (ev.prototype && ev.prototype.code && ev.prototype.filename) {
        const safe = path.basename(String(ev.prototype.filename));
        const dir = path.join(LAB_DIR, record.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, safe), ev.prototype.code, "utf8");
        protoPath = `lab/${record.id}/${safe}`;
      }
      record.evidence = {
        created_at: new Date().toISOString(),
        novelty: ev.novelty || null,
        feasibility: ev.feasibility || null,
        experiment: ev.experiment || null,
        prototype: ev.prototype
          ? {
              filename: ev.prototype.filename,
              description: ev.prototype.description,
              path: protoPath,
              code: ev.prototype.code,
            }
          : null,
      };
      saveJson(CONN_FILE, connections);
      return sendJson(res, 200, record);
    }

    /* ---- serve prototype files ---- */
    if (p.startsWith("/lab/") && req.method === "GET") {
      const full = path.join(ROOT, path.normalize(p).replace(/^[\\/]+/, ""));
      if (full.startsWith(LAB_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        const ext = path.extname(full);
        const mime =
          { ".html": "text/html", ".js": "text/javascript", ".py": "text/plain", ".css": "text/css" }[ext] || "text/plain";
        res.writeHead(200, { "Content-Type": mime + "; charset=utf-8" });
        return res.end(fs.readFileSync(full));
      }
    }

    /* ---- static ---- */
    if (req.method === "GET") {
      const file = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const full = path.join(PUBLIC_DIR, path.normalize(file));
      if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        const ext = path.extname(full);
        const mime =
          { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime + "; charset=utf-8" });
        return res.end(fs.readFileSync(full));
      }
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`  port ${PORT} already in use — another instance is running. Exiting.`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, () => {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(INBOX_DONE, { recursive: true });
  console.log(`\n  The Dot-Connector AI v3 (Serendipity Engine)`);
  console.log(`  engine:  claude cli (connect: ${MODEL}, harvest: ${HARVEST_MODEL})`);
  console.log(`  inbox:   ${INBOX_DIR}`);
  console.log(`  daemon:  every ${CHECK_MIN} min (auto-connect ≥ ${AUTO_HOURS}h apart)`);
  console.log(`  open:    http://localhost:${PORT}\n`);

  // Serendipity daemon: first cycle after 90s, then on interval
  setTimeout(() => serendipityCycle(false), 90 * 1000);
  setInterval(() => serendipityCycle(false), CHECK_MIN * 60 * 1000);
});
