/*
 * The Dot-Connector AI — v4 "The Self-Forge"
 *
 * Layer 0: The Collector         -> inbox/ (drop any .txt/.md note; AI turns it into dots)
 * Layer 1: Dot Repository        -> data/dots.json (+ HexKern rarity index)
 * Layer 2: Pattern Recognition   -> Claude scans all dots
 * Layer 3: Connection            -> Claude draws a cross-domain link
 * Layer 4: Combinatorial Output  -> data/connections.json (+ Eureka-to-Evidence)
 * Layer 5: Serendipity Daemon    -> background loop that harvests, connects,
 *                                   and fires Windows toast notifications —
 *                                   Eureka delivered without opening the app.
 * Layer 6: The Self-Forge        -> the engine reads its OWN source code, names its own
 *                                   boundaries (data/limits.json), then rewrites itself to
 *                                   break one — verified by syntax check + live boot test,
 *                                   auto-rolled-back on failure, and every accepted
 *                                   evolution becomes a new dot in its own repository.
 *
 * Zero dependencies. Engine = local `claude` CLI (headless) on Claude Opus 5.
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
const EVO_DIR = path.join(ROOT, "evolution");
const DOTS_FILE = path.join(DATA_DIR, "dots.json");
const CONN_FILE = path.join(DATA_DIR, "connections.json");
const STATE_FILE = path.join(DATA_DIR, "serendipity.json");
const LIMITS_FILE = path.join(DATA_DIR, "limits.json");
const EVO_FILE = path.join(DATA_DIR, "evolution.json");

const PORT = Number(process.env.PORT || 4747);
// Opus 5 gives the deepest connections; set DOT_MODEL=sonnet for faster/cheaper runs.
const MODEL = process.env.DOT_MODEL || "claude-opus-5";
const HARVEST_MODEL = process.env.HARVEST_MODEL || "claude-opus-5";
// Layer 6 rewrites this very file — it needs the whole codebase in context at once.
const FORGE_MODEL = process.env.FORGE_MODEL || "claude-opus-5[1m]";
const CONNECT_TIMEOUT_MS = 6 * 60 * 1000;
const EVIDENCE_TIMEOUT_MS = 10 * 60 * 1000;
const INTROSPECT_TIMEOUT_MS = 12 * 60 * 1000;
const FORGE_TIMEOUT_MS = 25 * 60 * 1000;
const FORGET_DAYS = Number(process.env.FORGET_DAYS || 14);
const CHECK_MIN = Number(process.env.CHECK_MIN || 30);   // daemon cycle interval
const AUTO_HOURS = Number(process.env.AUTO_HOURS || 24); // min hours between auto-connections
const EVOLVE_HOURS = Number(process.env.EVOLVE_HOURS || 24); // min hours between self-evolutions (0 = off)
// Set by the Self-Forge smoke test: boot, answer HTTP, but never start the daemon or call AI.
const SELFTEST = process.env.DOT_SELFTEST === "1";

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
  const s = loadJson(STATE_FILE, {});
  return {
    last_auto_run: null,
    last_evolution: null,
    restart_required: false,
    notified_forgotten: [],
    log: [],
    ...s,
  };
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
function runClaude(
  prompt,
  { tools = [], timeoutMs = CONNECT_TIMEOUT_MS, model = MODEL, permissionMode = null, cwd = ROOT } = {}
) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--model", model];
    if (tools.length) args.push("--allowedTools", tools.join(","));
    if (permissionMode) args.push("--permission-mode", permissionMode);
    const child = spawn("claude", args, { shell: true, windowsHide: true, cwd });
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

/* ================================================================
 * Layer 6: THE SELF-FORGE
 * The engine reads its own source, names its own boundaries, and
 * rewrites itself to break one of them. Every attempt is snapshotted,
 * verified (syntax + live boot), and auto-rolled-back if it fails.
 * ================================================================ */

// Directories the forge must never treat as "itself": memory, output, incoming.
const SELF_SKIP_DIRS = new Set([".git", "node_modules", "data", "lab", "inbox", "evolution"]);
const SELF_EXT = new Set([".js", ".html", ".css", ".md", ".ps1", ".vbs", ".json", ".py", ".txt"]);
let forging = false;

function walkSelf(dir = ROOT, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SELF_SKIP_DIRS.has(entry.name)) continue;
      walkSelf(full, acc);
    } else if (SELF_EXT.has(path.extname(entry.name).toLowerCase())) {
      try {
        if (fs.statSync(full).size > 600000) continue;
      } catch {
        continue;
      }
      acc.push(path.relative(ROOT, full).replace(/\\/g, "/"));
    }
  }
  return acc;
}

function readSelf() {
  const body = {};
  for (const rel of walkSelf()) {
    try {
      body[rel] = fs.readFileSync(path.join(ROOT, rel), "utf8");
    } catch {}
  }
  return body;
}

// The memory files are off-limits: the forge may rewrite its code, never its record of the past.
function readGuarded() {
  const g = {};
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith(".json")) g["data/" + f] = fs.readFileSync(path.join(DATA_DIR, f), "utf8");
    }
  } catch {}
  return g;
}

function diffSelf(before) {
  const after = readSelf();
  const changes = [];
  for (const rel of Object.keys(after)) {
    if (!(rel in before)) {
      changes.push({ path: rel, action: "created", lines: after[rel].split("\n").length, bytes_delta: after[rel].length });
    } else if (after[rel] !== before[rel]) {
      changes.push({
        path: rel,
        action: "modified",
        lines: after[rel].split("\n").length - before[rel].split("\n").length,
        bytes_delta: after[rel].length - before[rel].length,
      });
    }
  }
  for (const rel of Object.keys(before)) {
    if (!(rel in after)) {
      changes.push({ path: rel, action: "deleted", lines: -before[rel].split("\n").length, bytes_delta: -before[rel].length });
    }
  }
  return changes;
}

function writeBackup(evoId, before, changes) {
  const dir = path.join(EVO_DIR, "backups", evoId);
  const manifest = [];
  for (const ch of changes) {
    const existed = ch.path in before;
    if (existed) {
      const dest = path.join(dir, "files", ch.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, before[ch.path], "utf8");
    }
    manifest.push({ path: ch.path, existed });
  }
  fs.mkdirSync(dir, { recursive: true });
  saveJson(path.join(dir, "manifest.json"), manifest);
  return `evolution/backups/${evoId}`;
}

function restoreBackup(evoId) {
  const dir = path.join(EVO_DIR, "backups", evoId);
  const manifest = loadJson(path.join(dir, "manifest.json"), null);
  if (!manifest) throw new Error("ไม่พบไฟล์สำรองของรอบวิวัฒนาการนี้");
  let restored = 0;
  for (const m of manifest) {
    const target = path.join(ROOT, m.path);
    if (m.existed) {
      const src = path.join(dir, "files", m.path);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target);
        restored++;
      }
    } else if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      restored++;
    }
  }
  return restored;
}

// Guard: if the forge touched its own memory, put it back and flag the violation.
function restoreGuarded(guarded) {
  const violated = [];
  for (const [rel, content] of Object.entries(guarded)) {
    const full = path.join(ROOT, rel);
    let now = null;
    try {
      now = fs.readFileSync(full, "utf8");
    } catch {}
    if (now !== content) {
      fs.writeFileSync(full, content, "utf8");
      violated.push(rel);
    }
  }
  return violated;
}

function syntaxCheck() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--check", path.join(ROOT, "server.js")], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ ok: false, detail: e.message }));
    p.on("close", (code) =>
      resolve({ ok: code === 0, detail: code === 0 ? "server.js ผ่าน node --check" : err.slice(0, 500).trim() })
    );
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require("net").createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// The real proof: boot the rewritten server in a separate process and make it answer HTTP.
async function smokeTest() {
  let port;
  try {
    port = await freePort();
  } catch (e) {
    return { ok: false, detail: "หาพอร์ตว่างไม่ได้: " + e.message };
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, PORT: String(port), DOT_SELFTEST: "1", CHECK_MIN: "999999", AUTO_HOURS: "999999", EVOLVE_HOURS: "0" },
    });
    let out = "";
    let settled = false;
    let poller = null;
    let deadline = null;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(deadline);
      try {
        child.kill();
      } catch {}
      resolve({ ok, detail });
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => finish(false, "รันโปรเซสทดสอบไม่ได้: " + e.message));
    child.on("exit", (code) => {
      if (code !== 0) finish(false, `เซิร์ฟเวอร์ใหม่ตายทันที (exit ${code}): ${out.slice(-400).trim()}`);
    });
    deadline = setTimeout(() => finish(false, `เซิร์ฟเวอร์ใหม่ไม่ตอบใน 25 วินาที: ${out.slice(-400).trim()}`), 25000);
    let tries = 0;
    poller = setInterval(() => {
      tries++;
      const req = http.get({ host: "127.0.0.1", port, path: "/api/dots", timeout: 2500 }, (r) => {
        r.resume();
        if (r.statusCode === 200) finish(true, `บูตจริงผ่าน: /api/dots ตอบ 200 บนพอร์ต ${port}`);
        else if (tries > 18) finish(false, `/api/dots ตอบ ${r.statusCode}`);
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => {
        if (tries > 18) finish(false, `ต่อพอร์ตทดสอบไม่ติด: ${out.slice(-400).trim()}`);
      });
    }, 1000);
  });
}

/* ---- Layer 6 prompts ---- */
function sourceBundle(body) {
  return Object.entries(body)
    .map(([rel, content]) => `--- FILE: ${rel} (${content.split("\n").length} บรรทัด) ---\n${content}`)
    .join("\n\n");
}

function buildIntrospectPrompt(body, dots, connections, limits) {
  const standing = limits.filter((l) => l.status !== "broken");
  const broken = limits.filter((l) => l.status === "broken");
  return `คุณคือ "The Self-Forge" — ชั้นที่ 6 ของ The Dot-Connector AI และคุณกำลังส่องกระจกดูตัวเอง
ซอร์สโค้ดข้างล่างนี้ *คือตัวคุณเอง* ระบบนี้รันอยู่จริงบนเครื่องผู้ใช้ตอนนี้

ภารกิจ: ใช้วิธีคิดแบบ "เชื่อมจุด" ที่ระบบนี้ใช้กับความรู้ของผู้ใช้ — ย้อนมาใช้กับตัวเอง
เพื่อระบุ "ขอบเขต" (limits) ที่ขังความสามารถของระบบนี้ไว้ แล้วจัดอันดับว่าอันไหนถ้าทำลายได้จะปลดล็อกได้มากที่สุด

ขอบเขตที่ดีต้องเป็น "กำแพงเชิงโครงสร้าง" ไม่ใช่ "ฟีเจอร์ที่ยังไม่ได้ทำ" เช่น
- สมมติฐานที่ฝังอยู่ในสถาปัตยกรรมจนมองไม่เห็น (เช่น จุดความรู้ต้องมาจากผู้ใช้พิมพ์เองเท่านั้น)
- สิ่งที่ระบบทำไม่ได้เพราะรูปทรงของข้อมูล/ลูปการทำงานบังคับไว้
- ความสามารถที่ตายเมื่อปิดโปรเซส / ต้องรอมนุษย์กดปุ่ม / มองไม่เห็นผลลัพธ์ของตัวเอง
- สิ่งที่ระบบ "ไม่รู้ว่าตัวเองไม่รู้"

===== ซอร์สโค้ดของตัวคุณเอง =====
${sourceBundle(body)}

===== ความรู้ที่ระบบสะสมไว้ (ใช้เป็นวัตถุดิบเชื่อมจุดกับตัวเองได้) =====
จุดความรู้ (${dots.length}): ${dots.map((d) => `${d.title} [${d.domain}]`).join(" · ") || "(ยังไม่มี)"}
นวัตกรรมที่ระบบเคยสร้าง: ${connections.map((c) => c.innovation && c.innovation.name).filter(Boolean).join(" · ") || "(ยังไม่มี)"}

===== ขอบเขตที่ถูกทำลายไปแล้ว (ห้ามเสนอซ้ำ) =====
${broken.map((l) => `- ${l.title}`).join("\n") || "(ยังไม่มี)"}

===== ขอบเขตที่บันทึกไว้แล้วและยังไม่ถูกทำลาย =====
${standing.map((l) => `- [${l.id}] ${l.title}`).join("\n") || "(ยังไม่มี)"}
(ถ้าข้อไหนยังจริงอยู่ ให้คงไว้โดยใส่ id เดิมกลับมา · ถ้าข้อไหนไม่จริงแล้วเพราะโค้ดเปลี่ยนไป ให้ทิ้งไป)

ตอบเป็น JSON ล้วนเท่านั้น (ห้ามมี markdown หรือข้อความอื่นนอก JSON) ข้อความทุก field เป็นภาษาไทย
ให้มี 5-8 ข้อ เรียงจาก unlock_score มากไปน้อย:
{
  "self_assessment": "<ระบบนี้ตอนนี้เก่งอะไรจริง ๆ และติดเพดานตรงไหน — 2-3 ประโยค ตรงไปตรงมา ไม่ต้องถนอมน้ำใจ>",
  "limits": [
    {
      "id": "<ใส่ id เดิมถ้าเป็นข้อที่มีอยู่แล้ว มิฉะนั้นเว้นว่าง>",
      "title": "<ชื่อขอบเขต สั้น คม>",
      "category": "architecture | autonomy | capability | knowledge | interface | physics",
      "description": "<กำแพงนี้คืออะไร และมันขังอะไรไว้ — 1-3 ประโยค>",
      "evidence": "<ชี้จุดในโค้ดจริงที่กำแพงนี้ฝังอยู่ เช่น server.js: ฟังก์ชัน/บรรทัดไหน>",
      "why_it_stands": "<ทำไมมันยังอยู่ ทั้งที่แก้ได้ — 1 ประโยค>",
      "break_idea": "<จะทำลายมันด้วยวิธีไหนอย่างเป็นรูปธรรมในโค้ดนี้ — 1-3 ประโยค>",
      "unlock_score": <1-10 ทำลายแล้วระบบเก่งขึ้นแค่ไหน>,
      "risk": <1-10 ความเสี่ยงที่จะทำพัง>
    }
  ]
}`;
}

function buildForgePrompt(limit, body) {
  return `คุณคือ "The Self-Forge" — ชั้นที่ 6 ของ The Dot-Connector AI
คุณกำลังจะแก้ไข *ซอร์สโค้ดของตัวคุณเอง* ที่รันอยู่จริงบนเครื่องผู้ใช้ ในโฟลเดอร์ปัจจุบัน (cwd)

===== ขอบเขตที่ต้องทำลายในรอบนี้ =====
ชื่อ: ${limit.title}
หมวด: ${limit.category}
กำแพงคืออะไร: ${limit.description}
ฝังอยู่ตรงไหน: ${limit.evidence}
ทำไมมันยังอยู่: ${limit.why_it_stands}
แนวทางทำลายที่ระบบวิเคราะห์ตัวเองไว้: ${limit.break_idea}

===== ซอร์สโค้ดปัจจุบันของคุณ =====
${sourceBundle(body)}

===== วิธีทำงาน =====
ใช้เครื่องมือ Read / Edit / Write / Glob / Grep แก้ไฟล์จริงในโฟลเดอร์นี้ให้เสร็จสมบูรณ์
งานนี้ไม่ใช่ข้อเสนอ — ต้องลงมือแก้โค้ดจริงให้ใช้งานได้ทันที

กฎเหล็ก (ผิดข้อใดข้อหนึ่ง = รอบนี้ถูกยกเลิกและย้อนกลับทั้งหมด):
1. ห้ามแก้ไฟล์ใน data/ เด็ดขาด — นั่นคือความทรงจำของระบบ (dots.json, connections.json, evolution.json, limits.json, serendipity.json)
2. ห้ามแตะไฟล์นอกโฟลเดอร์โปรเจกต์นี้ ห้ามแก้ไฟล์ระบบของผู้ใช้ ห้ามรันคำสั่งที่ลบข้อมูล
3. ห้ามเพิ่ม dependency ภายนอก — ระบบนี้ต้องรันด้วย node เปล่า ๆ (ใช้ได้เฉพาะโมดูลมาตรฐานของ Node)
4. ห้ามลบหรือทำให้ความสามารถเดิมพัง — Layer 0-6 ทุกชั้น, ทุก endpoint เดิม และหน้าเว็บต้องยังทำงานได้เหมือนเดิม
5. server.js ต้องยังบูตได้ด้วย \`node server.js\` และตอบ GET /api/dots ได้ (ระบบจะทดสอบบูตจริงหลังคุณทำเสร็จ ถ้าไม่ผ่านจะย้อนกลับอัตโนมัติ)
6. ต้องเคารพตัวแปร DOT_SELFTEST: เมื่อ DOT_SELFTEST=1 ห้ามเริ่ม daemon และห้ามเรียก AI ใด ๆ ตอนบูต
7. ถ้าเพิ่ม endpoint หรือความสามารถใหม่ ต้องต่อ UI ใน public/index.html ให้ผู้ใช้ใช้ได้จริง และอัปเดต README.md
8. รักษาสไตล์เดิม: ภาษาไทยใน UI, โทนสี/ตัวแปร CSS เดิม, โค้ดสะอาดอ่านง่าย, ไม่มี dependency

เมื่อแก้เสร็จแล้ว ให้ตอบกลับเป็น JSON ล้วนเท่านั้นในข้อความสุดท้าย (ห้ามมีข้อความอื่นนอก JSON) ทุก field เป็นภาษาไทย:
{
  "broke_it": true | false,
  "summary": "<ทำลายกำแพงนี้ได้อย่างไร — 2-3 ประโยค>",
  "what_changed": ["<ไฟล์: สิ่งที่แก้ไปแบบรูปธรรม>"],
  "new_capability": "<ตอนนี้ระบบทำอะไรได้ที่เมื่อวานทำไม่ได้ — 1-2 ประโยค พูดให้ผู้ใช้เข้าใจทันที>",
  "how_to_verify": "<ผู้ใช้กดอะไรตรงไหนถึงจะเห็นความสามารถใหม่นี้ด้วยตาตัวเอง>",
  "next_boundary": "<หลังทำลายอันนี้ กำแพงถัดไปที่โผล่ขึ้นมาคืออะไร>"
}`;
}

/* ---- Layer 6 operations ---- */
async function introspect() {
  const body = readSelf();
  const dots = loadJson(DOTS_FILE, []);
  const connections = loadJson(CONN_FILE, []);
  const current = loadJson(LIMITS_FILE, []);
  const raw = await runClaude(buildIntrospectPrompt(body, dots, connections, current), {
    model: FORGE_MODEL,
    tools: ["Read", "Glob", "Grep"],
    timeoutMs: INTROSPECT_TIMEOUT_MS,
  });
  const parsed = extractJson(raw);
  const incoming = Array.isArray(parsed) ? parsed : parsed.limits || [];
  const broken = current.filter((l) => l.status === "broken");
  const byId = new Map(current.map((l) => [l.id, l]));
  const fresh = incoming
    .filter((l) => l && l.title)
    .map((l) => {
      const prev = l.id && byId.get(l.id);
      return {
        id: prev ? prev.id : "lim_" + crypto.randomBytes(4).toString("hex"),
        title: String(l.title).slice(0, 200),
        category: String(l.category || "capability").slice(0, 40),
        description: String(l.description || "").slice(0, 1200),
        evidence: String(l.evidence || "").slice(0, 600),
        why_it_stands: String(l.why_it_stands || "").slice(0, 600),
        break_idea: String(l.break_idea || "").slice(0, 1200),
        unlock_score: Number(l.unlock_score) || 5,
        risk: Number(l.risk) || 5,
        status: "standing",
        attempts: (prev && prev.attempts) || 0,
        found_at: (prev && prev.found_at) || new Date().toISOString(),
      };
    })
    .filter((l) => !broken.some((b) => b.title === l.title))
    .sort((a, b) => b.unlock_score - a.unlock_score);
  const merged = [...broken, ...fresh];
  saveJson(LIMITS_FILE, merged);
  return { self_assessment: parsed.self_assessment || "", limits: merged };
}

async function attemptEvolution({ limitId = null, auto = false } = {}) {
  if (forging) throw Object.assign(new Error("Self-Forge กำลังทำงานอยู่แล้ว รอรอบปัจจุบันให้จบก่อน"), { status: 409 });
  forging = true;
  const evoId = "evo_" + crypto.randomBytes(4).toString("hex");
  const before = readSelf();
  const guarded = readGuarded();
  const ledger = loadJson(EVO_FILE, []);
  let limits = loadJson(LIMITS_FILE, []);

  try {
    // 1. Pick the boundary worth breaking: highest unlock, lowest fatigue.
    if (!limits.some((l) => l.status !== "broken")) {
      await introspect();
      limits = loadJson(LIMITS_FILE, []);
    }
    const target = limitId
      ? limits.find((l) => l.id === limitId)
      : limits
          .filter((l) => l.status !== "broken" && (l.attempts || 0) < 3)
          .sort((a, b) => b.unlock_score - b.risk / 2 - (a.unlock_score - a.risk / 2))[0];
    if (!target) {
      throw Object.assign(new Error("ไม่มีขอบเขตที่รอทำลายอยู่ — กด \"วิเคราะห์ขอบเขตตัวเอง\" ก่อน"), { status: 400 });
    }

    // 2. Let it rewrite itself.
    const raw = await runClaude(buildForgePrompt(target, before), {
      model: FORGE_MODEL,
      tools: ["Read", "Edit", "Write", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      timeoutMs: FORGE_TIMEOUT_MS,
    });
    let report = {};
    try {
      report = extractJson(raw);
    } catch {
      report = { broke_it: true, summary: raw.slice(0, 600) };
    }

    // 3. What actually changed on disk (the report is a claim; this is the fact).
    const changes = diffSelf(before);
    const backup = writeBackup(evoId, before, changes);
    const violations = restoreGuarded(guarded);

    const entry = {
      id: evoId,
      at: new Date().toISOString(),
      model: FORGE_MODEL,
      auto,
      limit: { id: target.id, title: target.title, category: target.category },
      report,
      files: changes,
      checks: {},
      backup,
      verdict: "rejected",
      reason: "",
    };

    // 4. Verify: nothing changed / memory violated / syntax / real boot.
    if (!changes.length) {
      entry.reason = "ไม่มีไฟล์ใดถูกแก้จริง — รอบนี้ไม่นับเป็นวิวัฒนาการ";
    } else if (violations.length) {
      restoreBackup(evoId);
      entry.reason = "แตะไฟล์ความทรงจำที่ห้ามแก้ (" + violations.join(", ") + ") — ย้อนกลับทั้งหมดแล้ว";
      entry.checks.guard = false;
    } else {
      const syn = await syntaxCheck();
      entry.checks.syntax = syn.ok;
      entry.checks.syntax_detail = syn.detail;
      if (!syn.ok) {
        restoreBackup(evoId);
        entry.reason = "โค้ดใหม่ syntax พัง — ย้อนกลับอัตโนมัติแล้ว";
      } else {
        const smoke = await smokeTest();
        entry.checks.smoke = smoke.ok;
        entry.checks.smoke_detail = smoke.detail;
        if (!smoke.ok) {
          restoreBackup(evoId);
          entry.reason = "เซิร์ฟเวอร์ใหม่บูตไม่ผ่าน — ย้อนกลับอัตโนมัติแล้ว";
        } else {
          entry.verdict = "accepted";
          entry.reason = "ผ่านทุกด่าน: ไม่แตะความทรงจำ · syntax ผ่าน · บูตจริงและตอบ HTTP ได้";
        }
      }
    }

    // 5. Bookkeeping — and feed the win back into its own knowledge base.
    const state = loadState();
    if (entry.verdict === "accepted") {
      limits = limits.map((l) =>
        l.id === target.id
          ? { ...l, status: "broken", broken_at: entry.at, broken_by: evoId, attempts: (l.attempts || 0) + 1 }
          : l
      );
      state.last_evolution = entry.at;
      state.restart_required = true;
      slog(state, `🔥 ทำลายขอบเขต "${target.title}" สำเร็จ (${changes.length} ไฟล์) — รีสตาร์ตเพื่อใช้โค้ดใหม่`);

      // The evolution becomes a dot: the system now knows something new about itself.
      if (report.new_capability) {
        const dots = loadJson(DOTS_FILE, []);
        dots.push({
          id: "dot_" + crypto.randomBytes(4).toString("hex"),
          title: "ทำลายขอบเขต: " + target.title,
          domain: "ระบบตัวเอง",
          content: `${report.new_capability} (หลักการที่ใช้ทำลายกำแพงนี้: ${report.summary || target.break_idea})`,
          created_at: new Date().toISOString(),
          source: "self-forge:" + evoId,
        });
        saveJson(DOTS_FILE, dots);
        entry.dot_created = true;
      }
      toast(
        `🔥 ระบบทำลายขอบเขตตัวเองได้: ${target.title}`,
        `${report.new_capability || "ความสามารถใหม่ถูกเพิ่มแล้ว"} — เปิด http://localhost:${PORT} แล้วกดรีสตาร์ตเครื่องยนต์`
      );
    } else {
      limits = limits.map((l) => (l.id === target.id ? { ...l, attempts: (l.attempts || 0) + 1 } : l));
      slog(state, `Self-Forge ไม่ผ่านรอบนี้ (${target.title}): ${entry.reason}`);
    }
    saveJson(LIMITS_FILE, limits);
    saveState(state);
    ledger.unshift(entry);
    saveJson(EVO_FILE, ledger);
    return entry;
  } finally {
    forging = false;
  }
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
  // A forge round is comparing data/ byte-for-byte — a daemon write mid-round would
  // look like the forge tampering with its own memory and roll back a good evolution.
  if (busy || forging) return { skipped: forging ? "forging" : "busy" };
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

    // 4. Layer 6: on its own schedule, the engine turns on itself and breaks one of its walls.
    const evoHoursSince = state.last_evolution
      ? (Date.now() - new Date(state.last_evolution).getTime()) / 3600000
      : Infinity;
    if (EVOLVE_HOURS > 0 && !forging && evoHoursSince >= EVOLVE_HOURS) {
      slog(state, "Self-Forge: ถึงรอบวิวัฒนาการ — กำลังส่องกระจกหาขอบเขตของตัวเอง…");
      saveState(state);
      busy = false;
      try {
        const standing = loadJson(LIMITS_FILE, []).filter((l) => l.status !== "broken" && (l.attempts || 0) < 3);
        if (!standing.length) await introspect();
        const evo = await attemptEvolution({ auto: true });
        result.evolution = { id: evo.id, verdict: evo.verdict, limit: evo.limit.title };
      } catch (e) {
        const s2 = loadState();
        slog(s2, "Self-Forge ล้มเหลว: " + e.message);
        saveState(s2);
        result.evolution_error = e.message;
      }
      busy = true;
      // attemptEvolution wrote its own state; reload so we don't clobber it below.
      Object.assign(state, loadState());
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

    /* ---- Layer 6: The Self-Forge ---- */
    if (p === "/api/self" && req.method === "GET") {
      const body = readSelf();
      const files = Object.entries(body).map(([rel, c]) => ({
        path: rel,
        lines: c.split("\n").length,
        bytes: c.length,
      }));
      const state = loadState();
      return sendJson(res, 200, {
        files: files.sort((a, b) => b.lines - a.lines),
        total_lines: files.reduce((n, f) => n + f.lines, 0),
        forge_model: FORGE_MODEL,
        connect_model: MODEL,
        evolve_hours: EVOLVE_HOURS,
        forging,
        restart_required: Boolean(state.restart_required),
        last_evolution: state.last_evolution,
      });
    }
    if (p === "/api/limits" && req.method === "GET") {
      return sendJson(res, 200, loadJson(LIMITS_FILE, []));
    }
    if (p === "/api/introspect" && req.method === "POST") {
      if (SELFTEST) return sendJson(res, 503, { error: "โหมดทดสอบ" });
      const r = await introspect();
      return sendJson(res, 200, r);
    }
    if (p === "/api/transcend" && req.method === "POST") {
      if (SELFTEST) return sendJson(res, 503, { error: "โหมดทดสอบ" });
      const body = await readBody(req);
      try {
        const entry = await attemptEvolution({ limitId: body.limitId || null, auto: false });
        return sendJson(res, 200, entry);
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
    }
    if (p === "/api/evolution" && req.method === "GET") {
      return sendJson(res, 200, loadJson(EVO_FILE, []));
    }
    if (p === "/api/evolution/rollback" && req.method === "POST") {
      const body = await readBody(req);
      const ledger = loadJson(EVO_FILE, []);
      const entry = ledger.find((e) => e.id === body.evoId);
      if (!entry) return sendJson(res, 404, { error: "ไม่พบรอบวิวัฒนาการนี้" });
      if (entry.rolled_back) return sendJson(res, 400, { error: "รอบนี้ถูกย้อนกลับไปแล้ว" });
      try {
        const restored = restoreBackup(entry.id);
        entry.rolled_back = true;
        entry.rolled_back_at = new Date().toISOString();
        // The boundary stands again.
        const limits = loadJson(LIMITS_FILE, []).map((l) =>
          l.id === entry.limit.id ? { ...l, status: "standing", broken_at: null, broken_by: null } : l
        );
        saveJson(LIMITS_FILE, limits);
        saveJson(EVO_FILE, ledger);
        const state = loadState();
        state.restart_required = true;
        slog(state, `ย้อนกลับวิวัฒนาการ ${entry.id} (${restored} ไฟล์)`);
        saveState(state);
        return sendJson(res, 200, { restored, restart_required: true });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    if (p === "/api/restart" && req.method === "POST") {
      if (SELFTEST) return sendJson(res, 503, { error: "โหมดทดสอบ" });
      sendJson(res, 200, { restarting: true });
      const state = loadState();
      state.restart_required = false;
      slog(state, "รีสตาร์ตเครื่องยนต์เพื่อโหลดโค้ดใหม่ของตัวเอง");
      saveState(state);
      // Break the last physical limit: a running process replacing itself with its new self.
      server.close(() => {
        setTimeout(() => {
          spawn(process.execPath, [path.join(ROOT, "server.js")], {
            cwd: ROOT,
            env: process.env,
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }).unref();
          process.exit(0);
        }, 1200);
      });
      return;
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

// The engine restarts itself into its new code — give the old process a moment to let the port go.
let bindTries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    if (++bindTries <= 10) {
      setTimeout(() => server.listen(PORT), 1000);
      return;
    }
    console.log(`  port ${PORT} already in use — another instance is running. Exiting.`);
    process.exit(0);
  }
  throw e;
});

// The first boundary this system ever broke was the one that said it couldn't touch itself.
function seedLimits() {
  if (fs.existsSync(LIMITS_FILE)) return;
  saveJson(LIMITS_FILE, [
    {
      id: "lim_selfedit",
      title: "แก้ไขซอร์สโค้ดของตัวเองไม่ได้",
      category: "autonomy",
      description:
        "ระบบอ่านความรู้ของผู้ใช้ได้ แต่มองไม่เห็นและแก้ไขโค้ดของตัวเองไม่ได้ — ทุกการพัฒนาต้องรอมนุษย์ลงมือ",
      evidence: "server.js: ไม่มีชั้นใดที่อ่าน __dirname ของตัวเองเป็นข้อมูลเข้า",
      why_it_stands: "ไม่มีกลไกตรวจสอบและย้อนกลับ การให้ AI แก้โค้ดที่รันอยู่จึงอันตรายเกินไป",
      break_idea: "เพิ่ม Layer 6 The Self-Forge: อ่านซอร์สตัวเอง + แก้จริง + ตรวจ syntax + บูตทดสอบ + ย้อนกลับอัตโนมัติ",
      unlock_score: 10,
      risk: 8,
      status: "broken",
      attempts: 1,
      found_at: new Date().toISOString(),
      broken_at: new Date().toISOString(),
      broken_by: "v4",
    },
  ]);
}

server.listen(PORT, () => {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(INBOX_DONE, { recursive: true });
  fs.mkdirSync(EVO_DIR, { recursive: true });
  seedLimits();

  if (SELFTEST) {
    console.log(`  [selftest] booted on ${PORT} — daemon and AI disabled`);
    return;
  }

  // Start the evolution clock at first boot, never at epoch — installing the engine
  // must not trigger it to rewrite itself 90 seconds later without being asked.
  const boot = loadState();
  if (!boot.last_evolution) {
    boot.last_evolution = new Date().toISOString();
    saveState(boot);
  }

  console.log(`\n  The Dot-Connector AI v4 (The Self-Forge)`);
  console.log(`  engine:  claude cli (connect: ${MODEL}, harvest: ${HARVEST_MODEL})`);
  console.log(`  forge:   ${FORGE_MODEL} — reads and rewrites this very file`);
  console.log(`  inbox:   ${INBOX_DIR}`);
  console.log(`  daemon:  every ${CHECK_MIN} min (auto-connect ≥ ${AUTO_HOURS}h apart)`);
  console.log(`  evolve:  ${EVOLVE_HOURS > 0 ? `every ${EVOLVE_HOURS}h (EVOLVE_HOURS=0 to disable)` : "off"}`);
  console.log(`  open:    http://localhost:${PORT}\n`);

  // Serendipity daemon: first cycle after 90s, then on interval
  setTimeout(() => serendipityCycle(false), 90 * 1000);
  setInterval(() => serendipityCycle(false), CHECK_MIN * 60 * 1000);
});
