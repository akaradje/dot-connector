/*
 * The Dot-Connector AI — v4 "The Self-Forge"
 *
 * Layer 0   The Collector      inbox/ + /api/capture — raw notes become dots
 * Layer 1   Dot Repository     data/dots.json + HexKern rarity index
 * Layer 2-3 Pattern + Connect  Claude finds structural isomorphism across domains
 * Layer 4   Innovation         data/connections.json + Eureka-to-Evidence
 * Layer 4.5 The Return Path    real outcomes score the dots that produced them, so
 *                              attention ranks by proven value, not idle time
 * Layer 5   Serendipity Daemon background harvest/connect/toast loop
 * Layer 6   The Self-Forge     the engine rewrites its own source. Fitness is not
 *                              "it still boots": every round ships an executable proof
 *                              that PASSES on new code and FAILS on old, with every
 *                              pre-existing endpoint still 200. Else: rolled back.
 * Layer 6.5 Scar Tissue        a rejected round's code and failed gate are kept and fed
 *                              to the next attempt; the 3-try cap becomes an earned budget
 * Layer 6.6 The Consolidator   the inverse round: proof must pass on BOTH trees and the
 *                              size metrics must fall (see consolidationVerdict)
 * Layer 7   The Scout          knowledge stops being one-way — evidence finds become dots
 *                              and the engine searches the web for its own blind spots
 *
 * Architecture and rationale for each layer live in README.md.
 * Zero dependencies. Engine = local `claude` CLI (headless) on Claude Opus 5.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const LAB_DIR = path.join(ROOT, "lab");
const INBOX_DIR = path.join(ROOT, "inbox");
const INBOX_DONE = path.join(INBOX_DIR, "processed");
const PUBLIC_DIR = path.join(ROOT, "public");
const EVO_DIR = path.join(ROOT, "evolution");
// Layer 6: every evolution must ship an executable proof of its own new capability.
const PROOF_DIR = path.join(ROOT, "selftest");
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
// Each accepted round makes the source longer, so each next round takes longer to write.
// 25 min was already too short at ~3k lines — keep this ahead of the engine's own growth.
const FORGE_TIMEOUT_MS = Number(process.env.FORGE_TIMEOUT_MIN || 45) * 60 * 1000;
const PROOF_TIMEOUT_MS = 90 * 1000;
// Every endpoint that existed before an evolution must still answer 200 after it.
// This list is written by hand and only ever grew — see Layer 6.6: a consolidation round
// can now retire a path from the *effective* sweep, but only after the live usage ledger
// certifies that nothing has called it since tracking began. The declaration below stays
// the historical record; effectiveRegressionEndpoints() is what actually gets swept.
const REGRESSION_ENDPOINTS = [
  "/api/dots",
  "/api/connections",
  "/api/limits",
  "/api/self",
  "/api/evolution",
  "/api/forgotten",
  "/api/serendipity/status",
  "/api/lessons",
  "/api/forge/preview",
  "/api/evolution/attempted",
  "/api/scout/status",
  "/api/scout/candidates",
  "/api/scout/gaps",
  "/api/consolidation/preview",
  "/api/endpoints",
];
// Layer 6.6: both ledgers live outside data/ on purpose. data/*.json is compared
// byte-for-byte after every forge round, so an ordinary HTTP request arriving while the
// forge is running would otherwise look like the forge tampering with its own memory.
const USAGE_FILE = path.join(EVO_DIR, "endpoint-usage.json");
const DEPRECATED_FILE = path.join(EVO_DIR, "deprecations.json");
// How many accepted expansion rounds may pile up before the engine owes itself a
// consolidation round (0 = never schedule one automatically; the button still works).
const CONSOLIDATE_EVERY = Number(process.env.CONSOLIDATE_EVERY || 3);
// Upper bound on how many proof files one consolidation round re-runs against both trees.
const CONSOLIDATE_SUITE_MAX = Number(process.env.CONSOLIDATE_SUITE_MAX || 8);
const FORGET_DAYS = Number(process.env.FORGET_DAYS || 14);
const CHECK_MIN = Number(process.env.CHECK_MIN || 30);   // daemon cycle interval
const AUTO_HOURS = Number(process.env.AUTO_HOURS || 24); // min hours between auto-connections
const EVOLVE_HOURS = Number(process.env.EVOLVE_HOURS || 24); // min hours between self-evolutions (0 = off)
// Layer 7: how often the engine may go out and search the web for itself (0 = off).
const SCOUT_HOURS = Number(process.env.SCOUT_HOURS || 12);
const SCOUT_MODEL = process.env.SCOUT_MODEL || HARVEST_MODEL;
const SCOUT_TIMEOUT_MS = 8 * 60 * 1000;
const SCOUT_MAX_PER_RUN = Number(process.env.SCOUT_MAX || 4);
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
    // Layer 6.6: the last round that made the engine smaller instead of bigger.
    last_consolidation: null,
    restart_required: false,
    notified_forgotten: [],
    log: [],
    // Layer 7: what the Scout has fetched on its own, and what the owner has vetoed.
    scout: {},
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

/* ================= HexKern Memory + the return path =================
 * Ranking attention by rarity alone — daysIdle / (1 + uses) — measures a clock, not a
 * result: a dot that produced five dead ends still climbed by sitting still. Now each
 * connection can carry a real outcome (novelty verdict + what the user did with it) that
 * flows *back* onto the dots behind it. Rarity is the base; proven value bends it. This
 * is the only signal that lets the 100th connection beat the first.
 */
const VERDICT_WEIGHT = { world_first: 1, similar_exists: 0.25, already_exists: -1 };
// What the user did with the idea after the AI handed it over — the ground truth.
const OUTCOME_STATUS = { shipped: 1, testing: 0.4, parked: -0.2, dead: -1 };
const OUTCOME_LABEL = {
  shipped: "เอาไปทำจริงแล้ว",
  testing: "กำลังทดลองอยู่",
  parked: "พักไว้ก่อน",
  dead: "ตายแล้ว",
};

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
function round2(x) {
  return Math.round(x * 100) / 100;
}

// Fold one connection's real-world result into a single signal in [-1, 1].
// The user's own verdict outweighs the Evidence Agent's: they lived the result.
// Returns null when nothing has ever come back — silence is not a bad review.
function connectionSignal(c) {
  const parts = [];
  const verdict = c && c.evidence && c.evidence.novelty && c.evidence.novelty.verdict;
  const vw = VERDICT_WEIGHT[verdict];
  if (Number.isFinite(vw)) parts.push({ w: 1, v: vw });
  const o = c && c.outcome;
  if (o) {
    const sw = OUTCOME_STATUS[o.status];
    if (Number.isFinite(sw)) parts.push({ w: 2, v: sw });
    const rating = Number(o.rating);
    if (Number.isFinite(rating) && rating >= 1 && rating <= 5) parts.push({ w: 2, v: (rating - 3) / 2 });
  }
  if (!parts.length) return null;
  const wsum = parts.reduce((n, p) => n + p.w, 0);
  return clamp(parts.reduce((n, p) => n + p.w * p.v, 0) / wsum, -1, 1);
}

/* Layer 7: every dot now says where it came from. Four origins, one rule — anything the
 * system fetched for itself is labelled as such and can be vetoed by the owner. */
const ORIGIN = { human: "human", evidence: "scout:evidence", web: "scout:web", forge: "self-forge" };
const ORIGIN_LABEL = {
  human: "👤 เจ้าของเพิ่มเอง",
  "scout:evidence": "🧪 The Scout เก็บจากหลักฐานที่เคยค้นเจอ",
  "scout:web": "🌐 The Scout ออกไปค้นเว็บมาเอง",
  "self-forge": "🔥 ระบบได้มาจากการทำลายกำแพงตัวเอง",
};
function originOf(dot) {
  if (dot && dot.origin && ORIGIN_LABEL[dot.origin]) return dot.origin;
  const s = String((dot && dot.source) || "");
  if (s.startsWith("self-forge:")) return ORIGIN.forge;
  if (s.startsWith("evidence:")) return ORIGIN.evidence;
  if (s.startsWith("web:")) return ORIGIN.web;
  return ORIGIN.human;
}

function enrichDots(dots, connections) {
  const now = Date.now();
  return dots.map((d) => {
    let uses = 0;
    let lastTouched = new Date(d.created_at || now).getTime();
    const signals = [];
    for (const c of connections) {
      if ((c.selected_dots || []).some((sd) => sd.id === d.id)) {
        uses++;
        const t = new Date(c.created_at).getTime();
        if (t > lastTouched) lastTouched = t;
        const s = connectionSignal(c);
        if (s !== null) signals.push(s);
      }
    }
    const daysIdle = Math.max(0, Math.floor((now - lastTouched) / 86400000));
    const rarity = Math.round((daysIdle / (1 + uses)) * 100) / 100;
    // The dot's own track record: mean outcome of every connection it took part in.
    const valueScore = signals.length ? round2(signals.reduce((a, b) => a + b, 0) / signals.length) : 0;
    // Attention = rarity bent by proof. A dot whose every idea died falls to 0 however
    // long it has been idle; a dot that produced a world-first stays in view even when
    // it was just used. With no feedback yet, valueScore is 0 and the old order holds.
    const attention = round2((rarity + 1) * (1 + valueScore));
    // Layer 7: where this dot came from. Old dots carry no origin field — it is derived
    // from their source, so the whole repository is labelled without rewriting memory.
    const origin = originOf(d);
    return {
      ...d,
      origin,
      origin_label: ORIGIN_LABEL[origin] || origin,
      self_sourced: origin === ORIGIN.evidence || origin === ORIGIN.web,
      uses,
      last_touched: new Date(lastTouched).toISOString(),
      days_idle: daysIdle,
      rarity,
      value_score: valueScore,
      rated_uses: signals.length,
      attention_score: attention,
      proven: valueScore >= 0.34 && signals.length > 0,
      dead_end: valueScore <= -0.34 && signals.length > 0,
      never_connected: uses === 0,
      forgotten: daysIdle >= FORGET_DAYS,
    };
  });
}

/* The same return path, in words. Instead of shipping the next round a blacklist of
 * old names (a purely negative signal), it ships what actually happened: which
 * directions produced something real, which ones died, and why. */
function lessonLine(c, signal) {
  const inv = c.innovation || {};
  const verdict = c.evidence && c.evidence.novelty && c.evidence.novelty.verdict;
  const bits = [];
  if (verdict === "world_first") bits.push("ค้นแล้วยังไม่มีใครในโลกทำ");
  if (verdict === "similar_exists") bits.push("มีของใกล้เคียงอยู่แล้ว มุมที่เหลือแคบ");
  if (verdict === "already_exists") bits.push("ค้นแล้วมีคนทำไปแล้ว");
  if (c.outcome) {
    bits.push(`ผู้ใช้ให้ ${c.outcome.rating}/5 · ${OUTCOME_LABEL[c.outcome.status] || c.outcome.status}`);
    if (c.outcome.note) bits.push(`"${String(c.outcome.note).slice(0, 220)}"`);
  }
  if (signal === null) return "ยังไม่มีผลลัพธ์ตอบกลับ — ยังตัดสินไม่ได้ว่าทิศทางนี้ดีหรือไม่";
  const head = signal >= 0.34 ? "ได้ผลจริง" : signal <= -0.34 ? "ทางตัน" : "กลาง ๆ";
  return `${head}: ${bits.join(" · ")}${inv.why_new ? " · เหตุผลที่เคยอ้างว่าใหม่: " + String(inv.why_new).slice(0, 160) : ""}`;
}

function buildLessons(connections, limit = 8) {
  return connections.slice(0, limit).map((c) => {
    const signal = connectionSignal(c);
    return {
      id: c.id,
      name: (c.innovation && c.innovation.name) || "(ไม่มีชื่อ)",
      created_at: c.created_at,
      verdict: (c.evidence && c.evidence.novelty && c.evidence.novelty.verdict) || null,
      outcome: c.outcome || null,
      signal: signal === null ? null : round2(signal),
      dots: (c.selected_dots || []).map((d) => d.title),
      lesson: lessonLine(c, signal),
    };
  });
}

/* ================= Layer 7: THE SCOUT =================
 * Knowledge used to enter only through a human act (inbox/ or /api/capture), even though
 * the Evidence Agent web-searched on every proof round and buried what it found in
 * connections.json as a footnote nothing ever read again.
 *   · harvestEvidenceDots() promotes every similar_found into a real dot, tagged
 *     origin=scout:evidence / source=evidence:<connId>. No AI, no network, idempotent.
 *   · scoutGaps() names the domains the census has no representative in and writes a
 *     query for each; scoutWeb() goes out and fills the top gap.
 *
 * The guardrail that makes this safe is the veto: every dot carries an origin, and any
 * self-sourced dot can be rejected. A rejection is remembered by key, so the Scout can
 * never re-add what the owner threw out — the repository stays theirs.
 */
function scoutState(state) {
  const s = (state && state.scout) || {};
  return {
    rejected: Array.isArray(s.rejected) ? s.rejected : [],
    queries: Array.isArray(s.queries) ? s.queries : [],
    last_evidence_scout: s.last_evidence_scout || null,
    last_web_scout: s.last_web_scout || null,
    harvested_evidence: Number(s.harvested_evidence) || 0,
    harvested_web: Number(s.harvested_web) || 0,
  };
}

// One key per idea, so "Beeminder (อ้างอิง: beeminder.com)" and "beeminder" are the same thing.
function scoutKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\((?:อ้างอิง|ที่มา|ref|source)[^)]*\)/gi, " ")
    // \p{M} matters here: Thai vowel and tone marks are combining marks, not letters —
    // dropping them would collapse different words onto the same key.
    .replace(/[^\p{L}\p{N}\p{M} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

// The Evidence Agent writes its citations inline: "ชื่อของจริง (อ้างอิง: a.com, b.com)".
function splitReference(name) {
  const raw = String(name || "").trim();
  const m = raw.match(/\((?:อ้างอิง|ที่มา|ref|source)\s*:?\s*([^)]*)\)/i);
  return {
    title: raw.replace(/\((?:อ้างอิง|ที่มา|ref|source)[^)]*\)/gi, " ").replace(/\s+/g, " ").trim(),
    references: m ? m[1].split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 6) : [],
  };
}

// Domains the Scout can place a find into without asking anyone. Deliberately coarse:
// a wrong-but-close domain still lets the dot be connected; a missing one cannot.
const DOMAIN_HINTS = [
  { domain: "ธุรกิจ/โมเดลรายได้", words: ["pricing", "ราคา", "subscription", "สมาชิก", "credit", "เครดิต", "loyalty", "แต้ม", "revenue", "churn", "business", "ธุรกิจ", "saas", "billing", "การตลาด"] },
  { domain: "จิตวิทยา/พฤติกรรม", words: ["habit", "นิสัย", "streak", "behavio", "พฤติกรรม", "motivat", "แรงจูงใจ", "gamif", "commitment", "psycholog", "จิตวิทยา", "เดิมพัน", "nudge"] },
  { domain: "เทคโนโลยี/ซอฟต์แวร์", words: ["app", "แอป", "software", "ซอฟต์แวร์", "platform", "แพลตฟอร์ม", "algorithm", "อัลกอริทึม", "api", "เว็บ", "protocol", "โปรโตคอล", "database"] },
  { domain: "ชีววิทยา", words: ["cell", "เซลล์", "organism", "bio", "ชีว", "immune", "ภูมิคุ้มกัน", "วิวัฒนาการ", "evolution", "สัตว์", "พืช"] },
  { domain: "การแพทย์/สุขภาพ", words: ["health", "สุขภาพ", "medic", "แพทย์", "clinic", "therapy", "บำบัด", "โรค", "ผู้ป่วย"] },
  { domain: "เศรษฐศาสตร์", words: ["econom", "เศรษฐ", "incentive", "auction", "ประมูล", "ทฤษฎีเกม", "game theory", "ตลาดเสรี", "อุปสงค์"] },
  { domain: "วิศวกรรม/วัสดุ", words: ["material", "วัสดุ", "engineer", "วิศวกรรม", "robot", "หุ่นยนต์", "structure", "โครงสร้างทางกายภาพ", "โรงงาน", "logistic", "โลจิสติกส์"] },
  { domain: "ศิลปะ/การออกแบบ", words: ["design", "ออกแบบ", "art", "ศิลปะ", "typograph", "craft", "งานฝีมือ", "สถาปัตย", "ดนตรี", "music"] },
  { domain: "สังคม/องค์กร", words: ["communit", "ชุมชน", "organiz", "องค์กร", "team", "ทีม", "network", "เครือข่าย", "social", "สังคม", "การศึกษา", "education"] },
];
function inferDomain(text, fallback) {
  const t = String(text || "").toLowerCase();
  for (const hint of DOMAIN_HINTS) {
    if (hint.words.some((w) => t.includes(w))) return hint.domain;
  }
  return fallback || "โลกภายนอก";
}

/* ---- (1) The world the system already searched, no longer thrown away ---- */
function evidenceCandidates(connections, dots, rejectedKeys) {
  const taken = new Set((dots || []).map((d) => scoutKey(d.title)));
  const vetoed = rejectedKeys instanceof Set ? rejectedKeys : new Set(rejectedKeys || []);
  const out = [];
  for (const c of connections || []) {
    const nov = (c && c.evidence && c.evidence.novelty) || null;
    if (!nov || !Array.isArray(nov.similar_found)) continue;
    const from = (c.innovation && c.innovation.name) || c.id;
    for (const s of nov.similar_found) {
      const split = splitReference(s && s.name);
      const references = split.references;
      // Key off the stored (truncated) title, so a second harvest recognises its own work
      // and this stays idempotent however long the Evidence Agent's citation was.
      const title = split.title.slice(0, 200);
      const key = scoutKey(title);
      if (!title || !key || taken.has(key) || vetoed.has(key)) continue;
      taken.add(key);
      const how = String((s && s.how_close) || "").trim();
      out.push({
        key,
        title,
        domain: inferDomain(`${title} ${how}`, "โลกภายนอก"),
        content:
          `${how || "สิ่งที่มีอยู่จริงในโลกซึ่งระบบค้นเจอตอนตรวจความใหม่"}` +
          ` · ของจริงชิ้นนี้ถูกพบตอนพิสูจน์ไอเดีย "${from}"` +
          (references.length ? ` · อ้างอิง: ${references.join(", ")}` : ""),
        source: "evidence:" + c.id,
        origin: ORIGIN.evidence,
        scout: {
          from_connection: c.id,
          from_innovation: from,
          verdict: nov.verdict || null,
          references,
          harvested_at: null,
        },
      });
    }
  }
  return out;
}

// No AI, no network, safe to run on every daemon cycle: it only moves what is already here.
function harvestEvidenceDots({ max = 50, state = null } = {}) {
  const dots = loadJson(DOTS_FILE, []);
  const connections = loadJson(CONN_FILE, []);
  const own = state || loadState();
  const sc = scoutState(own);
  const candidates = evidenceCandidates(connections, dots, new Set(sc.rejected.map((r) => r.key))).slice(0, max);
  if (!candidates.length) return [];
  const now = new Date().toISOString();
  const created = candidates.map((c) => ({
    id: "dot_" + crypto.randomBytes(4).toString("hex"),
    title: c.title,
    domain: c.domain,
    content: c.content.slice(0, 2000),
    created_at: now,
    source: c.source,
    origin: c.origin,
    scout: { ...c.scout, harvested_at: now },
  }));
  saveJson(DOTS_FILE, [...dots, ...created]);
  sc.harvested_evidence += created.length;
  sc.last_evidence_scout = now;
  own.scout = sc;
  if (!state) saveState(own); // caller-owned state is saved by the caller
  return created;
}

/* ---- (2) The system names its own blind spots and writes its own queries ---- */
const SCOUT_REFERENCE_DOMAINS = [
  "ชีววิทยา", "ฟิสิกส์", "เคมี", "คณิตศาสตร์", "เศรษฐศาสตร์", "จิตวิทยา", "ประวัติศาสตร์",
  "ศิลปะ", "ดนตรี", "สถาปัตยกรรม", "การแพทย์", "นิเวศวิทยา", "ภาษาศาสตร์", "มานุษยวิทยา",
  "วัสดุศาสตร์", "การเกษตร", "กฎหมาย", "ปรัชญา", "การทหาร", "การศึกษา",
];

function domainCensus(dots) {
  const map = new Map();
  for (const d of dots || []) {
    const domain = String(d.domain || "ไม่ระบุ").trim() || "ไม่ระบุ";
    const e = map.get(domain) || { domain, count: 0, origins: {} };
    e.count++;
    const o = d.origin || originOf(d);
    e.origins[o] = (e.origins[o] || 0) + 1;
    map.set(domain, e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

// The query the system would type if it could type: its blind spot crossed with what it
// currently cares about most. Deterministic, so a human can audit it before it is sent.
function scoutQuery(domain, themes) {
  const anchor = (themes || []).slice(0, 2).join(" / ") || "การเชื่อมจุดข้ามสาขา";
  return `หลักการเชิงโครงสร้างใน "${domain}" ที่ถอดไปใช้ข้ามสาขาได้ และเทียบเคียงได้กับ ${anchor}`;
}

function scoutGaps(dots) {
  const census = domainCensus(dots);
  const have = census.map((c) => c.domain.toLowerCase());
  const themes = [...(dots || [])]
    .sort((a, b) => (b.attention_score || 0) - (a.attention_score || 0))
    .slice(0, 3)
    .map((d) => d.title);
  const gaps = SCOUT_REFERENCE_DOMAINS.filter((ref) => !have.some((h) => h.includes(ref.toLowerCase()))).map((ref) => ({
    domain: ref,
    why: `คลังยังไม่มีจุดใดเลยในโดเมน "${ref}" — การเชื่อมจุดจึงวนอยู่กับ ${census.length} โดเมนเดิมตลอดไป`,
    query: scoutQuery(ref, themes),
  }));
  return {
    census,
    themes,
    gaps,
    covered: SCOUT_REFERENCE_DOMAINS.length - gaps.length,
    reference_domains: SCOUT_REFERENCE_DOMAINS.length,
  };
}

function buildScoutPrompt(gap, existingTitles, census) {
  return `คุณคือ "The Scout" — ชั้นที่ 7 ของ The Dot-Connector AI
ระบบนี้เก็บ "จุดความรู้" ข้ามสาขาไว้เชื่อมกัน แต่คลังของมันมีช่องว่าง: ไม่มีจุดใดเลยที่อยู่ในโดเมน "${gap.domain}"
ภารกิจของคุณคือออกไปหาความรู้จากโลกจริงมาเติมช่องว่างนั้นด้วยตัวเอง

คำค้นตั้งต้นที่ระบบเขียนให้ตัวเอง: ${gap.query}
เหตุผลที่ต้องเติมโดเมนนี้: ${gap.why}

โดเมนที่คลังมีอยู่แล้ว (ห้ามส่งจุดที่อยู่ในโดเมนเหล่านี้กลับมา): ${census.map((c) => `${c.domain} (${c.count})`).join(" · ") || "(ยังไม่มี)"}
ชื่อจุดที่มีอยู่แล้ว (ห้ามซ้ำ): ${existingTitles.slice(0, 120).join(" · ") || "(ยังไม่มี)"}

วิธีทำงาน:
1. ใช้ web search จริงอย่างน้อย 2 ครั้ง (ค้นทั้งภาษาไทยและอังกฤษ) หา "หลักการเชิงโครงสร้าง" ในโดเมน ${gap.domain}
   ที่มีของจริงรองรับ — ไม่ใช่คำคมหรือความเห็น
2. เลือกเฉพาะหลักการที่ "ถอดข้ามสาขาได้" คือมีรูปทรงของกลไก (เช่น ลูปป้อนกลับ การหาค่าเหมาะสม การกระจายความเสี่ยง)
   ที่เอาไปทาบกับสาขาอื่นแล้วยังมีความหมาย
3. ส่งกลับ 2-${SCOUT_MAX_PER_RUN} จุด พร้อมแหล่งอ้างอิงจริงที่คุณเปิดอ่านมา

ตอบเป็น JSON array ล้วนเท่านั้น (ห้ามมี markdown หรือข้อความอื่นนอก JSON) ทุก field เป็นภาษาไทย:
[{"title": "<ชื่อจุด สั้น คม>", "domain": "${gap.domain}", "content": "<หลักการทำงานของมัน 1-3 ประโยค เน้นกลไก ไม่ใช่คำอธิบายทั่วไป>", "reference": "<URL หรือชื่อแหล่งที่ค้นเจอจริง>"}]`;
}

// The one place the system reaches out on its own initiative. Blocked under DOT_SELFTEST,
// like every other AI call, so the forge's sandboxes never dial out.
async function scoutWeb({ domain = null, max = SCOUT_MAX_PER_RUN, state = null } = {}) {
  if (SELFTEST) throw Object.assign(new Error("โหมดทดสอบ: The Scout ไม่ออกอินเทอร์เน็ต"), { status: 503 });
  const dots = enrichDots(loadJson(DOTS_FILE, []), loadJson(CONN_FILE, []));
  const plan = scoutGaps(dots);
  const gap = domain
    ? plan.gaps.find((g) => g.domain === domain) || {
        domain,
        why: "ผู้ใช้สั่งให้ไปหาความรู้ในโดเมนนี้เอง",
        query: scoutQuery(domain, plan.themes),
      }
    : plan.gaps[0];
  if (!gap) {
    throw Object.assign(new Error("ไม่พบช่องว่างของโดเมน — คลังครอบคลุมโดเมนอ้างอิงครบแล้ว ระบุโดเมนเองได้"), { status: 400 });
  }

  const raw = await runClaude(buildScoutPrompt(gap, dots.map((d) => d.title), plan.census), {
    model: SCOUT_MODEL,
    tools: ["WebSearch", "WebFetch"],
    timeoutMs: SCOUT_TIMEOUT_MS,
  });
  let parsed;
  try {
    parsed = extractJson(raw);
  } catch {
    throw Object.assign(new Error("The Scout ตอบกลับมาในรูปแบบที่อ่านไม่ได้ ลองอีกครั้ง"), { status: 502 });
  }
  if (!Array.isArray(parsed)) parsed = (parsed && parsed.dots) || [];

  const own = state || loadState();
  const sc = scoutState(own);
  const vetoed = new Set(sc.rejected.map((r) => r.key));
  const store = loadJson(DOTS_FILE, []);
  const taken = new Set(store.map((d) => scoutKey(d.title)));
  const now = new Date().toISOString();
  const created = [];
  for (const item of parsed.slice(0, max)) {
    if (!item || !item.title) continue;
    const title = String(item.title).slice(0, 200);
    const key = scoutKey(title);
    if (!key || taken.has(key) || vetoed.has(key)) continue;
    taken.add(key);
    created.push({
      id: "dot_" + crypto.randomBytes(4).toString("hex"),
      title,
      domain: String(item.domain || gap.domain).slice(0, 100),
      content: String(item.content || "").slice(0, 2000),
      created_at: now,
      source: "web:" + gap.domain,
      origin: ORIGIN.web,
      scout: { query: gap.query, domain: gap.domain, reference: String(item.reference || "").slice(0, 300), found_at: now },
    });
  }
  if (created.length) saveJson(DOTS_FILE, [...store, ...created]);
  sc.harvested_web += created.length;
  sc.last_web_scout = now;
  sc.queries = [{ at: now, domain: gap.domain, query: gap.query, found: created.length }, ...sc.queries].slice(0, 20);
  own.scout = sc;
  if (!state) saveState(own);
  return { gap, created };
}

/* ---- (3) The veto: the repository grows on its own, but it stays the owner's ---- */
function rejectDot(dotId, { veto = true, state = null } = {}) {
  const dots = loadJson(DOTS_FILE, []);
  const dot = dots.find((d) => d.id === dotId);
  if (!dot) return null;
  saveJson(DOTS_FILE, dots.filter((d) => d.id !== dotId));
  const origin = originOf(dot);
  if (!veto) return { dot, origin, vetoed: false };
  const own = state || loadState();
  const sc = scoutState(own);
  const key = scoutKey(dot.title);
  if (key && !sc.rejected.some((r) => r.key === key)) {
    sc.rejected = [
      ...sc.rejected,
      { key, title: dot.title, origin, source: dot.source || null, at: new Date().toISOString() },
    ].slice(-300);
  }
  own.scout = sc;
  if (!state) saveState(own);
  return { dot, origin, vetoed: true, rejected_total: sc.rejected.length };
}

function scoutStatus() {
  const rawDots = loadJson(DOTS_FILE, []);
  const connections = loadJson(CONN_FILE, []);
  const dots = enrichDots(rawDots, connections);
  const state = loadState();
  const sc = scoutState(state);
  const rejected = new Set(sc.rejected.map((r) => r.key));
  const origins = {};
  for (const d of dots) origins[d.origin] = (origins[d.origin] || 0) + 1;
  const plan = scoutGaps(dots);
  return {
    origins,
    origin_labels: ORIGIN_LABEL,
    total_dots: dots.length,
    self_sourced: dots.filter((d) => d.self_sourced).length,
    pending_evidence: evidenceCandidates(connections, rawDots, rejected).length,
    gaps: plan.gaps.map((g) => g.domain),
    next_query: plan.gaps.length ? plan.gaps[0].query : null,
    rejected: sc.rejected.slice(-20).reverse(),
    rejected_total: sc.rejected.length,
    queries: sc.queries.slice(0, 10),
    harvested_evidence: sc.harvested_evidence,
    harvested_web: sc.harvested_web,
    last_evidence_scout: sc.last_evidence_scout,
    last_web_scout: sc.last_web_scout,
    scout_hours: SCOUT_HOURS,
    scout_model: SCOUT_MODEL,
  };
}

/* ================= Prompts ================= */
function buildConnectPrompt(dots, lessons, focus, mustInclude) {
  const dotList = dots
    .map(
      (d) =>
        `- id: ${d.id}\n  โดเมน: ${d.domain}\n  ชื่อจุด: ${d.title}\n  รายละเอียด: ${d.content}\n  ที่มา: ${
          ORIGIN_LABEL[d.origin || originOf(d)] || "👤 เจ้าของเพิ่มเอง"
        }\n  สถิติ: ถูกเชื่อมแล้ว ${d.uses ?? 0} ครั้ง${
          d.rated_uses
            ? ` · คะแนนคุณค่าจากผลลัพธ์จริง ${d.value_score > 0 ? "+" : ""}${d.value_score} (จากผลตอบกลับ ${d.rated_uses} ครั้ง)${
                d.dead_end ? " — จุดนี้เคยพาไปทางตันซ้ำ ๆ ใช้ก็ได้แต่ต้องมีมุมใหม่จริง ๆ" : d.proven ? " — จุดนี้เคยให้ผลลัพธ์ที่ดีจริง" : ""
              }`
            : ""
        }${d.forgotten ? " (จุดนี้ถูกทิ้งไว้นาน — มีค่าสูงหากปลุกขึ้นมาใช้)" : ""}`
    )
    .join("\n");
  const must = (mustInclude || [])
    .map((id) => dots.find((d) => d.id === id))
    .filter(Boolean);

  // The return path: the previous rounds' actual results, not just their names.
  const rated = (lessons || []).filter((l) => l.signal !== null);
  const worked = rated.filter((l) => l.signal >= 0.34);
  const died = rated.filter((l) => l.signal <= -0.34);
  const flat = rated.filter((l) => l.signal > -0.34 && l.signal < 0.34);
  const untested = (lessons || []).filter((l) => l.signal === null);
  const line = (l) => `- "${l.name}" (จาก ${l.dots.join(" + ") || "?"}) → ${l.lesson}`;
  const lessonBlock = (lessons || []).length
    ? `\n===== บทเรียนจากรอบก่อน (ผลลัพธ์จริงที่ไหลกลับมา ไม่ใช่แค่บัญชีดำรายชื่อ) =====
${worked.length ? `✅ ทิศทางที่พิสูจน์แล้วว่าได้ผล — ต่อยอด "หลักการ" ของมันได้ แต่ห้ามสร้างของเดิมซ้ำ:\n${worked.map(line).join("\n")}\n` : ""}${died.length ? `❌ ทิศทางที่ตายแล้ว — อย่าเดินซ้ำรอย และให้น้ำหนักจุดที่พามาทางนี้น้อยลง:\n${died.map(line).join("\n")}\n` : ""}${flat.length ? `◻ ผลกลาง ๆ — ยังไม่คุ้มถ้าไม่มีมุมที่คมกว่าเดิม:\n${flat.map(line).join("\n")}\n` : ""}${untested.length ? `· ยังไม่มีผลตอบกลับ (ห้ามทำซ้ำชื่อเหล่านี้): ${untested.map((l) => l.name).join(", ")}\n` : ""}
สิ่งที่ต้องทำกับบทเรียนนี้: ก่อนเลือกจุด ให้สรุปกับตัวเองว่า "รอบก่อนอะไรได้ผลเพราะอะไร" แล้วเลือกจุดที่ทำให้รอบนี้ต่างจากรอบที่ตายไปแล้วอย่างมีเหตุผล ไม่ใช่แค่เลี่ยงชื่อเดิม`
    : "";

  return `คุณคือ "The Dot-Connector AI" — เครื่องยนต์เชื่อมจุดข้ามโดเมนตามปรัชญา "Connecting the Dots" ของ Steve Jobs

คุณทำงาน 3 ชั้น:
1. Pattern Recognition: สแกน "จุดความรู้" ทั้งหมดด้านล่าง หาความสัมพันธ์เชิงโครงสร้างที่ซ่อนอยู่ (structural isomorphism) — ไม่ใช่ความคล้ายผิวเผิน
2. Connection: เลือกจุด 2-3 จุดจาก "ต่างโดเมนกัน" ที่มีความเชื่อมโยงที่คาดไม่ถึงแต่มีเหตุผลรองรับแน่นที่สุด ให้ความสำคัญกับจุดที่ถูกเชื่อมน้อยครั้ง (จุดหายาก) และ "จุดที่เคยให้ผลลัพธ์จริงที่ดี" (คะแนนคุณค่าเป็นบวก) มากกว่าจุดที่ถูกใช้บ่อยแล้วหรือจุดที่เคยพาไปทางตัน
3. Combinatorial Innovation: สังเคราะห์เป็นแนวคิดนวัตกรรมใหม่ที่ทำได้จริง

คลังจุดความรู้ (Dot Repository):
${dotList}
${must.length ? `\nข้อบังคับ: การเชื่อมครั้งนี้ต้องมีจุดต่อไปนี้อยู่ด้วยเสมอ (Serendipity Revival): ${must.map((d) => `${d.id} (${d.title})`).join(", ")}\n` : ""}
${focus ? `\nโจทย์/คอขวดที่ผู้ใช้อยากปลดล็อก (ให้การเชื่อมจุดมุ่งแก้เรื่องนี้): ${focus}\n` : ""}
${lessonBlock}

ตอบเป็น JSON ล้วนเท่านั้น (ห้ามมี markdown, ห้ามมีข้อความอื่นนอก JSON) ทุก field เป็นภาษาไทย:
{
  "selected_dot_ids": ["<id ของจุดที่เลือก>"],
  "learned_from_last_round": "<รอบก่อนสอนอะไร และรอบนี้จึงเลือกต่างออกไปอย่างไร — 1-2 ประโยค (ถ้ายังไม่มีบทเรียนให้ตอบว่ายังไม่มีผลตอบกลับ)>",
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

  // The feedback loop, closed: past results decide both what the model reads first
  // (attention ordering by proven value, not rarity alone) and what it is told about
  // the last rounds (lessons with outcomes, replacing the old name-only blacklist).
  const lessons = buildLessons(connections);
  const ordered = [...pool].sort((a, b) => b.attention_score - a.attention_score);

  const raw = await runClaude(
    buildConnectPrompt(ordered, lessons, String(focus || "").slice(0, 500), mustInclude)
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
    // What flowed in from the past, and the slot the result flows back into.
    learned_from_last_round: parsed.learned_from_last_round || "",
    lessons_used: lessons.filter((l) => l.signal !== null).map((l) => l.id),
    outcome: null,
  };
  const fresh = loadJson(CONN_FILE, []);
  fresh.unshift(record);
  saveJson(CONN_FILE, fresh);
  return record;
}

async function harvestText(text, source, origin = ORIGIN.human) {
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
      origin,
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
 * rewrites itself to break one of them. Every attempt is snapshotted and
 * auto-rolled-back unless it survives four gates: syntax, live boot,
 * an executable capability proof that passes only on the new code, and a
 * regression sweep over every endpoint that existed before the round.
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

function diffSelf(before, after = readSelf()) {
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

// Boot a server.js from any tree on a throwaway port and wait until it answers HTTP.
// Resolves with a live handle — the caller decides when to stop it.
async function bootServer(dir, label = "เซิร์ฟเวอร์") {
  let port;
  try {
    port = await freePort();
  } catch (e) {
    return { ok: false, port: 0, detail: "หาพอร์ตว่างไม่ได้: " + e.message, stop() {} };
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, "server.js")], {
      cwd: dir,
      windowsHide: true,
      env: { ...process.env, PORT: String(port), DOT_SELFTEST: "1", CHECK_MIN: "999999", AUTO_HOURS: "999999", EVOLVE_HOURS: "0" },
    });
    let out = "";
    let settled = false;
    let poller = null;
    let deadline = null;
    const stop = () => {
      try {
        child.kill();
      } catch {}
    };
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(deadline);
      if (!ok) stop();
      resolve({ ok, port, detail, stop });
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => finish(false, `รันโปรเซส${label}ไม่ได้: ` + e.message));
    child.on("exit", (code) => {
      if (code !== 0) finish(false, `${label}ตายทันที (exit ${code}): ${out.slice(-400).trim()}`);
    });
    deadline = setTimeout(() => finish(false, `${label}ไม่ตอบใน 25 วินาที: ${out.slice(-400).trim()}`), 25000);
    let tries = 0;
    poller = setInterval(() => {
      tries++;
      const req = http.get({ host: "127.0.0.1", port, path: "/api/dots", timeout: 2500 }, (r) => {
        r.resume();
        if (r.statusCode === 200) finish(true, `${label}บูตผ่าน: /api/dots ตอบ 200 บนพอร์ต ${port}`);
        else if (tries > 18) finish(false, `/api/dots ตอบ ${r.statusCode}`);
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => {
        if (tries > 18) finish(false, `ต่อพอร์ต${label}ไม่ติด: ${out.slice(-400).trim()}`);
      });
    }, 1000);
  });
}

// Gate 1 (unchanged): the code that is actually on disk boots and answers HTTP.
async function smokeTest() {
  const boot = await bootServer(ROOT, "เซิร์ฟเวอร์ใหม่");
  boot.stop();
  return { ok: boot.ok, detail: boot.detail };
}

function httpStatus(port, pathname, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout }, (r) => {
      r.resume();
      r.on("end", () => resolve(r.statusCode));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(0));
  });
}

// Gate 4: nothing the system could do yesterday may have quietly disappeared.
// The list swept is the *effective* one: every declared endpoint minus the ones a
// consolidation round retired against a zero-usage certificate (Layer 6.6). Retiring is
// recorded, reversible and refused for any path that anyone has actually called.
async function regressionTest(port, endpoints = null) {
  const results = [];
  for (const ep of endpoints || effectiveRegressionEndpoints()) {
    let status = 0;
    for (let i = 0; i < 3 && status !== 200; i++) status = await httpStatus(port, ep);
    results.push({ endpoint: ep, status });
  }
  const broken = results.filter((r) => r.status !== 200);
  return {
    ok: broken.length === 0,
    results,
    detail: broken.length
      ? "endpoint เดิมที่พัง: " + broken.map((b) => `${b.endpoint} → ${b.status || "ไม่ตอบ"}`).join(", ")
      : `ทุก endpoint เดิมยังตอบ 200 ครบ ${results.length} เส้น`,
  };
}

// Run the evolution's own proof file against one tree. Exit 0 = capability present.
function runProof(file, { url, root, timeoutMs = PROOF_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, DOT_TEST_URL: url, DOT_TEST_ROOT: root, DOT_SELFTEST: "1" },
    });
    let out = "";
    let settled = false;
    let timer = null;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      done(false, `หมดเวลา ${Math.round(timeoutMs / 1000)} วินาที: ${out.slice(-300).trim()}`);
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => done(false, "รันไฟล์พิสูจน์ไม่ได้: " + e.message));
    child.on("close", (code) =>
      done(code === 0, `exit ${code}${out.trim() ? " · " + out.slice(-400).trim() : ""}`)
    );
  });
}

// Rebuild a whole runnable copy of the engine from an in-memory source snapshot,
// with a throwaway copy of memory so no test can ever touch the real data/.
function materializeTree(body, dir, dataSnapshot) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  for (const [rel, content] of Object.entries({ ...body, ...dataSnapshot })) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  fs.mkdirSync(path.join(dir, "inbox", "processed"), { recursive: true });
  fs.mkdirSync(path.join(dir, "evolution"), { recursive: true });
  return dir;
}

/*
 * Gates 2-4 — the fitness function stops being "did not die" and becomes "got better".
 * The forge must leave an executable proof at selftest/<evoId>.js. We then run it twice:
 * once against the NEW code (must pass) and once against the OLD code rebuilt from the
 * backup snapshot (must fail). A proof that passes on both proves nothing was broken open;
 * a proof that fails on the new code proves the capability was never delivered.
 */
async function proveEvolution(evoId, before, after, dataSnapshot) {
  const proofFile = path.join(PROOF_DIR, evoId + ".js");
  const sandbox = path.join(os.tmpdir(), "dot-forge-" + evoId);
  const newDir = path.join(sandbox, "new");
  const oldDir = path.join(sandbox, "old");
  const out = {
    capability: { ok: false, detail: "ยังไม่ได้ทดสอบ" },
    differential: { ok: false, detail: "ยังไม่ได้ทดสอบ" },
    regression: { ok: false, detail: "ยังไม่ได้ทดสอบ" },
  };
  let newBoot = null;
  let oldBoot = null;
  if (!fs.existsSync(proofFile)) {
    const why = `ไม่พบไฟล์พิสูจน์ selftest/${evoId}.js`;
    return { capability: { ok: false, detail: why }, differential: { ok: false, detail: why }, regression: { ok: false, detail: why } };
  }
  try {
    materializeTree(after, newDir, dataSnapshot);
    materializeTree(before, oldDir, dataSnapshot);

    newBoot = await bootServer(newDir, "โค้ดใหม่ในแซนด์บ็อกซ์");
    if (!newBoot.ok) {
      const skip = "ข้ามเพราะโค้ดใหม่บูตในแซนด์บ็อกซ์ไม่ขึ้น";
      return { ...out, capability: { ok: false, detail: newBoot.detail }, differential: { ok: false, detail: skip }, regression: { ok: false, detail: skip } };
    }

    const newProof = await runProof(proofFile, { url: `http://127.0.0.1:${newBoot.port}`, root: newDir });
    out.capability = {
      ok: newProof.ok,
      detail: (newProof.ok ? "ไฟล์พิสูจน์ผ่านกับโค้ดใหม่" : "ไฟล์พิสูจน์ตกกับโค้ดใหม่ — ความสามารถใหม่ยังใช้จริงไม่ได้") + " · " + newProof.detail,
    };

    out.regression = await regressionTest(newBoot.port);

    oldBoot = await bootServer(oldDir, "โค้ดเดิมในแซนด์บ็อกซ์");
    if (!oldBoot.ok) {
      out.differential = { ok: false, detail: "โค้ดเดิมบูตไม่ขึ้น จึงพิสูจน์ไม่ได้ว่าความสามารถนี้ใหม่จริง: " + oldBoot.detail };
    } else {
      const oldProof = await runProof(proofFile, { url: `http://127.0.0.1:${oldBoot.port}`, root: oldDir });
      out.differential = {
        ok: !oldProof.ok,
        detail: oldProof.ok
          ? "ไฟล์พิสูจน์ผ่านกับโค้ดเดิมด้วย — แปลว่ากำแพงนี้ไม่ได้ถูกทำลายจริง"
          : "ไฟล์พิสูจน์ตกกับโค้ดเดิมตามที่ควรเป็น · " + oldProof.detail,
      };
    }
  } catch (e) {
    out.capability = { ok: false, detail: "ระบบพิสูจน์ล้มเหลว: " + e.message };
  } finally {
    if (newBoot) newBoot.stop();
    if (oldBoot) oldBoot.stop();
    setTimeout(() => {
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
      } catch {}
    }, 2000);
  }
  return out;
}

/* ================= Layer 6.6: THE CONSOLIDATOR =================
 * The expansion gate `out.differential.ok = !oldProof.ok` demands the proof FAIL on
 * yesterday's code — so any change whose whole point is that behaviour stays identical
 * (merging duplicate code, deleting what nothing calls, dropping a dead endpoint) is
 * unprovable by construction: it passes on both trees, which the gate reads as "you did
 * nothing". With REGRESSION_ENDPOINTS append-only too, the engine could only grow.
 *
 * Hence two round types with exactly inverted fitness functions:
 *
 *   expansion round     proof PASSES on new, FAILS on old   → "you can do something new"
 *   consolidation round proof PASSES on new AND on old      → "you still do exactly this"
 *                       + quantitative shrink               → "and you are measurably smaller"
 *
 * Consolidation is not the soft option: it re-runs the *whole accumulated suite* against
 * both trees and demands an identical pass/fail signature file by file (one flipped result
 * = rolled back), must move a size metric with no growth in any, and still runs the full
 * regression sweep. A different gate, pointed the other way — not a weakened one.
 *
 * Retiring an endpoint is the one destructive power here, so it is the most heavily
 * fenced: every /api/* request increments a live usage ledger, and a path can be retired
 * only while its hit count is exactly zero. Retirement is recorded with who did it and
 * when, is undone with one call, and never deletes the historical declaration.
 */

/* ---- the live usage ledger: the only thing that can certify a path as dead ---- */
let usageLedger = null;
let usageDirty = false;

function loadUsage() {
  if (usageLedger) return usageLedger;
  const raw = loadJson(USAGE_FILE, null);
  usageLedger =
    raw && typeof raw === "object" && raw.endpoints
      ? { started_at: raw.started_at || new Date().toISOString(), endpoints: raw.endpoints }
      : { started_at: new Date().toISOString(), endpoints: {} };
  return usageLedger;
}
function flushUsage() {
  if (!usageDirty) return;
  usageDirty = false;
  try {
    saveJson(USAGE_FILE, loadUsage());
  } catch {}
}
// Counting in memory and flushing lazily keeps a burst of polling from turning into a
// burst of disk writes — and keeps reads exact even before the flush lands.
function recordEndpointHit(pathname) {
  if (!String(pathname || "").startsWith("/api/")) return;
  const u = loadUsage();
  const now = new Date().toISOString();
  const e = u.endpoints[pathname] || { hits: 0, first_hit: now, last_hit: now };
  e.hits++;
  e.last_hit = now;
  u.endpoints[pathname] = e;
  if (!usageDirty) {
    usageDirty = true;
    const t = setTimeout(flushUsage, 1500);
    if (t.unref) t.unref();
  }
}

/* ---- the deprecation ledger: how a path leaves the sweep without being forgotten ---- */
function loadDeprecations() {
  const list = loadJson(DEPRECATED_FILE, []);
  return Array.isArray(list) ? list : [];
}
function retiredEndpoints() {
  return new Set(loadDeprecations().filter((d) => d && d.active !== false).map((d) => d.endpoint));
}
function effectiveRegressionEndpoints() {
  const retired = retiredEndpoints();
  return REGRESSION_ENDPOINTS.filter((ep) => !retired.has(ep));
}
function endpointLedger() {
  const u = loadUsage();
  const retired = retiredEndpoints();
  const hours = Math.max(0, (Date.now() - new Date(u.started_at).getTime()) / 3600000);
  const known = new Set(REGRESSION_ENDPOINTS);
  return {
    tracking_since: u.started_at,
    tracking_hours: Math.round(hours * 10) / 10,
    // A ledger that started ten minutes ago proves nothing about a quiet endpoint.
    young_ledger: hours < 24,
    declared: REGRESSION_ENDPOINTS.length,
    sweeping: effectiveRegressionEndpoints().length,
    retired: retired.size,
    endpoints: REGRESSION_ENDPOINTS.map((ep) => {
      const e = u.endpoints[ep] || null;
      const isRetired = retired.has(ep);
      return {
        endpoint: ep,
        hits: e ? e.hits : 0,
        first_hit: e ? e.first_hit : null,
        last_hit: e ? e.last_hit : null,
        retired: isRetired,
        retirable: !isRetired && !(e && e.hits > 0),
      };
    }),
    other_traffic: Object.entries(u.endpoints)
      .filter(([k]) => !known.has(k))
      .map(([endpoint, e]) => ({ endpoint, hits: e.hits, last_hit: e.last_hit }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 20),
    deprecations: loadDeprecations().slice(-40).reverse(),
  };
}
function retirementCandidates() {
  return endpointLedger().endpoints.filter((e) => e.retirable).map((e) => e.endpoint);
}
function retireEndpoint(endpoint, { by = "owner", reason = "" } = {}) {
  const ep = String(endpoint || "").trim();
  if (!REGRESSION_ENDPOINTS.includes(ep)) {
    return { ok: false, error: `"${ep}" ไม่ได้อยู่ในรายการ regression sweep — ไม่มีอะไรให้ถอด` };
  }
  const list = loadDeprecations();
  if (list.some((d) => d.endpoint === ep && d.active !== false)) {
    return { ok: false, error: `"${ep}" ถูกถอดออกจาก sweep ไปแล้ว` };
  }
  const u = loadUsage();
  const hits = (u.endpoints[ep] || {}).hits || 0;
  if (hits > 0) {
    return {
      ok: false,
      error: `"${ep}" ยังมีคนเรียกอยู่จริง (${hits} ครั้ง ล่าสุด ${u.endpoints[ep].last_hit}) — เส้นทางที่ยังมีชีวิตถอดไม่ได้`,
    };
  }
  const record = {
    endpoint: ep,
    retired_at: new Date().toISOString(),
    by,
    reason: String(reason || "").slice(0, 400),
    hits_when_retired: 0,
    tracking_since: u.started_at,
    active: true,
  };
  saveJson(DEPRECATED_FILE, [...list, record]);
  return { ok: true, record, sweeping: effectiveRegressionEndpoints().length, declared: REGRESSION_ENDPOINTS.length };
}
// Retirement is never a deletion: the declaration stays and one call puts the path back.
function restoreEndpoint(endpoint) {
  const ep = String(endpoint || "").trim();
  const list = loadDeprecations();
  const idx = list.findIndex((d) => d.endpoint === ep && d.active !== false);
  if (idx < 0) return { ok: false, error: `"${ep}" ไม่ได้ถูกถอดออกจาก sweep อยู่` };
  list[idx] = { ...list[idx], active: false, restored_at: new Date().toISOString() };
  saveJson(DEPRECATED_FILE, list);
  return { ok: true, record: list[idx], sweeping: effectiveRegressionEndpoints().length, declared: REGRESSION_ENDPOINTS.length };
}
// A round may only retire what the ledger already certifies as dead. Everything else is
// refused with a reason, and the refusal is written into the round's own record.
function planRetirements(requested) {
  const candidates = new Set(retirementCandidates());
  const retired = retiredEndpoints();
  const approved = [];
  const refused = [];
  for (const raw of Array.isArray(requested) ? requested : []) {
    const ep = String(raw || "").trim();
    if (!ep) continue;
    if (candidates.has(ep)) approved.push(ep);
    else {
      refused.push({
        endpoint: ep,
        why: !REGRESSION_ENDPOINTS.includes(ep)
          ? "ไม่ได้อยู่ในรายการ sweep"
          : retired.has(ep)
            ? "ถูกถอดไปแล้วก่อนหน้านี้"
            : "ยังมีคนเรียกอยู่จริงตามบันทึกการใช้งาน",
      });
    }
  }
  return { requested: (requested || []).map(String), approved, refused };
}

/* ---- the numbers a consolidation round has to move ---- */
const SHRINK_KEYS = ["code_lines", "code_chars", "code_files", "prompt_chars", "endpoints"];
// Growth in any of these is disqualifying on its own; proof files are excluded from the
// code metrics because every round is *required* to add one, and a rule that punished
// that would make consolidation impossible for the same reason the old gate did.
const NO_GROWTH_KEYS = ["code_lines", "code_chars", "prompt_chars"];

function sizeMetrics(body) {
  const isProof = (rel) => rel.startsWith("selftest/");
  let totalLines = 0;
  let codeLines = 0;
  let codeChars = 0;
  let codeFiles = 0;
  for (const [rel, content] of Object.entries(body)) {
    const lines = content.split("\n").length;
    totalLines += lines;
    if (!isProof(rel)) {
      codeLines += lines;
      codeChars += content.length;
      codeFiles++;
    }
  }
  return {
    files: Object.keys(body).length,
    total_lines: totalLines,
    code_files: codeFiles,
    code_lines: codeLines,
    code_chars: codeChars,
    // The self-forge prompt is the engine's real context ceiling — measure it directly.
    prompt_chars: sourceBundle(promptBundle(body)).length,
    endpoints: effectiveRegressionEndpoints().length,
    retired_endpoints: retiredEndpoints().size,
  };
}

function metricDelta(before, after, retiring = 0) {
  const d = {};
  for (const k of SHRINK_KEYS) d[k] = (Number(after[k]) || 0) - (Number(before[k]) || 0);
  // Retirements are applied only after the round is accepted, so they are counted here.
  d.endpoints -= Number(retiring) || 0;
  d.total_lines = (Number(after.total_lines) || 0) - (Number(before.total_lines) || 0);
  return d;
}

/*
 * The inverted fitness function, as one pure function so the UI, the API and the forge all
 * judge a round by exactly the same rule — and so a human can dry-run it without spending
 * an AI round. Expansion asks "does the old code fail this?"; consolidation asks the
 * opposite: "does every test still pass, on both trees, while the thing gets smaller?"
 */
function consolidationVerdict(before, after, suite, { retiring = 0 } = {}) {
  const list = (Array.isArray(suite) ? suite : []).map((s) => ({
    file: String((s && s.file) || "?"),
    own: Boolean(s && s.own),
    old_ok: Boolean(s && s.old_ok),
    new_ok: Boolean(s && s.new_ok),
  }));
  const own = list.filter((s) => s.own);
  const flipped = list.filter((s) => s.old_ok !== s.new_ok);
  const brokenBoth = list.filter((s) => !s.old_ok && !s.new_ok && !s.own);
  const ownBoth = own.length > 0 && own.every((s) => s.old_ok && s.new_ok);
  const preserved = {
    ok: list.length > 0 && ownBoth && flipped.length === 0,
    suite_size: list.length,
    flipped,
    detail: !list.length
      ? "ไม่มีชุดทดสอบให้รัน — รอบยุบรวมต้องพิสูจน์ด้วยชุดทดสอบที่มีอยู่จริง"
      : !own.length
        ? "ไม่พบไฟล์พิสูจน์ของรอบนี้ในชุดทดสอบ"
        : !ownBoth
          ? "ไฟล์พิสูจน์ของรอบนี้ต้องผ่าน 'ทั้งกับโค้ดเดิมและโค้ดใหม่' (นี่คือฟังก์ชันความเหมาะสมกลับด้าน: พฤติกรรมต้องเหมือนเดิมเป๊ะ) แต่ได้ " +
            own.map((s) => `${s.file}: เดิม ${s.old_ok ? "ผ่าน" : "ตก"} / ใหม่ ${s.new_ok ? "ผ่าน" : "ตก"}`).join(", ")
          : flipped.length
            ? "พฤติกรรมเปลี่ยนไป " +
              flipped.length +
              " ไฟล์: " +
              flipped.map((s) => `${s.file} (เดิม ${s.old_ok ? "ผ่าน" : "ตก"} → ใหม่ ${s.new_ok ? "ผ่าน" : "ตก"})`).join(", ")
            : `ชุดทดสอบทั้ง ${list.length} ไฟล์ให้ผลเหมือนกันทุกไฟล์ก่อนและหลัง` +
              (brokenBoth.length ? ` (มี ${brokenBoth.length} ไฟล์ที่ตกอยู่แล้วตั้งแต่ก่อนรอบนี้ และยังตกเหมือนเดิม)` : ""),
  };

  const delta = metricDelta(before || {}, after || {}, retiring);
  const grew = NO_GROWTH_KEYS.filter((k) => delta[k] > 0);
  const shrank = SHRINK_KEYS.filter((k) => delta[k] < 0);
  const fmt = (k) => `${k} ${delta[k] > 0 ? "+" : ""}${delta[k]}`;
  const shrunk = {
    ok: grew.length === 0 && shrank.length > 0,
    grew,
    shrank,
    detail: grew.length
      ? "รอบยุบรวมแต่กลับใหญ่ขึ้น: " + grew.map(fmt).join(" · ")
      : shrank.length
        ? "เล็กลงจริงตามตัวเลข: " + shrank.map(fmt).join(" · ")
        : "ขนาดไม่ได้ลดลงเลย — รอบยุบรวมต้องขยับตัวเลขอย่างน้อยหนึ่งตัว (บรรทัดโค้ด/จำนวนไฟล์/ขนาดพรอมป์ต/จำนวน endpoint)",
  };

  return {
    ok: preserved.ok && shrunk.ok,
    gates: { preserved, shrunk },
    delta,
    metrics: { before: before || null, after: after || null },
    retiring: Number(retiring) || 0,
    rule:
      "รอบยุบรวมผ่านเมื่อ: (1) ชุดทดสอบเดิมทั้งชุดให้ผลเหมือนกันทั้งก่อนและหลัง และไฟล์พิสูจน์ของรอบนี้ผ่านทั้งก่อนและหลัง " +
      "(2) มีตัวเลขขนาดลดลงอย่างน้อยหนึ่งตัว และไม่มีตัวไหนโตขึ้น (3) regression sweep ครบทุกเส้นที่ยังมีชีวิต",
  };
}

// The whole accumulated suite — every proof any accepted round ever shipped — re-run
// against both trees. This is the consolidation round's equivalent of the differential
// gate, and it is strictly harder: N tests must agree, not one test must disagree.
async function proveConsolidation(evoId, before, after, dataSnapshot, { retiring = [] } = {}) {
  const proofRel = `selftest/${evoId}.js`;
  const sandbox = path.join(os.tmpdir(), "dot-consolidate-" + evoId);
  const newDir = path.join(sandbox, "new");
  const oldDir = path.join(sandbox, "old");
  const out = {
    preservation: { ok: false, detail: "ยังไม่ได้ทดสอบ" },
    shrink: { ok: false, detail: "ยังไม่ได้ทดสอบ" },
    regression: { ok: false, detail: "ยังไม่ได้ทดสอบ" },
    suite: [],
    skipped: [],
    delta: null,
    metrics: null,
  };
  if (!(proofRel in after)) {
    const why = `ไม่พบไฟล์พิสูจน์ ${proofRel}`;
    return { ...out, preservation: { ok: false, detail: why }, shrink: { ok: false, detail: why }, regression: { ok: false, detail: why } };
  }
  let newBoot = null;
  let oldBoot = null;
  try {
    materializeTree(after, newDir, dataSnapshot);
    materializeTree(before, oldDir, dataSnapshot);

    // Everything that is a proof file in the new tree, own file last so the suite is read
    // in a stable order. Capped, and whatever the cap dropped is named out loud.
    const all = Object.keys(after)
      .filter((rel) => /^selftest\/.+\.js$/.test(rel) && rel !== proofRel)
      .sort();
    const keep = all.slice(-Math.max(0, CONSOLIDATE_SUITE_MAX - 1));
    out.skipped = all.filter((rel) => !keep.includes(rel));
    const suiteFiles = [...keep, proofRel];

    newBoot = await bootServer(newDir, "โค้ดที่ยุบรวมแล้วในแซนด์บ็อกซ์");
    if (!newBoot.ok) {
      const skip = "ข้ามเพราะโค้ดใหม่บูตในแซนด์บ็อกซ์ไม่ขึ้น";
      return { ...out, preservation: { ok: false, detail: newBoot.detail }, shrink: { ok: false, detail: skip }, regression: { ok: false, detail: skip } };
    }
    oldBoot = await bootServer(oldDir, "โค้ดเดิมในแซนด์บ็อกซ์");
    if (!oldBoot.ok) {
      const why = "โค้ดเดิมบูตไม่ขึ้น จึงเทียบพฤติกรรมก่อน/หลังไม่ได้: " + oldBoot.detail;
      return { ...out, preservation: { ok: false, detail: why }, shrink: { ok: false, detail: why }, regression: { ok: false, detail: why } };
    }

    const results = [];
    for (const rel of suiteFiles) {
      // Always run the NEW tree's copy of the test against both servers: the question is
      // whether the same test sees the same behaviour, not whether the test itself changed.
      const file = path.join(newDir, rel);
      const nr = await runProof(file, { url: `http://127.0.0.1:${newBoot.port}`, root: newDir });
      const or = await runProof(file, { url: `http://127.0.0.1:${oldBoot.port}`, root: oldDir });
      results.push({
        file: rel,
        own: rel === proofRel,
        new_ok: nr.ok,
        old_ok: or.ok,
        new_detail: String(nr.detail || "").slice(0, 300),
        old_detail: String(or.detail || "").slice(0, 300),
      });
    }
    out.suite = results;

    const verdict = consolidationVerdict(sizeMetrics(before), sizeMetrics(after), results, { retiring: retiring.length });
    out.preservation = {
      ok: verdict.gates.preserved.ok,
      detail:
        verdict.gates.preserved.detail +
        (out.skipped.length ? ` · ข้ามไฟล์พิสูจน์เก่า ${out.skipped.length} ไฟล์เพราะเกินเพดานชุดทดสอบ: ${out.skipped.join(", ")}` : ""),
    };
    out.shrink = { ok: verdict.gates.shrunk.ok, detail: verdict.gates.shrunk.detail };
    out.delta = verdict.delta;
    out.metrics = verdict.metrics;

    // The endpoints this round is retiring are excluded from the sweep here, because the
    // ledger entry that retires them is only written once the round is accepted.
    const sweep = effectiveRegressionEndpoints().filter((ep) => !retiring.includes(ep));
    out.regression = await regressionTest(newBoot.port, sweep);
  } catch (e) {
    out.preservation = { ok: false, detail: "ระบบพิสูจน์รอบยุบรวมล้มเหลว: " + e.message };
  } finally {
    if (newBoot) newBoot.stop();
    if (oldBoot) oldBoot.stop();
    setTimeout(() => {
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
      } catch {}
    }, 2000);
  }
  return out;
}

// How much growth has piled up since the engine last made itself smaller.
function roundsSinceConsolidation(ledger) {
  let n = 0;
  for (const e of ledger || []) {
    if (e && e.mode === "consolidation" && e.verdict === "accepted" && !e.rolled_back) break;
    if (e && e.verdict === "accepted" && !e.rolled_back) n++;
  }
  return n;
}

// Everything a consolidation round is judged on, readable before spending one.
function consolidationPlan(body = null) {
  const self = body || readSelf();
  const ledger = loadJson(EVO_FILE, []);
  const since = roundsSinceConsolidation(ledger);
  const endpoints = endpointLedger();
  const suite = Object.keys(self).filter((rel) => /^selftest\/.+\.js$/.test(rel)).sort();
  const last = ledger.find((e) => e && e.mode === "consolidation" && e.verdict === "accepted" && !e.rolled_back) || null;
  return {
    metrics: sizeMetrics(self),
    suite,
    suite_size: suite.length,
    suite_cap: CONSOLIDATE_SUITE_MAX,
    endpoints,
    retirement_candidates: endpoints.endpoints.filter((e) => e.retirable).map((e) => e.endpoint),
    rounds_since_consolidation: since,
    consolidate_every: CONSOLIDATE_EVERY,
    due: CONSOLIDATE_EVERY > 0 && since >= CONSOLIDATE_EVERY,
    last_consolidation: last ? { id: last.id, at: last.at, delta: last.delta || null } : null,
    shrink_keys: SHRINK_KEYS,
    no_growth_keys: NO_GROWTH_KEYS,
    rule: consolidationVerdict(null, null, []).rule,
  };
}

function buildConsolidationPrompt(evoId, plan, body, note = "") {
  const m = plan.metrics;
  return `คุณคือ "The Consolidator" — ชั้นที่ 6.6 ของ The Dot-Connector AI
รอบนี้ **ไม่ใช่รอบทำลายกำแพง** และไม่ใช่รอบเพิ่มความสามารถ — เป็น "รอบยุบรวม" (consolidation round)
ฟังก์ชันความเหมาะสมของรอบนี้กลับด้านกับรอบปกติทุกประการ:

  รอบขยาย (expansion)   ไฟล์พิสูจน์ต้อง "ผ่านกับโค้ดใหม่ และตกกับโค้ดเดิม"  → พิสูจน์ว่าทำสิ่งใหม่ได้
  รอบยุบรวม (รอบนี้)     ไฟล์พิสูจน์ต้อง "ผ่านทั้งกับโค้ดใหม่และโค้ดเดิม"     → พิสูจน์ว่าพฤติกรรมไม่เปลี่ยนเลย
                        + ตัวเลขขนาดต้องลดลงจริง                          → พิสูจน์ว่าเล็กลงจริง

ภารกิจ: ทำให้ระบบนี้ *เล็กลงและอ่านง่ายขึ้น* โดยที่ความสามารถทุกอย่างเท่าเดิมเป๊ะ
ห้ามเพิ่มความสามารถใหม่ในรอบนี้ (นั่นเป็นงานของรอบขยาย)

===== ขนาดปัจจุบันของตัวคุณเอง (ตัวเลขที่ต้องทำให้ลดลง) =====
ไฟล์โค้ด (ไม่นับ selftest/): ${m.code_files} ไฟล์ · ${m.code_lines} บรรทัด · ${m.code_chars} ตัวอักษร
ขนาดพรอมป์ตหลอมตัวเอง: ${m.prompt_chars} ตัวอักษร  ← นี่คือเพดานบริบทของตัวเอง ยิ่งเล็กยิ่งมีที่ให้คิด
endpoint ที่ยังต้อง sweep: ${m.endpoints} เส้น (ประกาศไว้ทั้งหมด ${plan.endpoints.declared} · ถอดไปแล้ว ${m.retired_endpoints})
ชุดทดสอบสะสมที่ต้องยังผ่านเหมือนเดิมทุกไฟล์: ${plan.suite.join(", ") || "(ยังไม่มี)"}
รอบขยายที่สะสมมาตั้งแต่รอบยุบรวมล่าสุด: ${plan.rounds_since_consolidation} รอบ
${note ? `\nคำสั่งเพิ่มเติมจากเจ้าของ: ${note}\n` : ""}
===== 🗂 บันทึกการใช้งานจริงของแต่ละ endpoint (ใช้รับรองว่าเส้นทางไหนตายแล้ว) =====
เริ่มนับเมื่อ ${plan.endpoints.tracking_since} (${plan.endpoints.tracking_hours} ชั่วโมงที่แล้ว)${
    plan.endpoints.young_ledger ? " ⚠ บันทึกยังใหม่มาก — ยังไม่ควรเชื่อว่า 0 ครั้งแปลว่าตายจริง ให้เลี่ยงการถอด endpoint ในรอบนี้" : ""
  }
${plan.endpoints.endpoints.map((e) => `  ${e.retired ? "🗑" : e.hits > 0 ? "✅" : "  "} ${e.endpoint} — ถูกเรียก ${e.hits} ครั้ง${e.last_hit ? ` (ล่าสุด ${e.last_hit})` : ""}${e.retirable ? " ← ถอดออกจาก sweep ได้" : ""}`).join("\n")}

เส้นทางที่ระบบรับรองว่าถอดได้ตอนนี้: ${plan.retirement_candidates.join(", ") || "(ไม่มี)"}
ถ้าคุณลบโค้ดของ endpoint ใด ต้องใส่ชื่อเส้นทางนั้นใน field "retire_endpoints" ด้วย
ระบบจะตรวจซ้ำเองว่าเส้นทางนั้นถูกเรียก 0 ครั้งจริงหรือไม่ — ถ้ามีคนเรียกอยู่ คำขอจะถูกปฏิเสธและ sweep จะจับได้ว่าคุณทำของพัง

===== ซอร์สโค้ดปัจจุบันของคุณ =====
${sourceBundle(promptBundle(body))}

===== วิธีทำงาน =====
ใช้เครื่องมือ Read / Edit / Write / Glob / Grep แก้ไฟล์จริงในโฟลเดอร์นี้ให้เสร็จสมบูรณ์
สิ่งที่ควรมองหา (เรียงจากคุ้มที่สุด):
1. โค้ดที่ตายแล้ว — ฟังก์ชัน/ตัวแปร/สาขาเงื่อนไขที่ไม่มีใครเรียกถึงอีก
2. ตรรกะซ้ำที่รวบเป็นฟังก์ชันเดียวได้ (เช่น รูปแบบการอ่าน/เขียน JSON, การประกอบบล็อกพรอมป์ตที่คล้ายกัน, ตัวช่วย HTTP ที่เขียนซ้ำ)
3. endpoint ที่ไม่มีใครเรียกเลยตามบันทึกด้านบน — ลบโค้ดของมันแล้วประกาศใน retire_endpoints
4. ความยาวของพรอมป์ตที่ระบบสร้างให้ตัวเอง (buildForgePrompt / buildConsolidationPrompt / buildIntrospectPrompt) — ตัดคำฟุ่มเฟือยโดยคงข้อมูลที่จำเป็นครบ
5. คอมเมนต์ที่ยาวเกินจำเป็นจนกลายเป็นภาระบริบท (แต่ **ห้าม** ลบคอมเมนต์ที่อธิบาย "ทำไม" ของกลไกความปลอดภัย)

===== ⚖ ไฟล์พิสูจน์ของรอบยุบรวม: กติกากลับด้าน =====
คุณต้องสร้าง \`selftest/${evoId}.js\` ตามสัญญาเดิมของระบบ (Node เปล่า · อ่าน DOT_TEST_URL/DOT_TEST_ROOT · จบใน 60 วินาที · ออฟไลน์)
แต่เนื้อหาต้องกลับด้านกับรอบขยาย: มันคือ **ชุดทดสอบพฤติกรรมที่ต้องผ่านทั้งกับโค้ดเดิมและโค้ดใหม่**
- ทดสอบพฤติกรรมที่คุณเพิ่งรวบ/ลบ/ทำให้เรียบง่ายลง ว่ายังทำงานเหมือนเดิมทุกประการ (ยิง HTTP จริง ตรวจรูปร่างข้อมูลจริง)
- ถ้ามันตกกับโค้ดเดิม แปลว่าคุณเปลี่ยนพฤติกรรม ไม่ใช่ยุบรวม → รอบนี้ถูกตีตกและย้อนกลับ
- ถ้ามันตกกับโค้ดใหม่ แปลว่าคุณทำของพัง → ตีตกและย้อนกลับเช่นกัน

ระบบจะรัน **ชุดทดสอบสะสมทั้งหมด** (${plan.suite_size} ไฟล์ · เพดาน ${plan.suite_cap} ไฟล์ต่อรอบ) กับทั้งสองเวอร์ชัน
ผลของทุกไฟล์ต้อง "เหมือนกันทั้งก่อนและหลัง" — มีไฟล์ไหนพลิกผลแม้ไฟล์เดียว = ตีตกทั้งรอบ
จากนั้นยิง regression sweep ทุก endpoint ที่ยังมีชีวิต ต้องได้ 200 ครบ
และตัวเลขขนาดต้องลดลงอย่างน้อยหนึ่งตัว (${SHRINK_KEYS.join(", ")}) โดยห้ามมีตัวไหนใน (${NO_GROWTH_KEYS.join(", ")}) โตขึ้น

กฎเหล็ก (ผิดข้อใดข้อหนึ่ง = ย้อนกลับทั้งรอบ):
1. ห้ามแก้ไฟล์ใน data/ เด็ดขาด — ความทรงจำของระบบ
2. ห้ามแตะไฟล์นอกโฟลเดอร์โปรเจกต์นี้ · ห้ามเพิ่ม dependency ภายนอก
3. ห้ามลบหรือแก้ไฟล์พิสูจน์ของรอบก่อนใน selftest/ (นั่นคือชุดทดสอบที่ค้ำระบบอยู่)
4. ห้ามแก้กลไกตรวจสอบให้อ่อนลง: proveEvolution, proveConsolidation, runProof, regressionTest, bootServer,
   materializeTree, consolidationVerdict, retireEndpoint, planRetirements, writeAttempted, attemptBudget
5. ห้ามแก้ evolution/deprecations.json หรือ evolution/endpoint-usage.json ด้วยมือ — เป็นบันทึกที่ระบบเขียนเอง
6. ต้องเคารพ DOT_SELFTEST=1 (ห้ามเริ่ม daemon ห้ามเรียก AI ตอนบูต)
7. ถ้าลบ endpoint ต้องอัปเดต public/index.html และ README.md ให้ตรงกัน — ห้ามเหลือปุ่มที่กดแล้ว 404
8. รักษาสไตล์เดิม: ภาษาไทยใน UI, ตัวแปร CSS เดิม, ไม่มี dependency

ตอบกลับเป็น JSON ล้วนเท่านั้นในข้อความสุดท้าย ทุก field เป็นภาษาไทย:
{
  "consolidated": true | false,
  "summary": "<ยุบรวมอะไรไปบ้าง — 2-3 ประโยค>",
  "what_changed": ["<ไฟล์: สิ่งที่รวบ/ลบไปแบบรูปธรรม>"],
  "removed": ["<สิ่งที่หายไปจากระบบ และเหตุผลว่าทำไมไม่มีใครใช้แล้ว>"],
  "retire_endpoints": ["<เส้นทางที่ขอถอดออกจาก regression sweep — ต้องถูกเรียก 0 ครั้งเท่านั้น>"],
  "behaviour_preserved": "<อธิบายว่าทำไมพฤติกรรมภายนอกยังเหมือนเดิมทุกประการ>",
  "proof_file": "selftest/${evoId}.js",
  "proof_explains": "<ไฟล์พิสูจน์นี้ยืนยันพฤติกรรมอะไร และทำไมมันต้องผ่านทั้งกับโค้ดเดิมและโค้ดใหม่>",
  "how_to_verify": "<เจ้าของกดดูตรงไหนถึงจะเห็นว่าระบบเล็กลงแต่ยังทำงานเหมือนเดิม>",
  "next_consolidation": "<รอบยุบรวมถัดไปควรไปแตะอะไรต่อ>"
}`;
}

/* ================= Layer 6.5: SCAR TISSUE =================
 * A failed round used to vanish twice: restoreBackup() deleted the code it wrote, and
 * nothing carried its lesson forward, so attempt #2 walked into the wall exactly as #1
 * did — then a hard `attempts < 3` filter banned the wall on three identical mistakes.
 *
 * Now the wound is kept: rejected code stays under evolution/backups/<evoId>/attempted/,
 * the exact gate that failed is extracted with its detail, and both go into the next
 * round's prompt with an explicit ban on repeating the approach. The ceiling becomes a
 * budget the wall earns — every failed round proposing a genuinely different approach
 * (different file set, or a description that is not a paraphrase) buys one more attempt,
 * up to a hard maximum. Repeating yourself still runs out.
 */
const FORGE_BASE_ATTEMPTS = 3;  // the old constant, now only the floor
const FORGE_MAX_ATTEMPTS = 6;   // even novelty cannot loop forever
const APPROACH_SAME_AT = 0.6;   // 4-gram overlap above which two write-ups are "the same idea"

const GATE_LABEL = {
  guard: "แตะไฟล์ความทรงจำที่ห้ามแก้",
  proof_written: "ไม่ได้เขียนไฟล์พิสูจน์",
  syntax: "syntax พัง",
  smoke: "บูตเซิร์ฟเวอร์ไม่ผ่าน",
  capability: "ความสามารถใหม่พิสูจน์ไม่ผ่าน",
  differential: "โค้ดเดิมก็ทำได้อยู่แล้ว — ไม่ได้ทำลายกำแพงจริง",
  regression: "ความสามารถเดิมพัง",
};

// Which gate actually stopped this round, with the detail the gate printed at the time.
function failedGates(entry) {
  const c = (entry && entry.checks) || {};
  return Object.keys(GATE_LABEL)
    .filter((gate) => c[gate] === false)
    .map((gate) => ({ gate, label: GATE_LABEL[gate], detail: String(c[gate + "_detail"] || "").slice(0, 400) }));
}

function approachText(entry) {
  const r = (entry && entry.report) || {};
  return [r.summary, r.new_capability, r.differs_from_previous, ...(Array.isArray(r.what_changed) ? r.what_changed : [])]
    .filter(Boolean)
    .join(" ");
}
// Character 4-grams, not words: the write-ups are Thai, which has no spaces to split on.
function shingles(text, n = 4) {
  const s = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return a.size === b.size ? 1 : 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}
function approachOf(entry) {
  const text = approachText(entry);
  return {
    files: (entry.files || []).map((f) => f.path).sort().join(" | "),
    text,
    grams: shingles(text),
  };
}
// Same files touched AND a description that is merely a paraphrase = the same attempt again.
function sameApproach(a, b) {
  return a.files === b.files && jaccard(a.grams, b.grams) >= APPROACH_SAME_AT;
}
function failedRounds(limitId, ledger) {
  return (ledger || [])
    .filter((e) => e && e.limit && e.limit.id === limitId && e.verdict !== "accepted")
    .slice()
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
}
function distinctApproaches(entries) {
  const kept = [];
  for (const e of entries) {
    const a = approachOf(e);
    if (!kept.some((k) => sameApproach(k, a))) kept.push(a);
  }
  return kept.length;
}

// The movable ceiling. Three tries is where a wall starts, not where it dies:
// each genuinely different failed approach buys one more, capped at FORGE_MAX_ATTEMPTS.
function attemptBudget(limit, ledger) {
  const failures = failedRounds(limit.id, ledger);
  const distinct = distinctApproaches(failures);
  const attempts = Math.max(Number(limit.attempts) || 0, failures.length);
  const earned = Math.max(0, Math.min(FORGE_MAX_ATTEMPTS - FORGE_BASE_ATTEMPTS, distinct - 1));
  const cap = FORGE_BASE_ATTEMPTS + earned;
  const left = Math.max(0, cap - attempts);
  return {
    attempts,
    failed_attempts: failures.length,
    distinct_approaches: distinct,
    base: FORGE_BASE_ATTEMPTS,
    earned,
    cap,
    left,
    max: FORGE_MAX_ATTEMPTS,
    exhausted: left <= 0,
    note:
      `เพดานขยับได้: พื้นฐาน ${FORGE_BASE_ATTEMPTS} ครั้ง และทุกครั้งที่รอบที่ตก "เสนอวิธีที่ต่างจากเดิมจริง" ` +
      `จะได้โควตาเพิ่มอีก 1 ครั้ง (สูงสุด ${FORGE_MAX_ATTEMPTS}) — ลองวิธีเดิมซ้ำจะไม่ได้เพิ่ม`,
  };
}

// The code a rejected round wrote, kept after the tree was rolled back.
function listAttempted(evoId) {
  const dir = path.join(EVO_DIR, "backups", evoId, "attempted");
  const out = [];
  const walk = (abs, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), child);
      else if (child !== "index.json") {
        try {
          const c = fs.readFileSync(path.join(abs, e.name), "utf8");
          out.push({ path: child, lines: c.split("\n").length, bytes: c.length });
        } catch {}
      }
    }
  };
  walk(dir, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Rolled back on disk, not erased from the record: what this round actually wrote.
function writeAttempted(evoId, after, changes) {
  const dir = path.join(EVO_DIR, "backups", evoId, "attempted");
  const index = [];
  for (const ch of changes) {
    const content = after[ch.path];
    if (ch.action === "deleted" || typeof content !== "string") {
      index.push({ path: ch.path, action: ch.action, lines: ch.lines, saved: false });
      continue;
    }
    const dest = path.join(dir, ch.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf8");
    index.push({ path: ch.path, action: ch.action, lines: ch.lines, bytes_delta: ch.bytes_delta, saved: true });
  }
  if (index.length) {
    fs.mkdirSync(dir, { recursive: true });
    saveJson(path.join(dir, "index.json"), index);
  }
  return `evolution/backups/${evoId}/attempted`;
}

function failureDossier(limitId, ledger) {
  return failedRounds(limitId, ledger).map((e, i) => {
    const r = e.report || {};
    return {
      round: i + 1,
      evo_id: e.id,
      at: e.at,
      reason: String(e.reason || "").slice(0, 600),
      failed_gates: failedGates(e),
      files: (e.files || []).map((f) => ({ path: f.path, action: f.action, lines: f.lines })),
      approach: String(r.summary || "").slice(0, 700),
      what_changed: (Array.isArray(r.what_changed) ? r.what_changed : []).slice(0, 12).map((s) => String(s).slice(0, 300)),
      claimed_capability: String(r.new_capability || "").slice(0, 300),
      differs_from_previous: String(r.differs_from_previous || "").slice(0, 300),
      attempted_dir: `evolution/backups/${e.id}/attempted`,
      attempted_files: listAttempted(e.id),
    };
  });
}

// The block the next round reads before it touches a single line.
function buildFailureBlock(dossier, budget) {
  if (!dossier.length) {
    return `===== 🩹 ประวัติความล้มเหลวของกำแพงนี้ =====
ยังไม่เคยมีรอบไหนล้มเหลวกับกำแพงนี้ — รอบนี้คือครั้งแรก (เพดานตอนนี้ ${budget.cap} ครั้ง เหลืออีก ${budget.left} ครั้ง)
${budget.note}`;
  }
  const rounds = dossier
    .map(
      (d) => `--- ครั้งที่ ${d.round} · ${d.evo_id} · ${d.at} ---
วิธีที่ลองไปแล้ว: ${d.approach || "(รอบนั้นไม่ได้สรุปวิธีไว้)"}
${d.what_changed.length ? "สิ่งที่แก้จริง:\n" + d.what_changed.map((w) => "  · " + w).join("\n") + "\n" : ""}${
        d.claimed_capability ? "ความสามารถที่รอบนั้นอ้างว่าได้: " + d.claimed_capability + "\n" : ""
      }${d.differs_from_previous ? "รอบนั้นอ้างว่าต่างจากรอบก่อนตรงที่: " + d.differs_from_previous + "\n" : ""}ไฟล์ที่แตะ: ${
        d.files
          .map((f) => `${f.path} (${f.action}${Number.isFinite(f.lines) ? `, ${f.lines >= 0 ? "+" : ""}${f.lines} บรรทัด` : ""})`)
          .join(", ") || "(ไม่มีไฟล์ถูกแก้)"
      }
❌ ตกที่ด่าน: ${
        d.failed_gates.length
          ? d.failed_gates.map((g) => `${g.label}${g.detail ? "\n     ↳ " + g.detail : ""}`).join("\n   · ")
          : "(ไม่ระบุด่าน)"
      }
เหตุผลที่ถูกตีตก: ${d.reason}
โค้ดที่ลองแล้วไม่ผ่านยังอยู่ครบที่ ${d.attempted_dir}/ ${
        d.attempted_files.length
          ? "(" + d.attempted_files.map((f) => `${f.path} ${f.lines} บรรทัด`).join(", ") + ") — เปิดอ่านด้วย Read ก่อนลงมือ"
          : "(รอบนั้นไม่ได้เก็บสำเนาไฟล์ไว้)"
      }`
    )
    .join("\n\n");

  return `===== 🩹 ประวัติความล้มเหลวของกำแพงนี้ (อ่านให้จบก่อนแตะโค้ดแม้แต่บรรทัดเดียว) =====
กำแพงนี้ถูกลองมาแล้ว ${budget.attempts} ครั้ง · ตก ${dossier.length} ครั้ง · เป็นวิธีที่ต่างกันจริง ${budget.distinct_approaches} แบบ
เพดานของกำแพงนี้ตอนนี้ ${budget.cap} ครั้ง (พื้นฐาน ${budget.base} + ได้เพิ่มจากการเสนอวิธีใหม่จริง ${budget.earned}) เหลืออีก ${budget.left} ครั้ง

${rounds}

⛔ กติกาบังคับของรอบนี้ — ห้ามใช้วิธีเดิมซ้ำ:
1. ห้ามใช้วิธีเดิมซ้ำ: ห้ามแก้ชุดไฟล์เดิมด้วยตรรกะเดิมที่เคยตกมาแล้ว ถ้าแนวทางของคุณเป็นแค่การเขียนของเดิมให้สวยขึ้น รอบนี้จะตกซ้ำที่ด่านเดิม
2. ก่อนตัดสินใจ ให้ใช้ Read เปิดอ่านโค้ดที่เคยลองแล้วไม่ผ่านใน evolution/backups/<evo-id>/attempted/ ให้ครบทุกรอบด้านบน
3. โจมตีสาเหตุที่ทำให้รอบก่อนตกโดยตรง (ด่านที่ตกและข้อความของด่านระบุไว้ให้แล้ว) ไม่ใช่แค่ทำสิ่งเดิมอีกครั้งอย่างระมัดระวังขึ้น
4. ในผลลัพธ์ JSON ต้องมี field "differs_from_previous" อธิบายว่ารอบนี้ต่างจากทุกรอบที่ตกไปแล้วอย่างไร ทั้งในเชิงไฟล์ที่แตะและเชิงกลไก
   ${budget.note}`;
}

function forgeHistory(limit, ledger) {
  const budget = attemptBudget(limit, ledger);
  const dossier = failureDossier(limit.id, ledger);
  return { budget, dossier, block: buildFailureBlock(dossier, budget) };
}

// One place decides who is next, so the daemon, the API and the forge agree on the ceiling.
function selectTarget(limits, ledger) {
  return (
    (limits || [])
      .filter((l) => l.status !== "broken" && !attemptBudget(l, ledger).exhausted)
      .sort((a, b) => b.unlock_score - b.risk / 2 - (a.unlock_score - a.risk / 2))[0] || null
  );
}

/* ---- Layer 6 prompts ---- */
function sourceBundle(body) {
  return Object.entries(body)
    .map(([rel, content]) => `--- FILE: ${rel} (${content.split("\n").length} บรรทัด) ---\n${content}`)
    .join("\n\n");
}

// Past proof files are real source, but the bundle only needs the newest one as a worked example.
function promptBundle(body) {
  const proofs = Object.keys(body).filter((rel) => rel.startsWith("selftest/"));
  const keep = proofs.sort().slice(-1);
  const trimmed = {};
  for (const [rel, content] of Object.entries(body)) {
    if (proofs.includes(rel) && !keep.includes(rel)) continue;
    trimmed[rel] = content;
  }
  return trimmed;
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
${sourceBundle(promptBundle(body))}

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

function buildForgePrompt(limit, body, evoId, history = null) {
  const hist = history || { budget: attemptBudget(limit, []), dossier: [], block: "" };
  const block = hist.block || buildFailureBlock(hist.dossier || [], hist.budget);
  return `คุณคือ "The Self-Forge" — ชั้นที่ 6 ของ The Dot-Connector AI
คุณกำลังจะแก้ไข *ซอร์สโค้ดของตัวคุณเอง* ที่รันอยู่จริงบนเครื่องผู้ใช้ ในโฟลเดอร์ปัจจุบัน (cwd)

===== ขอบเขตที่ต้องทำลายในรอบนี้ =====
ชื่อ: ${limit.title}
หมวด: ${limit.category}
กำแพงคืออะไร: ${limit.description}
ฝังอยู่ตรงไหน: ${limit.evidence}
ทำไมมันยังอยู่: ${limit.why_it_stands}
แนวทางทำลายที่ระบบวิเคราะห์ตัวเองไว้: ${limit.break_idea}

${block}

===== ซอร์สโค้ดปัจจุบันของคุณ =====
${sourceBundle(promptBundle(body))}

===== วิธีทำงาน =====
ใช้เครื่องมือ Read / Edit / Write / Glob / Grep แก้ไฟล์จริงในโฟลเดอร์นี้ให้เสร็จสมบูรณ์
งานนี้ไม่ใช่ข้อเสนอ — ต้องลงมือแก้โค้ดจริงให้ใช้งานได้ทันที

===== ⚖ ข้อบังคับสำคัญที่สุดของรอบนี้: ต้องเขียน "ไฟล์พิสูจน์" ที่รันได้จริง =====
รอบนี้จะไม่ถูกตัดสินว่าสำเร็จเพียงเพราะโค้ดยังบูตได้ — คุณต้องพิสูจน์ด้วยโค้ดว่า "เก่งขึ้นจริง"
คุณต้องสร้างไฟล์ใหม่ชื่อ \`selftest/${evoId}.js\` (เขียนด้วย Write ในโฟลเดอร์ selftest/)

สัญญาของไฟล์นี้:
- เป็นสคริปต์ Node.js ล้วน ไม่มี dependency ภายนอก รันด้วย \`node selftest/${evoId}.js\`
- ระบบจะบูตเซิร์ฟเวอร์จากโค้ดที่จะทดสอบให้ก่อน แล้วส่งค่าให้ผ่าน environment variable:
  · \`process.env.DOT_TEST_URL\`  = base URL ของเซิร์ฟเวอร์ที่รันอยู่แล้ว เช่น http://127.0.0.1:53411
  · \`process.env.DOT_TEST_ROOT\` = พาธของซอร์สทรีที่กำลังถูกทดสอบ (ใช้ตัวนี้เสมอ ห้ามใช้ __dirname หรือพาธตายตัว)
- **ต้องออกด้วย exit code 0 เมื่อความสามารถใหม่ "มีอยู่และใช้ได้จริง" และ exit code ที่ไม่ใช่ 0 เมื่อไม่มี**
  (ใช้ process.exit(1) หรือ throw ก็ได้ · พิมพ์เหตุผลออก stdout/stderr เพื่อให้มนุษย์อ่านย้อนหลังได้)
- ต้องเสร็จภายใน 60 วินาที · ห้ามเขียนไฟล์นอก DOT_TEST_ROOT · ห้ามเรียก AI/ออกอินเทอร์เน็ต (ทดสอบต้องรันได้ออฟไลน์)
- ต้องทดสอบ *พฤติกรรมจริง* ของความสามารถใหม่ (ยิง HTTP ไปที่ DOT_TEST_URL แล้วตรวจผลลัพธ์ / อ่านไฟล์ที่ระบบสร้าง)
  ห้ามทดสอบแบบขอไปที เช่น grep หาชื่อฟังก์ชันในซอร์ส หรือเช็กว่าไฟล์มีอยู่เฉย ๆ

ระบบจะรันไฟล์นี้ **สองครั้ง** แล้วเทียบผล:
  1. กับโค้ดใหม่ของคุณ → **ต้องผ่าน (exit 0)**
  2. กับโค้ดเดิมก่อนรอบนี้ ที่ถูกสร้างขึ้นใหม่จาก evolution/backups/${evoId} → **ต้องตก (exit ≠ 0)**
ถ้ามันผ่านทั้งสองแบบ แปลว่าความสามารถนี้มีอยู่ก่อนแล้ว = ไม่ได้ทำลายกำแพงจริง = รอบนี้ถูกตีตกและย้อนกลับ
ดังนั้นไฟล์พิสูจน์ต้องเจาะจงไปที่ "สิ่งที่เพิ่งทำได้" ไม่ใช่สิ่งที่ระบบทำได้อยู่แล้ว

จากนั้นระบบจะยิง regression ทุก endpoint ที่ยังมีชีวิต (${effectiveRegressionEndpoints().join(", ")}) ต้องได้ 200 ครบทุกเส้น
ขาดข้อใดข้อหนึ่ง = rejected + ย้อนโค้ดกลับทั้งหมดอัตโนมัติ

กฎเหล็ก (ผิดข้อใดข้อหนึ่ง = รอบนี้ถูกยกเลิกและย้อนกลับทั้งหมด):
1. ห้ามแก้ไฟล์ใน data/ เด็ดขาด — นั่นคือความทรงจำของระบบ (dots.json, connections.json, evolution.json, limits.json, serendipity.json)
2. ห้ามแตะไฟล์นอกโฟลเดอร์โปรเจกต์นี้ ห้ามแก้ไฟล์ระบบของผู้ใช้ ห้ามรันคำสั่งที่ลบข้อมูล
3. ห้ามเพิ่ม dependency ภายนอก — ระบบนี้ต้องรันด้วย node เปล่า ๆ (ใช้ได้เฉพาะโมดูลมาตรฐานของ Node)
4. ห้ามลบหรือทำให้ความสามารถเดิมพัง — Layer 0-6 ทุกชั้น, ทุก endpoint ที่ยังมีชีวิต และหน้าเว็บต้องยังทำงานได้เหมือนเดิม
   (ถ้าสิ่งที่คุณอยากทำคือ "รวบโค้ดซ้ำ / ลบของที่ไม่มีใครใช้ / ทำให้เล็กลง" นั่นไม่ใช่รอบนี้ —
    ระบบมีรอบยุบรวม (consolidation round) ที่ POST /api/consolidate ซึ่งใช้ฟังก์ชันความเหมาะสมกลับด้าน
    คือชุดทดสอบต้องผ่านทั้งก่อนและหลัง แล้ววัดผลด้วยตัวเลขขนาดที่ลดลง — อย่าพยายามทำงานนั้นในรอบขยายนี้)
5. server.js ต้องยังบูตได้ด้วย \`node server.js\` และตอบ GET /api/dots ได้ (ระบบจะทดสอบบูตจริงหลังคุณทำเสร็จ ถ้าไม่ผ่านจะย้อนกลับอัตโนมัติ)
6. ต้องเคารพตัวแปร DOT_SELFTEST: เมื่อ DOT_SELFTEST=1 ห้ามเริ่ม daemon และห้ามเรียก AI ใด ๆ ตอนบูต
7. ถ้าเพิ่ม endpoint หรือความสามารถใหม่ ต้องต่อ UI ใน public/index.html ให้ผู้ใช้ใช้ได้จริง และอัปเดต README.md
8. รักษาสไตล์เดิม: ภาษาไทยใน UI, โทนสี/ตัวแปร CSS เดิม, โค้ดสะอาดอ่านง่าย, ไม่มี dependency
9. ต้องมีไฟล์ \`selftest/${evoId}.js\` ตามสัญญาด้านบน — ไม่มีไฟล์นี้ = รอบนี้ถูกตีตกทันที ไม่ว่าโค้ดจะดีแค่ไหน
10. ห้ามแก้/ลบไฟล์พิสูจน์ของรอบก่อน ๆ ใน selftest/ และห้ามแก้กลไกตรวจสอบใน server.js
    (proveEvolution, runProof, regressionTest, bootServer, materializeTree) ให้อ่อนลงเพื่อให้ตัวเองผ่านง่ายขึ้น
11. ห้ามแก้กลไกความจำของความล้มเหลวให้อ่อนลงเพื่อซื้อโอกาสให้ตัวเอง
    (writeAttempted, failureDossier, attemptBudget, selectTarget, buildFailureBlock) และห้ามลบโฟลเดอร์ attempted/ ของรอบก่อน

เมื่อแก้เสร็จแล้ว ให้ตอบกลับเป็น JSON ล้วนเท่านั้นในข้อความสุดท้าย (ห้ามมีข้อความอื่นนอก JSON) ทุก field เป็นภาษาไทย:
{
  "broke_it": true | false,
  "summary": "<ทำลายกำแพงนี้ได้อย่างไร — 2-3 ประโยค>",
  "differs_from_previous": "<รอบนี้ต่างจากรอบที่เคยตกกับกำแพงนี้อย่างไร ทั้งไฟล์ที่แตะและกลไกที่ใช้ — ถ้าเป็นครั้งแรกให้บอกว่ายังไม่มีรอบก่อน>",
  "what_changed": ["<ไฟล์: สิ่งที่แก้ไปแบบรูปธรรม>"],
  "new_capability": "<ตอนนี้ระบบทำอะไรได้ที่เมื่อวานทำไม่ได้ — 1-2 ประโยค พูดให้ผู้ใช้เข้าใจทันที>",
  "proof_file": "selftest/${evoId}.js",
  "proof_explains": "<ไฟล์พิสูจน์นี้ทดสอบอะไร และทำไมโค้ดเดิมถึงต้องตกการทดสอบนี้ — 1-2 ประโยค>",
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

// The pseudo-boundary a consolidation round works against. It is never "broken" and never
// enters limits.json: shrinking is not a wall you get past once, it is maintenance forever.
const CONSOLIDATION_TARGET = {
  id: "consolidation",
  title: "รอบยุบรวม: ทำให้ตัวเองเล็กลงโดยไม่เสียความสามารถ",
  category: "architecture",
};

async function attemptEvolution({ limitId = null, auto = false, mode = "expansion", note = "" } = {}) {
  if (forging) throw Object.assign(new Error("Self-Forge กำลังทำงานอยู่แล้ว รอรอบปัจจุบันให้จบก่อน"), { status: 409 });
  forging = true;
  const consolidating = mode === "consolidation";
  const evoId = "evo_" + crypto.randomBytes(4).toString("hex");
  const before = readSelf();
  const guarded = readGuarded();
  const ledger = loadJson(EVO_FILE, []);
  let limits = loadJson(LIMITS_FILE, []);
  let retirePlan = { requested: [], approved: [], refused: [] };

  try {
    // 1. Pick what this round is aimed at. An expansion round picks the boundary worth
    //    breaking (highest unlock, lowest fatigue); a consolidation round aims at the
    //    engine's own size and needs no boundary at all.
    let target = CONSOLIDATION_TARGET;
    let history = null;
    let plan = null;
    let prompt = "";
    if (consolidating) {
      plan = consolidationPlan(before);
      prompt = buildConsolidationPrompt(evoId, plan, before, note);
    } else {
      if (!limits.some((l) => l.status !== "broken")) {
        await introspect();
        limits = loadJson(LIMITS_FILE, []);
      }
      target = limitId ? limits.find((l) => l.id === limitId) : selectTarget(limits, ledger);
      if (!target) {
        throw Object.assign(new Error("ไม่มีขอบเขตที่รอทำลายอยู่ — กด \"วิเคราะห์ขอบเขตตัวเอง\" ก่อน"), { status: 400 });
      }
      // 2. Hand this round every scar the wall has left: why each past attempt fell, at which
      //    gate, and where its rejected code is still readable. Attempt #2 must not be #1 again.
      history = forgeHistory(target, ledger);
      prompt = buildForgePrompt(target, before, evoId, history);
    }

    fs.mkdirSync(PROOF_DIR, { recursive: true });
    let raw;
    try {
      raw = await runClaude(prompt, {
        model: FORGE_MODEL,
        tools: ["Read", "Edit", "Write", "Glob", "Grep"],
        permissionMode: "acceptEdits",
        timeoutMs: FORGE_TIMEOUT_MS,
      });
    } catch (e) {
      // The AI died mid-flight (timeout, crash, killed). Whatever it already wrote never
      // faced a single gate — half-written code must never be left standing just because
      // nobody was there to judge it. Keep a copy for forensics, then put the tree back.
      const abandoned = diffSelf(before, readSelf());
      let salvage = null;
      if (abandoned.length) {
        salvage = writeBackup(evoId, before, abandoned);
        try {
          writeAttempted(evoId, readSelf(), abandoned);
        } catch {}
        restoreBackup(evoId);
      }
      restoreGuarded(guarded);
      const dead = {
        id: evoId,
        at: new Date().toISOString(),
        model: FORGE_MODEL,
        auto,
        limit: { id: target.id, title: target.title, category: target.category },
        report: { broke_it: false, summary: "รอบนี้ไม่จบ: " + e.message },
        files: abandoned,
        checks: { completed: false },
        backup: salvage,
        verdict: "rejected",
        reason: `AI หยุดกลางรอบ (${e.message}) — โค้ดที่เขียนค้างไว้ ${abandoned.length} ไฟล์ถูกย้อนกลับทั้งหมด (เก็บสำเนาไว้อ่านได้ที่ evolution/backups/${evoId}/attempted)`,
        rolled_back: true,
      };
      ledger.unshift(dead);
      saveJson(EVO_FILE, ledger);
      if (!consolidating) {
        saveJson(
          LIMITS_FILE,
          limits.map((l) => (l.id === target.id ? { ...l, attempts: (l.attempts || 0) + 1 } : l))
        );
      }
      const st = loadState();
      slog(st, `Self-Forge ตายกลางรอบ: ${e.message} — ย้อนไฟล์ที่เขียนค้าง ${abandoned.length} ไฟล์กลับแล้ว`);
      saveState(st);
      throw Object.assign(new Error(dead.reason), { status: 504, evolution: dead });
    }
    let report = {};
    try {
      report = extractJson(raw);
    } catch {
      report = { broke_it: true, summary: raw.slice(0, 600) };
    }

    // 3. What actually changed on disk (the report is a claim; this is the fact).
    const after = readSelf();
    const changes = diffSelf(before, after);
    const backup = writeBackup(evoId, before, changes);
    const violations = restoreGuarded(guarded);

    const proofRel = `selftest/${evoId}.js`;
    const entry = {
      id: evoId,
      at: new Date().toISOString(),
      model: FORGE_MODEL,
      auto,
      // Which fitness function judged this round — the ledger must never be ambiguous
      // about whether "the proof passed on both trees" was a failure or the whole point.
      mode: consolidating ? "consolidation" : "expansion",
      limit: { id: target.id, title: target.title, category: target.category },
      report,
      files: changes,
      checks: {},
      proof_file: proofRel,
      backup,
      // What this round was told about the wall's past — auditable after the fact.
      history_used: history
        ? {
            rounds: history.dossier.map((d) => d.evo_id),
            attempts_before: history.budget.attempts,
            cap: history.budget.cap,
            left: history.budget.left,
            distinct_approaches: history.budget.distinct_approaches,
          }
        : null,
      verdict: "rejected",
      reason: "",
    };
    if (consolidating) entry.plan_before = plan ? plan.metrics : null;

    // 4. Verify. "Still alive" is only the first gate — the last three ask whether it got better:
    //    the proof must pass on the new code, fail on the old code, and every old endpoint must survive.
    if (!changes.length) {
      entry.reason = "ไม่มีไฟล์ใดถูกแก้จริง — รอบนี้ไม่นับเป็นวิวัฒนาการ";
    } else if (violations.length) {
      restoreBackup(evoId);
      entry.reason = "แตะไฟล์ความทรงจำที่ห้ามแก้ (" + violations.join(", ") + ") — ย้อนกลับทั้งหมดแล้ว";
      entry.checks.guard = false;
    } else if (!(proofRel in after)) {
      restoreBackup(evoId);
      entry.checks.proof_written = false;
      entry.reason = `ไม่ได้เขียนไฟล์พิสูจน์ ${proofRel} — พิสูจน์ไม่ได้ว่าเก่งขึ้นจริง จึงย้อนกลับทั้งหมด`;
    } else {
      entry.checks.proof_written = true;
      // Keep a copy of the proof even if this round gets rolled back — a failed proof is evidence too.
      try {
        fs.mkdirSync(path.join(EVO_DIR, "backups", evoId), { recursive: true });
        fs.writeFileSync(path.join(EVO_DIR, "backups", evoId, "proof.js"), after[proofRel], "utf8");
      } catch {}
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
          // The two fitness functions ask three questions each and differ only in which
          // three. Expansion: "the new code can, the old code cannot, nothing broke."
          // Consolidation (inverted): "everything still works, it got smaller, nothing broke."
          // Every gate is still evaluated and every failure still rolls the round back —
          // only the bookkeeping around them is shared.
          let proof;
          let gates;
          if (consolidating) {
            retirePlan = planRetirements(report.retire_endpoints);
            proof = await proveConsolidation(evoId, before, after, guarded, { retiring: retirePlan.approved });
            gates = [
              ["preservation", "พฤติกรรมไม่เหมือนเดิม (ชุดทดสอบต้องผ่านทั้งก่อนและหลัง)"],
              ["shrink", "ไม่ได้เล็กลงจริงตามตัวเลข"],
              ["regression", "ความสามารถเดิมพัง"],
            ];
            entry.suite = proof.suite;
            entry.metrics = proof.metrics;
            entry.delta = proof.delta;
            entry.retirements = retirePlan;
          } else {
            proof = await proveEvolution(evoId, before, after, guarded);
            gates = [
              ["capability", "ความสามารถใหม่พิสูจน์ไม่ผ่าน"],
              ["differential", "พิสูจน์ไม่ได้ว่าโค้ดเดิมทำไม่ได้"],
              ["regression", "ความสามารถเดิมพัง"],
            ];
          }
          for (const [name] of gates) {
            entry.checks[name] = proof[name].ok;
            entry.checks[name + "_detail"] = proof[name].detail;
          }
          entry.checks.regression_endpoints = proof.regression.results || [];

          const failed = gates.filter(([name]) => !proof[name].ok).map(([, why]) => why);
          if (failed.length) {
            restoreBackup(evoId);
            entry.reason = failed.join(" · ") + " — ย้อนกลับอัตโนมัติแล้ว";
          } else {
            entry.verdict = "accepted";
            entry.reason = consolidating
              ? "ผ่านทุกด่านของรอบยุบรวม: ไม่แตะความทรงจำ · syntax ผ่าน · บูตจริงได้ · " +
                `ชุดทดสอบ ${proof.suite.length} ไฟล์ให้ผลเหมือนกันทั้งก่อนและหลัง · ` +
                `เล็กลงจริง (${proof.delta ? `code_lines ${proof.delta.code_lines}, prompt_chars ${proof.delta.prompt_chars}` : "?"}) · endpoint ที่ยังมีชีวิตครบทุกเส้น`
              : "ผ่านทุกด่าน: ไม่แตะความทรงจำ · syntax ผ่าน · บูตจริงได้ · ไฟล์พิสูจน์ผ่านกับโค้ดใหม่และตกกับโค้ดเดิม · endpoint เดิมครบทุกเส้น";
          }
        }
      }
    }

    // 5. Bookkeeping — and feed the win back into its own knowledge base.
    const state = loadState();
    if (entry.verdict === "accepted" && consolidating) {
      // Only now do the certified-dead endpoints actually leave the sweep — and only the
      // ones the ledger approved, each recorded with the round that retired it.
      const retired = [];
      for (const ep of retirePlan.approved) {
        const r = retireEndpoint(ep, { by: "consolidation:" + evoId, reason: String(report.summary || "").slice(0, 200) });
        if (r.ok) retired.push(ep);
      }
      entry.retirements = { ...retirePlan, applied: retired };
      state.last_evolution = entry.at;
      state.last_consolidation = entry.at;
      state.restart_required = true;
      const d = entry.delta || {};
      slog(
        state,
        `🧹 รอบยุบรวมสำเร็จ: โค้ด ${d.code_lines} บรรทัด · พรอมป์ต ${d.prompt_chars} ตัวอักษร · ` +
          `endpoint ${d.endpoints}${retired.length ? ` (ถอด ${retired.join(", ")})` : ""} — รีสตาร์ตเพื่อใช้โค้ดใหม่`
      );
      // Shrinking is knowledge about itself too — it goes back into the repository like a win.
      const dots = loadJson(DOTS_FILE, []);
      dots.push({
        id: "dot_" + crypto.randomBytes(4).toString("hex"),
        title: `ยุบรวมตัวเอง: ${d.code_lines || 0} บรรทัด`,
        domain: "ระบบตัวเอง",
        content:
          `${report.summary || "รอบยุบรวมที่ทำให้ระบบเล็กลงโดยพฤติกรรมไม่เปลี่ยน"} ` +
          `(หลักการ: ความคืบหน้าไม่จำเป็นต้องแปลว่าใหญ่ขึ้น — พิสูจน์ด้วยชุดทดสอบเดิมที่ผ่านทั้งก่อนและหลัง แล้ววัดด้วยตัวเลขขนาดที่ลดลง)`,
        created_at: new Date().toISOString(),
        source: "self-forge:" + evoId,
        origin: ORIGIN.forge,
      });
      saveJson(DOTS_FILE, dots);
      entry.dot_created = true;
      toast(
        `🧹 ระบบยุบรวมตัวเองสำเร็จ (${d.code_lines || 0} บรรทัด)`,
        `${report.new_capability || report.summary || "พฤติกรรมเท่าเดิม แต่เล็กลง"} — เปิด http://localhost:${PORT} แล้วกดรีสตาร์ตเครื่องยนต์`
      );
    } else if (entry.verdict === "accepted") {
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
          origin: ORIGIN.forge,
        });
        saveJson(DOTS_FILE, dots);
        entry.dot_created = true;
      }
      toast(
        `🔥 ระบบทำลายขอบเขตตัวเองได้: ${target.title}`,
        `${report.new_capability || "ความสามารถใหม่ถูกเพิ่มแล้ว"} — เปิด http://localhost:${PORT} แล้วกดรีสตาร์ตเครื่องยนต์`
      );
    } else {
      // The round is rolled back on disk — but not erased. Its code, its gate and its
      // reasoning are kept so the next attempt on this wall starts where this one stopped.
      if (changes.length) entry.attempted = writeAttempted(evoId, after, changes);
      if (consolidating) {
        // A consolidation round has no wall and therefore no attempt budget to burn:
        // being unable to shrink today never costs the engine a try at anything else.
        slog(state, `🧹 รอบยุบรวมไม่ผ่าน: ${entry.reason} · เก็บโค้ดที่ลองไว้ที่ ${entry.attempted || "(ไม่มีไฟล์)"}`);
      } else {
        limits = limits.map((l) => (l.id === target.id ? { ...l, attempts: (l.attempts || 0) + 1 } : l));
        // Did this failure buy the wall another try? Only if it was a genuinely new approach.
        const budgetAfter = attemptBudget(limits.find((l) => l.id === target.id) || target, [entry, ...ledger]);
        entry.budget_after = budgetAfter;
        slog(
          state,
          `Self-Forge ไม่ผ่านรอบนี้ (${target.title}): ${entry.reason} · ` +
            `เก็บโค้ดที่ลองไว้ที่ ${entry.attempted || "(ไม่มีไฟล์)"} · ` +
            `โควตากำแพงนี้ ${budgetAfter.attempts}/${budgetAfter.cap}` +
            (budgetAfter.left > 0
              ? ` (เหลืออีก ${budgetAfter.left} ครั้ง — รอบหน้าจะได้อ่านว่ารอบนี้ตกเพราะอะไร)`
              : " (ครบเพดาน — ต้องเสนอวิธีที่ต่างจากเดิมจริงเพื่อขยับเพดาน)")
        );
      }
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
  const result = { harvested: 0, connected: false, notified_forgotten: 0, scouted_evidence: 0, scouted_web: 0 };
  try {
    // 1. Layer 0: harvest new dots from the inbox
    const harvested = await processInbox(state);
    result.harvested = harvested.length;

    // 1.5 Layer 7: The Scout. First the free half — every "similar_found" the Evidence
    // Agent already paid a web search for becomes a real dot instead of a footnote.
    const scouted = harvestEvidenceDots({ state });
    result.scouted_evidence = scouted.length;
    if (scouted.length) {
      slog(state, `The Scout: กู้หลักฐานที่เคยค้นเจอกลับมาเป็นจุดใหม่ ${scouted.length} จุด: ${scouted.map((d) => d.title).join(", ")}`);
    }

    // Then the half that leaves the house: the engine reads its own domain census,
    // writes its own query, and goes looking for a domain it has never had a dot in.
    const scoutHoursSince = scoutState(state).last_web_scout
      ? (Date.now() - new Date(scoutState(state).last_web_scout).getTime()) / 3600000
      : Infinity;
    let scoutedWeb = [];
    if (SCOUT_HOURS > 0 && scoutHoursSince >= SCOUT_HOURS) {
      try {
        const run = await scoutWeb({ state });
        scoutedWeb = run.created;
        result.scouted_web = run.created.length;
        result.scout_query = run.gap.query;
        slog(state, `The Scout ออกไปค้นเว็บเองในโดเมน "${run.gap.domain}" → ได้จุดใหม่ ${run.created.length} จุด`);
        if (run.created.length) {
          toast(
            `🌐 The Scout หาความรู้ใหม่มาเอง: ${run.gap.domain}`,
            `${run.created.map((d) => d.title).join(", ")} — เปิด http://localhost:${PORT} เพื่อดูหรือปฏิเสธ`
          );
        }
      } catch (e) {
        slog(state, "The Scout ออกไปค้นเว็บไม่สำเร็จ: " + e.message);
        result.scout_error = e.message;
      }
    }
    const selfFound = [...scouted, ...scoutedWeb];

    // 2. Loss-aversion notifications for dots about to be forgotten
    const enriched = enrichDots(loadJson(DOTS_FILE, []), loadJson(CONN_FILE, []));
    const forgotten = enriched.filter((d) => d.forgotten).sort((a, b) => b.attention_score - a.attention_score);
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
      // Dots the system found for itself are not a user action, so they wait for the same
      // cost guard as a forgotten-dot revival before they may spend an Opus round.
      ((selfFound.length > 0 || forgotten.length > 0) && hoursSince >= AUTO_HOURS);

    if (shouldConnect && enriched.length >= 2) {
      const seed = harvested.length
        ? harvested[harvested.length - 1].id
        : selfFound.length
          ? selfFound[selfFound.length - 1].id
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
        const evoLedger = loadJson(EVO_FILE, []);
        // Layer 6.6: growth now carries a debt. After CONSOLIDATE_EVERY accepted rounds the
        // engine owes itself a round that only makes it smaller — otherwise every schedule
        // tick spends context it will never get back.
        const owed = CONSOLIDATE_EVERY > 0 && roundsSinceConsolidation(evoLedger) >= CONSOLIDATE_EVERY;
        let evo;
        if (owed) {
          slog(state, `Self-Forge: สะสมรอบขยายมา ${roundsSinceConsolidation(evoLedger)} รอบ — รอบนี้เป็นรอบยุบรวม`);
          evo = await attemptEvolution({ auto: true, mode: "consolidation" });
        } else {
          const standing = loadJson(LIMITS_FILE, []).filter(
            (l) => l.status !== "broken" && !attemptBudget(l, evoLedger).exhausted
          );
          if (!standing.length) await introspect();
          evo = await attemptEvolution({ auto: true });
        }
        result.evolution = { id: evo.id, verdict: evo.verdict, mode: evo.mode, limit: evo.limit.title };
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
  // Layer 6.6: the live usage ledger. This is the only evidence that can ever certify a
  // route as dead, so it is counted before anything else can fail.
  recordEndpointHit(p);

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
        origin: ORIGIN.human,
      };
      dots.push(dot);
      saveJson(DOTS_FILE, dots);
      return sendJson(res, 201, dot);
    }
    if (p.startsWith("/api/dots/") && req.method === "DELETE") {
      const id = p.split("/").pop();
      const before = loadJson(DOTS_FILE, []);
      const doomed = before.find((d) => d.id === id);
      // Deleting a dot the system found for itself is a veto, not just a delete:
      // the Scout must remember it and never fetch the same thing back.
      const r = doomed ? rejectDot(id, { veto: originOf(doomed) !== ORIGIN.human }) : null;
      return sendJson(res, 200, {
        deleted: r ? 1 : 0,
        vetoed: Boolean(r && r.vetoed),
        origin: r ? r.origin : null,
      });
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
      // Revive by attention, not by rarity: a dot that only ever produced dead ends
      // has earned its rest, however long it has been sitting there.
      const forgotten = dots
        .filter((d) => d.forgotten)
        .sort((a, b) => b.attention_score - a.attention_score)
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

    /* ---- Layer 7: The Scout — knowledge that walks in by itself ---- */
    if (p === "/api/scout/status" && req.method === "GET") {
      return sendJson(res, 200, scoutStatus());
    }
    // What the Scout would take from evidence it has already searched — a preview, no writes.
    if (p === "/api/scout/candidates" && req.method === "GET") {
      const dots = loadJson(DOTS_FILE, []);
      const connections = loadJson(CONN_FILE, []);
      const sc = scoutState(loadState());
      const candidates = evidenceCandidates(connections, dots, new Set(sc.rejected.map((r) => r.key)));
      return sendJson(res, 200, {
        candidates,
        count: candidates.length,
        searched_connections: connections.filter(
          (c) => c.evidence && c.evidence.novelty && (c.evidence.novelty.similar_found || []).length
        ).length,
        note:
          "ทุกชิ้นนี้คือ 'สิ่งใกล้เคียงที่มีอยู่จริงในโลก' ที่ Evidence Agent ค้นเจอมาแล้ว " +
          "แต่เดิมถูกฝังไว้ใน connections.json โดยไม่เคยกลายเป็นจุดที่เอาไปเชื่อมได้",
      });
    }
    // The system's own blind spots, named from its own census, with the query it would send.
    if (p === "/api/scout/gaps" && req.method === "GET") {
      const dots = enrichDots(loadJson(DOTS_FILE, []), loadJson(CONN_FILE, []));
      const plan = scoutGaps(dots);
      return sendJson(res, 200, { ...plan, scout_hours: SCOUT_HOURS, total_dots: dots.length });
    }
    if (p === "/api/scout/harvest" && req.method === "POST") {
      const body = await readBody(req);
      const created = harvestEvidenceDots({ max: Number(body.max) > 0 ? Number(body.max) : 50 });
      return sendJson(res, 200, { created, count: created.length });
    }
    if (p === "/api/scout/web" && req.method === "POST") {
      if (SELFTEST) return sendJson(res, 503, { error: "โหมดทดสอบ: The Scout ไม่ออกอินเทอร์เน็ต" });
      const body = await readBody(req);
      try {
        const run = await scoutWeb({ domain: body.domain ? String(body.domain).slice(0, 100) : null });
        return sendJson(res, 200, { gap: run.gap, created: run.created, count: run.created.length });
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
    }
    // The veto. The repository keeps growing on its own — and stays the owner's.
    if (p === "/api/scout/reject" && req.method === "POST") {
      const body = await readBody(req);
      const r = rejectDot(String(body.dotId || ""));
      if (!r) return sendJson(res, 404, { error: "ไม่พบจุดนี้ในคลัง" });
      return sendJson(res, 200, {
        rejected: r.dot.title,
        origin: r.origin,
        vetoed: r.vetoed,
        rejected_total: r.rejected_total,
        note: "ระบบจะไม่หยิบสิ่งนี้กลับเข้าคลังอีก แม้จะเจอซ้ำจากการค้นครั้งหน้า",
      });
    }

    /* ---- Layer 4 history ---- */
    if (p === "/api/connections" && req.method === "GET") {
      return sendJson(res, 200, loadJson(CONN_FILE, []));
    }

    /* ---- Layer 4.5: the return path — outcomes flow back into the next round ---- */
    if (p === "/api/outcome" && req.method === "POST") {
      const body = await readBody(req);
      const connections = loadJson(CONN_FILE, []);
      const record = connections.find((c) => c.id === body.connectionId);
      if (!record) return sendJson(res, 404, { error: "ไม่พบการเชื่อมนี้" });
      const status = String(body.status || "");
      if (!Number.isFinite(OUTCOME_STATUS[status])) {
        return sendJson(res, 400, {
          error: "status ต้องเป็นหนึ่งใน " + Object.keys(OUTCOME_STATUS).join(" | "),
        });
      }
      const rating = Number(body.rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
        return sendJson(res, 400, { error: "rating ต้องเป็นตัวเลข 1-5" });
      }
      record.outcome = {
        rated_at: new Date().toISOString(),
        rating: Math.round(rating),
        status,
        note: String(body.note || "").slice(0, 1000),
      };
      saveJson(CONN_FILE, connections);
      // Show the caller exactly which dots just moved because of this rating —
      // the loop is only real if you can watch it change the next round's weights.
      const ids = new Set((record.selected_dots || []).map((d) => d.id));
      const affected = enrichDots(loadJson(DOTS_FILE, []), connections)
        .filter((d) => ids.has(d.id))
        .map((d) => ({
          id: d.id,
          title: d.title,
          value_score: d.value_score,
          attention_score: d.attention_score,
          rated_uses: d.rated_uses,
        }));
      return sendJson(res, 200, {
        connection: record.id,
        outcome: record.outcome,
        signal: round2(connectionSignal(record)),
        affected_dots: affected,
      });
    }
    // What the next connection round will actually be told about the past.
    if (p === "/api/lessons" && req.method === "GET") {
      const connections = loadJson(CONN_FILE, []);
      const lessons = buildLessons(connections, 20);
      const rated = lessons.filter((l) => l.signal !== null);
      return sendJson(res, 200, {
        lessons,
        summary: {
          total: connections.length,
          with_feedback: rated.length,
          worked: rated.filter((l) => l.signal >= 0.34).length,
          died: rated.filter((l) => l.signal <= -0.34).length,
          untested: lessons.length - rated.length,
        },
        statuses: OUTCOME_LABEL,
      });
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
        // Layer 6.6: the engine can now see its own size and its own growth debt.
        last_consolidation: state.last_consolidation || null,
        metrics: sizeMetrics(body),
        endpoints: {
          declared: REGRESSION_ENDPOINTS.length,
          sweeping: effectiveRegressionEndpoints().length,
          retired: retiredEndpoints().size,
        },
        rounds_since_consolidation: roundsSinceConsolidation(loadJson(EVO_FILE, [])),
        consolidate_every: CONSOLIDATE_EVERY,
      });
    }

    /* ---- Layer 6.6: The Consolidator — the round type that is allowed to shrink ---- */
    // Everything a consolidation round will be judged on, readable before spending one.
    if (p === "/api/consolidation/preview" && req.method === "GET") {
      return sendJson(res, 200, consolidationPlan());
    }
    // The inverted fitness function itself, callable with hypothetical numbers. No AI, no
    // writes: anyone can check what would pass and what would not before a round is run.
    if (p === "/api/consolidation/dryrun" && req.method === "POST") {
      const body = await readBody(req);
      const verdict = consolidationVerdict(body.before || {}, body.after || {}, body.suite || [], {
        retiring: Number(body.retiring) || 0,
      });
      return sendJson(res, 200, verdict);
    }
    if (p === "/api/consolidate" && req.method === "POST") {
      if (SELFTEST) return sendJson(res, 503, { error: "โหมดทดสอบ" });
      const body = await readBody(req);
      try {
        const entry = await attemptEvolution({
          auto: false,
          mode: "consolidation",
          note: String(body.note || "").slice(0, 500),
        });
        return sendJson(res, 200, entry);
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
    }
    // The sweep list stops being append-only: who is called, who is dead, who was retired.
    if (p === "/api/endpoints" && req.method === "GET") {
      return sendJson(res, 200, endpointLedger());
    }
    if (p === "/api/endpoints/retire" && req.method === "POST") {
      const body = await readBody(req);
      const r = retireEndpoint(body.endpoint, {
        by: "owner",
        reason: String(body.reason || "").slice(0, 400),
      });
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, {
        retired: r.record.endpoint,
        record: r.record,
        declared: r.declared,
        sweeping: r.sweeping,
        note: "เส้นทางนี้ถูกถอดออกจาก regression sweep แล้ว — ยังกดคืนได้ตลอดเวลา และประวัติการประกาศไม่ถูกลบ",
      });
    }
    if (p === "/api/endpoints/restore" && req.method === "POST") {
      const body = await readBody(req);
      const r = restoreEndpoint(body.endpoint);
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, {
        restored: r.record.endpoint,
        record: r.record,
        declared: r.declared,
        sweeping: r.sweeping,
      });
    }
    // Every wall now carries its own attempt budget: how many tries it has had, how many
    // the ceiling allows *right now*, and how it earned the ones above the base of three.
    if (p === "/api/limits" && req.method === "GET") {
      const limits = loadJson(LIMITS_FILE, []);
      const ledger = loadJson(EVO_FILE, []);
      const next = selectTarget(limits, ledger);
      return sendJson(
        res,
        200,
        limits.map((l) => {
          const b = attemptBudget(l, ledger);
          return {
            ...l,
            attempts_used: b.attempts,
            attempt_cap: b.cap,
            attempts_left: b.left,
            cap_base: b.base,
            cap_earned: b.earned,
            cap_max: b.max,
            distinct_approaches: b.distinct_approaches,
            exhausted: l.status !== "broken" && b.exhausted,
            cap_note: b.note,
            is_next_target: Boolean(next && next.id === l.id),
            failed_attempts: failureDossier(l.id, ledger).map((d) => ({
              evo_id: d.evo_id,
              at: d.at,
              reason: d.reason,
              failed_gates: d.failed_gates.map((g) => g.label),
              attempted_dir: d.attempted_dir,
              attempted_files: d.attempted_files.length,
            })),
          };
        })
      );
    }
    // The scar tissue, made inspectable: exactly what the next forge round will be told
    // about this wall — including the real prompt it will read.
    if (p === "/api/forge/preview" && req.method === "GET") {
      const limits = loadJson(LIMITS_FILE, []);
      const ledger = loadJson(EVO_FILE, []);
      const wanted = String(url.searchParams.get("limitId") || "");
      const target = wanted ? limits.find((l) => l.id === wanted) : selectTarget(limits, ledger);
      if (wanted && !target) return sendJson(res, 404, { error: "ไม่พบขอบเขตนี้" });
      if (!target) {
        return sendJson(res, 200, {
          target: null,
          message: "ยังไม่มีขอบเขตที่รอทำลาย — กด \"วิเคราะห์ขอบเขตตัวเอง\" ก่อน",
          history: [],
          budget: null,
        });
      }
      const hist = forgeHistory(target, ledger);
      const prompt = buildForgePrompt(target, readSelf(), "evo_<รอบถัดไป>", hist);
      const marker = "===== ซอร์สโค้ดปัจจุบันของคุณ =====";
      const cut = prompt.indexOf(marker);
      return sendJson(res, 200, {
        target: {
          id: target.id,
          title: target.title,
          category: target.category,
          status: target.status,
          unlock_score: target.unlock_score,
          risk: target.risk,
          break_idea: target.break_idea,
        },
        budget: hist.budget,
        blocked: target.status !== "broken" && hist.budget.exhausted,
        history: hist.dossier,
        failure_block: hist.block,
        // The prompt minus the source bundle — the part where the lessons actually live.
        prompt_head: cut > 0 ? prompt.slice(0, cut) : prompt,
        prompt_chars: prompt.length,
        prompt: url.searchParams.get("full") === "1" ? prompt : undefined,
      });
    }
    // The code a rejected round wrote, still readable after the tree was rolled back.
    if (p === "/api/evolution/attempted" && req.method === "GET") {
      const evoId = String(url.searchParams.get("evoId") || "");
      if (!evoId) {
        const base = path.join(EVO_DIR, "backups");
        let rounds = [];
        try {
          rounds = fs
            .readdirSync(base, { withFileTypes: true })
            .filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, "attempted")))
            .map((e) => ({ evoId: e.name, files: listAttempted(e.name) }));
        } catch {}
        return sendJson(res, 200, { rounds });
      }
      if (!/^evo_[a-z0-9_]+$/i.test(evoId)) return sendJson(res, 400, { error: "evoId ไม่ถูกต้อง" });
      const dir = path.join(EVO_DIR, "backups", evoId, "attempted");
      const files = listAttempted(evoId);
      const wantFile = url.searchParams.get("file");
      if (wantFile) {
        const full = path.resolve(dir, wantFile);
        const inside = path.resolve(dir) + path.sep;
        if (!full.startsWith(inside) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return sendJson(res, 404, { error: "ไม่พบไฟล์ที่รอบนั้นเคยลองเขียน" });
        }
        return sendJson(res, 200, {
          evoId,
          path: `evolution/backups/${evoId}/attempted/${wantFile}`,
          code: fs.readFileSync(full, "utf8"),
        });
      }
      return sendJson(res, 200, { evoId, dir: `evolution/backups/${evoId}/attempted`, files });
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
    // The proof file behind a round — readable whether the round was accepted or rolled back.
    if (p === "/api/evolution/proof" && req.method === "GET") {
      const evoId = String(url.searchParams.get("evoId") || "");
      if (!/^evo_[a-f0-9]+$/.test(evoId)) return sendJson(res, 400, { error: "evoId ไม่ถูกต้อง" });
      const live = path.join(PROOF_DIR, evoId + ".js");
      const kept = path.join(EVO_DIR, "backups", evoId, "proof.js");
      const file = fs.existsSync(live) ? live : fs.existsSync(kept) ? kept : null;
      if (!file) return sendJson(res, 404, { error: "รอบนี้ไม่มีไฟล์พิสูจน์" });
      return sendJson(res, 200, {
        evoId,
        path: file === live ? `selftest/${evoId}.js` : `evolution/backups/${evoId}/proof.js`,
        active: file === live,
        code: fs.readFileSync(file, "utf8"),
      });
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
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  seedLimits();
  // Layer 6.6: pick the usage ledger back up where the last process left it, so an engine
  // that restarts every day never mistakes its own amnesia for a dead endpoint.
  loadUsage();
  const flushTimer = setInterval(flushUsage, 60 * 1000);
  if (flushTimer.unref) flushTimer.unref();
  // A lost hit would make a live endpoint look dead, so the counter is also written down
  // on the way out — including the restart where the engine replaces itself.
  process.on("exit", flushUsage);

  if (SELFTEST) {
    console.log(`  [selftest] booted on ${PORT} — daemon and AI disabled`);
    return;
  }

  // Start the evolution clock at first boot, never at epoch — installing the engine
  // must not trigger it to rewrite itself 90 seconds later without being asked.
  // The Scout's clock starts here too: a restart must never send the engine shopping the
  // web 90 seconds later without being asked.
  const boot = loadState();
  const bootScout = scoutState(boot);
  if (!boot.last_evolution || !bootScout.last_web_scout) {
    if (!boot.last_evolution) boot.last_evolution = new Date().toISOString();
    if (!bootScout.last_web_scout) {
      boot.scout = { ...bootScout, last_web_scout: new Date().toISOString() };
    }
    saveState(boot);
  }

  console.log(`\n  The Dot-Connector AI v4 (The Self-Forge)`);
  console.log(`  engine:  claude cli (connect: ${MODEL}, harvest: ${HARVEST_MODEL})`);
  console.log(`  forge:   ${FORGE_MODEL} — reads and rewrites this very file`);
  console.log(`  inbox:   ${INBOX_DIR}`);
  console.log(`  daemon:  every ${CHECK_MIN} min (auto-connect ≥ ${AUTO_HOURS}h apart)`);
  console.log(`  evolve:  ${EVOLVE_HOURS > 0 ? `every ${EVOLVE_HOURS}h (EVOLVE_HOURS=0 to disable)` : "off"}`);
  console.log(`  scout:   ${SCOUT_HOURS > 0 ? `every ${SCOUT_HOURS}h via ${SCOUT_MODEL} (SCOUT_HOURS=0 to disable)` : "off"} — evidence harvest always on`);
  console.log(`  open:    http://localhost:${PORT}\n`);

  // Serendipity daemon: first cycle after 90s, then on interval
  setTimeout(() => serendipityCycle(false), 90 * 1000);
  setInterval(() => serendipityCycle(false), CHECK_MIN * 60 * 1000);
});
