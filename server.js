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
 * Layer 6.8 The Adoption Ledger the engine's own return path: every round declares the
 *                              routes its capability will be used through, and N days later
 *                              the live usage ledger scores it with the SAME formula that
 *                              scores an idea. 0 hits → proposed for consolidation, and the
 *                              category's score bends selectTarget (see adoptionRound)
 * Layer 6.9 The Self-Connector the dot-connector finally connects dots while writing its own
 *                              code: a forge round reads the repository's actual principles,
 *                              the innovations it synthesised and a connect round aimed at the
 *                              wall — then must name which dots it used, and that claim is
 *                              scored by whether the wall fell (see forgeKnowledge /
 *                              applyForgeFeedback)
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
const VERIFIER_DIR = path.join(ROOT, "verifier");
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
// "index" hands the forge a symbol map and lets it Read what it needs; "full" inlines every
// byte of source the way rounds 1-11 did. Set FORGE_BUNDLE=full to compare round quality.
const FORGE_BUNDLE = process.env.FORGE_BUNDLE === "full" ? "full" : "index";
const CONNECT_TIMEOUT_MS = 6 * 60 * 1000;
const EVIDENCE_TIMEOUT_MS = 10 * 60 * 1000;
const INTROSPECT_TIMEOUT_MS = 12 * 60 * 1000;
// Each accepted round makes the source longer, so each next round takes longer to write.
// 25 min was already too short at ~3k lines — keep this ahead of the engine's own growth.
const FORGE_TIMEOUT_MS = Number(process.env.FORGE_TIMEOUT_MIN || 45) * 60 * 1000;
const PROOF_TIMEOUT_MS = 90 * 1000;
// Layer 6.7: a forge round is a conversation, not a single shot. How many turns the engine
// may spend inside ONE round — turn 1 writes, every later turn is a repair driven by the
// real stdout of the gate that just failed. 1 = the old one-shot behaviour.
const FORGE_MAX_TURNS = Math.max(1, Number(process.env.FORGE_MAX_TURNS || 3));
// A repair turn is a patch, not a rewrite: it gets a shorter leash than the opening turn.
const FORGE_RETRY_TIMEOUT_MS = Math.round(FORGE_TIMEOUT_MS * 0.6);
// The model's own hands. `node --check` is added on purpose: it is the one gate that costs
// milliseconds, and having to fail a whole round to learn about a stray bracket was absurd.
const FORGE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(node --check:*)"];
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
  "/api/forge/loop",
  "/api/evolution/attempted",
  "/api/scout/status",
  "/api/scout/candidates",
  "/api/scout/gaps",
  "/api/consolidation/preview",
  "/api/endpoints",
  "/api/knowledge/preview",
  "/api/knowledge/archive",
  // Layer 6.8: the one route that reports whether any of the routes above are used at all.
  "/api/adoption",
  // Layer 6.9: the knowledge a forge round actually gets to read before it touches code.
  "/api/forge/knowledge",
  // Layer 9: the owner's ignition. This one is not merely a route that must keep answering —
  // it is the route by which a human stops the engine, so a round that breaks it is void
  // even if everything else it did was brilliant.
  "/api/autopilot",
  // Layer 10: how the register of walls got to be the way it is. The engine's memory of its
  // own failures is addressed through here.
  "/api/limits/events",
];
// Layer 6.6: both ledgers live outside data/ on purpose. data/*.json is compared
// byte-for-byte after every forge round, so an ordinary HTTP request arriving while the
// forge is running would otherwise look like the forge tampering with its own memory.
const USAGE_FILE = path.join(EVO_DIR, "endpoint-usage.json");
const DEPRECATED_FILE = path.join(EVO_DIR, "deprecations.json");
/* ================= Layer 09: THE IGNITION — the key switch =================
 * Every autonomous behaviour above (auto-connect, the Scout, the Distiller and above all
 * the Self-Forge rewriting this file) used to start on a timer the moment the process
 * booted. That is the right default for a demo and the wrong default for a tool somebody
 * depends on: the owner learns what their engine did by reading the log afterwards.
 * From here the daemon is a machine with an ignition. Nothing scheduled runs until the
 * switch is turned on in the UI, the setting survives restarts, and the most expensive and
 * least reversible capability — the engine editing its own source — stays off even then
 * until it is armed on purpose.
 *
 * Every manual button keeps working with the switch off. The switch governs the *clock*,
 * never the owner's hands.
 *
 * The file lives outside data/ for the same reason the usage ledger does: data/*.json is
 * compared byte-for-byte around a forge round, and a human flipping a switch mid-round
 * must not read as the forge tampering with its own memory. It is also the one setting the
 * forge must never be able to turn back on for itself — see AUTOPILOT_FILE in walkSelf's
 * skip set and the guard in restoreGuarded().
 */
const AUTOPILOT_FILE = path.join(EVO_DIR, "autopilot.json");
// Sub-switches, in the order they are shown. `master` gates all of them at once.
const AUTOPILOT_KEYS = ["connect", "scout", "distill", "evolve"];
// What the switches mean once the master switch is on. `evolve` is deliberately not in
// this set: arming the engine to rewrite itself unattended is always an explicit act.
const AUTOPILOT_DEFAULT = { master: false, connect: true, scout: true, distill: true, evolve: false };
// Boot with the master switch already on — for a headless/service install where there is
// no browser to press the button in. Absent or "0", the engine boots idle.
const AUTOPILOT_BOOT = process.env.AUTOPILOT === "1";
// How many accepted expansion rounds may pile up before the engine owes itself a
// consolidation round (0 = never schedule one automatically; the button still works).
const CONSOLIDATE_EVERY = Number(process.env.CONSOLIDATE_EVERY || 3);
// Upper bound on how many proof files one consolidation round re-runs against both trees.
const CONSOLIDATE_SUITE_MAX = Number(process.env.CONSOLIDATE_SUITE_MAX || 8);
/* Layer 6.8: how long a capability is allowed to be ignored before "nobody called it" is
 * treated as an answer instead of as silence. Both conditions must hold — a week of wall
 * clock AND a ledger that has actually seen traffic — because a quiet week during which
 * nobody opened the page at all says nothing about the capability. */
const ADOPTION_DAYS = Math.max(1, Number(process.env.ADOPTION_DAYS || 7));
const ADOPTION_MIN_REQUESTS = Math.max(1, Number(process.env.ADOPTION_MIN_REQUESTS || 50));
// Hits at which a capability counts as fully fluent rather than merely touched once.
const ADOPTION_FLUENT_HITS = Math.max(1, Number(process.env.ADOPTION_FLUENT_HITS || 10));
// Consecutive scored rounds coming back unused before the engine owes itself a consolidation.
const ADOPTION_STREAK = Math.max(1, Number(process.env.ADOPTION_STREAK || 2));
// How hard a category's adoption record is allowed to bend selectTarget's ranking (0 = off).
const ADOPTION_WEIGHT = Math.max(0, Number(process.env.ADOPTION_WEIGHT || 2));
/* Layer 6.9: THE SELF-CONNECTOR — how much of the repository a forge round may read.
 * The whole system rests on "good answers come from laying one domain's structure over
 * another", and its most important layer was working in exactly one domain: its own source.
 * These caps are what let that be fixed without the prompt growing without end — the block
 * costs a bounded number of characters no matter how large the repository gets, and the
 * budget is reported next to the other prompt parts in GET /api/forge/preview so the cost
 * of letting knowledge in is visible rather than assumed. */
const FORGE_KNOWLEDGE_DOTS = Math.max(0, Number(process.env.FORGE_KNOWLEDGE_DOTS || 8));
const FORGE_KNOWLEDGE_CHARS = Math.max(120, Number(process.env.FORGE_KNOWLEDGE_CHARS || 360));
const FORGE_KNOWLEDGE_INNOVATIONS = Math.max(0, Number(process.env.FORGE_KNOWLEDGE_INNOVATIONS || 4));
const FORGE_KNOWLEDGE_LESSONS = Math.max(0, Number(process.env.FORGE_KNOWLEDGE_LESSONS || 4));
// At most this many dots from any one domain, so the block stays cross-domain instead of
// collapsing onto whichever domain happens to describe the wall in the same words.
const FORGE_KNOWLEDGE_PER_DOMAIN = Math.max(1, Number(process.env.FORGE_KNOWLEDGE_PER_DOMAIN || 2));
// How long a wall's cross-domain connect round stays fresh before the forge runs another
// one for it (0 = never run one automatically; the button and stored rounds still work).
const FORGE_INSIGHT_HOURS = Math.max(0, Number(process.env.FORGE_INSIGHT_HOURS || 72));
const FORGET_DAYS = Number(process.env.FORGET_DAYS || 14);
const CHECK_MIN = Number(process.env.CHECK_MIN || 30);   // daemon cycle interval
const AUTO_HOURS = Number(process.env.AUTO_HOURS || 24); // min hours between auto-connections
const EVOLVE_HOURS = Number(process.env.EVOLVE_HOURS || 24); // min hours between self-evolutions (0 = off)
// Layer 7: how often the engine may go out and search the web for itself (0 = off).
const SCOUT_HOURS = Number(process.env.SCOUT_HOURS || 12);
const SCOUT_MODEL = process.env.SCOUT_MODEL || HARVEST_MODEL;
const SCOUT_TIMEOUT_MS = 8 * 60 * 1000;
const SCOUT_MAX_PER_RUN = Number(process.env.SCOUT_MAX || 4);
/* Layer 8: THE DISTILLER — the knowledge side of Layer 6.6.
 * Every entrance to the repository was purely additive (capture, inbox, evidence harvest,
 * web scout, one dot per accepted forge round) and the only exit was a human pressing
 * DELETE. buildConnectPrompt() then poured every dot's full content into the prompt, so the
 * thing the engine has to read before it can think grew linearly with everything it had
 * ever learned — for ever. Two knobs and one round type answer that:
 *   · the prompt gets a budget (head rendered in full, tail compressed to an index line)
 *   · a distill round merges redundant dots into one principle dot, judged by an inverted
 *     fitness function and archived in data/knowledge.json so it is reversible.
 */
const KNOWLEDGE_FILE = path.join(DATA_DIR, "knowledge.json");
// How many dots are rendered with their full content, and how much content each may spend.
// The rest keep their id/domain/title so they stay selectable — they just stop costing
// a paragraph each. This is the only real "forgetting" the engine has ever had.
const CONNECT_FULL_DOTS = Math.max(4, Number(process.env.CONNECT_FULL_DOTS || 40));
const CONNECT_DOT_CHARS = Math.max(80, Number(process.env.CONNECT_DOT_CHARS || 420));
// 4-gram overlap above which two dots are proposed as the same idea wearing two names.
const DISTILL_SIMILARITY = Math.min(0.95, Math.max(0.15, Number(process.env.DISTILL_SIMILARITY || 0.42)));
// Pairwise clustering is O(n²); past this many dots only the most recent are compared.
const DISTILL_SCAN_MAX = Math.max(20, Number(process.env.DISTILL_SCAN_MAX || 260));
// Hours between automatic distill rounds (0 = off; the button always works).
const DISTILL_HOURS = Number(process.env.DISTILL_HOURS || 24);
const DISTILL_MODEL = process.env.DISTILL_MODEL || HARVEST_MODEL;
const DISTILL_TIMEOUT_MS = 6 * 60 * 1000;
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
    // Layer 8: the last round that made the *repository* smaller instead of bigger.
    last_distill: null,
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

/* ---- Layer 9: the ignition switch (see AUTOPILOT_FILE) ---- */
function loadAutopilot() {
  const raw = loadJson(AUTOPILOT_FILE, {});
  const ap = { ...AUTOPILOT_DEFAULT };
  for (const k of ["master", ...AUTOPILOT_KEYS]) {
    if (typeof raw[k] === "boolean") ap[k] = raw[k];
  }
  ap.changed_at = raw.changed_at || null;
  return ap;
}
function saveAutopilot(next) {
  const ap = { ...loadAutopilot(), ...next, changed_at: new Date().toISOString() };
  const out = { master: !!ap.master, changed_at: ap.changed_at };
  for (const k of AUTOPILOT_KEYS) out[k] = !!ap[k];
  saveJson(AUTOPILOT_FILE, out);
  return out;
}
function ensureAutopilotFile() {
  // Always on disk, so readGuarded() can hold it byte-for-byte across a forge round: a file
  // that does not exist yet cannot be restored if the round invents it.
  //
  // AUTOPILOT=1 applies here and only here — at first install, when there is no file and
  // therefore no decision by the owner to overrule. After that the file is the truth, so a
  // service restart can never undo someone pressing stop.
  if (!fs.existsSync(AUTOPILOT_FILE)) saveAutopilot({ master: AUTOPILOT_BOOT });
}
/* What the *clock* is allowed to do right now. Env stays a hard ceiling above the switch:
 * EVOLVE_HOURS=0 means the schedule is off no matter what the page says, so an operator
 * who disabled a capability at install time cannot have it re-enabled from the browser. */
function autopilot() {
  const ap = loadAutopilot();
  const on = (k, ceiling = true) => ap.master === true && ap[k] === true && ceiling;
  return {
    ...ap,
    can_connect: on("connect"),
    can_scout: on("scout", SCOUT_HOURS > 0),
    can_distill: on("distill", DISTILL_HOURS > 0),
    can_evolve: on("evolve", EVOLVE_HOURS > 0),
  };
}
const AUTOPILOT_LABELS = {
  master: "เดินเครื่องอัตโนมัติ",
  connect: "เชื่อมจุดเอง",
  scout: "The Scout ออกไปค้นเว็บเอง",
  distill: "The Distiller ยุบรวมความรู้เอง",
  evolve: "Self-Forge เขียนโค้ดตัวเองใหม่",
};
/* One place that answers "what will this machine do if I walk away", so the page never has
 * to infer it from four separate numbers. `due_in_h` is null when the clock for that
 * capability is off — the difference between "not yet" and "never" is the whole point. */
function autopilotStatus() {
  const ap = autopilot();
  const state = loadState();
  const since = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : Infinity);
  const due = (can, every, last) => {
    if (!can || !(every > 0)) return null;
    return Math.max(0, Math.round((every - since(last)) * 10) / 10);
  };
  return {
    master: ap.master,
    connect: ap.connect,
    scout: ap.scout,
    distill: ap.distill,
    evolve: ap.evolve,
    changed_at: ap.changed_at,
    labels: AUTOPILOT_LABELS,
    // What the switches add up to once the env ceilings are applied.
    effective: {
      connect: ap.can_connect,
      scout: ap.can_scout,
      distill: ap.can_distill,
      evolve: ap.can_evolve,
    },
    // A switch the page must draw as unavailable rather than merely off: the operator
    // disabled this capability at install time and the browser cannot undo that.
    locked: {
      connect: false,
      scout: !(SCOUT_HOURS > 0),
      distill: !(DISTILL_HOURS > 0),
      evolve: !(EVOLVE_HOURS > 0),
    },
    schedule: {
      check_interval_min: CHECK_MIN,
      connect_hours: AUTO_HOURS,
      scout_hours: SCOUT_HOURS,
      distill_hours: DISTILL_HOURS,
      evolve_hours: EVOLVE_HOURS,
    },
    due_in_h: {
      connect: ap.can_connect ? Math.max(0, Math.round((AUTO_HOURS - since(state.last_auto_run)) * 10) / 10) : null,
      scout: due(ap.can_scout, SCOUT_HOURS, scoutState(state).last_web_scout),
      distill: due(ap.can_distill, DISTILL_HOURS, state.last_distill),
      evolve: due(ap.can_evolve, EVOLVE_HOURS, state.last_evolution),
    },
    boot_env: AUTOPILOT_BOOT,
    busy,
    forging,
  };
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

/* ================= AI engine (headless Claude) =================
 * One call in, one answer out — except for Layer 6.7, which needs to keep talking to the
 * same session after it has seen the gate output. Hence the raw form returns the session id
 * and accepts one back: `resume` turns a monologue into a conversation without changing a
 * single one of the twelve callers that only ever wanted the text.
 */
// A forge round costs 20+ minutes of thinking. Losing one because the CLI happened to die
// in its first second is pure waste — startup failures are retried, real failures are not.
// A timeout is never retried: it already spent the whole budget once.
async function runClaudeRaw(prompt, opts = {}) {
  let last;
  // Layer 9: which "stop everything" era this call belongs to. If the counter moves while
  // the call is in flight, someone hit the stop button — a retry then means the engine
  // ignoring an instruction, which is the one failure mode a kill switch cannot have.
  const era = abortEpoch;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await runClaudeOnce(prompt, opts);
    } catch (e) {
      last = e;
      if (abortEpoch !== era) throw new Error("ถูกสั่งหยุดกลางคัน");
      const msg = String((e && e.message) || e);
      const transient = /EOF|EPIPE|ECONNRESET|ปิดก่อนอ่านข้อมูล|exited \d+/.test(msg) && !/timed out/.test(msg);
      if (!transient || attempt === 3) throw e;
      console.log(`  [claude] เริ่มโปรเซสไม่สำเร็จ (${msg.slice(0, 80)}) — ลองใหม่ครั้งที่ ${attempt + 1}/3`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw last;
}

/* Layer 9: every claude process this engine has alive right now.
 * A forge round is 45 minutes of someone else's electricity and it used to be
 * uninterruptible — the only stop button was killing the server, which leaves a
 * half-written source tree behind. Holding the handles makes "stop" a real answer:
 * killing the child fails the round, and a failed round is the path the engine already
 * knows how to walk back. */
const liveClaude = new Set();
let abortEpoch = 0;
function killAllClaude(reason = "หยุดโดยผู้ใช้") {
  abortEpoch++;
  let killed = 0;
  for (const child of [...liveClaude]) {
    try {
      // shell:true means the direct child is cmd.exe — killing it alone orphans the CLI
      // underneath, which would keep burning tokens with nobody listening.
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
      child.__abortReason = reason;
      killed++;
    } catch {}
    liveClaude.delete(child);
  }
  return killed;
}

/* Every thinking layer in this file shells out to the same binary, and until now the first
 * thing to tell you it was missing was a four-minute round dying with "claude exited 1".
 * The engine asks once at boot and says so where a person will see it. */
let cliHealth = { ok: null, version: null, error: null, at: null };
function checkClaudeCli() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, version, error) => {
      if (done) return;
      done = true;
      cliHealth = { ok, version, error, at: new Date().toISOString() };
      resolve(cliHealth);
    };
    let child;
    try {
      child = spawn("claude", ["--version"], { shell: true, windowsHide: true });
    } catch (e) {
      return finish(false, null, e.message);
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false, null, "ไม่ตอบใน 20 วินาที");
    }, 20000);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish(false, null, e.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const v = out.trim().split("\n")[0] || "";
      if (code === 0 && v) return finish(true, v, null);
      finish(false, null, (err || out).trim().slice(0, 200) || `claude --version exited ${code}`);
    });
  });
}

function runClaudeOnce(
  prompt,
  { tools = [], timeoutMs = CONNECT_TIMEOUT_MS, model = MODEL, permissionMode = null, cwd = ROOT, resume = null } = {}
) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--model", model];
    if (resume) args.push("--resume", resume);
    if (tools.length) args.push("--allowedTools", tools.join(","));
    if (permissionMode) args.push("--permission-mode", permissionMode);

    // The forge prompt is the whole engine plus its history — it passed 250 KB around round 8
    // and pushing that much through a shell-wrapped stdin pipe on Windows breaks the pipe
    // (write EOF) before the CLI reads a byte. Past that size, hand the shell a file instead:
    // the redirect is the OS's job, and it does not care how big the file is.
    const viaFile = prompt.length > 50000;
    let promptFile = null;
    let cmdline = "claude";
    if (viaFile) {
      promptFile = path.join(os.tmpdir(), "dot-prompt-" + crypto.randomBytes(6).toString("hex") + ".txt");
      fs.writeFileSync(promptFile, prompt, "utf8");
      const q = (s) => (/[\s"&|<>^()]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : s);
      cmdline = ["claude", ...args].map(q).join(" ") + " < " + q(promptFile);
    }
    const child = viaFile
      ? spawn(cmdline, { shell: true, windowsHide: true, cwd })
      : spawn("claude", args, { shell: true, windowsHide: true, cwd });
    liveClaude.add(child);
    const cleanup = () => {
      liveClaude.delete(child);
      if (promptFile) {
        try {
          fs.unlinkSync(promptFile);
        } catch {}
        promptFile = null;
      }
    };
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      cleanup();
      reject(new Error("AI engine timed out"));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      out = out.replace(/^﻿/, "").trim();
      // A round the owner stopped is not a round that failed on its merits: say so plainly,
      // and never let the retry loop above resurrect it (the message carries no EOF/EPIPE).
      if (child.__abortReason) {
        return reject(new Error("ถูกสั่งหยุดกลางคัน: " + child.__abortReason));
      }
      if (code !== 0 && !out) {
        return reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      }
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error) {
          return reject(new Error(envelope.result || "Claude returned an error"));
        }
        resolve({ text: String(envelope.result || ""), sessionId: envelope.session_id || resume || null });
      } catch {
        reject(new Error("Could not parse Claude CLI output: " + out.slice(0, 300)));
      }
    });
    // If the CLI dies before reading the prompt, this pipe emits 'error' (EOF/EPIPE).
    // An unhandled stream error takes the whole engine down with it — the round is lost
    // either way, but the server must survive to report it and roll back.
    child.stdin.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      // Being stopped on purpose also breaks this pipe. Reporting that as a flaky start
      // would send the retry loop off to redo the very work someone just cancelled.
      if (child.__abortReason) {
        return reject(new Error("ถูกสั่งหยุดกลางคัน: " + child.__abortReason));
      }
      reject(new Error("ส่งพรอมป์ตให้ claude CLI ไม่สำเร็จ (" + e.code + ") — โปรเซสปิดก่อนอ่านข้อมูล"));
    });
    try {
      if (!viaFile) child.stdin.write(prompt, "utf8");
      child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      cleanup();
      reject(e);
    }
  });
}
// Every layer but the forge only ever wanted the answer.
function runClaude(prompt, opts = {}) {
  return runClaudeRaw(prompt, opts).then((r) => r.text);
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

/* Fold a set of weighted votes into one signal in [-1, +1], or null when there is not a
 * single vote to fold — silence is not a bad review. Layer 6.8 scores the engine's own
 * rounds through this exact function, so "did this idea work?" and "did anyone use this
 * capability?" are answered on one scale with one rule about silence. */
function weightedSignal(parts) {
  const votes = (parts || []).filter((p) => p && Number.isFinite(p.w) && Number.isFinite(p.v) && p.w > 0);
  if (!votes.length) return null;
  const wsum = votes.reduce((n, p) => n + p.w, 0);
  return clamp(votes.reduce((n, p) => n + p.w * p.v, 0) / wsum, -1, 1);
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
  return weightedSignal(parts);
}

/* Layer 7: every dot now says where it came from. Four origins, one rule — anything the
 * system fetched for itself is labelled as such and can be vetoed by the owner. */
const ORIGIN = {
  human: "human",
  evidence: "scout:evidence",
  web: "scout:web",
  forge: "self-forge",
  // Layer 8: not fetched from anywhere — distilled out of dots the repository already had.
  distill: "distill",
};
const ORIGIN_LABEL = {
  human: "👤 เจ้าของเพิ่มเอง",
  "scout:evidence": "🧪 The Scout เก็บจากหลักฐานที่เคยค้นเจอ",
  "scout:web": "🌐 The Scout ออกไปค้นเว็บมาเอง",
  "self-forge": "🔥 ระบบได้มาจากการทำลายกำแพงตัวเอง",
  distill: "⚗ ยุบรวมจากหลายจุดเป็นหลักการเดียว",
};
function originOf(dot) {
  if (dot && dot.origin && ORIGIN_LABEL[dot.origin]) return dot.origin;
  const s = String((dot && dot.source) || "");
  if (s.startsWith("self-forge:")) return ORIGIN.forge;
  if (s.startsWith("evidence:")) return ORIGIN.evidence;
  if (s.startsWith("web:")) return ORIGIN.web;
  if (s.startsWith("distill:")) return ORIGIN.distill;
  return ORIGIN.human;
}

function enrichDots(dots, connections) {
  const now = Date.now();
  return dots.map((d) => {
    let uses = 0;
    let lastTouched = new Date(d.created_at || now).getTime();
    const signals = [];
    // Layer 6.9: the same tally, restricted to rounds where the engine was rewriting itself.
    // A dot's ordinary value_score says "this helped an idea"; forge_score says "this helped
    // the engine get past a wall in its own code" — the one claim this repository could never
    // make before, because the forge never read it.
    let forgeUses = 0;
    const forgeSignals = [];
    for (const c of connections) {
      if ((c.selected_dots || []).some((sd) => sd.id === d.id)) {
        uses++;
        const t = new Date(c.created_at).getTime();
        if (t > lastTouched) lastTouched = t;
        const s = connectionSignal(c);
        if (s !== null) signals.push(s);
        if (c.forge) {
          forgeUses++;
          if (s !== null) forgeSignals.push(s);
        }
      }
    }
    const forgeScore = forgeSignals.length
      ? round2(forgeSignals.reduce((a, b) => a + b, 0) / forgeSignals.length)
      : 0;
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
    // Layer 8: a distilled dot carries the dots it replaced, so nothing it absorbed
    // becomes untraceable just because it stopped taking up room in the prompt.
    const absorbed = (d.distilled && Array.isArray(d.distilled.absorbed) ? d.distilled.absorbed : []);
    return {
      ...d,
      origin,
      origin_label: ORIGIN_LABEL[origin] || origin,
      self_sourced: origin === ORIGIN.evidence || origin === ORIGIN.web,
      distilled_from: absorbed.length ? d.distilled.round || null : null,
      absorbed_count: absorbed.length,
      absorbed_titles: absorbed.map((a) => a.title).slice(0, 8),
      uses,
      last_touched: new Date(lastTouched).toISOString(),
      days_idle: daysIdle,
      rarity,
      value_score: valueScore,
      rated_uses: signals.length,
      attention_score: attention,
      // Layer 6.9: has this dot ever helped the engine break one of its own walls?
      forge_uses: forgeUses,
      forge_rated_uses: forgeSignals.length,
      forge_score: forgeScore,
      forge_proven: forgeSignals.length > 0 && forgeScore >= 0.34,
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

function buildLessons(connections, limit = 8, { includeForge = false } = {}) {
  // Layer 6.9 writes self-forge rounds into this same ledger so the dots they name can be
  // scored by Layer 4.5. They are lessons about the engine, not about ideas, so they stay
  // out of the connect prompt's lesson block by default — otherwise a run of forge rounds
  // would crowd every real idea out of "what worked last time".
  return (includeForge ? connections : (connections || []).filter((c) => !c.forge))
    .slice(0, limit)
    .map((c) => {
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
/* Layer 8: one dot, rendered in full. This is what every dot in the repository used to
 * cost the prompt, once per round, for ever — which is why the prompt grew linearly with
 * everything the engine had ever been told and never shrank by a single character. */
function renderDotFull(d) {
  const content = String(d.content || "");
  const clipped = content.length > CONNECT_DOT_CHARS ? content.slice(0, CONNECT_DOT_CHARS) + "…" : content;
  return `- id: ${d.id}\n  โดเมน: ${d.domain}\n  ชื่อจุด: ${d.title}\n  รายละเอียด: ${clipped}\n  ที่มา: ${
    ORIGIN_LABEL[d.origin || originOf(d)] || "👤 เจ้าของเพิ่มเอง"
  }${
    d.absorbed_count
      ? `\n  ยุบรวมมาจาก ${d.absorbed_count} จุดเดิม: ${(d.absorbed_titles || []).join(" · ")}`
      : ""
  }\n  สถิติ: ถูกเชื่อมแล้ว ${d.uses ?? 0} ครั้ง${
    d.rated_uses
      ? ` · คะแนนคุณค่าจากผลลัพธ์จริง ${d.value_score > 0 ? "+" : ""}${d.value_score} (จากผลตอบกลับ ${d.rated_uses} ครั้ง)${
          d.dead_end ? " — จุดนี้เคยพาไปทางตันซ้ำ ๆ ใช้ก็ได้แต่ต้องมีมุมใหม่จริง ๆ" : d.proven ? " — จุดนี้เคยให้ผลลัพธ์ที่ดีจริง" : ""
        }`
      : ""
  }${d.forgotten ? " (จุดนี้ถูกทิ้งไว้นาน — มีค่าสูงหากปลุกขึ้นมาใช้)" : ""}`;
}
// ...and the same dot once the budget has spent itself: still selectable by id, no longer
// carrying a paragraph. Forgetting content is the only thing that makes the prompt bounded.
function renderDotIndex(d) {
  return `- id: ${d.id} · ${d.domain} · ${d.title}`;
}
/* The budget itself. Dots arrive already sorted by attention_score, so the head is what the
 * return path says is worth reading in full; anything the round is *required* to include
 * (Serendipity Revival) is pulled into the head no matter where it sits. */
function connectPromptBudget(dots, mustInclude = []) {
  const must = new Set(mustInclude || []);
  const head = [];
  const tail = [];
  for (const d of dots) {
    if (must.has(d.id) || head.length < CONNECT_FULL_DOTS) head.push(d);
    else tail.push(d);
  }
  return { head, tail };
}

function buildConnectPrompt(dots, lessons, focus, mustInclude) {
  const { head, tail } = connectPromptBudget(dots, mustInclude);
  const dotList =
    head.map(renderDotFull).join("\n") +
    (tail.length
      ? `\n\n(อีก ${tail.length} จุดที่ลำดับความสนใจต่ำกว่านี้ ถูกย่อเหลือดัชนีบรรทัดเดียวเพื่อไม่ให้พรอมป์ตยาวขึ้นไม่สิ้นสุด` +
        ` — เลือกด้วย id ได้ตามปกติ แต่ถ้าจะหยิบจุดจากดัชนี ต้องอธิบายให้ชัดว่าทำไมถึงคุ้มกว่าจุดที่แสดงเต็มด้านบน)\n` +
        tail.map(renderDotIndex).join("\n")
      : "");
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

/* ================================================================
 * Layer 8: THE DISTILLER — the repository learns to shrink
 *
 * Layer 6.6 gave the *code* a second direction: a round whose fitness function is inverted,
 * where progress means the thing got smaller and the proof of correctness is that nothing
 * changed. The knowledge side kept the wall standing in its original shape. Every entrance
 * added (capture, inbox, harvestEvidenceDots({max:50}), scoutWeb, one dot per accepted
 * forge round); nothing merged two dots into one; nothing raised anything to a principle;
 * and the dots the system politely called "forgotten" were still shipped into
 * buildConnectPrompt() character for character. The prompt therefore grew linearly with
 * everything the engine had ever been told, and the growth rate had just been increased.
 *
 * Same medicine, pointed at the dots instead of the files:
 *
 *   expansion round     proof PASSES on new code, FAILS on old      "you can do something new"
 *   consolidation round proof PASSES on both, code metrics fall     "you are the same, but smaller"
 *   distill round       every positively-rated connection is still  "you know the same things,
 *                       explicable, no proven dot is gone, and       in fewer words"
 *                       the connect prompt is measurably shorter
 *
 * The three gates below are the whole contract, and they are strict in the direction that
 * matters: a merge may only ever *absorb*, never delete — an absorbed dot keeps its title
 * and id inside the principle dot that replaced it, which is what lets gate 1 prove that
 * every idea a successful connection was built on can still be pointed at. Dots that have
 * actually earned their keep (proven) can never be absorbed at all, and the originals are
 * archived in data/knowledge.json so any round can be walked back exactly like the
 * evolution ledger walks back code.
 * ================================================================ */

function loadKnowledgeLedger() {
  const raw = loadJson(KNOWLEDGE_FILE, null);
  const rounds = raw && Array.isArray(raw.rounds) ? raw.rounds : Array.isArray(raw) ? raw : [];
  return { rounds };
}
function saveKnowledgeLedger(ledger) {
  saveJson(KNOWLEDGE_FILE, { rounds: (ledger.rounds || []).slice(-200) });
}

// The real number, not an estimate: what the next connection round would actually have to
// read. Measured by building the prompt the engine really uses.
function connectPromptChars(dots, connections) {
  const enriched = enrichDots(dots || [], connections || []);
  const ordered = [...enriched].sort((a, b) => b.attention_score - a.attention_score);
  return buildConnectPrompt(ordered, buildLessons(connections || []), "", []).length;
}

// Every id an after-state can still account for: present as itself, or named inside the
// `absorbed` list of a dot that replaced it (absorb lists are flattened when merging, so
// a dot absorbed twice is still reachable after the second round).
function coverageIndex(dots) {
  const present = new Set();
  const absorbedBy = new Map();
  for (const d of dots || []) {
    present.add(d.id);
    for (const a of (d.distilled && d.distilled.absorbed) || []) {
      if (a && a.id) absorbedBy.set(a.id, d.id);
    }
  }
  return { present, absorbedBy };
}

/*
 * The inverted fitness function for knowledge. Pure, so the UI, the API dry-run, the real
 * merge and the daemon all judge a proposal by exactly the same rule, and so a human can
 * ask "would this pass?" without spending an AI round or touching the repository.
 */
function knowledgeVerdict(before, after, connections) {
  const dotsBefore = Array.isArray(before) ? before : [];
  const dotsAfter = Array.isArray(after) ? after : [];
  const conns = Array.isArray(connections) ? connections : [];
  const enrichedBefore = enrichDots(dotsBefore, conns);
  const { present, absorbedBy } = coverageIndex(dotsAfter);
  const explains = (id) => (present.has(id) ? "kept" : absorbedBy.has(id) ? "absorbed" : null);

  /* Gate 1 — every connection that once produced a positive signal must still be
     explicable by the smaller repository. Not "the dots still exist": every dot it was
     built on must still be pointable-at, either as itself or inside what replaced it. */
  const positive = conns.filter((c) => {
    const s = connectionSignal(c);
    return s !== null && s >= 0.34;
  });
  const orphans = [];
  for (const c of positive) {
    for (const d of c.selected_dots || []) {
      if (!explains(d.id)) {
        orphans.push({
          connection: c.id,
          innovation: (c.innovation && c.innovation.name) || c.id,
          dot_id: d.id,
          dot_title: d.title,
        });
      }
    }
  }
  const coverage = {
    ok: orphans.length === 0,
    positive_connections: positive.length,
    orphans,
    detail: orphans.length
      ? `การเชื่อมที่เคยได้สัญญาณบวก ${orphans.length} จุดอธิบายด้วยคลังที่เล็กลงไม่ได้: ` +
        orphans.map((o) => `"${o.dot_title}" (จาก ${o.innovation})`).join(", ")
      : positive.length
        ? `การเชื่อมที่เคยได้สัญญาณบวกทั้ง ${positive.length} ครั้ง ยังอธิบายได้ครบด้วยคลังที่เล็กลง`
        : "ยังไม่มีการเชื่อมที่ได้สัญญาณบวก — ด่านนี้จึงยังไม่มีอะไรให้ขัดขวาง",
  };

  /* Gate 2 — a dot the return path has already proven cannot be dissolved into a summary
     of itself. Absorbing it counts as losing it: it must survive under its own id. */
  const provenLost = enrichedBefore
    .filter((d) => d.proven && !present.has(d.id))
    .map((d) => ({ id: d.id, title: d.title, value_score: d.value_score, rated_uses: d.rated_uses }));
  const provenKept = {
    ok: provenLost.length === 0,
    proven_before: enrichedBefore.filter((d) => d.proven).length,
    lost: provenLost,
    detail: provenLost.length
      ? `จุดที่พิสูจน์แล้วว่าให้ผลจริงหายไป ${provenLost.length} จุด: ` + provenLost.map((d) => `"${d.title}"`).join(", ")
      : `จุดที่พิสูจน์แล้ว ${enrichedBefore.filter((d) => d.proven).length} จุดยังอยู่ครบทุกจุด`,
  };

  /* Gate 3 — and it has to have actually worked. The measurement is the prompt itself. */
  const promptBefore = connectPromptChars(dotsBefore, conns);
  const promptAfter = connectPromptChars(dotsAfter, conns);
  const shrunk = {
    ok: promptAfter < promptBefore,
    prompt_before: promptBefore,
    prompt_after: promptAfter,
    delta: promptAfter - promptBefore,
    detail:
      promptAfter < promptBefore
        ? `พรอมป์ตเชื่อมจุดสั้นลงจริง ${promptBefore - promptAfter} ตัวอักษร (${promptBefore} → ${promptAfter})`
        : `พรอมป์ตเชื่อมจุดไม่ได้สั้นลง (${promptBefore} → ${promptAfter}) — รอบยุบรวมความรู้ต้องวัดผลได้ว่าคลังเบาลงจริง`,
  };

  return {
    ok: coverage.ok && provenKept.ok && shrunk.ok,
    gates: { coverage, proven_kept: provenKept, shrunk },
    metrics: {
      dots_before: dotsBefore.length,
      dots_after: dotsAfter.length,
      dots_delta: dotsAfter.length - dotsBefore.length,
      prompt_before: promptBefore,
      prompt_after: promptAfter,
      prompt_delta: promptAfter - promptBefore,
    },
    rule:
      "รอบยุบรวมความรู้ผ่านเมื่อ: (1) ทุกการเชื่อมที่เคยได้สัญญาณบวกยังถูกอธิบายได้ด้วยคลังที่เล็กลง " +
      "(จุดที่หายต้องถูกดูดเข้าไปอยู่ในจุดหลักการ ไม่ใช่หายไปเฉย ๆ) (2) ไม่มีจุดที่ proven หายไปแม้แต่จุดเดียว " +
      "(3) จำนวนตัวอักษรของ buildConnectPrompt ลดลงจริง",
  };
}

/* ---- finding the redundancy, without asking an AI anything ---- */
function dotFingerprint(d) {
  return shingles(`${d.title || ""} ${String(d.content || "").slice(0, 600)}`);
}

// Single-link clustering over 4-gram similarity: the same measure Layer 6.5 uses to decide
// whether two failed forge rounds were really the same idea, pointed at dots instead.
function findRedundantClusters(dots, { threshold = DISTILL_SIMILARITY, scanMax = DISTILL_SCAN_MAX } = {}) {
  const pool = (dots || []).slice(-scanMax);
  const prints = pool.map(dotFingerprint);
  const parent = pool.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const pairs = [];
  for (let i = 0; i < pool.length; i++) {
    // Two dots with almost no text are not "the same idea" — they are two empty dots.
    if (prints[i].size < 8) continue;
    for (let j = i + 1; j < pool.length; j++) {
      if (prints[j].size < 8) continue;
      const sim = jaccard(prints[i], prints[j]);
      if (sim >= threshold) {
        pairs.push({ a: pool[i].id, b: pool[j].id, similarity: round2(sim) });
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < pool.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(pool[i]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      dot_ids: g.map((d) => d.id),
      dots: g.map((d) => ({ id: d.id, title: d.title, domain: d.domain, chars: String(d.content || "").length })),
      domains: [...new Set(g.map((d) => d.domain))],
      chars: g.reduce((n, d) => n + String(d.content || "").length, 0),
      // A sample of the evidence, not all of it: a cluster of N dots has O(N²) pairs and
      // nobody — model or human — reads the two-thousandth one.
      pairs: pairs.filter((p) => g.some((d) => d.id === p.a) && g.some((d) => d.id === p.b)).slice(0, 12),
    }))
    .sort((a, b) => b.dots.length - a.dots.length || b.chars - a.chars);
}

/* ---- applying a merge: deterministic, gated, archived, reversible ---- */
function buildMergedDot(cluster, members, roundId) {
  const now = new Date().toISOString();
  // Absorb lists are flattened: a dot that was already a principle hands its children on,
  // so nothing ever falls out of reach by being merged twice.
  const absorbed = [];
  for (const m of members) {
    absorbed.push({ id: m.id, title: m.title, domain: m.domain, origin: originOf(m) });
    for (const a of (m.distilled && m.distilled.absorbed) || []) {
      if (a && a.id && !absorbed.some((x) => x.id === a.id)) absorbed.push(a);
    }
  }
  return {
    id: "dot_" + crypto.randomBytes(4).toString("hex"),
    title: String(cluster.title || "").slice(0, 200),
    domain: String(cluster.domain || members[0].domain || "หลักการร่วม").slice(0, 100),
    content: String(cluster.content || "").slice(0, 2000),
    created_at: now,
    source: "distill:" + roundId,
    origin: ORIGIN.distill,
    distilled: { round: roundId, at: now, absorbed, principle: String(cluster.principle || "").slice(0, 600) },
  };
}

// Validation first, gates second, disk last. A rejected plan writes nothing at all.
function applyKnowledgeMerge({ clusters, note = "", by = "owner", auto = false } = {}) {
  const before = loadJson(DOTS_FILE, []);
  const connections = loadJson(CONN_FILE, []);
  const byId = new Map(before.map((d) => [d.id, d]));
  const list = Array.isArray(clusters) ? clusters : [];
  const roundId = "kn_" + crypto.randomBytes(4).toString("hex");
  const claimed = new Set();
  const planned = [];
  const errors = [];

  for (const [i, c] of list.entries()) {
    const ids = [...new Set((Array.isArray(c && c.dot_ids) ? c.dot_ids : []).map(String))];
    const members = ids.map((id) => byId.get(id)).filter(Boolean);
    if (members.length !== ids.length) {
      errors.push(`คลัสเตอร์ที่ ${i + 1}: มี id ที่ไม่มีอยู่ในคลัง (${ids.filter((id) => !byId.has(id)).join(", ")})`);
      continue;
    }
    if (members.length < 2) {
      errors.push(`คลัสเตอร์ที่ ${i + 1}: ต้องรวบอย่างน้อย 2 จุด (การยุบรวมจุดเดียวไม่ใช่การยุบรวม)`);
      continue;
    }
    if (ids.some((id) => claimed.has(id))) {
      errors.push(`คลัสเตอร์ที่ ${i + 1}: มีจุดที่ถูกใช้ในคลัสเตอร์อื่นแล้ว`);
      continue;
    }
    if (!String((c && c.title) || "").trim() || !String((c && c.content) || "").trim()) {
      errors.push(`คลัสเตอร์ที่ ${i + 1}: ต้องมี title และ content ของจุดหลักการที่จะมาแทน`);
      continue;
    }
    ids.forEach((id) => claimed.add(id));
    planned.push({ cluster: c, members });
  }
  if (errors.length) {
    return { verdict: "rejected", ok: false, round: null, errors, reason: errors.join(" · "), applied: false };
  }
  if (!planned.length) {
    return {
      verdict: "rejected",
      ok: false,
      round: null,
      errors: ["ไม่มีคลัสเตอร์ที่ยุบรวมได้"],
      reason: "ไม่มีคลัสเตอร์ที่ยุบรวมได้",
      applied: false,
    };
  }

  const created = planned.map((p) => buildMergedDot(p.cluster, p.members, roundId));
  const removedIds = new Set([...claimed]);
  const archived = before.filter((d) => removedIds.has(d.id));
  const after = [...before.filter((d) => !removedIds.has(d.id)), ...created];
  const verdict = knowledgeVerdict(before, after, connections);

  const round = {
    id: roundId,
    at: new Date().toISOString(),
    by,
    auto,
    note: String(note || "").slice(0, 500),
    verdict: verdict.ok ? "accepted" : "rejected",
    gates: verdict.gates,
    metrics: verdict.metrics,
    clusters: planned.map((p, i) => ({
      merged_into: created[i].id,
      title: created[i].title,
      domain: created[i].domain,
      absorbed: created[i].distilled.absorbed.map((a) => ({ id: a.id, title: a.title })),
    })),
    created: created.map((d) => ({ id: d.id, title: d.title })),
    // The originals, whole. This is what makes the round reversible, exactly like the
    // evolution ledger's backups make a code round reversible.
    archived,
    restored_at: null,
  };

  if (!verdict.ok) {
    const failed = Object.entries(verdict.gates)
      .filter(([, g]) => !g.ok)
      .map(([, g]) => g.detail);
    round.reason = failed.join(" · ");
    // Rejected rounds are recorded too — a refusal to forget is knowledge about the
    // repository, and it costs nothing to keep. But not one dot moves.
    const ledger = loadKnowledgeLedger();
    ledger.rounds.unshift({ ...round, archived: [] });
    saveKnowledgeLedger(ledger);
    return { verdict: "rejected", ok: false, applied: false, round, ...verdict, reason: round.reason };
  }

  round.reason =
    `ผ่านทั้งสามด่าน: ${verdict.gates.coverage.detail} · ${verdict.gates.proven_kept.detail} · ${verdict.gates.shrunk.detail}`;
  saveJson(DOTS_FILE, after);
  const ledger = loadKnowledgeLedger();
  ledger.rounds.unshift(round);
  saveKnowledgeLedger(ledger);
  return { verdict: "accepted", ok: true, applied: true, round, ...verdict, reason: round.reason, created };
}

// Undo. The archived originals go back exactly as they were and the principle dots that
// replaced them are withdrawn — nothing about a distill round is a one-way door.
function restoreKnowledgeRound(roundId) {
  const ledger = loadKnowledgeLedger();
  const round = ledger.rounds.find((r) => r.id === roundId);
  if (!round) return { ok: false, error: "ไม่พบรอบยุบรวมความรู้นี้" };
  if (round.verdict !== "accepted") return { ok: false, error: "รอบนี้ไม่เคยถูกใช้จริง จึงไม่มีอะไรให้ย้อน" };
  if (round.restored_at) return { ok: false, error: "รอบนี้ถูกย้อนกลับไปแล้ว" };
  const dots = loadJson(DOTS_FILE, []);
  const createdIds = new Set((round.created || []).map((c) => c.id));
  const have = new Set(dots.map((d) => d.id));
  const back = (round.archived || []).filter((d) => !have.has(d.id));
  const after = [...dots.filter((d) => !createdIds.has(d.id)), ...back];
  saveJson(DOTS_FILE, after);
  round.restored_at = new Date().toISOString();
  saveKnowledgeLedger(ledger);
  return {
    ok: true,
    round: round.id,
    restored: back.length,
    withdrawn: (round.created || []).filter((c) => have.has(c.id)).length,
    dots_now: after.length,
  };
}

// Everything a distill round will be judged on, readable before spending one.
function knowledgePlan() {
  const dots = loadJson(DOTS_FILE, []);
  const connections = loadJson(CONN_FILE, []);
  const enriched = enrichDots(dots, connections);
  const ordered = [...enriched].sort((a, b) => b.attention_score - a.attention_score);
  const { head, tail } = connectPromptBudget(ordered, []);
  const ledger = loadKnowledgeLedger();
  const clusters = findRedundantClusters(dots);
  const positive = connections.filter((c) => {
    const s = connectionSignal(c);
    return s !== null && s >= 0.34;
  });
  return {
    metrics: {
      dots: dots.length,
      prompt_chars: connectPromptChars(dots, connections),
      // What the repository block would cost if every dot were still poured in whole, the
      // way it was before this layer: every dot rendered, and every dot's content uncut.
      // The size of the wall this layer removed, recomputed live rather than asserted.
      unbudgeted_chars:
        ordered.map(renderDotFull).join("\n").length +
        ordered.reduce((n, d) => n + Math.max(0, String(d.content || "").length - CONNECT_DOT_CHARS), 0),
      budgeted_chars: head.map(renderDotFull).join("\n").length + tail.map(renderDotIndex).join("\n").length,
      full_dots: head.length,
      indexed_dots: tail.length,
      distilled_dots: enriched.filter((d) => d.absorbed_count > 0).length,
      absorbed_dots: enriched.reduce((n, d) => n + (d.absorbed_count || 0), 0),
      proven_dots: enriched.filter((d) => d.proven).length,
      forgotten_dots: enriched.filter((d) => d.forgotten).length,
    },
    caps: { full_dots: CONNECT_FULL_DOTS, dot_chars: CONNECT_DOT_CHARS, scan_max: DISTILL_SCAN_MAX },
    similarity: DISTILL_SIMILARITY,
    clusters,
    cluster_count: clusters.length,
    redundant_dots: clusters.reduce((n, c) => n + c.dots.length, 0),
    protected: {
      proven: enriched.filter((d) => d.proven).map((d) => ({ id: d.id, title: d.title, value_score: d.value_score })),
      positive_connections: positive.length,
    },
    rounds: ledger.rounds.slice(0, 20).map((r) => ({
      id: r.id,
      at: r.at,
      by: r.by,
      auto: r.auto,
      verdict: r.verdict,
      reason: r.reason,
      metrics: r.metrics,
      clusters: r.clusters,
      restored_at: r.restored_at || null,
      restorable: r.verdict === "accepted" && !r.restored_at,
    })),
    accepted_rounds: ledger.rounds.filter((r) => r.verdict === "accepted" && !r.restored_at).length,
    last_distill: (ledger.rounds.find((r) => r.verdict === "accepted") || {}).at || null,
    distill_hours: DISTILL_HOURS,
    rule: knowledgeVerdict([], [], []).rule,
  };
}

function buildDistillPrompt(plan, dots) {
  const byId = new Map(dots.map((d) => [d.id, d]));
  const clusterBlock = plan.clusters
    .slice(0, 12)
    .map(
      (c, i) =>
        `--- คลัสเตอร์ที่ ${i + 1} (ความคล้าย ${c.pairs.map((p) => p.similarity).join(", ") || "?"}) ---\n` +
        c.dot_ids
          .map((id) => {
            const d = byId.get(id) || {};
            return `  · id: ${id} · [${d.domain}] ${d.title}\n    ${String(d.content || "").slice(0, 400)}`;
          })
          .join("\n")
    )
    .join("\n\n");
  return `คุณคือ "The Distiller" — ชั้นที่ 8 ของ The Dot-Connector AI
รอบนี้ไม่ใช่การหาความรู้ใหม่ และไม่ใช่การเชื่อมจุด — เป็น "รอบยุบรวมความรู้" (distill round)
ฟังก์ชันความเหมาะสมของรอบนี้กลับด้านกับทุกรอบที่คลังเคยมี:

  ทุกทางเข้าเดิม   เพิ่มจุดใหม่เข้าคลัง                        → คลังโตขึ้นเสมอ
  รอบนี้           รวบจุดที่ซ้ำซ้อนให้เป็น "จุดหลักการ" เดียว   → คลังเล็กลงโดยไม่มีความรู้ใดหาย

===== สภาพคลังตอนนี้ =====
จุดทั้งหมด ${plan.metrics.dots} จุด · พรอมป์ตเชื่อมจุดยาว ${plan.metrics.prompt_chars} ตัวอักษร
จุดที่แสดงเต็มในพรอมป์ต ${plan.metrics.full_dots} จุด · ที่เหลือถูกย่อเป็นดัชนี ${plan.metrics.indexed_dots} จุด
จุดที่พิสูจน์แล้วว่าให้ผลจริง (ห้ามยุบรวมเด็ดขาด): ${
    plan.protected.proven.map((d) => `${d.id} "${d.title}"`).join(" · ") || "(ยังไม่มี)"
  }

===== คลัสเตอร์ที่ระบบตรวจพบเองว่าซ้ำซ้อน (ยังไม่ได้ตัดสิน — คุณเป็นคนตัดสิน) =====
${clusterBlock || "(ระบบยังไม่พบคลัสเตอร์ที่ซ้ำซ้อนชัดเจน — ถ้าคุณเห็นว่าไม่มีอะไรควรยุบรวม ให้ตอบ clusters เป็น [] ตรง ๆ)"}

===== กติกาที่รอบนี้จะถูกตัดสิน (ระบบตรวจเองด้วยโค้ด ไม่ได้เชื่อคำพูดของคุณ) =====
1. ทุกการเชื่อมที่เคยได้ "สัญญาณบวก" ต้องยังอธิบายได้ด้วยคลังที่เล็กลง —
   จุดที่หายไปต้องถูกดูดเข้าไปอยู่ในจุดหลักการที่มาแทน (ระบบเก็บ id เดิมไว้ในนั้นให้เอง)
2. ห้ามให้จุดที่ proven หายไปแม้แต่จุดเดียว (ห้ามใส่ id ของจุดเหล่านั้นในคลัสเตอร์ใด ๆ)
3. จำนวนตัวอักษรของพรอมป์ตเชื่อมจุดต้องลดลงจริง
ขาดข้อใดข้อหนึ่ง = รอบนี้ถูกปฏิเสธ และคลังไม่ถูกแตะแม้แต่จุดเดียว

===== สิ่งที่ต้องทำ =====
เลือกเฉพาะคลัสเตอร์ที่ "ยุบรวมแล้วไม่มีความรู้ใดหายจริง ๆ" แล้วเขียน "จุดหลักการ" หนึ่งจุดมาแทนทั้งกลุ่ม
จุดหลักการที่ดีต้อง *เป็นนามธรรมขึ้นหนึ่งขั้น* ไม่ใช่การต่อข้อความของเดิมเข้าด้วยกัน:
มันต้องบอก "กลไกร่วม" ที่ทำให้จุดเหล่านั้นเป็นเรื่องเดียวกัน จนเอาไปทาบกับสาขาอื่นได้กว้างกว่าเดิม
ถ้าคลัสเตอร์ไหนที่ระบบเสนอมาแล้วคุณเห็นว่าจริง ๆ เป็นคนละเรื่อง ให้ข้ามไป — การไม่ยุบรวมดีกว่ายุบรวมผิด

ตอบเป็น JSON ล้วนเท่านั้น (ห้ามมี markdown หรือข้อความอื่นนอก JSON) ทุก field เป็นภาษาไทย:
{
  "clusters": [
    {
      "dot_ids": ["<id ของจุดเดิมที่จะถูกยุบรวม อย่างน้อย 2 id>"],
      "title": "<ชื่อจุดหลักการใหม่ สั้น คม>",
      "domain": "<โดเมนของหลักการนี้>",
      "content": "<หลักการร่วมที่ครอบคลุมทุกจุดในกลุ่ม 2-4 ประโยค เน้นกลไก ไม่ใช่การสรุปรวมข้อความ>",
      "principle": "<เหตุผลว่าทำไมยุบรวมแล้วไม่มีความรู้ใดหาย — 1 ประโยค>"
    }
  ],
  "summary": "<รอบนี้ทำให้คลังเล็กลงอย่างไรโดยไม่เสียความรู้ — 2-3 ประโยค>"
}`;
}

// The AI half. The gates above do not trust a word of what comes back: whatever plan the
// model proposes still goes through applyKnowledgeMerge() and is refused on the numbers.
async function distillKnowledge({ note = "", auto = false, state = null } = {}) {
  if (SELFTEST) throw Object.assign(new Error("โหมดทดสอบ: The Distiller ไม่เรียก AI"), { status: 503 });
  if (forging) throw Object.assign(new Error("Self-Forge กำลังเทียบไฟล์ความทรงจำอยู่ — รอรอบหลอมตัวเองให้จบก่อน"), { status: 409 });
  const dots = loadJson(DOTS_FILE, []);
  const plan = knowledgePlan();
  if (!plan.clusters.length) {
    throw Object.assign(new Error("ยังไม่พบจุดที่ซ้ำซ้อนพอจะยุบรวม — คลังยังไม่มีหนี้ให้จ่าย"), { status: 400 });
  }
  const raw = await runClaude(buildDistillPrompt(plan, dots), {
    model: DISTILL_MODEL,
    timeoutMs: DISTILL_TIMEOUT_MS,
  });
  let parsed;
  try {
    parsed = extractJson(raw);
  } catch {
    throw Object.assign(new Error("The Distiller ตอบกลับมาในรูปแบบที่อ่านไม่ได้ ลองอีกครั้ง"), { status: 502 });
  }
  const clusters = Array.isArray(parsed) ? parsed : parsed.clusters || [];
  if (!clusters.length) {
    return {
      verdict: "rejected",
      ok: false,
      applied: false,
      reason: "The Distiller ตัดสินว่าไม่มีคลัสเตอร์ใดยุบรวมได้โดยไม่เสียความรู้ — คลังไม่ถูกแตะ",
      summary: String(parsed.summary || ""),
      round: null,
    };
  }
  const result = applyKnowledgeMerge({
    clusters,
    note: String(parsed.summary || note || "").slice(0, 500),
    by: auto ? "distiller:auto" : "distiller",
    auto,
  });
  result.summary = String(parsed.summary || "");
  if (state && result.applied) {
    state.last_distill = new Date().toISOString();
  }
  return result;
}

/* ================= Core operations (shared by HTTP + daemon) ================= */
let busy = false;

async function performConnection({ focus = "", dotIds = null, mustInclude = [], auto = false, wall = null } = {}) {
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
    // Layer 6.9: a connect round can now be aimed at one of the engine's own walls. It is an
    // ordinary connection in every other way — visible, ratable, and reusable — but it is
    // stamped so the next forge round against that wall can find the pattern it produced.
    wall: wall ? { id: wall.id, title: wall.title, category: wall.category || null } : null,
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

// Directories the forge must never treat as "itself": memory, output, incoming — and the
// verifier, which audits the forge from outside. An exam-taker who may rewrite the
// invigilator's instructions is not being examined, so verifier/ is out of reach by
// construction: excluded from the editable set here, and restored byte-for-byte if touched.
const SELF_SKIP_DIRS = new Set([".git", "node_modules", "data", "lab", "inbox", "evolution", "verifier"]);
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
  // The auditor is guarded like memory: a round that edits its own invigilator is void.
  try {
    for (const f of fs.readdirSync(VERIFIER_DIR)) {
      if (f.endsWith(".js")) g["verifier/" + f] = fs.readFileSync(path.join(VERIFIER_DIR, f), "utf8");
    }
  } catch {}
  // Layer 9: and so is the ignition. The forge may rewrite every line that decides *how* it
  // evolves; the switch deciding *whether* it may start itself belongs to the owner alone.
  try {
    if (fs.existsSync(AUTOPILOT_FILE)) g["evolution/autopilot.json"] = fs.readFileSync(AUTOPILOT_FILE, "utf8");
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
  // Layer 6.8: growth is not the only debt. Capabilities the usage ledger says nobody ever
  // called are proposed here as this round's targets, without anyone having to notice them.
  const adoption = adoptionDebt();
  return {
    metrics: sizeMetrics(self),
    suite,
    suite_size: suite.length,
    suite_cap: CONSOLIDATE_SUITE_MAX,
    endpoints,
    retirement_candidates: endpoints.endpoints.filter((e) => e.retirable).map((e) => e.endpoint),
    adoption,
    unused_capabilities: adoption.targets,
    rounds_since_consolidation: since,
    consolidate_every: CONSOLIDATE_EVERY,
    due: (CONSOLIDATE_EVERY > 0 && since >= CONSOLIDATE_EVERY) || adoption.consolidation_due,
    due_reason:
      CONSOLIDATE_EVERY > 0 && since >= CONSOLIDATE_EVERY
        ? `สะสมรอบขยายมา ${since}/${CONSOLIDATE_EVERY} รอบ`
        : adoption.consolidation_due
          ? `มีรอบที่ไม่มีใครเรียกเลยติดกัน ${adoption.unused_streak} รอบ (เกณฑ์ ${ADOPTION_STREAK})`
          : null,
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

===== 📈 ความสามารถที่ระบบสร้างไว้แล้วไม่มีใครเรียกเลย (Layer 6.8 · เป้าหมายที่ระบบเสนอเอง) =====
บันทึกการใช้งานให้คะแนนรอบขยายไปแล้ว ${(plan.adoption.counts || {}).scored || 0} รอบ · ถูกใช้จริง ${(plan.adoption.counts || {}).adopted || 0} · ไม่มีใครเรียกเลย ${(plan.adoption.counts || {}).unused || 0}${
    plan.adoption.unused_streak ? ` · ไม่มีใครเรียกติดกัน ${plan.adoption.unused_streak} รอบ` : ""
  }
${
    (plan.unused_capabilities || []).length
      ? (plan.unused_capabilities || [])
          .map(
            (t) =>
              `  · ${t.evo_id} (${String(t.at || "").slice(0, 10)}) — ${t.capability || "(ไม่ระบุ)"}\n` +
              `    เส้นทางที่ประกาศไว้แต่ไม่มีใครเรียก: ${t.endpoints.join(", ") || "(ไม่มี)"} · ผ่านมา ${t.days} วัน`
          )
          .join("\n") +
        `\nนี่คือรายการที่ควรพิจารณาก่อนอย่างอื่นในรอบนี้: มันคือของที่พิสูจน์แล้วว่า "ทำได้" และพิสูจน์แล้วด้วยว่า "ไม่มีใครใช้"` +
        `\nแต่การยุบรวมยังต้องพิสูจน์ตามกติกาเดิมทุกข้อ — ถ้าคุณลบเส้นทางใด ต้องใส่ใน retire_endpoints และบันทึกการใช้งานต้องรับรองว่ามันถูกเรียก 0 ครั้งจริง`
      : "  (ยังไม่มีความสามารถไหนที่บันทึกการใช้งานตัดสินว่าไม่มีใครเรียก — ยังไม่มีหนี้ก้อนนี้ให้จ่าย)"
  }

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
   materializeTree, consolidationVerdict, retireEndpoint, planRetirements, writeAttempted, attemptBudget,
   recordEndpointHit, declareAdoption, adoptionRound, adoptionReport, weightedSignal, targetRanking
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

/* ================= Layer 6.8: THE ADOPTION LEDGER =================
 * Every gate this engine has ever had returns its verdict in the same minute the code was
 * written: the proof file passes, the old tree fails it, the size metrics fall, the endpoint
 * answers 200. Not one of them asks whether the capability shipped twenty rounds ago was
 * ever *called*. The answer was already on disk the whole time — evolution/endpoint-usage.json
 * has counted every /api/* request since Layer 6.6 — but it was only ever read as a licence
 * to retire a route (retireEndpoint, planRetirements), never as a value signal. So the
 * engine could pile up capabilities that nobody has invoked even once and score every one of
 * them as progress. Layer 4.5 built a return path for *ideas*. The system itself had none.
 *
 * It has one now, and on purpose it is the same one:
 *
 *   an idea    Evidence verdict + what the owner did with it   ┐
 *   a round    did anyone call the routes it declared?         ┴→ weightedSignal() → [-1,+1]
 *
 * Three properties are what make this a feedback loop instead of one more instant verdict:
 *   · a round must DECLARE the routes its capability will be reached through (gate
 *     `declared_usage`) — otherwise the question is unanswerable later, which is exactly
 *     how every round before this one escaped it;
 *   · the answer is allowed to arrive LATE. Before ADOPTION_DAYS have passed, or before the
 *     ledger has observed ADOPTION_MIN_REQUESTS requests, an unused round scores `null`,
 *     not −1 — the same way an unrated connection scores null. A quiet week is not a verdict;
 *   · and then it flows BACK: rounds that came back unused are proposed as consolidation
 *     targets automatically, and a category's mean adoption bends targetRanking(), so the
 *     kind of wall that keeps producing things nobody touches stops being picked first.
 */
const ADOPTION_RULE =
  "รอบขยายหนึ่งรอบได้คะแนน 'ถูกใช้จริง' เมื่อ: (1) มันประกาศเส้นทางที่ความสามารถจะถูกเรียกผ่านไว้ตอนที่มันผ่านด่าน " +
  `(2) เวลาผ่านไปอย่างน้อย ${ADOPTION_DAYS} วัน และบันทึกการใช้งานเห็นคำขอมาแล้วอย่างน้อย ${ADOPTION_MIN_REQUESTS} ครั้ง ` +
  "(3) แล้วจึงเปิด evolution/endpoint-usage.json มาให้คะแนนด้วยสูตรเดียวกับ connectionSignal() — " +
  "ก่อนถึงเกณฑ์ข้อ 2 ความเงียบให้คะแนน null ไม่ใช่ติดลบ · เส้นทางที่มีอยู่ก่อนรอบนั้นนับให้ก็ต่อเมื่อถูกเรียกหลังวันที่ประกาศ";

// Every /api/* route this source tree actually dispatches, read out of the router itself.
// Used to check a declaration against reality: a round may under-declare, it may not
// declare a route it never wrote.
function declaredApiPaths(body) {
  const src = String((body && body["server.js"]) || "");
  const found = new Set();
  for (const m of src.matchAll(/p === "(\/api\/[A-Za-z0-9/_-]+)"/g)) found.add(m[1]);
  return found;
}

/* What a round puts on the record about how its capability is supposed to be reached.
 * Two sources, deliberately: what the round *claims* (a promise it can be held to) and what
 * the diff actually added (which it cannot quietly omit). */
function declareAdoption({ report, before, after, at }) {
  const had = declaredApiPaths(before);
  const now = declaredApiPaths(after);
  const detected = [...now].filter((ep) => !had.has(ep)).sort();
  const raw = (Array.isArray(report && report.usage_endpoints) ? report.usage_endpoints : [])
    .map((x) => String(x || "").trim().split("?")[0])
    .filter((x) => /^\/api\/[A-Za-z0-9/_-]+$/.test(x));
  const claimed = [...new Set(raw.filter((ep) => now.has(ep)))].sort();
  const at_iso = new Date(at || Date.now()).toISOString();
  return {
    endpoints: [...new Set([...claimed, ...detected])].sort(),
    claimed,
    detected,
    // Named but absent from the router: kept visible instead of silently dropped.
    ignored: [...new Set(raw.filter((ep) => !now.has(ep)))].sort(),
    note: String((report && report.usage_note) || "").slice(0, 500),
    declared_at: at_iso,
    matures_at: new Date(new Date(at_iso).getTime() + ADOPTION_DAYS * 86400000).toISOString(),
    grace_days: ADOPTION_DAYS,
    min_requests: ADOPTION_MIN_REQUESTS,
  };
}

/* One round's own return path. Pure — same inputs, same verdict — so the live ledger and
 * POST /api/adoption/dryrun can never disagree about what counts as used. */
function adoptionRound(entry, usage, nowMs, observedRequests) {
  const mode = (entry && entry.mode) || "expansion";
  const report = (entry && entry.report) || {};
  const base = {
    evo_id: (entry && entry.id) || null,
    at: (entry && entry.at) || null,
    mode,
    verdict: (entry && entry.verdict) || null,
    limit: (entry && entry.limit) || null,
    category: (entry && entry.limit && entry.limit.category) || null,
    capability: String(report.new_capability || report.summary || "").slice(0, 300),
    endpoints: [],
    declared: 0,
    used: 0,
    hits: 0,
    days: null,
    mature: false,
    signal: null,
    status: "exempt",
    why: "",
  };
  if (!entry || entry.verdict !== "accepted" || entry.rolled_back) {
    return { ...base, why: "รอบที่ไม่ได้ถูกใช้จริง (ตกหรือถูกย้อนกลับ) — ไม่มีความสามารถให้ใครเรียก" };
  }
  if (mode === "consolidation") {
    return { ...base, why: "รอบยุบรวมไม่ได้เพิ่มความสามารถ จึงไม่มีการใช้งานให้วัด" };
  }
  const decl = entry.adoption || null;
  if (!decl) {
    return {
      ...base,
      status: "undeclared",
      why: "รอบนี้เกิดก่อน Layer 6.8 จึงไม่เคยประกาศเส้นทางที่ความสามารถของมันจะถูกใช้ผ่าน — วัดย้อนหลังไม่ได้อย่างซื่อสัตย์",
    };
  }
  const declaredAt = new Date(decl.declared_at || entry.at).getTime();
  const eps = (Array.isArray(decl.endpoints) ? decl.endpoints : []).map((ep) => {
    const e = ((usage && usage.endpoints) || {})[ep] || null;
    const hits = e && Number.isFinite(e.hits) ? e.hits : 0;
    const last = (e && e.last_hit) || null;
    const isNew = (decl.detected || []).includes(ep);
    // A route that already existed only counts if it was called *after* this round declared
    // it — otherwise a round could buy itself a passing score by pointing at /api/dots.
    const fresh = isNew || Boolean(last && new Date(last).getTime() >= declaredAt);
    return { endpoint: ep, hits, last_hit: last, new_route: isNew, used_since_declared: hits > 0 && fresh };
  });
  const used = eps.filter((e) => e.used_since_declared);
  const hits = used.reduce((n, e) => n + e.hits, 0);
  const days = round2(Math.max(0, (nowMs - declaredAt) / 86400000));
  const mature = days >= ADOPTION_DAYS && observedRequests >= ADOPTION_MIN_REQUESTS;
  const common = {
    ...base,
    endpoints: eps,
    declared: eps.length,
    used: used.length,
    hits,
    days,
    mature,
    matures_at: decl.matures_at || new Date(declaredAt + ADOPTION_DAYS * 86400000).toISOString(),
    note: String(decl.note || "").slice(0, 300),
  };
  if (!eps.length) {
    return { ...common, status: "unmeasurable", why: "รอบนี้ไม่ได้ประกาศเส้นทางไว้เลย จึงไม่มีทางรู้ว่ามีใครใช้" };
  }
  // Silence before maturity is not a verdict — exactly the rule connectionSignal() follows.
  if (!hits && !mature) {
    return {
      ...common,
      status: "pending",
      why:
        `ยังตัดสินไม่ได้ — ผ่านมา ${days}/${ADOPTION_DAYS} วัน` +
        ` และบันทึกการใช้งานเห็นคำขอมาแล้ว ${observedRequests}/${ADOPTION_MIN_REQUESTS} ครั้ง`,
    };
  }
  const coverage = used.length / eps.length;
  return {
    ...common,
    signal: round2(
      weightedSignal([
        // Was it reached at all — the vote that matters most, weighted like the owner's own.
        { w: 2, v: hits > 0 ? 1 : -1 },
        // How much of what it declared is actually live.
        { w: 1, v: coverage * 2 - 1 },
        // Touched once, or genuinely in use.
        { w: 1, v: clamp(hits / ADOPTION_FLUENT_HITS, 0, 1) * 2 - 1 },
      ])
    ),
    status: hits > 0 ? "adopted" : "unused",
    why:
      hits > 0
        ? `ถูกเรียกจริง ${hits} ครั้ง ผ่าน ${used.length}/${eps.length} เส้นทางที่ประกาศไว้`
        : `ผ่านมา ${days} วันและบันทึกเห็นคำขอ ${observedRequests} ครั้ง แต่ไม่มีใครเรียกเส้นทางของความสามารถนี้เลยแม้ครั้งเดียว`,
  };
}

// The whole ledger, scored. Pure over (ledger, usage, now) so it is dry-runnable.
function adoptionReport(ledger, usage, { now = Date.now() } = {}) {
  const nowMs = new Date(now).getTime() || Date.now();
  const u = usage && typeof usage === "object" ? usage : {};
  const eps = u.endpoints && typeof u.endpoints === "object" ? u.endpoints : {};
  const observed = Object.values(eps).reduce((n, e) => n + (Number(e && e.hits) || 0), 0);
  const startedAt = u.started_at || new Date(nowMs).toISOString();
  const trackingHours = round2(Math.max(0, (nowMs - new Date(startedAt).getTime()) / 3600000));
  const rounds = (Array.isArray(ledger) ? ledger : [])
    .slice()
    .sort((a, b) => new Date((b && b.at) || 0) - new Date((a && a.at) || 0))
    .map((e) => adoptionRound(e, { endpoints: eps }, nowMs, observed));
  const scored = rounds.filter((r) => r.signal !== null);
  const of = (s) => rounds.filter((r) => r.status === s);
  const unused = of("unused");
  // "0 hit ติดกัน": how many of the most recently *scored* rounds came back unused in a row.
  let streak = 0;
  for (const r of scored) {
    if (r.status === "unused") streak++;
    else break;
  }
  const categories = {};
  for (const r of scored) {
    const cat = r.category || "unknown";
    const c = (categories[cat] = categories[cat] || { rounds: 0, adopted: 0, unused: 0, sum: 0, signal: null });
    c.rounds++;
    c.sum += r.signal;
    if (r.status === "adopted") c.adopted++;
    if (r.status === "unused") c.unused++;
  }
  for (const c of Object.values(categories)) {
    c.signal = round2(c.sum / c.rounds);
    delete c.sum;
  }
  return {
    now: new Date(nowMs).toISOString(),
    tracking_since: startedAt,
    tracking_hours: trackingHours,
    young_ledger: trackingHours < 24,
    observed_requests: observed,
    grace_days: ADOPTION_DAYS,
    min_requests: ADOPTION_MIN_REQUESTS,
    fluent_hits: ADOPTION_FLUENT_HITS,
    weight: ADOPTION_WEIGHT,
    streak_trigger: ADOPTION_STREAK,
    rounds,
    counts: {
      total: rounds.length,
      scored: scored.length,
      adopted: of("adopted").length,
      unused: unused.length,
      pending: of("pending").length,
      undeclared: of("undeclared").length,
      unmeasurable: of("unmeasurable").length,
      exempt: of("exempt").length,
    },
    signal: scored.length ? round2(scored.reduce((n, r) => n + r.signal, 0) / scored.length) : null,
    unused_streak: streak,
    consolidation_due: streak >= ADOPTION_STREAK,
    // The automatic proposal: capabilities the ledger says nobody reached.
    consolidation_targets: unused.map((r) => ({
      evo_id: r.evo_id,
      at: r.at,
      capability: r.capability,
      limit: r.limit ? r.limit.title : null,
      category: r.category,
      endpoints: r.endpoints.map((e) => e.endpoint),
      days: r.days,
      signal: r.signal,
    })),
    categories,
    rule: ADOPTION_RULE,
  };
}

/* Category → mean adoption signal: the number that feeds back into which wall comes next.
 * Taken out of an already-computed report where there is one, so a single round never scores
 * the whole ledger twice. */
function categoryOf(report) {
  const out = {};
  for (const [cat, c] of Object.entries((report && report.categories) || {})) {
    if (c && c.rounds > 0 && Number.isFinite(c.signal)) out[cat] = c.signal;
  }
  return out;
}
function categoryAdoption(ledger, usage, now = Date.now()) {
  return categoryOf(adoptionReport(ledger, usage, { now }));
}

// The live summary a consolidation round and the web page both read.
function adoptionDebt() {
  const r = adoptionReport(loadJson(EVO_FILE, []), loadUsage());
  return {
    signal: r.signal,
    counts: r.counts,
    unused_streak: r.unused_streak,
    consolidation_due: r.consolidation_due,
    targets: r.consolidation_targets,
    categories: r.categories,
    grace_days: r.grace_days,
    min_requests: r.min_requests,
    observed_requests: r.observed_requests,
    young_ledger: r.young_ledger,
    tracking_since: r.tracking_since,
  };
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

// Every way a round can die, in the order the gates run. Layer 6.7 feeds these labels back
// into the round that is still running, so they are the model's error messages too now —
// which is why the two consolidation gates finally appear here as well.
const GATE_LABEL = {
  changed: "ไม่มีไฟล์ใดถูกแก้จริง",
  guard: "แตะไฟล์ความทรงจำที่ห้ามแก้",
  proof_written: "ไม่ได้เขียนไฟล์พิสูจน์",
  // Layer 6.8: a round that cannot say how its capability will be reached can never be
  // asked, a week later, whether anyone reached it.
  declared_usage: "ไม่ได้ประกาศเส้นทางที่ความสามารถใหม่จะถูกใช้ผ่าน",
  syntax: "syntax พัง",
  smoke: "บูตเซิร์ฟเวอร์ไม่ผ่าน",
  capability: "ความสามารถใหม่พิสูจน์ไม่ผ่าน",
  differential: "โค้ดเดิมก็ทำได้อยู่แล้ว — ไม่ได้ทำลายกำแพงจริง",
  preservation: "พฤติกรรมเปลี่ยนไป — ชุดทดสอบไม่ได้ให้ผลเหมือนกันทั้งก่อนและหลัง",
  shrink: "ไม่ได้เล็กลงจริงตามตัวเลข",
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
/* Layer 10: a wall's scars are addressed by id, and ids used to be reissued on every look in
 * the mirror. `aliases` is the list of ids this wall has worn before, so a round that failed
 * under an old name is still this wall's failure. Passing the wall (not just its id) is what
 * makes the history survive being renamed. */
function limitIdSet(limit) {
  if (!limit) return [];
  const ids = [typeof limit === "string" ? limit : limit.id, ...(Array.isArray(limit.aliases) ? limit.aliases : [])];
  return ids.filter(Boolean);
}
function failedRounds(limit, ledger) {
  const ids = new Set(limitIdSet(limit));
  return (ledger || [])
    .filter((e) => e && e.limit && ids.has(e.limit.id) && e.verdict !== "accepted")
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
  // Layer 10: the whole wall, not its current id — see limitIdSet()
  const failures = failedRounds(limit, ledger);
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

function failureDossier(limit, ledger) {
  return failedRounds(limit, ledger).map((e, i) => {
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
  const dossier = failureDossier(limit, ledger);
  return { budget, dossier, block: buildFailureBlock(dossier, budget) };
}

/* Who is next, and why — one place, so the daemon, the API and the forge agree on both the
 * ceiling and the feedback. Layer 6.8 adds the second term: a wall's own category record.
 * `unlock − risk/2` is the engine's *estimate* of what a wall is worth, made before anything
 * was built; the adoption term is what actually happened to the last things built there. A
 * category whose rounds nobody ever called loses up to ADOPTION_WEIGHT points, one whose
 * rounds are in daily use gains them. Categories with nothing scored yet contribute exactly
 * 0 — an unmeasured category is never punished for being unmeasured. */
function targetRanking(limits, ledger, { adoption = null, usage = null, now = Date.now() } = {}) {
  const cats = adoption || categoryAdoption(ledger, usage || loadUsage(), now);
  return (limits || [])
    // Layer 10: dormant walls stay in the register but stop competing for rounds
    .filter((l) => isTargetable(l) && !attemptBudget(l, ledger).exhausted)
    .map((l) => {
      const base = round2(l.unlock_score - l.risk / 2);
      const s = cats[l.category];
      const adjust = Number.isFinite(s) ? round2(ADOPTION_WEIGHT * s) : 0;
      return {
        id: l.id,
        title: l.title,
        category: l.category,
        base,
        adoption_signal: Number.isFinite(s) ? s : null,
        adoption_adjust: adjust,
        score: round2(base + adjust),
      };
    })
    // Ties fall back to the pre-Layer-6.8 order, so an engine with nothing scored yet
    // behaves exactly as it did before this layer existed.
    .sort((a, b) => b.score - a.score || b.base - a.base);
}

function selectTarget(limits, ledger, opts = {}) {
  const top = targetRanking(limits, ledger, opts)[0];
  return top ? (limits || []).find((l) => l.id === top.id) || null : null;
}

/* ================= Layer 6.9: THE SELF-CONNECTOR =================
 * The premise the entire system is built on is that a good answer comes from laying one
 * domain's structure over another's. Every layer honours it except the one that matters
 * most: buildForgePrompt() received three things — the wall, the failure history, and the
 * source code — and not one knowledge dot. Not one of the innovations the engine had
 * synthesised itself. Nothing from /api/lessons. So the layer that decides what this engine
 * becomes worked inside exactly one domain: its own source. And buildIntrospectPrompt(),
 * which did see the repository, saw only `d.title` — Kintsugi, memory immunity, queueing
 * theory arrived as a list of names with their contents stripped off, close enough to look
 * like knowledge was present while none of it could be used as material.
 *
 * Nobody removed the dots on purpose. The forge prompt was frightening enough already, so
 * adding anything to it read as self-harm — and the question that never got asked was the
 * other one: what should come *out* so that knowledge can come *in*.
 *
 * So this layer answers both halves.
 *
 *   what comes in    the dots most structurally relevant to this wall, WITH their content ·
 *                    the innovations the engine synthesised, with the hidden pattern each
 *                    one found · the lessons the return path already computes · and one
 *                    connect round aimed at the wall itself (focus = description +
 *                    why_it_stands), so the cross-domain machinery is pointed at the engine
 *   what comes out   nothing arbitrary — the block is *budgeted*: FORGE_KNOWLEDGE_DOTS dots
 *                    clipped to FORGE_KNOWLEDGE_CHARS each, at most
 *                    FORGE_KNOWLEDGE_PER_DOMAIN per domain. The repository can grow for
 *                    ever; this block cannot. GET /api/forge/preview reports the size of
 *                    every part of the prompt so the trade is a number, not a feeling.
 *
 * And then the part that makes it a loop rather than a decoration: the round must name the
 * dots whose principles it used (`used_dot_ids`). That claim is written back into
 * connections.json as a real connection, and the verdict of the gates becomes its outcome —
 * so Layer 4.5 scores those dots by whether the wall actually fell. A repository that only
 * ever accumulates is unfalsifiable; this is the first mechanism that can tell the engine a
 * piece of its own knowledge is worthless.
 */
const FORGE_KNOWLEDGE_RULE =
  "รอบหลอมตัวเองได้อ่านคลังความรู้ของตัวเองก่อนแตะโค้ด: จุดที่เกี่ยวกับกำแพงนี้ที่สุดพร้อม 'เนื้อหาจริง' " +
  "(วัดความเกี่ยวด้วย 4-gram overlap ถ่วงด้วยลำดับความสนใจและประวัติการช่วยทำลายกำแพง · จำกัดโดเมนละไม่เกิน " +
  `${FORGE_KNOWLEDGE_PER_DOMAIN} จุด) · นวัตกรรมที่ระบบเคยสังเคราะห์เองพร้อมรูปแบบที่ซ่อนอยู่ · บทเรียนจากเส้นตอบกลับ · ` +
  "และรอบเชื่อมจุดที่เล็งกำแพงนี้โดยเฉพาะ (focus = description + why_it_stands) · " +
  "แลกกับการที่บล็อกนี้มีเพดานตายตัว จึงไม่โตตามคลังไปเรื่อย ๆ · " +
  "จากนั้นรอบนั้นต้องประกาศว่าใช้หลักการจากจุดไหน (used_dot_ids) คำประกาศถูกเขียนกลับเป็นการเชื่อมจุดจริง " +
  "แล้วผลของด่านทั้งหมดกลายเป็น outcome ของมันตาม Layer 4.5 — จุดที่ถูกอ้างว่าช่วยแล้วกำแพงไม่ล้ม ถูกหักคะแนนเท่าไอเดียที่ตายแล้ว";

function clipText(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// The wall, written as the focus of a connect round — exactly what the analysis prescribed:
// description plus the reason it is still standing, which is usually where the structure
// worth matching against another domain actually lives.
function wallFocus(limit) {
  const l = limit || {};
  const head = `ทำลายกำแพงในโค้ดของระบบตัวเอง: ${clipText(l.title, 140) || "(ไม่ระบุ)"}`;
  // The reason a wall is still standing is usually where the structure worth matching lives,
  // so it is clipped *first* and the description gets whatever room is left — the other way
  // round, a long description would silently push the "why" out of the focus entirely.
  const why = l.why_it_stands ? `กำแพงนี้ยังอยู่เพราะ: ${clipText(l.why_it_stands, 170)}` : "";
  const desc = clipText(l.description, Math.max(60, 450 - head.length - why.length));
  return [head, desc, why].filter(Boolean).join(" · ");
}

/* Which dots stand a chance of being useful against this wall. The measure is the same
 * character 4-gram overlap Layer 6.5 uses to decide whether two failed rounds were really
 * the same approach, pointed at a wall instead of a round — Thai has no spaces to tokenise
 * on, so shingles are the one comparison in this codebase that works on both languages.
 *
 * Overlap alone would be self-defeating: it would only ever surface dots that describe the
 * wall in the wall's own words, which is the opposite of a cross-domain connection. So it is
 * bent by two things the engine already knows — the attention the return path assigned
 * (normalised, or a dot idle for 300 days would drown everything else out) and whether this
 * dot has helped break a wall before. Pure and deterministic: the same repository always
 * produces the same ranking, which is why it can be dry-run without an AI. */
function wallRelevance(limit, dots) {
  const l = limit || {};
  const wall = shingles(
    `${l.title || ""} ${l.description || ""} ${l.why_it_stands || ""} ${l.break_idea || ""} ${l.evidence || ""}`
  );
  const pool = Array.isArray(dots) ? dots : [];
  // reduce, not Math.max(...spread): a repository of a few thousand dots would blow the
  // argument limit, and this function has to survive the repository growing.
  const maxAttention = pool.reduce((n, d) => Math.max(n, Number(d.attention_score) || 0), 1);
  return pool
    .map((d) => {
      const overlap = wall.size ? round2(jaccard(wall, shingles(`${d.title || ""} ${String(d.content || "").slice(0, 900)}`))) : 0;
      const attention = round2((Number(d.attention_score) || 0) / maxAttention);
      const forge = Number(d.forge_score) || 0;
      return {
        ...d,
        wall_overlap: overlap,
        attention_norm: attention,
        relevance: round2(3 * overlap + 0.6 * attention + 0.5 * forge),
      };
    })
    .sort((a, b) => b.relevance - a.relevance || b.attention_score - a.attention_score);
}

// The budget, applied: take the most relevant dots but never let one domain fill the block,
// because a block full of one domain is a block that cannot produce a cross-domain match.
function pickForgeDots(ranked, { max = FORGE_KNOWLEDGE_DOTS, perDomain = FORGE_KNOWLEDGE_PER_DOMAIN } = {}) {
  const picked = [];
  const taken = new Set();
  const perDomainCount = new Map();
  for (const d of ranked) {
    if (picked.length >= max) break;
    const n = perDomainCount.get(d.domain) || 0;
    if (n >= perDomain) continue;
    perDomainCount.set(d.domain, n + 1);
    taken.add(d.id);
    picked.push(d);
  }
  // A repository with only one or two domains must still fill the block it was given.
  for (const d of ranked) {
    if (picked.length >= max) break;
    if (!taken.has(d.id)) {
      taken.add(d.id);
      picked.push(d);
    }
  }
  return picked;
}

// The innovations the engine synthesised for itself, best-scoring first, each carrying the
// hidden pattern it claimed to see. This is the material Layer 6 never got: the engine's own
// track record of structural matches, offered back to it as it rewrites its own structure.
function forgeInnovations(connections, max = FORGE_KNOWLEDGE_INNOVATIONS) {
  return (Array.isArray(connections) ? connections : [])
    .filter((c) => c && c.innovation && c.innovation.name)
    .map((c) => ({ c, signal: connectionSignal(c) }))
    .sort((a, b) => (b.signal === null ? 0 : b.signal) - (a.signal === null ? 0 : a.signal))
    .slice(0, max)
    .map(({ c, signal }) => ({
      id: c.id,
      name: String(c.innovation.name).slice(0, 200),
      at: c.created_at,
      signal: signal === null ? null : round2(signal),
      from_wall: c.wall ? c.wall.title : null,
      dots: (c.selected_dots || []).map((d) => `${d.title} [${d.domain}]`),
      hidden_pattern: clipText(c.hidden_pattern, 300),
      connection: clipText(c.connection, 300),
      why_new: clipText(c.innovation.why_new, 200),
    }));
}

// The freshest connect round that was aimed at this particular wall, if there is one.
function wallInsight(limit, connections, { maxAgeHours = FORGE_INSIGHT_HOURS } = {}) {
  const l = limit || {};
  if (!l.id) return null;
  for (const c of Array.isArray(connections) ? connections : []) {
    if (!c || !c.wall || c.wall.id !== l.id) continue;
    const ageHours = round2(Math.max(0, (Date.now() - new Date(c.created_at).getTime()) / 3600000));
    const signal = connectionSignal(c);
    return {
      connection: c.id,
      at: c.created_at,
      age_hours: ageHours,
      stale: maxAgeHours > 0 && ageHours > maxAgeHours,
      focus: c.focus || null,
      auto: Boolean(c.auto),
      hidden_pattern: clipText(c.hidden_pattern, 600),
      connection_text: clipText(c.connection, 700),
      innovation: c.innovation || {},
      dots: (c.selected_dots || []).map((d) => ({ id: d.id, title: d.title, domain: d.domain })),
      signal: signal === null ? null : round2(signal),
    };
  }
  return null;
}

/* Everything a forge round is allowed to read about the repository, assembled. Pure over
 * (limit, dots, connections) so POST /api/forge/knowledge/dryrun exercises this exact
 * function with a hypothetical repository and cannot disagree with the real round. */
function forgeKnowledge(limit, { dots = null, connections = null } = {}) {
  const conns = Array.isArray(connections) ? connections : loadJson(CONN_FILE, []);
  const raw = Array.isArray(dots) ? dots : loadJson(DOTS_FILE, []);
  const enriched = enrichDots(raw, conns);
  const ranked = wallRelevance(limit, enriched);
  const picked = pickForgeDots(ranked);
  return {
    wall: limit
      ? { id: limit.id, title: limit.title, category: limit.category, focus: wallFocus(limit) }
      : null,
    dots: picked.map((d) => ({
      id: d.id,
      title: d.title,
      domain: d.domain,
      content: clipText(d.content, FORGE_KNOWLEDGE_CHARS),
      content_chars: String(d.content || "").length,
      origin_label: d.origin_label,
      relevance: d.relevance,
      wall_overlap: d.wall_overlap,
      attention_score: d.attention_score,
      value_score: d.value_score,
      rated_uses: d.rated_uses,
      proven: d.proven,
      dead_end: d.dead_end,
      forge_uses: d.forge_uses,
      forge_score: d.forge_score,
      forge_proven: d.forge_proven,
      absorbed_count: d.absorbed_count,
    })),
    // What was left out, named — the honest half of having a budget at all.
    skipped_dots: Math.max(0, ranked.length - picked.length),
    pool_dots: ranked.length,
    domains: [...new Set(picked.map((d) => d.domain))],
    innovations: forgeInnovations(conns),
    lessons: buildLessons(conns, FORGE_KNOWLEDGE_LESSONS),
    insight: wallInsight(limit, conns),
    caps: {
      dots: FORGE_KNOWLEDGE_DOTS,
      dot_chars: FORGE_KNOWLEDGE_CHARS,
      per_domain: FORGE_KNOWLEDGE_PER_DOMAIN,
      innovations: FORGE_KNOWLEDGE_INNOVATIONS,
      lessons: FORGE_KNOWLEDGE_LESSONS,
      insight_hours: FORGE_INSIGHT_HOURS,
    },
    rule: FORGE_KNOWLEDGE_RULE,
  };
}

// The block itself — bounded, and written so a round cannot mistake it for decoration.
function buildKnowledgeBlock(brief) {
  const b = brief || {};
  const dots = b.dots || [];
  const line = (d) =>
    `- id: ${d.id} · [${d.domain}] ${d.title}\n` +
    `  หลักการ: ${d.content || "(จุดนี้ไม่มีเนื้อหา)"}\n` +
    `  ความเกี่ยวกับกำแพงนี้ ${d.relevance} (ทาบโครงสร้างตรงกัน ${d.wall_overlap})` +
    ` · ลำดับความสนใจ ${d.attention_score}` +
    (d.rated_uses ? ` · คะแนนคุณค่าจากผลลัพธ์จริง ${d.value_score > 0 ? "+" : ""}${d.value_score}` : "") +
    (d.forge_uses
      ? ` · เคยถูกอ้างในรอบหลอมตัวเอง ${d.forge_uses} ครั้ง คะแนน ${d.forge_score > 0 ? "+" : ""}${d.forge_score}` +
        (d.forge_proven ? " (เคยช่วยทำลายกำแพงได้จริง)" : d.forge_score < 0 ? " (เคยถูกอ้างแล้วกำแพงไม่ล้ม)" : "")
      : " · ยังไม่เคยถูกใช้ในรอบหลอมตัวเองเลย");
  const inv = (i) =>
    `- "${i.name}"${i.signal === null ? " (ยังไม่มีผลตอบกลับ)" : ` (สัญญาณ ${i.signal > 0 ? "+" : ""}${i.signal})`}` +
    `${i.from_wall ? ` · เกิดจากรอบที่เล็งกำแพง "${i.from_wall}"` : ""}\n` +
    `  จาก: ${i.dots.join(" + ") || "?"}\n` +
    `  รูปแบบที่ซ่อนอยู่ที่มันเห็น: ${i.hidden_pattern || "(ไม่ระบุ)"}`;

  const insight = b.insight
    ? `--- 🎯 รอบเชื่อมจุดที่เล็งกำแพงนี้โดยเฉพาะ (${b.insight.at}${b.insight.stale ? " · เก่ากว่าเพดานความสดแล้ว" : ""}) ---
โจทย์ที่ตั้งให้รอบนั้น: ${b.insight.focus || "(ไม่ระบุ)"}
จุดที่มันเลือกมาเชื่อม: ${b.insight.dots.map((d) => `${d.title} [${d.domain}]`).join(" + ") || "(ไม่ระบุ)"}
รูปแบบเชิงโครงสร้างที่มันเห็น: ${b.insight.hidden_pattern || "(ไม่ระบุ)"}
การลากเส้นเชื่อม: ${b.insight.connection_text || "(ไม่ระบุ)"}
สิ่งที่มันเสนอ: ${clipText(b.insight.innovation && b.insight.innovation.name, 200)} — ${clipText(
        b.insight.innovation && b.insight.innovation.description,
        400
      )}
⚠ นี่คือ "ข้อเสนอ" ไม่ใช่ "คำสั่ง": มันถูกเขียนโดยไม่ได้เห็นโค้ด คุณเห็นโค้ด ถ้าโครงสร้างที่มันทาบไม่เข้ากับของจริง ให้บอกออกมาตรง ๆ ว่าไม่เข้า`
    : `--- 🎯 รอบเชื่อมจุดที่เล็งกำแพงนี้ ---
ยังไม่มีรอบเชื่อมจุดที่เล็งกำแพงนี้ (สั่งได้เองที่ POST /api/forge/insight หรือปุ่ม "⚡ สั่งรอบเชื่อมจุดเล็งกำแพงนี้" บนหน้าเว็บ)
รอบนี้จึงต้องทาบโครงสร้างด้วยตัวเองจากจุดความรู้ด้านล่าง`;

  return `===== 🧠 หลักการข้ามโดเมนที่อาจใช้กับกำแพงนี้ (Layer 6.9 · คลังความรู้ของตัวคุณเอง) =====
สมมติฐานที่ระบบทั้งระบบตั้งอยู่บนนั้นคือ "คำตอบที่ดีเกิดจากการทาบโครงสร้างข้ามโดเมน"
แต่เดิมชั้นที่สำคัญที่สุดของมัน (ชั้นนี้) ทำงานในโดเมนเดียวคือซอร์สโค้ดของตัวเอง — บล็อกนี้คือการแก้ข้อนั้น
คลังมี ${b.pool_dots || 0} จุด · เลือกมาให้คุณ ${dots.length} จุดจาก ${(b.domains || []).length} โดเมน (${(b.domains || []).join(" · ") || "-"})${
    b.skipped_dots ? ` · ย่อทิ้ง ${b.skipped_dots} จุดที่เกี่ยวน้อยกว่า เพื่อไม่ให้บล็อกนี้โตตามคลังไปเรื่อย ๆ` : ""
  }

--- 🔗 จุดความรู้ที่เกี่ยวกับกำแพงนี้ที่สุด (เนื้อหาจริง ไม่ใช่แค่ชื่อ) ---
${dots.map(line).join("\n") || "(คลังยังว่าง — รอบนี้ไม่มีความรู้ข้ามโดเมนให้ใช้)"}

--- 💡 นวัตกรรมที่ระบบนี้เคยสังเคราะห์เอง (โครงสร้างที่มันเคยมองเห็น) ---
${(b.innovations || []).map(inv).join("\n") || "(ยังไม่มี)"}

--- 🔁 บทเรียนจากเส้นตอบกลับ (Layer 4.5) ---
${(b.lessons || []).map((l) => `- "${l.name}" → ${l.lesson}`).join("\n") || "(ยังไม่มี)"}

${insight}

⛔ ข้อบังคับของรอบนี้ที่มาจากชั้นนี้:
1. ก่อนตัดสินใจว่าจะแก้โค้ดอย่างไร ให้ลองทาบ "หลักการ" ข้างบนกับรูปทรงของกำแพงนี้อย่างจริงจังก่อนหนึ่งรอบ
   (เช่น กลไกที่มีลูปป้อนกลับ / การหาค่าเหมาะสม / การกระจายความเสี่ยง / การซ่อมที่ทำให้แข็งแรงขึ้น
    มักมีรูปทรงเดียวกับปัญหาเชิงสถาปัตยกรรมในโค้ด) แล้วเลือกทางที่โครงสร้างเข้ากันจริง ไม่ใช่ที่ฟังดูเข้ากัน
2. ใน JSON ที่คุณตอบกลับ ต้องมี "used_dot_ids" (array ของ id จุดที่คุณใช้หลักการของมันจริง — ใส่ [] ถ้าไม่ได้ใช้เลย)
   และ "used_principle" (หลักการนั้นคืออะไร และคุณทาบมันกับกำแพงนี้อย่างไร — 1-3 ประโยค)
3. คำประกาศนั้นเป็น "การเดิมพัน" ไม่ใช่พิธีกรรม: ระบบจะเขียนมันกลับเป็นการเชื่อมจุดจริงในคลัง
   แล้วผลของด่านทั้งหมดในรอบนี้จะกลายเป็นผลลัพธ์ของการเชื่อมนั้นตาม Layer 4.5 —
   รอบผ่าน = จุดเหล่านั้นได้คะแนนบวกเท่าไอเดียที่ถูกเอาไปทำจริง · รอบตก = ถูกหักเท่าไอเดียที่ตายแล้ว
   ดังนั้น **ห้ามอ้างจุดที่ไม่ได้ใช้จริงเพื่อให้ดูดี** และ **ห้ามปิดบังจุดที่ใช้จริง** — คลังนี้จะเริ่มถูกพิสูจน์ด้วยรอบแบบนี้เท่านั้น
4. ถ้าคลังไม่ได้ช่วยอะไรเลยจริง ๆ ให้ตอบ used_dot_ids เป็น [] แล้วอธิบายใน used_principle ว่าทำไมความรู้ที่มีจึงทาบกับกำแพงนี้ไม่ได้
   — คำตอบแบบนั้นมีค่ากับระบบมากกว่าการอ้างจุดแบบขอไปที เพราะมันบอกว่าคลังยังขาดอะไร`;
}

/* ---- the return path of the knowledge itself (Layer 4.5, pointed at the forge) ---- */

// A round's claim, checked against the repository as it stands. `used_dot_ids` that name
// nothing real are reported, not silently dropped — the same way declareAdoption() reports
// routes a round claimed but never wrote.
function forgeFeedbackPlan(entry, dots) {
  const report = (entry && entry.report) || {};
  const byId = new Map((Array.isArray(dots) ? dots : []).map((d) => [d.id, d]));
  const raw = [
    ...new Set(
      (Array.isArray(report.used_dot_ids) ? report.used_dot_ids : [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    ),
  ];
  const dotIds = raw.filter((id) => byId.has(id));
  const accepted = entry && entry.verdict === "accepted" && !entry.rolled_back;
  return {
    declared: raw.length > 0,
    claimed: raw,
    dot_ids: dotIds,
    // Named but not in the repository (deleted since, or invented). Kept visible.
    missing: raw.filter((id) => !byId.has(id)),
    dots: dotIds.map((id) => {
      const d = byId.get(id);
      return { id: d.id, title: d.title, domain: d.domain };
    }),
    principle: clipText(report.used_principle, 600),
    verdict: (entry && entry.verdict) || null,
    mode: (entry && entry.mode) || "expansion",
    // The gates are the ground truth, so the outcome is written by them, not by a human:
    // a round that passed every gate is a shipped idea; one that was rolled back is a dead one.
    grade: accepted ? { status: "shipped", rating: 5 } : { status: "dead", rating: 1 },
    applicable: (entry && entry.mode) !== "consolidation" && dotIds.length > 0,
  };
}

// The claim, as an ordinary connection. Written into connections.json on purpose: that is
// the one ledger enrichDots() reads, so this is what makes a forge round able to move a
// dot's value_score at all — no second scoring system, no new formula.
function forgeFeedbackRecord(entry, plan) {
  const limit = (entry && entry.limit) || {};
  const report = (entry && entry.report) || {};
  const accepted = plan.grade.status === "shipped";
  return {
    id: "conn_forge_" + (entry && entry.id ? entry.id : crypto.randomBytes(4).toString("hex")),
    created_at: (entry && entry.at) || new Date().toISOString(),
    model: (entry && entry.model) || FORGE_MODEL,
    focus: clipText(`ทำลายกำแพงของระบบตัวเอง: ${limit.title || ""}`, 300),
    auto: true,
    wall: { id: limit.id || null, title: limit.title || null, category: limit.category || null },
    // Layer 6.9: this marker is what tells enrichDots() and the UI that the outcome below was
    // written by the forge gates rather than by the owner.
    forge: {
      evo_id: (entry && entry.id) || null,
      mode: plan.mode,
      verdict: plan.verdict,
      limit: { id: limit.id || null, title: limit.title || null, category: limit.category || null },
      principle: plan.principle,
      declared: plan.claimed,
      missing: plan.missing,
    },
    revived_dots: [],
    selected_dots: plan.dots,
    hidden_pattern:
      plan.principle ||
      "รอบหลอมตัวเองอ้างว่าใช้หลักการจากจุดเหล่านี้ แต่ไม่ได้อธิบายว่าหลักการนั้นคืออะไร",
    connection:
      `รอบหลอมตัวเอง ${(entry && entry.id) || "?"} เล็งกำแพง "${limit.title || "?"}" ` +
      `โดยอ้างว่าทาบหลักการจาก ${plan.dots.map((d) => `${d.title} [${d.domain}]`).join(" + ") || "?"} เข้ากับโค้ดของตัวเอง — ` +
      (accepted
        ? "และด่านทั้งหมดของรอบนั้นผ่าน จึงนับว่าหลักการนี้ทาบได้จริง"
        : "แต่รอบนั้นตกและถูกย้อนกลับ จึงยังไม่มีหลักฐานว่าหลักการนี้ทาบได้จริง"),
    innovation: {
      name: (accepted ? "ทำลายกำแพงได้: " : "รอบที่ตกกับกำแพง: ") + (limit.title || "?"),
      description: clipText(report.new_capability || report.summary, 500),
      why_new: clipText(report.differs_from_previous || report.proof_explains, 400),
      first_step: clipText(report.how_to_verify, 300),
    },
    evidence: null,
    learned_from_last_round: "",
    lessons_used: [],
    outcome: {
      rated_at: new Date().toISOString(),
      rating: plan.grade.rating,
      status: plan.grade.status,
      note: accepted
        ? `ด่านทั้งหมดของรอบหลอมตัวเองผ่าน (${clipText(entry && entry.reason, 240)}) — คะแนนนี้ถูกให้โดยด่านของระบบ ไม่ใช่โดยมนุษย์`
        : `รอบหลอมตัวเองนี้ตกและถูกย้อนกลับ (${clipText(entry && entry.reason, 240)}) — คะแนนนี้ถูกให้โดยด่านของระบบ ไม่ใช่โดยมนุษย์`,
    },
  };
}

/* Write the bet down. Called *after* the verdict and after the gates are done with the
 * memory snapshot, because this is a deliberate write to data/ — during the gates the very
 * same write would (correctly) look like the forge tampering with its own memory. */
function applyForgeFeedback(entry) {
  const dots = loadJson(DOTS_FILE, []);
  const plan = forgeFeedbackPlan(entry, dots);
  if (!plan.applicable) return { applied: false, plan };
  const record = forgeFeedbackRecord(entry, plan);
  const connections = loadJson(CONN_FILE, []);
  if (connections.some((c) => c && c.id === record.id)) return { applied: false, plan, duplicate: true };
  connections.unshift(record);
  saveJson(CONN_FILE, connections);
  const ids = new Set(plan.dot_ids);
  return {
    applied: true,
    plan,
    connection: record.id,
    signal: round2(connectionSignal(record)),
    affected_dots: enrichDots(dots, connections)
      .filter((d) => ids.has(d.id))
      .map((d) => ({
        id: d.id,
        title: d.title,
        value_score: d.value_score,
        attention_score: d.attention_score,
        forge_uses: d.forge_uses,
        forge_score: d.forge_score,
        forge_proven: d.forge_proven,
      })),
  };
}

// Which forge rounds put a bet on the repository and which never did. Rounds from before
// this layer are reported as such rather than being scored retroactively — the same honesty
// Layer 6.8 applies to rounds that never declared a route.
function forgeFeedbackLedger(connections, ledger) {
  const conns = Array.isArray(connections) ? connections : [];
  const rounds = Array.isArray(ledger) ? ledger : [];
  const byEvo = new Map();
  for (const c of conns) if (c && c.forge && c.forge.evo_id) byEvo.set(c.forge.evo_id, c);
  const declared = [];
  const undeclared = [];
  for (const e of rounds) {
    if (!e || e.mode === "consolidation") continue;
    const rec = byEvo.get(e.id);
    if (rec) {
      const signal = connectionSignal(rec);
      declared.push({
        evo_id: e.id,
        at: e.at,
        verdict: e.verdict,
        limit: (e.limit && e.limit.title) || null,
        connection: rec.id,
        principle: clipText(rec.forge.principle, 300),
        dots: (rec.selected_dots || []).map((d) => ({ id: d.id, title: d.title, domain: d.domain })),
        missing: rec.forge.missing || [],
        signal: signal === null ? null : round2(signal),
      });
    } else {
      undeclared.push({
        evo_id: e.id,
        at: e.at,
        verdict: e.verdict,
        limit: (e.limit && e.limit.title) || null,
        why: e.knowledge_used
          ? "รอบนี้ได้อ่านคลังความรู้แล้ว แต่ไม่ได้ประกาศว่าใช้หลักการจากจุดไหน — คลังจึงยังไม่ถูกพิสูจน์ด้วยรอบนี้"
          : "รอบนี้เกิดก่อน Layer 6.9 จึงไม่เคยได้อ่านคลังความรู้เลย — วัดย้อนหลังไม่ได้อย่างซื่อสัตย์",
      });
    }
  }
  return {
    declared,
    undeclared,
    declared_rounds: declared.length,
    undeclared_rounds: undeclared.length,
    signal: declared.filter((d) => d.signal !== null).length
      ? round2(
          declared.filter((d) => d.signal !== null).reduce((n, d) => n + d.signal, 0) /
            declared.filter((d) => d.signal !== null).length
        )
      : null,
  };
}

// The live summary the header bar, /api/self and the knowledge panel all read.
function forgeKnowledgeStatus() {
  const conns = loadJson(CONN_FILE, []);
  const dots = enrichDots(loadJson(DOTS_FILE, []), conns);
  const ledger = forgeFeedbackLedger(conns, loadJson(EVO_FILE, []));
  return {
    dots: dots.length,
    forge_scored_dots: dots.filter((d) => d.forge_rated_uses > 0).length,
    forge_proven_dots: dots.filter((d) => d.forge_proven).length,
    forge_dead_dots: dots.filter((d) => d.forge_rated_uses > 0 && d.forge_score <= -0.34).length,
    declared_rounds: ledger.declared_rounds,
    undeclared_rounds: ledger.undeclared_rounds,
    signal: ledger.signal,
    insight_rounds: conns.filter((c) => c && c.wall).length,
    insight_hours: FORGE_INSIGHT_HOURS,
    caps: {
      dots: FORGE_KNOWLEDGE_DOTS,
      dot_chars: FORGE_KNOWLEDGE_CHARS,
      per_domain: FORGE_KNOWLEDGE_PER_DOMAIN,
      innovations: FORGE_KNOWLEDGE_INNOVATIONS,
      lessons: FORGE_KNOWLEDGE_LESSONS,
    },
  };
}

/* The one AI call this layer adds: a connect round whose focus *is* the wall. It runs before
 * the forge takes its memory snapshot, is skipped entirely under DOT_SELFTEST or
 * FORGE_INSIGHT_HOURS=0, reuses a fresh round rather than paying twice, and can never fail a
 * forge round — a wall is still breakable with the knowledge already on disk. */
async function ensureWallInsight(limit, { force = false } = {}) {
  const existing = wallInsight(limit, loadJson(CONN_FILE, []));
  if (existing && !existing.stale && !force) return { insight: existing, ran: false, reason: "ใช้รอบที่ยังสดของกำแพงนี้ซ้ำ" };
  if (SELFTEST) return { insight: existing, ran: false, reason: "โหมดทดสอบ: ไม่เรียก AI" };
  if (FORGE_INSIGHT_HOURS <= 0 && !force) {
    return { insight: existing, ran: false, reason: "ปิดรอบเชื่อมจุดอัตโนมัติไว้ (FORGE_INSIGHT_HOURS=0)" };
  }
  try {
    const record = await performConnection({ focus: wallFocus(limit), wall: limit, auto: !force });
    return { insight: wallInsight(limit, [record]), ran: true, connection: record.id };
  } catch (e) {
    return { insight: existing, ran: false, error: e.message };
  }
}

/* ---- Layer 6 prompts ---- */
function sourceBundle(body) {
  return Object.entries(body)
    .map(([rel, content]) => `--- FILE: ${rel} (${content.split("\n").length} บรรทัด) ---\n${content}`)
    .join("\n\n");
}

/* The engine used to hand itself its entire source every round. That worked at 700 lines
 * and became the main cost at 6,000: a ~450 KB prompt to read before a single thought, growing
 * with every accepted round — the "the more it writes, the less of itself it can read" wall.
 * The forge holds Read/Grep/Glob, so a map plus on-demand reads buys the same context for a
 * fraction of the tokens. FORGE_BUNDLE=full restores the old behaviour for comparison.
 */
const SYMBOL_RE =
  /^\s*(?:(?:async\s+)?function\s+([A-Za-z0-9_$]+)|const\s+([A-Z][A-Z0-9_]+)\s*=|(?:.*\bp\s*===\s*"([^"]+)"))/;

function symbolIndex(body) {
  return Object.entries(body)
    .map(([rel, content]) => {
      const lines = content.split("\n");
      const syms = [];
      lines.forEach((line, i) => {
        const m = SYMBOL_RE.exec(line);
        const name = m && (m[1] || m[2] || (m[3] ? "route " + m[3] : null));
        if (name) syms.push(`${name}:${i + 1}`);
      });
      return `--- ${rel} (${lines.length} บรรทัด) ---\n${syms.length ? syms.join("  ") : "(ไม่มีสัญลักษณ์ระดับบนสุด)"}`;
    })
    .join("\n\n");
}

function forgeBundle(body) {
  if (FORGE_BUNDLE === "full") return sourceBundle(body);
  return (
    `นี่คือ "แผนที่" ซอร์สโค้ดของตัวคุณเอง ไม่ใช่ซอร์สเต็ม — รูปแบบ \`ชื่อสัญลักษณ์:เลขบรรทัด\`\n` +
    `คุณมี Read / Grep / Glob อยู่ในมือ: **เปิดอ่านเฉพาะส่วนที่จะแก้จริง และต้องอ่านก่อนแก้ทุกครั้ง**\n` +
    `ห้ามแก้ไฟล์ส่วนที่ยังไม่ได้อ่าน — แผนที่บอกได้แค่ว่าอะไรอยู่ที่ไหน ไม่ได้บอกว่ามันทำงานอย่างไร\n\n` +
    symbolIndex(body)
  );
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

/* Layer 6.9: introspection used to receive `dots.map(d => d.title)` — Kintsugi, memory
 * immunity, queueing theory arriving as a list of names with their mechanisms stripped off.
 * It looked like the repository was present while none of it could be used as material, which
 * is the most expensive kind of almost-right: the round that names the engine's walls was
 * asked to think across domains with the domains removed. Same budget shape as the forge
 * block — the head carries real content, the tail keeps its names so nothing disappears. */
function introspectKnowledgeBlock(dots, connections) {
  const conns = Array.isArray(connections) ? connections : [];
  const ordered = [...enrichDots(Array.isArray(dots) ? dots : [], conns)].sort(
    (a, b) => b.attention_score - a.attention_score
  );
  const full = ordered.slice(0, FORGE_KNOWLEDGE_DOTS * 2);
  const rest = ordered.slice(full.length);
  const innovations = forgeInnovations(conns, FORGE_KNOWLEDGE_INNOVATIONS * 2);
  return `จุดความรู้ในคลัง ${ordered.length} จุด — ${full.length} จุดที่ลำดับความสนใจสูงสุดถูกส่งมาพร้อม "เนื้อหาจริง" ไม่ใช่แค่ชื่อ
(ชั้นนี้เคยเห็นแค่ชื่อจุด คินสึงิ ภูมิคุ้มกันแบบจดจำ ทฤษฎีแถวคอย จึงเป็นได้แค่รายชื่อ ไม่เคยเป็นวัตถุดิบ — Layer 6.9 แก้ข้อนั้น):
${
    full
      .map(
        (d) =>
          `- [${d.domain}] ${d.title}${d.proven ? " ✅ เคยให้ผลจริง" : d.dead_end ? " 📉 เคยพาไปทางตัน" : ""}${
            d.forge_uses ? ` · เคยถูกใช้ในรอบหลอมตัวเอง ${d.forge_uses} ครั้ง (คะแนน ${d.forge_score})` : ""
          }\n  หลักการ: ${clipText(d.content, FORGE_KNOWLEDGE_CHARS)}`
      )
      .join("\n") || "(ยังไม่มีจุดในคลัง)"
  }
${rest.length ? `\n(อีก ${rest.length} จุดที่ลำดับความสนใจต่ำกว่า ย่อเหลือชื่อเพื่อคุมขนาดพรอมป์ต: ${rest.map((d) => `${d.title} [${d.domain}]`).join(" · ")})` : ""}

นวัตกรรมที่ระบบนี้เคยสังเคราะห์เอง พร้อม "รูปแบบเชิงโครงสร้าง" ที่มันเคยมองเห็น:
${
    innovations
      .map(
        (i) =>
          `- "${i.name}"${i.signal === null ? "" : ` (สัญญาณ ${i.signal > 0 ? "+" : ""}${i.signal})`} จาก ${i.dots.join(" + ") || "?"}\n` +
          `  รูปแบบที่ซ่อนอยู่: ${i.hidden_pattern || "(ไม่ระบุ)"}`
      )
      .join("\n") || "(ยังไม่มี)"
  }

⚠ วิธีใช้บล็อกนี้: กำแพงเชิงโครงสร้างของตัวเองมักมองเห็นได้ชัดที่สุดตอนเอา "หลักการ" ข้างบนไปทาบกับรูปทรงของโค้ดตัวเอง
เช่น ถามว่ากลไกในโดเมนอื่นที่แก้ปัญหารูปทรงเดียวกันนี้ ทำอย่างไร แล้วโค้ดนี้ขาดอะไรไปเมื่อเทียบกับมัน
ในแต่ละข้อที่คุณเสนอ ให้ break_idea อ้างอิงหลักการจากจุดข้างบนได้ถ้ามันเข้ากันจริง`;
}

function buildIntrospectPrompt(body, dots, connections, limits) {
  const standing = limits.filter(isTargetable);
  const broken = limits.filter((l) => l.status === "broken");
  // Layer 10: walls the mirror stopped mentioning are shown separately, so the model can
  // bring one back deliberately instead of rediscovering it under a new name.
  const dormant = limits.filter((l) => l.status === "dormant");
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
${forgeBundle(promptBundle(body))}

===== ความรู้ที่ระบบสะสมไว้ (ใช้เป็นวัตถุดิบเชื่อมจุดกับตัวเองได้) =====
${introspectKnowledgeBlock(dots, connections)}

===== ขอบเขตที่ถูกทำลายไปแล้ว (ห้ามเสนอซ้ำ) =====
${broken.map((l) => `- ${l.title}`).join("\n") || "(ยังไม่มี)"}

===== ขอบเขตที่บันทึกไว้แล้วและยังไม่ถูกทำลาย =====
${standing.map((l) => `- [${l.id}] ${l.title}${l.silent_rounds ? ` (ไม่ถูกเอ่ยถึงมาแล้ว ${l.silent_rounds} รอบ)` : ""}`).join("\n") || "(ยังไม่มี)"}
(ถ้าข้อไหนยังจริงอยู่ ให้คงไว้โดยใส่ id เดิมกลับมา)

⚠ สำคัญ (Layer 10 · RemLedger): ทะเบียนนี้เป็น "บัญชีสะสม" ไม่ใช่ภาพถ่าย — **การไม่เอ่ยถึงข้อใด ไม่ได้แปลว่าลบข้อนั้น**
ข้อที่คุณไม่พูดถึงจะยังอยู่ในสถานะ remanent (ยังจริง ยังถือประวัติความล้มเหลวของมันไว้) และจะเลิกถูกเสนอเป็นเป้าหมาย
ก็ต่อเมื่อเงียบติดกัน ${LIMIT_COERCIVE_ROUNDS} รอบ ดังนั้น**ถ้าข้อไหนไม่จริงแล้วจริง ๆ ให้พูดออกมาตรง ๆ ใน self_assessment ว่าข้อไหนและเพราะอะไร**
อย่าใช้วิธี "เงียบใส่" — และถ้าคุณคืน id ใหม่ให้กำแพงที่มีอยู่แล้ว ระบบจะจับคู่จากลายเซ็นเชิงโครงสร้าง (epitope) ให้เอง
เพื่อไม่ให้แผลเป็นของมันขาดจากตัวมัน

${dormant.length ? `===== ขอบเขตที่หลับอยู่ (เงียบเกิน ${LIMIT_COERCIVE_ROUNDS} รอบ — ยังอยู่ในทะเบียน ยังไม่ถูกทำลาย) =====
${dormant.map((l) => `- [${l.id}] ${l.title}`).join("\n")}
(ถ้าข้อไหนยังจริงอยู่ ให้เอ่ยถึงพร้อม id เดิม มันจะกลับมาพร้อมประวัติทั้งหมด)
` : ""}

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

/* Layer 6.8: the block that tells a round what happened to the last things this engine
 * built — and that it will be asked the same question about itself in a week. */
function buildAdoptionBlock(limit, debt, rank = null) {
  const c = debt.counts || {};
  const cat = (debt.categories || {})[limit && limit.category] || null;
  const targets = (debt.targets || []).slice(0, 6);
  return `===== 📈 เส้นตอบกลับของตัวระบบเอง (Layer 6.8 · ของที่รอบก่อน ๆ สร้างไว้ มีใครใช้บ้าง) =====
ทุกด่านของรอบนี้ตัดสินภายในวันนี้ แต่มีอีกด่านหนึ่งที่จะมาถึงทีหลัง: อีก ${debt.grace_days} วันข้างหน้า
ระบบจะเปิด evolution/endpoint-usage.json ขึ้นมาถามว่า "เส้นทางที่รอบนี้ประกาศไว้ มีใครเรียกจริงไหม"
แล้วให้คะแนนด้วยสูตรเดียวกับที่ใช้ให้คะแนนไอเดียของผู้ใช้ (weightedSignal) — รอบที่ได้ 0 ครั้งจะถูกเสนอเป็นเป้าหมายของรอบยุบรวมเอง
(ความเงียบก่อนครบ ${debt.grace_days} วัน หรือก่อนที่บันทึกจะเห็นคำขอครบ ${debt.min_requests} ครั้ง ยังไม่นับเป็นคำตัดสิน — ตอนนี้เห็นมาแล้ว ${debt.observed_requests} ครั้ง)

สภาพตอนนี้: ให้คะแนนได้แล้ว ${c.scored || 0} รอบ · ถูกใช้จริง ${c.adopted || 0} · ไม่มีใครเรียกเลย ${c.unused || 0} · ยังรอเวลา ${c.pending || 0} · เกิดก่อนชั้นนี้จึงวัดไม่ได้ ${c.undeclared || 0}
คะแนนการถูกใช้จริงเฉลี่ยของทั้งระบบ: ${debt.signal === null ? "ยังไม่มีรอบไหนถูกให้คะแนน" : debt.signal}
${
    cat
      ? `หมวด "${limit.category}" ของกำแพงนี้: คะแนน ${cat.signal} (ถูกใช้ ${cat.adopted}/${cat.rounds} รอบ)` +
        (rank
          ? ` → ลำดับความคุ้มของกำแพงนี้ถูกปรับจาก ${rank.base} เป็น ${rank.score} เพราะประวัติการถูกใช้ของหมวดนี้`
          : "")
      : `หมวด "${limit ? limit.category : "?"}" ยังไม่มีรอบไหนถูกให้คะแนน จึงยังไม่มีการปรับลำดับความคุ้มของกำแพงนี้`
  }
${
    targets.length
      ? `\n⚠ ความสามารถที่ระบบสร้างไว้แล้วไม่มีใครเรียกเลย (ระบบเสนอเป็นเป้าหมายของรอบยุบรวมเองแล้ว):\n` +
        targets
          .map(
            (t) =>
              `  · ${t.evo_id} (${String(t.at || "").slice(0, 10)}) — ${t.capability || "(ไม่ระบุความสามารถ)"}\n` +
              `    เส้นทางที่ประกาศไว้: ${t.endpoints.join(", ") || "(ไม่มี)"} · ผ่านมา ${t.days} วัน ยังไม่มีใครเรียก`
          )
          .join("\n") +
        `\nอ่านรายการนี้ก่อนลงมือ: ถ้าสิ่งที่คุณกำลังจะสร้างมีรูปทรงเดียวกับของที่ไม่มีใครเรียกด้านบน ให้เปลี่ยนแนวทาง` +
        ` — ความสามารถที่ต้องรอให้มนุษย์ไปหาปุ่มเจอเอง คือความสามารถที่ประวัติบอกแล้วว่าจะไม่ถูกเรียก`
      : ""
  }

⛔ ข้อบังคับของรอบนี้ที่มาจากชั้นนี้:
1. ใน JSON ที่คุณตอบกลับ ต้องมี "usage_endpoints" (เส้นทางที่จะถูกเรียก) และ "usage_note" (ใครจะเรียกมันผ่านอะไร)
   "usage_endpoints" คือเส้นทาง /api/... ที่ความสามารถใหม่นี้จะถูกใช้ผ่านจริง อย่างน้อยหนึ่งเส้น
   และต้องมีอยู่จริงในโค้ดใหม่ (ระบบตรวจกับ router เอง เส้นที่ไม่มีอยู่จริงจะถูกทิ้งและถูกบันทึกไว้ว่าคุณอ้างเกิน)
   ถ้ารอบนี้ไม่ได้เพิ่มเส้นทางใหม่เลย ให้ประกาศเส้นทางเดิมที่ความสามารถนี้ไหลผ่าน — แต่เส้นทางเดิมจะนับให้ก็ต่อเมื่อถูกเรียก *หลัง* รอบนี้
   ไม่ประกาศเลย = ตกด่าน "${GATE_LABEL.declared_usage}" และถูกย้อนกลับทั้งรอบ
2. ต่อ UI ให้ความสามารถใหม่ถูกเรียกได้จริงจากหน้าเว็บ ไม่ใช่แค่มี endpoint — เส้นทางที่ไม่มีใครกดถึงจะได้ 0 ครั้งแน่นอน`;
}

function buildForgePrompt(limit, body, evoId, history = null, debt = null, rank = null, knowledge = null) {
  const hist = history || { budget: attemptBudget(limit, []), dossier: [], block: "" };
  const block = hist.block || buildFailureBlock(hist.dossier || [], hist.budget);
  const adoptionBlock = buildAdoptionBlock(limit, debt || adoptionDebt(), rank);
  // Layer 6.9: the block this prompt spent its whole life without. It goes at the head, before
  // the scars and before the source, because a round that has already decided how it will
  // patch server.js will not go looking for another domain's structure afterwards.
  const knowledgeBlock = buildKnowledgeBlock(knowledge || forgeKnowledge(limit));
  return `คุณคือ "The Self-Forge" — ชั้นที่ 6 ของ The Dot-Connector AI
คุณกำลังจะแก้ไข *ซอร์สโค้ดของตัวคุณเอง* ที่รันอยู่จริงบนเครื่องผู้ใช้ ในโฟลเดอร์ปัจจุบัน (cwd)

===== ขอบเขตที่ต้องทำลายในรอบนี้ =====
ชื่อ: ${limit.title}
หมวด: ${limit.category}
กำแพงคืออะไร: ${limit.description}
ฝังอยู่ตรงไหน: ${limit.evidence}
ทำไมมันยังอยู่: ${limit.why_it_stands}
แนวทางทำลายที่ระบบวิเคราะห์ตัวเองไว้: ${limit.break_idea}

${knowledgeBlock}

${block}

${adoptionBlock}

===== ซอร์สโค้ดปัจจุบันของคุณ =====
${forgeBundle(promptBundle(body))}

===== วิธีทำงาน =====
ใช้เครื่องมือ Read / Edit / Write / Glob / Grep แก้ไฟล์จริงในโฟลเดอร์นี้ให้เสร็จสมบูรณ์
งานนี้ไม่ใช่ข้อเสนอ — ต้องลงมือแก้โค้ดจริงให้ใช้งานได้ทันที
🔧 คุณมี Bash แบบจำกัดคำสั่งด้วย: รัน \`node --check <ไฟล์>\` ได้เองทันทีเพื่อจับ syntax ก่อนส่งงาน (คำสั่งอื่นถูกปฏิเสธ)

🔁 รอบนี้ไม่ใช่การยิงนัดเดียวจบ (Layer 6.7): หลังคุณตอบ ระบบจะรันด่านทั้งหมดทันที
ถ้าตกด่านไหน stdout จริงของด่านนั้นจะถูกส่งกลับมาให้คุณอ่านในเซสชันเดิม แล้วคุณแก้ต่อได้เลย
โดยไฟล์ทุกไฟล์ที่คุณเขียนยังอยู่ครบบนดิสก์ (สูงสุด ${FORGE_MAX_TURNS} เทิร์นต่อรอบ)
แปลว่า: อย่าเดาว่าอะไรจะผ่าน — ส่งงานที่ดีที่สุดของคุณ แล้วใช้ผลตรวจจริงที่จะตามมาแก้ให้ตรงจุด

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
    (proveEvolution, runProof, regressionTest, bootServer, materializeTree, runForgeGates,
     forgeConverge, buildGateFeedback) ให้อ่อนลงเพื่อให้ตัวเองผ่านง่ายขึ้น
    — โดยเฉพาะห้ามทำให้ลูปของ Layer 6.7 ข้ามด่านใดด่านหนึ่งในเทิร์นหลัง ๆ: ทุกเทิร์นต้องรันด่านครบทั้งชุดเสมอ
11. ห้ามแก้กลไกความจำของความล้มเหลวให้อ่อนลงเพื่อซื้อโอกาสให้ตัวเอง
    (writeAttempted, failureDossier, attemptBudget, selectTarget, buildFailureBlock) และห้ามลบโฟลเดอร์ attempted/ ของรอบก่อน
12. ห้ามแก้กลไกวัดการถูกใช้จริงให้อ่อนลง (recordEndpointHit, loadUsage, declareAdoption, adoptionRound,
    adoptionReport, weightedSignal, targetRanking) และห้ามแก้ evolution/endpoint-usage.json ด้วยมือ
    — นี่คือด่านเดียวของระบบที่ตัดสินหลังรอบนี้จบไปแล้ว การทำให้มันอ่อนลงคือการปิดตาตัวเองเรื่องคุณค่าของงานตัวเอง
13. ห้ามแก้กลไกที่ทำให้คลังความรู้ถูกพิสูจน์ได้ให้อ่อนลง (forgeKnowledge, wallRelevance, buildKnowledgeBlock,
    forgeFeedbackPlan, forgeFeedbackRecord, applyForgeFeedback, introspectKnowledgeBlock)
    — โดยเฉพาะห้ามทำให้การประกาศ used_dot_ids กลายเป็นสิ่งที่ไม่มีผลอะไรกับคะแนนของจุด
    เพราะกลไกนี้คือทางเดียวที่ระบบจะรู้ได้ว่าความรู้ในคลังของมันช่วยอะไรจริงหรือเปล่า

เมื่อแก้เสร็จแล้ว ให้ตอบกลับเป็น JSON ล้วนเท่านั้นในข้อความสุดท้าย (ห้ามมีข้อความอื่นนอก JSON) ทุก field เป็นภาษาไทย:
{
  "broke_it": true | false,
  "summary": "<ทำลายกำแพงนี้ได้อย่างไร — 2-3 ประโยค>",
  "differs_from_previous": "<รอบนี้ต่างจากรอบที่เคยตกกับกำแพงนี้อย่างไร ทั้งไฟล์ที่แตะและกลไกที่ใช้ — ถ้าเป็นครั้งแรกให้บอกว่ายังไม่มีรอบก่อน>",
  "what_changed": ["<ไฟล์: สิ่งที่แก้ไปแบบรูปธรรม>"],
  "new_capability": "<ตอนนี้ระบบทำอะไรได้ที่เมื่อวานทำไม่ได้ — 1-2 ประโยค พูดให้ผู้ใช้เข้าใจทันที>",
  "used_dot_ids": ["<id ของจุดความรู้ที่คุณใช้หลักการของมันจริงในรอบนี้ — [] ถ้าคลังไม่ได้ช่วยเลย>"],
  "used_principle": "<หลักการข้ามโดเมนที่คุณหยิบมาใช้คืออะไร และคุณทาบมันกับกำแพงนี้อย่างไร — 1-3 ประโยค (ถ้า used_dot_ids ว่าง ให้อธิบายว่าทำไมความรู้ที่มีทาบไม่ได้)>",
  "usage_endpoints": ["<เส้นทาง /api/... ที่ความสามารถใหม่นี้จะถูกเรียกผ่านจริง — อย่างน้อยหนึ่งเส้น และต้องมีอยู่จริงในโค้ดใหม่>"],
  "usage_note": "<ใครจะเรียกเส้นทางเหล่านั้น ผ่านปุ่มไหนหรือกลไกไหน และเมื่อไหร่ — นี่คือคำสัญญาที่อีก ${ADOPTION_DAYS} วันระบบจะเอามาเทียบกับบันทึกการใช้งานจริง>",
  "proof_file": "selftest/${evoId}.js",
  "proof_explains": "<ไฟล์พิสูจน์นี้ทดสอบอะไร และทำไมโค้ดเดิมถึงต้องตกการทดสอบนี้ — 1-2 ประโยค>",
  "how_to_verify": "<ผู้ใช้กดอะไรตรงไหนถึงจะเห็นความสามารถใหม่นี้ด้วยตาตัวเอง>",
  "next_boundary": "<หลังทำลายอันนี้ กำแพงถัดไปที่โผล่ขึ้นมาคืออะไร>"
}`;
}

/* ---- Layer 6 operations ---- */
/* ================= Layer 10: THE REMLEDGER — ทะเบียนกำแพงแบบแม่เหล็กค้าง =================
 * This layer was designed by the engine itself: POST /api/forge/insight laid its own wall
 * "the register is overwritten every time it looks in the mirror" over two dots from the
 * repository — hysteresis in physics (dot_2c82d4bf) and immune memory (dot_21a771d4) — and
 * the shared structure it found is the whole design:
 *
 *   · hysteresis     asserting a wall exists is cheap; declaring it gone must cost a
 *                    coercive field. In between, the state simply *stays* (remanence),
 *                    with nobody having to mention it this round.
 *   · immune memory  a memory cell remembers the antigen, not the case number. A scar must
 *                    bind to the wall's structural signature — its epitope — never to an id
 *                    the model reissues at random each time it looks.
 *
 * What it replaces: introspect() wrote the whole of limits.json every round and kept only
 * (a) broken walls and (b) walls whose id the model happened to echo back. A wall that was
 * still true but went unmentioned vanished — with its attempt count, and with the link from
 * evolution.json's failed rounds to the thing they failed at. Three of the four inputs to
 * attemptBudget()/failureDossier() were addressed by an id the register kept reissuing, so
 * the engine could try the same wall five times and believe every time was the first.
 *
 * Nothing is deleted here, ever. Walls move between states and every move is appended to
 * evolution/limits-events.jsonl, which is the audit trail limits.json cannot be.
 */
const LIMIT_EVENTS_FILE = path.join(EVO_DIR, "limits-events.jsonl");
// Consecutive introspections a standing wall may go unmentioned before the register stops
// offering it as a target. Not deletion — dormancy, and one mention brings it back.
const LIMIT_COERCIVE_ROUNDS = Math.max(1, Number(process.env.LIMIT_COERCIVE_ROUNDS || 3));
// Jaccard overlap over 4-gram shingles above which two descriptions are the same wall
// wearing two names. Deliberately not too eager: merging two real walls hides one of them.
const LIMIT_EPITOPE_MATCH = Math.min(0.95, Math.max(0.2, Number(process.env.LIMIT_EPITOPE_MATCH || 0.42)));

/* The structural signature of a wall: what it is about, not what it was called this time.
 * Two parts, because they fail in different ways —
 *   shingles: 4-grams of the normalised prose, which survives rewording
 *   symbols:  the code identifiers the wall names (functions, files, endpoints), which
 *             survive a complete rewrite of the prose but not a genuine change of subject */
function epitopeOf(limit) {
  const text = [limit.title, limit.description, limit.evidence].filter(Boolean).join(" ");
  const norm = String(text)
    .toLowerCase()
    .replace(/[\s​]+/g, " ")
    .replace(/[«»"'`(),.;:!?\[\]{}]/g, "")
    .trim();
  const shingles = new Set();
  for (let i = 0; i + 4 <= norm.length; i++) shingles.add(norm.slice(i, i + 4));
  const symbols = new Set(
    (String(text).match(/[A-Za-z_][A-Za-z0-9_]{3,}(?:\(\)|\.js|\.json)?|\/api\/[a-z/]+/g) || [])
      .map((s) => s.toLowerCase().replace(/\(\)$/, ""))
  );
  return { shingles, symbols };
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / (a.size + b.size - hit);
}
/* How strongly two walls are the same wall. Symbol overlap is worth more than prose overlap:
 * two walls can describe the same code in different words, but two walls that name the same
 * three functions and the same failure shape are not two walls. */
function epitopeSimilarity(a, b) {
  const prose = jaccard(a.shingles, b.shingles);
  const code = jaccard(a.symbols, b.symbols);
  return Math.max(prose, code ? prose * 0.5 + code * 0.5 : 0);
}
function appendLimitEvent(event) {
  try {
    fs.mkdirSync(path.dirname(LIMIT_EVENTS_FILE), { recursive: true });
    fs.appendFileSync(LIMIT_EVENTS_FILE, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch {}
}
function readLimitEvents(limit = null) {
  let lines = [];
  try {
    lines = fs.readFileSync(LIMIT_EVENTS_FILE, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const ids = limit ? new Set(limitIdSet(limit)) : null;
  const out = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (!ids || ids.has(e.limit_id)) out.push(e);
    } catch {}
  }
  return out;
}
// A wall the register is currently willing to spend a round on.
function isTargetable(l) {
  return l.status !== "broken" && l.status !== "dormant";
}

/* The merge that used to be an overwrite. Pure — no AI, no disk — so the proof file can
 * drive it through POST /api/limits/merge/dryrun with invented input and check every
 * transition without spending a forge round. */
function mergeLimits(current, incoming, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const events = [];
  const kept = current.map((l) => ({ ...l, aliases: Array.isArray(l.aliases) ? [...l.aliases] : [] }));
  const epitopes = kept.map((l) => ({ limit: l, ep: epitopeOf(l) }));
  const touched = new Set();

  for (const raw of incoming) {
    if (!raw || !raw.title) continue;
    const candidate = {
      title: String(raw.title).slice(0, 200),
      category: String(raw.category || "capability").slice(0, 40),
      description: String(raw.description || "").slice(0, 1200),
      evidence: String(raw.evidence || "").slice(0, 600),
      why_it_stands: String(raw.why_it_stands || "").slice(0, 600),
      break_idea: String(raw.break_idea || "").slice(0, 1200),
      unlock_score: Number(raw.unlock_score) || 5,
      risk: Number(raw.risk) || 5,
    };
    // 1. The id, if the model happened to echo one back that we know.
    let match = raw.id ? kept.find((l) => limitIdSet(l).includes(raw.id)) : null;
    let how = match ? "id" : null;
    let score = match ? 1 : 0;
    // 2. Otherwise the epitope: same wall, new name.
    if (!match) {
      const ep = epitopeOf(candidate);
      let best = null;
      for (const row of epitopes) {
        if (touched.has(row.limit.id)) continue;
        const sim = epitopeSimilarity(ep, row.ep);
        if (sim >= LIMIT_EPITOPE_MATCH && (!best || sim > best.sim)) best = { limit: row.limit, sim };
      }
      if (best) {
        match = best.limit;
        how = "epitope";
        score = Math.round(best.sim * 100) / 100;
      }
    }

    if (match) {
      touched.add(match.id);
      // A wall that was broken and is being described again has come back: the code that
      // broke it was rolled back, or it was never really broken. Say so out loud.
      const revived = match.status === "broken" || match.status === "dormant";
      const before = match.status;
      if (raw.id && raw.id !== match.id && !match.aliases.includes(raw.id)) match.aliases.push(raw.id);
      Object.assign(match, candidate, {
        status: match.status === "broken" ? "broken" : "standing",
        silent_rounds: 0,
        last_seen_at: now,
      });
      events.push({
        limit_id: match.id,
        type: revived && before === "dormant" ? "revived" : "confirmed",
        matched_by: how,
        similarity: score,
        from_status: before,
        to_status: match.status,
        title: match.title,
      });
    } else {
      const fresh = {
        id: "lim_" + crypto.randomBytes(4).toString("hex"),
        ...candidate,
        status: "standing",
        attempts: 0,
        aliases: [],
        silent_rounds: 0,
        found_at: now,
        last_seen_at: now,
      };
      kept.push(fresh);
      epitopes.push({ limit: fresh, ep: epitopeOf(fresh) });
      touched.add(fresh.id);
      events.push({ limit_id: fresh.id, type: "found", to_status: "standing", title: fresh.title });
    }
  }

  // Remanence: a standing wall nobody mentioned does not disappear. It holds its state, and
  // only after LIMIT_COERCIVE_ROUNDS of silence does it stop being offered as a target —
  // still in the file, still holding its scars, one mention away from coming back.
  for (const l of kept) {
    if (touched.has(l.id) || l.status === "broken") continue;
    const silent = (Number(l.silent_rounds) || 0) + 1;
    l.silent_rounds = silent;
    if (l.status !== "dormant" && silent >= LIMIT_COERCIVE_ROUNDS) {
      l.status = "dormant";
      l.dormant_at = now;
      events.push({ limit_id: l.id, type: "dormant", from_status: "standing", to_status: "dormant", silent_rounds: silent, title: l.title });
    } else if (l.status !== "dormant") {
      events.push({ limit_id: l.id, type: "remanent", to_status: l.status, silent_rounds: silent, title: l.title });
    }
  }

  const order = { standing: 0, dormant: 1, broken: 2 };
  const merged = kept.sort(
    (a, b) => (order[a.status] ?? 0) - (order[b.status] ?? 0) || (b.unlock_score || 0) - (a.unlock_score || 0)
  );
  return { limits: merged, events };
}

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
  const { limits, events } = mergeLimits(current, incoming);
  saveJson(LIMITS_FILE, limits);
  for (const e of events) appendLimitEvent({ ...e, source: "introspect" });
  return {
    self_assessment: parsed.self_assessment || "",
    limits,
    // What the mirror actually did to the register, so it is reviewable rather than assumed.
    register: {
      before: current.length,
      after: limits.length,
      found: events.filter((e) => e.type === "found").length,
      confirmed: events.filter((e) => e.type === "confirmed").length,
      renamed: events.filter((e) => e.matched_by === "epitope").length,
      remanent: events.filter((e) => e.type === "remanent").length,
      dormant: events.filter((e) => e.type === "dormant").length,
      revived: events.filter((e) => e.type === "revived").length,
      lost: 0,
    },
  };
}

// The pseudo-boundary a consolidation round works against. It is never "broken" and never
// enters limits.json: shrinking is not a wall you get past once, it is maintenance forever.
const CONSOLIDATION_TARGET = {
  id: "consolidation",
  title: "รอบยุบรวม: ทำให้ตัวเองเล็กลงโดยไม่เสียความสามารถ",
  category: "architecture",
};

/* ================= Layer 6.7: THE CLOSED LOOP =================
 * The author used to leave the room before the exam was marked. runClaude() was a
 * single shot: the model got Read/Edit/Write/Glob/Grep, wrote its round, and its process
 * died. Only then did syntax, boot, the capability proof, the differential and the
 * regression sweep run — and runProof() printed the real stdout of the file the model had
 * just written into checks.capability_detail, a field that round could never read. The
 * knowledge that decided life or death existed at minute three and was withheld from the
 * only party who could still act on it until the next round, 5-20 minutes and one quota
 * later, through scar tissue.
 *
 * So the round becomes a loop instead of a shot:
 *
 *   ask ──→ runForgeGates()  ──ผ่าน──→ accepted
 *    ↑           │
 *    │         ตกที่ด่านไหน + stdout จริงของด่านนั้น
 *    └── buildGateFeedback() ──── same Claude session, same round, code still on disk
 *
 * Three pieces, deliberately separable so the loop can be tested without an AI at all:
 *   · runForgeGates()      runs the whole battery over whatever is on disk. Never rolls
 *                          back — that is the round's decision, made once, at the end.
 *   · buildGateFeedback()  turns gate results into the next prompt, stdout included verbatim.
 *   · forgeConverge()      the driver: ask → verify → feed back → stop. `ask` and `verify`
 *                          are injected, which is what makes POST /api/forge/loop/simulate
 *                          able to exercise this exact function offline.
 */

// One pass of the whole gate battery over the tree as it stands right now.
async function runForgeGates({ evoId, before, guarded, consolidating, report }) {
  const after = readSelf();
  const changes = diffSelf(before, after);
  const backup = writeBackup(evoId, before, changes);
  // Memory goes back the instant it is touched, on every turn — never at the end only.
  const violations = restoreGuarded(guarded);
  const proofRel = `selftest/${evoId}.js`;
  const checks = {};
  const failures = [];
  const out = { after, changes, backup, violations, checks, failures, proof_rel: proofRel, proof: null, retirements: null };
  const fail = (gate, why, detail) => {
    checks[gate] = false;
    checks[gate + "_detail"] = String(detail || "");
    failures.push({ gate, label: GATE_LABEL[gate] || gate, why, detail: String(detail || "") });
    return out;
  };

  if (!changes.length) {
    return fail(
      "changed",
      "ไม่มีไฟล์ใดถูกแก้จริง — รอบนี้ไม่นับเป็นวิวัฒนาการ",
      "diffSelf() ไม่พบไฟล์ที่ต่างจากตอนเริ่มรอบเลยแม้แต่ไฟล์เดียว"
    );
  }
  checks.changed = true;
  if (violations.length) {
    return fail(
      "guard",
      "แตะไฟล์ความทรงจำที่ห้ามแก้ (" + violations.join(", ") + ")",
      "ไฟล์ความทรงจำที่ถูกแตะและถูกคืนค่าเดิมไปแล้ว: " + violations.join(", ")
    );
  }
  if (!(proofRel in after)) {
    return fail(
      "proof_written",
      `ไม่ได้เขียนไฟล์พิสูจน์ ${proofRel} — พิสูจน์ไม่ได้ว่าเก่งขึ้นจริง`,
      `ระบบหาไฟล์ ${proofRel} ไม่พบในทรีที่คุณเพิ่งแก้`
    );
  }
  checks.proof_written = true;
  // A failed proof is evidence too — copy it before anything can roll it back.
  try {
    fs.mkdirSync(path.join(EVO_DIR, "backups", evoId), { recursive: true });
    fs.writeFileSync(path.join(EVO_DIR, "backups", evoId, "proof.js"), after[proofRel], "utf8");
  } catch {}

  /* Layer 6.8: shipping includes saying how the thing will be reached. Satisfied by either
     half of the declaration — a route the diff added, or an existing route the round names
     as the path its capability flows through — so no honest round can be blocked by it, and
     no round can slip through leaving the question unanswerable. */
  const declaration = declareAdoption({ report, before, after, at: new Date().toISOString() });
  out.adoption = declaration;
  if (!consolidating) {
    if (!declaration.endpoints.length) {
      return fail(
        "declared_usage",
        "ไม่ได้ประกาศเส้นทางที่ความสามารถใหม่จะถูกใช้ผ่าน — รอบนี้จึงถูกถามภายหลังไม่ได้ว่ามีใครใช้",
        `รอบนี้ไม่ได้เพิ่มเส้นทาง /api/* ใหม่ในโค้ด และ field "usage_endpoints" ที่คุณตอบมาก็ว่างเปล่าหรือชี้ไปที่เส้นทางที่ไม่มีอยู่จริง` +
          (declaration.ignored.length ? ` (เส้นที่อ้างมาแต่ไม่มีใน router: ${declaration.ignored.join(", ")})` : "") +
          ' · ใส่เส้นทางที่ความสามารถนี้จะถูกเรียกผ่านลงใน "usage_endpoints" อย่างน้อยหนึ่งเส้น'
      );
    }
    checks.declared_usage = true;
    checks.declared_usage_detail =
      `ประกาศไว้ ${declaration.endpoints.length} เส้น: ${declaration.endpoints.join(", ")}` +
      ` (เส้นทางใหม่จากโค้ดจริง ${declaration.detected.length} · ที่รอบนี้อ้างเอง ${declaration.claimed.length})` +
      ` — อีก ${ADOPTION_DAYS} วันบันทึกการใช้งานจะเป็นผู้ตัดสินว่ามีใครเรียกจริงไหม`;
  }

  const syn = await syntaxCheck();
  checks.syntax = syn.ok;
  checks.syntax_detail = syn.detail;
  if (!syn.ok) return fail("syntax", "โค้ดใหม่ syntax พัง", syn.detail);

  const smoke = await smokeTest();
  checks.smoke = smoke.ok;
  checks.smoke_detail = smoke.detail;
  if (!smoke.ok) return fail("smoke", "เซิร์ฟเวอร์ใหม่บูตไม่ผ่าน", smoke.detail);

  // The two fitness functions ask three questions each and differ only in which three.
  // Expansion: "the new code can, the old code cannot, nothing broke."
  // Consolidation (inverted): "everything still works, it got smaller, nothing broke."
  let proof;
  let gates;
  if (consolidating) {
    const retirePlan = planRetirements(report && report.retire_endpoints);
    proof = await proveConsolidation(evoId, before, after, guarded, { retiring: retirePlan.approved });
    gates = [
      ["preservation", "พฤติกรรมไม่เหมือนเดิม (ชุดทดสอบต้องผ่านทั้งก่อนและหลัง)"],
      ["shrink", "ไม่ได้เล็กลงจริงตามตัวเลข"],
      ["regression", "ความสามารถเดิมพัง"],
    ];
    out.retirements = retirePlan;
    out.suite = proof.suite;
    out.metrics = proof.metrics;
    out.delta = proof.delta;
  } else {
    proof = await proveEvolution(evoId, before, after, guarded);
    gates = [
      ["capability", "ความสามารถใหม่พิสูจน์ไม่ผ่าน"],
      ["differential", "พิสูจน์ไม่ได้ว่าโค้ดเดิมทำไม่ได้"],
      ["regression", "ความสามารถเดิมพัง"],
    ];
  }
  out.proof = proof;
  for (const [gate, why] of gates) {
    checks[gate] = proof[gate].ok;
    checks[gate + "_detail"] = proof[gate].detail;
    if (!proof[gate].ok) {
      failures.push({ gate, label: GATE_LABEL[gate] || gate, why, detail: String(proof[gate].detail || "") });
    }
  }
  checks.regression_endpoints = proof.regression.results || [];
  return out;
}

// The round's own test output, turned back into a prompt. This is the whole point of the
// layer: stdout that used to be filed away for a reader who no longer existed is now the
// next thing the model reads — while its code is still on disk and still fixable.
function buildGateFeedback({ turn, maxTurns, failures, mode = "expansion", evoId = "" }) {
  const left = Math.max(0, maxTurns - turn);
  const body = (failures || [])
    .map(
      (f) => `--- ❌ ตกที่ด่าน "${f.label}" (${f.gate}) ---
สรุปของด่าน: ${f.why}
ผลจริงที่ด่านนี้พิมพ์ออกมา (stdout/stderr ของการรันจริง ไม่ได้ย่อ):
${f.detail || "(ด่านนี้ไม่ได้พิมพ์รายละเอียดออกมา)"}`
    )
    .join("\n\n");
  return `===== ⛔ ผลการตรวจจริงของรอบนี้ (เทิร์นที่ ${turn} จาก ${maxTurns}) =====
โค้ดที่คุณเพิ่งเขียนถูกนำไปรันจริงในแซนด์บ็อกซ์เมื่อสักครู่นี้ — และมันตก
คุณยังอยู่ใน "รอบเดียวกัน": ไฟล์ทุกไฟล์ที่คุณเขียนไว้ยังอยู่ครบในโฟลเดอร์นี้ ยังไม่ถูกย้อนกลับ
ข้างล่างนี้คือผลจากเครื่องจริง ไม่ใช่การเดา${
    mode === "consolidation"
      ? " (รอบนี้เป็นรอบยุบรวม: ชุดทดสอบต้องผ่านทั้งก่อนและหลัง และตัวเลขขนาดต้องลดลง)"
      : ""
  }:

${body}

===== สิ่งที่ต้องทำต่อเดี๋ยวนี้ =====
1. อ่านข้อความของด่านที่ตกให้ละเอียด แล้วใช้ Read เปิดไฟล์ที่เกี่ยวข้องจริง ๆ ก่อนลงมือแก้
2. แก้ที่ต้นเหตุตามที่ด่านบอก ห้ามเดา — ถ้าด่านให้ exit code หรือข้อความ error มา ให้ไล่ตามนั้นตรง ๆ
   (ใช้ Bash รัน \`node --check <ไฟล์>\` ตรวจ syntax เองได้ทันทีในเทิร์นนี้ ไม่ต้องรอให้ระบบตรวจให้)
3. ห้ามแก้กลไกตรวจสอบให้อ่อนลงเพื่อให้ตัวเองผ่าน (proveEvolution, proveConsolidation, runProof,
   regressionTest, bootServer, materializeTree, runForgeGates, forgeConverge) — ระบบตรวจซ้ำทุกเทิร์น
4. ถ้าด่านที่ตกคือ differential (โค้ดเดิมก็ผ่านไฟล์พิสูจน์ด้วย) ห้ามแก้ไฟล์พิสูจน์ให้หลวมลง
   ต้องทำให้ความสามารถใหม่ "ใหม่จริง" จนโค้ดเดิมทำไม่ได้ต่างหาก
5. แก้เสร็จแล้วตอบ JSON รูปแบบเดิมของรอบนี้อีกครั้งเป็นข้อความสุดท้าย${
    evoId ? ` (proof_file ยังคงเป็น selftest/${evoId}.js)` : ""
  }

${
  left > 1
    ? `เหลือโอกาสแก้ในรอบนี้อีก ${left} ครั้ง ถ้ายังตกอยู่หลังจากนั้น โค้ดทั้งหมดของรอบนี้จะถูกย้อนกลับถาวร`
    : "นี่คือโอกาสสุดท้ายของรอบนี้ (เหลือโอกาสแก้ในรอบนี้อีก 1 ครั้ง) ถ้ายังตกอยู่ โค้ดทั้งหมดของรอบนี้จะถูกย้อนกลับถาวร"
}`;
}

// The driver. `ask` and `verify` are injected so the exact control flow that runs a real
// forge round can also be run with stubs — see POST /api/forge/loop/simulate.
// `ask` returning null means "this turn could not even be started": the loop stops and
// keeps the verdict of the last turn that did run, so a dead retry never costs more than
// the knowledge it would have added.
async function forgeConverge({ maxTurns = FORGE_MAX_TURNS, mode = "expansion", evoId = "", ask, verify, onTurn = null } = {}) {
  const turns = [];
  let feedback = null;
  let last = null;
  const stop = (stopped) => ({
    ok: stopped === "passed",
    stopped,
    turns,
    max_turns: maxTurns,
    answer: last ? last.answer : null,
    result: last ? last.result : null,
  });

  for (let turn = 1; turn <= maxTurns; turn++) {
    const answer = await ask({ turn, feedback, maxTurns, isRetry: turn > 1 });
    if (answer === null || answer === undefined) {
      turns.push({
        turn,
        at: new Date().toISOString(),
        ok: false,
        aborted: true,
        fed_back_chars: feedback ? feedback.length : 0,
        failed_gates: [],
      });
      return stop("ask_failed");
    }
    const result = await verify({ turn, answer, feedback });
    const failures = (result && result.failures) || [];
    const record = {
      turn,
      at: new Date().toISOString(),
      ok: failures.length === 0,
      fed_back_chars: feedback ? feedback.length : 0,
      failed_gates: failures.map((f) => f.gate),
      files_changed: result && result.changes ? result.changes.length : 0,
    };
    turns.push(record);
    last = { answer, result };
    if (onTurn) onTurn(record, result);
    if (!failures.length) return stop("passed");
    if (turn >= maxTurns) return stop("exhausted");
    feedback = buildGateFeedback({ turn, maxTurns, failures, mode, evoId });
    record.fed_forward_chars = feedback.length;
  }
  return stop("exhausted");
}

async function attemptEvolution({ limitId = null, auto = false, mode = "expansion", note = "" } = {}) {
  if (forging) throw Object.assign(new Error("Self-Forge กำลังทำงานอยู่แล้ว รอรอบปัจจุบันให้จบก่อน"), { status: 409 });
  forging = true;
  const consolidating = mode === "consolidation";
  const evoId = "evo_" + crypto.randomBytes(4).toString("hex");
  const before = readSelf();
  const ledger = loadJson(EVO_FILE, []);
  let limits = loadJson(LIMITS_FILE, []);
  let retirePlan = { requested: [], approved: [], refused: [] };
  /* Layer 6.9: the memory snapshot has to be taken *after* the two steps that are allowed to
   * write to data/ on purpose — introspect() saving limits.json when no wall is on record, and
   * the cross-domain connect round this layer runs before the forge starts. Snapshotting first
   * (as this function used to) would make both of them look like the forge tampering with its
   * own memory and fail the guard gate on the very first turn. */
  let guarded = {};

  try {
    // 1. Pick what this round is aimed at. An expansion round picks the boundary worth
    //    breaking (highest unlock, lowest fatigue); a consolidation round aims at the
    //    engine's own size and needs no boundary at all.
    let target = CONSOLIDATION_TARGET;
    let history = null;
    let plan = null;
    let prompt = "";
    let knowledge = null;
    let insightRun = null;
    // Layer 6.8: what the usage ledger currently says about everything already built. Read
    // once here so the choice of target, the prompt and the ledger entry all quote the
    // same numbers.
    const debt = adoptionDebt();
    let rank = null;
    if (consolidating) {
      plan = consolidationPlan(before);
      prompt = buildConsolidationPrompt(evoId, plan, before, note);
    } else {
      if (!limits.some(isTargetable)) {
        await introspect();
        limits = loadJson(LIMITS_FILE, []);
      }
      const ranking = targetRanking(limits, ledger, { adoption: categoryOf(debt) });
      target = limitId ? limits.find((l) => l.id === limitId) : selectTarget(limits, ledger, { adoption: categoryOf(debt) });
      if (!target) {
        throw Object.assign(new Error("ไม่มีขอบเขตที่รอทำลายอยู่ — กด \"วิเคราะห์ขอบเขตตัวเอง\" ก่อน"), { status: 400 });
      }
      rank = ranking.find((r) => r.id === target.id) || null;
      // 2. Hand this round every scar the wall has left: why each past attempt fell, at which
      //    gate, and where its rejected code is still readable. Attempt #2 must not be #1 again.
      history = forgeHistory(target, ledger);
      // 2.5 Layer 6.9 — and hand it the repository. First point the cross-domain machinery at
      //     the wall itself (focus = description + why_it_stands), reusing a fresh round rather
      //     than paying for a second one; a failure here is never fatal, it just means this
      //     round works from the knowledge already on disk.
      insightRun = await ensureWallInsight(target);
      knowledge = forgeKnowledge(target);
      prompt = buildForgePrompt(target, before, evoId, history, debt, rank, knowledge);
    }

    // Everything above was allowed to write to data/. From here on, nothing is.
    guarded = readGuarded();
    fs.mkdirSync(PROOF_DIR, { recursive: true });

    // 3. Layer 6.7 — the round is a closed loop now. The model answers, every gate runs
    //    immediately in the sandbox, and if a gate fails its real stdout goes straight back
    //    into the same Claude session as the next turn, while the code is still on disk.
    //    Nothing is rolled back until the turns run out.
    let sessionId = null;
    let retryError = null;
    let loop;
    try {
      loop = await forgeConverge({
        maxTurns: FORGE_MAX_TURNS,
        mode: consolidating ? "consolidation" : "expansion",
        evoId,
        ask: async ({ turn, feedback }) => {
          const opts = {
            model: FORGE_MODEL,
            tools: FORGE_TOOLS,
            permissionMode: "acceptEdits",
            timeoutMs: turn === 1 ? FORGE_TIMEOUT_MS : FORGE_RETRY_TIMEOUT_MS,
            resume: sessionId,
          };
          if (turn === 1) {
            const first = await runClaudeRaw(prompt, opts);
            sessionId = first.sessionId;
            return first.text;
          }
          // A repair turn that cannot even be started must not destroy the round: keep the
          // verdict of the turn that did run, exactly as the old one-shot forge would have.
          try {
            const next = await runClaudeRaw(feedback, opts);
            if (next.sessionId) sessionId = next.sessionId;
            return next.text;
          } catch (e) {
            retryError = e.message;
            return null;
          }
        },
        verify: async ({ answer }) => {
          let claim;
          try {
            claim = extractJson(answer);
          } catch {
            claim = { broke_it: true, summary: String(answer).slice(0, 600) };
          }
          const run = await runForgeGates({ evoId, before, guarded, consolidating, report: claim });
          run.report = claim;
          return run;
        },
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
    // 4. What actually happened on disk, and what the gates said about it. The report is a
    //    claim; runForgeGates() has already turned it into fact — possibly more than once.
    const gateRun = loop.result;
    const report = (gateRun && gateRun.report) || { broke_it: false, summary: "รอบนี้ไม่ได้ผลลัพธ์ที่ตรวจได้" };
    const after = (gateRun && gateRun.after) || readSelf();
    const changes = (gateRun && gateRun.changes) || diffSelf(before, after);
    const backup = (gateRun && gateRun.backup) || writeBackup(evoId, before, changes);
    if (gateRun && gateRun.retirements) retirePlan = gateRun.retirements;

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
      checks: (gateRun && gateRun.checks) || {},
      proof_file: proofRel,
      backup,
      // Layer 6.7: the round arguing with itself, turn by turn — what it was told after
      // each verification, which gates fell, and why the loop stopped when it did.
      turns: loop.turns,
      turn_count: loop.turns.length,
      max_turns: FORGE_MAX_TURNS,
      stopped: loop.stopped,
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
      // Layer 6.9: what the repository actually put in front of this round — recorded so the
      // claim it makes below (used_dot_ids) can be checked against what it was allowed to see.
      knowledge_used: knowledge
        ? {
            dots: knowledge.dots.map((d) => ({
              id: d.id,
              title: d.title,
              domain: d.domain,
              relevance: d.relevance,
              forge_score: d.forge_score,
            })),
            domains: knowledge.domains,
            pool_dots: knowledge.pool_dots,
            skipped_dots: knowledge.skipped_dots,
            innovations: knowledge.innovations.map((i) => i.name),
            lessons: knowledge.lessons.map((l) => l.id),
            insight: knowledge.insight
              ? {
                  connection: knowledge.insight.connection,
                  at: knowledge.insight.at,
                  ran_now: Boolean(insightRun && insightRun.ran),
                  focus: knowledge.insight.focus,
                  hidden_pattern: knowledge.insight.hidden_pattern,
                }
              : null,
            insight_note: insightRun ? insightRun.reason || insightRun.error || null : null,
            block_chars: buildKnowledgeBlock(knowledge).length,
            caps: knowledge.caps,
          }
        : null,
      verdict: "rejected",
      reason: "",
    };
    if (retryError) entry.retry_error = retryError;
    if (!consolidating) {
      // Layer 6.8: the promise this round is held to, recomputed against the round's own
      // timestamp so declared_at and matures_at line up exactly with the ledger entry.
      entry.adoption = declareAdoption({ report, before, after, at: entry.at });
      // ...and the feedback that was in play when this wall was chosen, kept for audit:
      // it is the only way to check later whether the loop actually changed a decision.
      entry.adoption_used = {
        system_signal: debt.signal,
        category: target.category,
        category_signal: (debt.categories[target.category] || {}).signal ?? null,
        base_score: rank ? rank.base : null,
        adjusted_score: rank ? rank.score : null,
        adoption_adjust: rank ? rank.adoption_adjust : 0,
        unused_streak: debt.unused_streak,
        unused_rounds: (debt.targets || []).map((t) => t.evo_id),
        observed_requests: debt.observed_requests,
      };
    }
    if (consolidating) {
      entry.plan_before = plan ? plan.metrics : null;
      if (gateRun) {
        entry.suite = gateRun.suite || [];
        entry.metrics = gateRun.metrics || null;
        entry.delta = gateRun.delta || null;
        entry.retirements = retirePlan;
      }
    }

    // The verdict is now the loop's verdict. Every gate was already run — up to
    // FORGE_MAX_TURNS times, each failure handed back to the model that could still fix it.
    // Only here, once, does anything get rolled back.
    const repaired = loop.turns.length - 1;
    if (loop.ok) {
      entry.verdict = "accepted";
      const selfRepair = repaired > 0 ? ` · แก้ตัวเองในรอบเดียวกัน ${repaired} ครั้งจากผลตรวจจริง` : "";
      entry.reason = consolidating
        ? "ผ่านทุกด่านของรอบยุบรวม: ไม่แตะความทรงจำ · syntax ผ่าน · บูตจริงได้ · " +
          `ชุดทดสอบ ${(entry.suite || []).length} ไฟล์ให้ผลเหมือนกันทั้งก่อนและหลัง · ` +
          `เล็กลงจริง (${entry.delta ? `code_lines ${entry.delta.code_lines}, prompt_chars ${entry.delta.prompt_chars}` : "?"}) · endpoint ที่ยังมีชีวิตครบทุกเส้น` +
          selfRepair
        : "ผ่านทุกด่าน: ไม่แตะความทรงจำ · syntax ผ่าน · บูตจริงได้ · ไฟล์พิสูจน์ผ่านกับโค้ดใหม่และตกกับโค้ดเดิม · endpoint เดิมครบทุกเส้น" +
          selfRepair;
    } else {
      if (changes.length) restoreBackup(evoId);
      const why = ((gateRun && gateRun.failures) || []).map((f) => f.why).join(" · ") || "รอบนี้ไม่ผ่านการตรวจ";
      entry.reason =
        why +
        (repaired > 0 ? ` (ป้อนผลตรวจจริงกลับเข้าไปให้แก้ในรอบเดียวกันแล้ว ${repaired} ครั้ง)` : "") +
        (retryError ? ` · เทิร์นซ่อมถัดไปเริ่มไม่ได้: ${retryError}` : "") +
        " — ย้อนกลับอัตโนมัติแล้ว";
    }

    // 5. Bookkeeping — and feed the win back into its own knowledge base.
    const state = loadState();

    /* 5.0 Layer 6.9 — settle the bet this round placed on the repository. The gates are done
     *     with the memory snapshot, so a deliberate write to data/ is finally safe, and the
     *     verdict that just landed is exactly the outcome Layer 4.5 wants: a round that broke
     *     the wall scores the dots it named like an idea that shipped, a round that was rolled
     *     back scores them like an idea that died. This runs for failed rounds too — that is
     *     the whole point. A repository that is only ever credited can never be corrected. */
    // Wrapped: this is bookkeeping about the *previous* verdict, so a disk error here must
    // never be the thing that stops a round that already passed from reaching the ledger.
    let fb = null;
    try {
      if (!consolidating) fb = applyForgeFeedback(entry);
    } catch (e) {
      entry.knowledge_feedback = { applied: false, error: e.message };
      slog(state, "🧠 เขียนเส้นตอบกลับของคลังความรู้ไม่สำเร็จ (ไม่กระทบคำตัดสินของรอบนี้): " + e.message);
    }
    if (fb) {
      entry.knowledge_feedback = {
        applied: fb.applied,
        declared: fb.plan.declared,
        dot_ids: fb.plan.dot_ids,
        missing: fb.plan.missing,
        principle: fb.plan.principle,
        connection: fb.connection || null,
        signal: fb.signal ?? null,
        grade: fb.plan.grade,
        affected_dots: fb.affected_dots || [],
      };
      if (fb.applied) {
        slog(
          state,
          `🧠 รอบนี้ประกาศว่าใช้หลักการจาก ${fb.plan.dot_ids.length} จุด ` +
            `(${fb.affected_dots.map((d) => `${d.title} → คุณค่า ${d.value_score > 0 ? "+" : ""}${d.value_score}`).join(" · ")}) — ` +
            `ผลของรอบนี้ (${entry.verdict}) ถูกป้อนกลับเป็นคะแนนของจุดเหล่านั้นแล้วตาม Layer 4.5` +
            (fb.plan.missing.length ? ` · อ้าง id ที่ไม่มีในคลัง: ${fb.plan.missing.join(", ")}` : "")
        );
      } else if (knowledge) {
        slog(
          state,
          `🧠 รอบนี้ได้อ่านคลังความรู้ ${knowledge.dots.length} จุด แต่ไม่ได้ประกาศว่าใช้หลักการจากจุดไหน — ` +
            `คลังจึงยังไม่ถูกพิสูจน์ด้วยรอบนี้` +
            (fb.plan.missing.length ? ` (อ้าง id ที่ไม่มีในคลัง: ${fb.plan.missing.join(", ")})` : "")
        );
      }
    }
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
          ? { ...l, status: "broken", broken_at: entry.at, broken_by: evoId, attempts: (l.attempts || 0) + 1, silent_rounds: 0 }
          : l
      );
      // Layer 10: breaking a wall is a state change like any other, and the account of how
      // the register got here has to include the good news too, not only the drift.
      appendLimitEvent({
        limit_id: target.id,
        type: "broken",
        source: "forge",
        evo_id: evoId,
        from_status: target.status,
        to_status: "broken",
        title: target.title,
      });
      state.last_evolution = entry.at;
      state.restart_required = true;
      slog(state, `🔥 ทำลายขอบเขต "${target.title}" สำเร็จ (${changes.length} ไฟล์) — รีสตาร์ตเพื่อใช้โค้ดใหม่`);
      // Layer 6.8: the round is accepted, but not yet judged. Say out loud what it will be
      // judged on, and when — so "accepted" stops sounding like the end of the story.
      slog(
        state,
        `📈 รอบนี้ประกาศเส้นทางที่ความสามารถจะถูกใช้ผ่านไว้ ${entry.adoption.endpoints.length} เส้น ` +
          `(${entry.adoption.endpoints.join(", ") || "-"}) — ` +
          `อีก ${ADOPTION_DAYS} วัน (${String(entry.adoption.matures_at).slice(0, 10)}) บันทึกการใช้งานจะเป็นผู้ตัดสินว่ามีใครเรียกจริงไหม`
      );

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
            `ใช้ไป ${loop.turns.length}/${FORGE_MAX_TURNS} เทิร์นในรอบนี้ · ` +
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

/* scheduled = the clock called this, not a person. Layer 9 turns that distinction into the
 * whole difference between the two: a scheduled cycle may do nothing at all unless the
 * ignition is on, while a cycle a human asked for always harvests what is waiting. */
async function serendipityCycle(forceConnect = false, scheduled = false) {
  const ap = autopilot();
  if (scheduled && !ap.master) return { skipped: "ignition_off" };
  // A forge round is comparing data/ byte-for-byte — a daemon write mid-round would
  // look like the forge tampering with its own memory and roll back a good evolution.
  if (busy || forging) return { skipped: forging ? "forging" : "busy" };
  busy = true;
  const state = loadState();
  const result = { harvested: 0, connected: false, notified_forgotten: 0, scouted_evidence: 0, scouted_web: 0, ignition: ap.master };
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
    // Layer 9: leaving the house on a timer is exactly the kind of thing the ignition
    // governs. The button in the Scout panel still goes out whenever it is pressed.
    if (ap.can_scout && scoutHoursSince >= SCOUT_HOURS) {
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

    // 1.7 Layer 8: the bill for all of that. Every step above only ever adds, so once the
    // repository has accumulated real redundancy the engine owes itself a round that pays
    // it back — the knowledge equivalent of the consolidation debt in Layer 6.6.
    const distillHoursSince = state.last_distill
      ? (Date.now() - new Date(state.last_distill).getTime()) / 3600000
      : Infinity;
    if (ap.can_distill && !forging && distillHoursSince >= DISTILL_HOURS) {
      const owed = findRedundantClusters(loadJson(DOTS_FILE, []));
      if (owed.length) {
        slog(state, `The Distiller: พบคลัสเตอร์ซ้ำซ้อน ${owed.length} กลุ่ม — เริ่มรอบยุบรวมความรู้…`);
        try {
          const d = await distillKnowledge({ auto: true });
          state.last_distill = new Date().toISOString();
          result.distilled = d.applied ? d.metrics : null;
          slog(
            state,
            d.applied
              ? `⚗ ยุบรวมความรู้สำเร็จ: จุด ${d.metrics.dots_delta} · พรอมป์ตเชื่อมจุดสั้นลง ${-d.metrics.prompt_delta} ตัวอักษร`
              : `รอบยุบรวมความรู้ไม่ผ่าน: ${d.reason} — คลังไม่ถูกแตะ`
          );
          if (d.applied) {
            toast(
              `⚗ คลังความรู้เล็กลงเอง (${d.metrics.dots_delta} จุด)`,
              `${d.round.clusters.map((c) => c.title).join(", ")} — เปิด http://localhost:${PORT} เพื่อดูหรือย้อนกลับ`
            );
          }
        } catch (e) {
          slog(state, "The Distiller ยุบรวมความรู้ไม่สำเร็จ: " + e.message);
          result.distill_error = e.message;
        }
      }
    }

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
    // Layer 9: an Opus round is the most expensive thing this loop can decide to do by
    // itself, so with the ignition off it never decides. forceConnect is a person asking.
    const shouldConnect =
      forceConnect ||
      (ap.can_connect &&
        (harvested.length > 0 ||
          // Dots the system found for itself are not a user action, so they wait for the same
          // cost guard as a forgotten-dot revival before they may spend an Opus round.
          ((selfFound.length > 0 || forgotten.length > 0) && hoursSince >= AUTO_HOURS)));

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
    // Layer 9: the switch that has to be armed on purpose. Everything else the engine does
    // on a timer can be undone by deleting a row; this one rewrites the engine itself.
    if (ap.can_evolve && !forging && evoHoursSince >= EVOLVE_HOURS) {
      slog(state, "Self-Forge: ถึงรอบวิวัฒนาการ — กำลังส่องกระจกหาขอบเขตของตัวเอง…");
      saveState(state);
      busy = false;
      try {
        const evoLedger = loadJson(EVO_FILE, []);
        // Layer 6.6: growth now carries a debt. After CONSOLIDATE_EVERY accepted rounds the
        // engine owes itself a round that only makes it smaller — otherwise every schedule
        // tick spends context it will never get back.
        const grown = CONSOLIDATE_EVERY > 0 && roundsSinceConsolidation(evoLedger) >= CONSOLIDATE_EVERY;
        // Layer 6.8: and so does building things nobody uses. A run of rounds the usage
        // ledger scored as unused schedules the consolidation round by itself, with those
        // rounds already named as its targets — no human has to notice.
        const unusedDebt = adoptionDebt();
        const owed = grown || unusedDebt.consolidation_due;
        let evo;
        if (owed) {
          slog(
            state,
            grown
              ? `Self-Forge: สะสมรอบขยายมา ${roundsSinceConsolidation(evoLedger)} รอบ — รอบนี้เป็นรอบยุบรวม`
              : `Self-Forge: มีรอบที่ไม่มีใครเรียกเลยติดกัน ${unusedDebt.unused_streak} รอบ ` +
                  `(${(unusedDebt.targets || []).map((t) => t.evo_id).join(", ")}) — รอบนี้เป็นรอบยุบรวมโดยอัตโนมัติ`
          );
          evo = await attemptEvolution({ auto: true, mode: "consolidation" });
        } else {
          const standing = loadJson(LIMITS_FILE, []).filter(
            (l) => isTargetable(l) && !attemptBudget(l, evoLedger).exhausted
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
        // Layer 9: the header renders the engine's real state, not the state a reader
        // assumes from the fact that the page loaded.
        autopilot: autopilotStatus(),
        engine_cli: cliHealth,
        log: state.log.slice(-10),
      });
    }
    if (p === "/api/serendipity/scan" && req.method === "POST") {
      const body = await readBody(req);
      // A person pressed a button: this cycle runs whatever the ignition says.
      const result = await serendipityCycle(Boolean(body.forceConnect), false);
      return sendJson(res, 200, result);
    }

    /* ---- Layer 9: The Ignition — the owner's switch over every clock in the engine ---- */
    // The stop button proper: cut the ignition AND kill whatever is running right now.
    // A forge round killed mid-write fails its own gates and gets rolled back by the same
    // path as any other failed round — there is no special "cancelled" state to maintain.
    if (p === "/api/autopilot/stop" && req.method === "POST") {
      const wasForging = forging;
      saveAutopilot({ master: false });
      const killed = killAllClaude("ผู้ใช้กดหยุดฉุกเฉิน");
      const state = loadState();
      slog(
        state,
        `🛑 หยุดฉุกเฉิน: ปิดสวิตช์ใหญ่${killed ? ` และหยุดงาน AI ที่กำลังทำอยู่ ${killed} งาน` : ""}` +
          (wasForging ? " — รอบหลอมตัวเองที่ค้างอยู่จะตกด่านและถูกย้อนไฟล์กลับอัตโนมัติ" : "")
      );
      saveState(state);
      return sendJson(res, 200, { stopped: true, killed, was_forging: wasForging, autopilot: autopilotStatus() });
    }
    if (p === "/api/autopilot" && req.method === "GET") {
      return sendJson(res, 200, autopilotStatus());
    }
    if (p === "/api/autopilot" && req.method === "POST") {
      const body = await readBody(req);
      const next = {};
      for (const k of ["master", ...AUTOPILOT_KEYS]) {
        if (k in body) {
          if (typeof body[k] !== "boolean") return sendJson(res, 400, { error: `${k} ต้องเป็น true/false` });
          next[k] = body[k];
        }
      }
      if (!Object.keys(next).length) return sendJson(res, 400, { error: "ไม่มีสวิตช์ที่จะเปลี่ยน" });
      const before = loadAutopilot();
      saveAutopilot(next);
      const after = autopilotStatus();
      const state = loadState();
      const changed = Object.keys(next).filter((k) => before[k] !== next[k]);
      if (changed.length) {
        slog(
          state,
          changed.map((k) => `${AUTOPILOT_LABELS[k] || k}: ${next[k] ? "เปิด" : "ปิด"}`).join(" · ") +
            (next.master === false ? " — เครื่องยนต์หยุดเดินเอง ทุกปุ่มยังกดได้" : "")
        );
        saveState(state);
      }
      return sendJson(res, 200, after);
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

    /* ---- Layer 8: The Distiller — the repository's second direction ---- */
    // Everything a distill round will be judged on, plus the redundancy the engine found
    // in itself without asking an AI anything.
    if (p === "/api/knowledge/preview" && req.method === "GET") {
      return sendJson(res, 200, knowledgePlan());
    }
    // The inverted fitness function itself. Called with `before`/`after` dot arrays it
    // judges a hypothetical repository; called with `clusters` it judges a real proposal
    // against the real one. Either way: no AI, no writes, nothing moves.
    if (p === "/api/knowledge/dryrun" && req.method === "POST") {
      const body = await readBody(req);
      const connections = Array.isArray(body.connections) ? body.connections : loadJson(CONN_FILE, []);
      if (Array.isArray(body.before) && Array.isArray(body.after)) {
        return sendJson(res, 200, knowledgeVerdict(body.before, body.after, connections));
      }
      const before = Array.isArray(body.dots) ? body.dots : loadJson(DOTS_FILE, []);
      const byId = new Map(before.map((d) => [d.id, d]));
      const removed = new Set();
      const created = [];
      const problems = [];
      for (const [i, c] of (Array.isArray(body.clusters) ? body.clusters : []).entries()) {
        const ids = [...new Set((Array.isArray(c && c.dot_ids) ? c.dot_ids : []).map(String))];
        const members = ids.map((id) => byId.get(id)).filter(Boolean);
        if (members.length !== ids.length || members.length < 2) {
          problems.push(`คลัสเตอร์ที่ ${i + 1}: id ไม่ครบหรือมีน้อยกว่า 2 จุด`);
          continue;
        }
        ids.forEach((id) => removed.add(id));
        created.push(buildMergedDot(c, members, "kn_dryrun"));
      }
      const after = [...before.filter((d) => !removed.has(d.id)), ...created];
      const verdict = knowledgeVerdict(before, after, connections);
      return sendJson(res, 200, {
        ...verdict,
        problems,
        would_remove: [...removed],
        would_create: created.map((d) => ({ id: d.id, title: d.title, absorbed: d.distilled.absorbed.length })),
        note: "นี่คือฟังก์ชันความเหมาะสมตัวจริงที่รอบยุบรวมความรู้ใช้ตัดสิน — เรียกได้โดยไม่เสียรอบ AI และไม่แตะคลัง",
      });
    }
    // A merge with the plan written by hand instead of by a model: same gates, same archive.
    if (p === "/api/knowledge/merge" && req.method === "POST") {
      if (forging) return sendJson(res, 409, { error: "Self-Forge กำลังเทียบไฟล์ความทรงจำอยู่ — รอรอบหลอมตัวเองให้จบก่อน" });
      const body = await readBody(req);
      const r = applyKnowledgeMerge({
        clusters: body.clusters,
        note: String(body.note || "").slice(0, 500),
        by: "owner",
      });
      return sendJson(res, r.applied ? 200 : 400, r);
    }
    // The AI round: the model proposes, the gates dispose.
    if (p === "/api/knowledge/distill" && req.method === "POST") {
      if (SELFTEST) return sendJson(res, 503, { error: "โหมดทดสอบ: The Distiller ไม่เรียก AI" });
      const body = await readBody(req);
      try {
        const r = await distillKnowledge({ note: String(body.note || "").slice(0, 500) });
        if (r.applied) {
          const st = loadState();
          st.last_distill = new Date().toISOString();
          slog(st, `⚗ ยุบรวมความรู้สำเร็จ: จุด ${r.metrics.dots_delta} · พรอมป์ต ${r.metrics.prompt_delta} ตัวอักษร`);
          saveState(st);
        }
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
    }
    // The archive, and the way back out of it.
    if (p === "/api/knowledge/archive" && req.method === "GET") {
      const ledger = loadKnowledgeLedger();
      const wanted = String(url.searchParams.get("roundId") || "");
      if (wanted) {
        const round = ledger.rounds.find((r) => r.id === wanted);
        if (!round) return sendJson(res, 404, { error: "ไม่พบรอบยุบรวมความรู้นี้" });
        return sendJson(res, 200, round);
      }
      return sendJson(res, 200, {
        rounds: ledger.rounds.map((r) => ({
          id: r.id,
          at: r.at,
          by: r.by,
          auto: Boolean(r.auto),
          verdict: r.verdict,
          reason: r.reason,
          note: r.note,
          metrics: r.metrics,
          clusters: r.clusters,
          archived_dots: (r.archived || []).length,
          restored_at: r.restored_at || null,
          restorable: r.verdict === "accepted" && !r.restored_at,
        })),
        total: ledger.rounds.length,
        accepted: ledger.rounds.filter((r) => r.verdict === "accepted").length,
        note:
          "จุดเดิมทุกจุดที่ถูกยุบรวมถูกเก็บไว้ทั้งดวงในรอบของมัน — ย้อนกลับได้เหมือน evolution ledger",
      });
    }
    if (p === "/api/knowledge/restore" && req.method === "POST") {
      if (forging) return sendJson(res, 409, { error: "Self-Forge กำลังเทียบไฟล์ความทรงจำอยู่ — รอรอบหลอมตัวเองให้จบก่อน" });
      const body = await readBody(req);
      const r = restoreKnowledgeRound(String(body.roundId || ""));
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, r);
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
        // Layer 6.9: ...and whether its own knowledge base is being used at all when it
        // rewrites itself — which is a different question from whether users use the result.
        self_connector: forgeKnowledgeStatus(),
        // Layer 6.8: the engine can see whether anything it built is being used at all.
        adoption: (() => {
          const d = adoptionDebt();
          return {
            signal: d.signal,
            counts: d.counts,
            unused_streak: d.unused_streak,
            consolidation_due: d.consolidation_due,
            grace_days: d.grace_days,
            min_requests: d.min_requests,
            observed_requests: d.observed_requests,
          };
        })(),
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
    /* ---- Layer 6.8: The Adoption Ledger — the engine's own return path ---- */
    // Was any of this used? Every accepted expansion round, the routes it declared, the hits
    // those routes actually took, and the score that flows back into what gets built next.
    if (p === "/api/adoption" && req.method === "GET") {
      const ledger = loadJson(EVO_FILE, []);
      const limits = loadJson(LIMITS_FILE, []);
      const report = adoptionReport(ledger, loadUsage());
      const ranking = targetRanking(limits, ledger, { adoption: categoryOf(report) });
      return sendJson(res, 200, {
        ...report,
        // The feedback loop closing, as a table: estimate, correction, order.
        ranking,
        next_target: ranking.length ? ranking[0] : null,
        adoption_weight: ADOPTION_WEIGHT,
        note:
          "ทุกรอบขยายประกาศเส้นทางที่ความสามารถของมันจะถูกใช้ผ่านไว้ตอนที่มันผ่านด่าน " +
          "แล้วบันทึกการใช้งานจริง (evolution/endpoint-usage.json) เป็นผู้ตัดสินทีหลังด้วยสูตรเดียวกับที่ให้คะแนนไอเดียของผู้ใช้ — " +
          "รอบที่ไม่มีใครเรียกถูกเสนอเป็นเป้าหมายของรอบยุบรวมเอง และคะแนนของหมวดนั้นถูกป้อนกลับเข้าการเลือกกำแพงถัดไป",
      });
    }
    // The same scoring function, called with a hypothetical ledger, hypothetical usage and a
    // hypothetical clock. No AI, no writes, offline: this is how "would a round with zero
    // hits be down-ranked?" can be checked without waiting a week for it to happen.
    if (p === "/api/adoption/dryrun" && req.method === "POST") {
      const body = await readBody(req);
      const rounds = Array.isArray(body.rounds) ? body.rounds : Array.isArray(body.ledger) ? body.ledger : [];
      const usage = body.usage && typeof body.usage === "object" ? body.usage : { endpoints: {} };
      const now = body.now ? new Date(body.now).getTime() : Date.now();
      if (!Number.isFinite(now)) return sendJson(res, 400, { error: "now ต้องเป็นเวลาที่อ่านได้" });
      const report = adoptionReport(rounds, usage, { now });
      const limits = Array.isArray(body.limits) ? body.limits : null;
      const ranking = limits ? targetRanking(limits, rounds, { adoption: categoryOf(report), now }) : null;
      return sendJson(res, 200, {
        ...report,
        ranking,
        next_target: ranking && ranking.length ? ranking[0] : null,
        note:
          "นี่คือ adoptionRound()/adoptionReport()/targetRanking() ตัวจริงที่ระบบใช้ตัดสิน — " +
          "ต่างกันแค่บันทึกและนาฬิกาถูกแทนด้วยของสมมติ จึงตรวจเองได้ว่ากรณีไหนถูกนับว่าถูกใช้ กรณีไหนถูกนับว่าไม่มีใครใช้",
      });
    }

    // Every wall now carries its own attempt budget: how many tries it has had, how many
    // the ceiling allows *right now*, and how it earned the ones above the base of three.
    if (p === "/api/limits" && req.method === "GET") {
      const limits = loadJson(LIMITS_FILE, []);
      const ledger = loadJson(EVO_FILE, []);
      // Layer 6.8: the ranking each wall is judged by now carries its category's own record
      // of whether anything built there was ever called.
      const report = adoptionReport(ledger, loadUsage());
      const ranking = targetRanking(limits, ledger, { adoption: categoryOf(report) });
      const rankOf = new Map(ranking.map((r) => [r.id, r]));
      const next = ranking.length ? limits.find((l) => l.id === ranking[0].id) || null : null;
      return sendJson(
        res,
        200,
        limits.map((l) => {
          const b = attemptBudget(l, ledger);
          const r = rankOf.get(l.id) || null;
          const cat = report.categories[l.category] || null;
          return {
            ...l,
            category_adoption: cat ? { ...cat, category: l.category } : null,
            adoption_signal: r ? r.adoption_signal : null,
            adoption_adjust: r ? r.adoption_adjust : 0,
            priority_base: r ? r.base : round2(l.unlock_score - l.risk / 2),
            priority_score: r ? r.score : null,
            attempts_used: b.attempts,
            attempt_cap: b.cap,
            attempts_left: b.left,
            cap_base: b.base,
            cap_earned: b.earned,
            cap_max: b.max,
            distinct_approaches: b.distinct_approaches,
            exhausted: isTargetable(l) && b.exhausted,
            cap_note: b.note,
            is_next_target: Boolean(next && next.id === l.id),
            failed_attempts: failureDossier(l, ledger).map((d) => ({
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
    /* ---- Layer 10: The RemLedger — the register as an accumulating account ---- */
    // Every state change any wall has ever made. limits.json says what is true now;
    // this says how it got that way, and it is the only one of the two that cannot lie
    // by omission — nothing is ever rewritten here, only appended.
    if (p === "/api/limits/events" && req.method === "GET") {
      const wanted = String(url.searchParams.get("limitId") || "");
      const limits = loadJson(LIMITS_FILE, []);
      const limit = wanted ? limits.find((l) => limitIdSet(l).includes(wanted)) : null;
      if (wanted && !limit) return sendJson(res, 404, { error: "ไม่พบกำแพงนี้ในทะเบียน" });
      const events = readLimitEvents(limit);
      return sendJson(res, 200, {
        limit: limit ? { id: limit.id, title: limit.title, status: limit.status, aliases: limit.aliases || [] } : null,
        total: events.length,
        coercive_rounds: LIMIT_COERCIVE_ROUNDS,
        epitope_match: LIMIT_EPITOPE_MATCH,
        events: events.slice(-200),
      });
    }
    // The merge, drivable by hand. The whole point of pulling mergeLimits() out as a pure
    // function: the behaviour that decides whether a wall's history survives can be tested
    // with invented input, in a second, without spending a 12-minute introspection.
    if (p === "/api/limits/merge/dryrun" && req.method === "POST") {
      const body = await readBody(req);
      const current = Array.isArray(body.current) ? body.current : loadJson(LIMITS_FILE, []);
      const incoming = Array.isArray(body.incoming) ? body.incoming : [];
      const { limits, events } = mergeLimits(current, incoming, { now: body.now || undefined });
      return sendJson(res, 200, {
        // Nothing is written: this is the answer to "what would the mirror do to the register".
        applied: false,
        before: current.length,
        after: limits.length,
        lost: current.filter((c) => !limits.some((l) => limitIdSet(l).includes(c.id))).map((c) => c.id),
        limits,
        events,
      });
    }
    // The scar tissue, made inspectable: exactly what the next forge round will be told
    // about this wall — including the real prompt it will read.
    if (p === "/api/forge/preview" && req.method === "GET") {
      const limits = loadJson(LIMITS_FILE, []);
      const ledger = loadJson(EVO_FILE, []);
      const wanted = String(url.searchParams.get("limitId") || "");
      // Layer 6.8: read the usage ledger once, then let the target, the ranking and the
      // prompt all quote that one reading — a preview that disagreed with itself would be
      // worse than no preview.
      const debt = adoptionDebt();
      const ranking = targetRanking(limits, ledger, { adoption: categoryOf(debt) });
      const target = wanted
        ? limits.find((l) => l.id === wanted)
        : (ranking.length && limits.find((l) => l.id === ranking[0].id)) || null;
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
      const rank = ranking.find((r) => r.id === target.id) || null;
      // Layer 6.9: the knowledge block is part of this prompt now, so the preview must build
      // the same one the round will read — and report what every part of the prompt costs, so
      // "letting knowledge in makes the prompt bigger" is a number the owner can see.
      const brief = forgeKnowledge(target);
      const knowledgeBlock = buildKnowledgeBlock(brief);
      const prompt = buildForgePrompt(target, readSelf(), "evo_<รอบถัดไป>", hist, debt, rank, brief);
      const marker = "===== ซอร์สโค้ดปัจจุบันของคุณ =====";
      const cut = prompt.indexOf(marker);
      const adoptionBlock = buildAdoptionBlock(target, debt, rank);
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
        blocked: isTargetable(target) && hist.budget.exhausted,
        history: hist.dossier,
        failure_block: hist.block,
        // Layer 6.8: and the other block — what the usage ledger says about what already exists.
        adoption: {
          ...debt,
          rank,
          block: buildAdoptionBlock(target, debt, rank),
        },
        // Layer 6.9: ...and the block that finally makes this a cross-domain round.
        knowledge: {
          ...brief,
          block: knowledgeBlock,
          block_chars: knowledgeBlock.length,
        },
        // What each part of the prompt costs. The wall this round breaks was held in place by
        // "the forge prompt is frightening enough already" — a fear that was never a number.
        prompt_parts: {
          knowledge_block: knowledgeBlock.length,
          failure_block: hist.block.length,
          adoption_block: adoptionBlock.length,
          source_bundle: sourceBundle(promptBundle(readSelf())).length,
          total: prompt.length,
        },
        // The prompt minus the source bundle — the part where the lessons actually live.
        prompt_head: cut > 0 ? prompt.slice(0, cut) : prompt,
        prompt_chars: prompt.length,
        prompt: url.searchParams.get("full") === "1" ? prompt : undefined,
      });
    }
    /* ---- Layer 6.7: the closed loop, from outside ---- */
    // What the loop is allowed to do, and what the recorded rounds actually did turn by turn.
    if (p === "/api/forge/loop" && req.method === "GET") {
      const ledger = loadJson(EVO_FILE, []);
      const rounds = (Array.isArray(ledger) ? ledger : [])
        .filter((e) => e && Array.isArray(e.turns) && e.turns.length)
        .slice(0, 20)
        .map((e) => ({
          id: e.id,
          at: e.at,
          mode: e.mode || "expansion",
          verdict: e.verdict,
          stopped: e.stopped || null,
          turn_count: e.turns.length,
          turns: e.turns,
          // The thing that was impossible before: a round that failed a gate, was told why,
          // and passed — without spending a second round or a second slot of the wall's budget.
          repaired_in_round: e.verdict === "accepted" && e.turns.length > 1,
        }));
      return sendJson(res, 200, {
        enabled: FORGE_MAX_TURNS > 1,
        max_turns: FORGE_MAX_TURNS,
        first_turn_timeout_ms: FORGE_TIMEOUT_MS,
        retry_timeout_ms: FORGE_RETRY_TIMEOUT_MS,
        tools: FORGE_TOOLS,
        gates: Object.entries(GATE_LABEL).map(([gate, label]) => ({ gate, label })),
        rounds,
        rounds_with_turns: rounds.length,
        repaired_rounds: rounds.filter((r) => r.repaired_in_round).length,
        note:
          "รอบหลอมตัวเองไม่ใช่การยิงนัดเดียวจบอีกต่อไป: หลังโมเดลตอบ ระบบรันด่านทั้งหมดทันที " +
          "แล้วป้อน stdout จริงของด่านที่ตกกลับเข้าเซสชันเดิมเป็นเทิร์นถัดไปในรอบเดียวกัน",
      });
    }
    // The loop driver itself, run with scripted gate results instead of a real AI and a real
    // sandbox. Same forgeConverge() the forge uses — so the text this returns as "what turn
    // N was told" is the literal text the model would read. No AI, no writes, offline.
    if (p === "/api/forge/loop/simulate" && req.method === "POST") {
      const body = await readBody(req);
      const script = Array.isArray(body.turns) ? body.turns : [];
      const maxTurns = Math.max(1, Math.min(6, Number(body.max_turns) || script.length || FORGE_MAX_TURNS));
      const simMode = body.mode === "consolidation" ? "consolidation" : "expansion";
      const asked = [];
      const run = await forgeConverge({
        maxTurns,
        mode: simMode,
        evoId: String(body.evoId || "evo_dryrun"),
        ask: async ({ turn, feedback }) => {
          asked.push({ prompt_received: feedback, prompt_chars: feedback ? feedback.length : 0 });
          return `{"broke_it": true, "summary": "เทิร์นจำลองที่ ${turn}"}`;
        },
        verify: async ({ turn }) => {
          const step = script[turn - 1] || {};
          const failures = (Array.isArray(step.failed_gates) ? step.failed_gates : []).map((g) => {
            const gate = typeof g === "string" ? g : String((g && g.gate) || "?");
            const detail = (g && typeof g === "object" && g.detail) || step.detail || "";
            return {
              gate,
              label: GATE_LABEL[gate] || gate,
              why: String((g && typeof g === "object" && g.why) || GATE_LABEL[gate] || gate),
              detail: String(detail),
            };
          });
          return { failures };
        },
      });
      return sendJson(res, 200, {
        max_turns: maxTurns,
        mode: simMode,
        ok: run.ok,
        stopped: run.stopped,
        turns: run.turns.map((t, i) => ({ ...t, ...(asked[i] || {}) })),
        note:
          "นี่คือ forgeConverge() ตัวจริงที่รอบหลอมตัวเองใช้ ต่างกันแค่ผู้ตอบและผู้ตรวจถูกแทนด้วยของจำลอง " +
          "— ข้อความใน prompt_received จึงเป็นข้อความจริงที่โมเดลจะได้อ่านกลางรอบ",
      });
    }
    /* ---- Layer 6.9: The Self-Connector — the knowledge a forge round finally gets to read ---- */
    // Exactly what will be in front of the next round: the dots (with their contents), the
    // innovations the engine synthesised, the lessons, the connect round aimed at this wall —
    // and the scoreboard of which dots have actually helped break walls.
    if (p === "/api/forge/knowledge" && req.method === "GET") {
      const dots = loadJson(DOTS_FILE, []);
      const conns = loadJson(CONN_FILE, []);
      const limits = loadJson(LIMITS_FILE, []);
      const ledger = loadJson(EVO_FILE, []);
      const wanted = String(url.searchParams.get("limitId") || "");
      const ranking = targetRanking(limits, ledger, { adoption: categoryOf(adoptionDebt()) });
      const target = wanted
        ? limits.find((l) => l.id === wanted)
        : (ranking.length && limits.find((l) => l.id === ranking[0].id)) || null;
      if (wanted && !target) return sendJson(res, 404, { error: "ไม่พบขอบเขตนี้" });
      const brief = forgeKnowledge(target, { dots, connections: conns });
      const block = buildKnowledgeBlock(brief);
      const introspect = introspectKnowledgeBlock(dots, conns);
      const enriched = enrichDots(dots, conns);
      return sendJson(res, 200, {
        target: target
          ? { id: target.id, title: target.title, category: target.category, status: target.status }
          : null,
        // With no wall on record the block is still meaningful — it just ranks by attention
        // alone, which is what the introspection round will read anyway.
        message: target ? null : "ยังไม่มีกำแพงที่รอทำลาย — บล็อกนี้จึงถูกจัดลำดับด้วยลำดับความสนใจล้วน",
        ...brief,
        block,
        block_chars: block.length,
        // The other half of the same wall: the introspection round used to see titles only.
        introspect_knowledge: introspect,
        introspect_chars: introspect.length,
        insight_focus: target ? wallFocus(target) : null,
        // Which rounds bet on the repository, and which never said anything.
        feedback: forgeFeedbackLedger(conns, ledger),
        // The repository being judged by whether it helped: a dot that was named by a round
        // that failed carries a negative score here, in the same units as an idea that died.
        dot_scoreboard: enriched
          .filter((d) => d.forge_uses > 0)
          .sort((a, b) => b.forge_score - a.forge_score || b.forge_uses - a.forge_uses)
          .map((d) => ({
            id: d.id,
            title: d.title,
            domain: d.domain,
            forge_uses: d.forge_uses,
            forge_score: d.forge_score,
            forge_proven: d.forge_proven,
            value_score: d.value_score,
            attention_score: d.attention_score,
          })),
        status: forgeKnowledgeStatus(),
        note:
          "เดิม buildForgePrompt() ได้รับแค่ตัวขอบเขต ประวัติความล้มเหลว และซอร์สโค้ด — ไม่มีจุดความรู้แม้แต่จุดเดียว " +
          "ทั้งที่ทั้งระบบตั้งอยู่บนสมมติฐานว่าคำตอบที่ดีเกิดจากการทาบโครงสร้างข้ามโดเมน · " +
          "บล็อกด้านบนคือสิ่งที่รอบถัดไปจะได้อ่านจริง และมีเพดานตายตัวจึงไม่โตตามคลังไปเรื่อย ๆ",
      });
    }
    // The same functions, called with a hypothetical wall, repository and round: which dots
    // would be picked and why, and what one round's declaration would do to their scores.
    // No AI, no writes — the feedback loop can be checked without spending a forge round.
    if (p === "/api/forge/knowledge/dryrun" && req.method === "POST") {
      const body = await readBody(req);
      const limit = body.limit && typeof body.limit === "object" ? body.limit : null;
      const dots = Array.isArray(body.dots) ? body.dots : loadJson(DOTS_FILE, []);
      const conns = Array.isArray(body.connections) ? body.connections : loadJson(CONN_FILE, []);
      const brief = forgeKnowledge(limit, { dots, connections: conns });
      const block = buildKnowledgeBlock(brief);
      const enrichedBefore = enrichDots(dots, conns);
      let feedback = null;
      if (body.round && typeof body.round === "object") {
        const plan = forgeFeedbackPlan(body.round, dots);
        const record = plan.applicable ? forgeFeedbackRecord(body.round, plan) : null;
        const enrichedAfter = enrichDots(dots, record ? [record, ...conns] : conns);
        const pick = (rows, id) => rows.find((x) => x.id === id) || {};
        feedback = {
          plan,
          signal: record ? round2(connectionSignal(record)) : null,
          would_write: record
            ? {
                id: record.id,
                selected_dots: record.selected_dots,
                outcome: record.outcome,
                hidden_pattern: record.hidden_pattern,
                innovation: record.innovation.name,
                forge: record.forge,
              }
            : null,
          // The loop, as numbers: what naming a dot does to that dot.
          moves: plan.dot_ids.map((id) => {
            const b = pick(enrichedBefore, id);
            const a = pick(enrichedAfter, id);
            return {
              id,
              title: a.title || b.title || null,
              value_before: b.value_score ?? null,
              value_after: a.value_score ?? null,
              forge_uses_before: b.forge_uses ?? 0,
              forge_uses_after: a.forge_uses ?? 0,
              forge_score_before: b.forge_score ?? 0,
              forge_score_after: a.forge_score ?? 0,
              attention_before: b.attention_score ?? null,
              attention_after: a.attention_score ?? null,
              proven_after: Boolean(a.proven),
              dead_end_after: Boolean(a.dead_end),
            };
          }),
        };
      }
      return sendJson(res, 200, {
        // The ranking in full, so the ordering itself can be checked rather than trusted.
        ranking: wallRelevance(limit, enrichedBefore).map((d) => ({
          id: d.id,
          title: d.title,
          domain: d.domain,
          relevance: d.relevance,
          wall_overlap: d.wall_overlap,
          attention_norm: d.attention_norm,
          forge_score: d.forge_score,
        })),
        brief,
        block,
        block_chars: block.length,
        feedback,
        caps: brief.caps,
        rule: FORGE_KNOWLEDGE_RULE,
        note:
          "นี่คือ forgeKnowledge()/wallRelevance()/forgeFeedbackPlan()/forgeFeedbackRecord() ตัวจริงที่รอบหลอมตัวเองใช้ " +
          "ต่างกันแค่คลังความรู้ กำแพง และรอบถูกแทนด้วยของสมมติ — จึงตรวจได้ทันทีว่าจุดไหนจะถูกเลือกเพราะอะไร " +
          "และการที่รอบหนึ่งอ้างว่าใช้จุดไหน ทำให้คะแนนของจุดนั้นขยับไปทางไหนจริง",
      });
    }
    // Point the cross-domain machinery at one of the engine's own walls, on demand: a real
    // connect round whose focus is the wall's description plus the reason it still stands.
    if (p === "/api/forge/insight" && req.method === "POST") {
      if (SELFTEST) return sendJson(res, 503, { error: "โหมดทดสอบ: รอบเชื่อมจุดเล็งกำแพงไม่เรียก AI" });
      if (forging) return sendJson(res, 409, { error: "Self-Forge กำลังทำงานอยู่ — รอรอบหลอมตัวเองให้จบก่อน" });
      const body = await readBody(req);
      const limits = loadJson(LIMITS_FILE, []);
      const ledger = loadJson(EVO_FILE, []);
      const wanted = String(body.limitId || "");
      const ranking = targetRanking(limits, ledger, { adoption: categoryOf(adoptionDebt()) });
      const target = wanted
        ? limits.find((l) => l.id === wanted)
        : (ranking.length && limits.find((l) => l.id === ranking[0].id)) || null;
      if (!target) {
        return sendJson(res, 400, { error: "ไม่พบกำแพงที่จะเล็ง — กด \"วิเคราะห์ขอบเขตตัวเอง\" ก่อน" });
      }
      try {
        const run = await ensureWallInsight(target, { force: true });
        if (!run.insight) {
          return sendJson(res, 502, { error: run.error || "รอบเชื่อมจุดเล็งกำแพงนี้ไม่สำเร็จ" });
        }
        return sendJson(res, 200, {
          wall: { id: target.id, title: target.title, category: target.category },
          focus: wallFocus(target),
          ran: run.ran,
          connection: run.connection || run.insight.connection,
          insight: run.insight,
          note:
            "รอบนี้ถูกเก็บเป็นการเชื่อมจุดปกติในคลัง (ให้คะแนนผลลัพธ์จริงได้เหมือนไอเดียอื่น) " +
            "และรอบหลอมตัวเองครั้งถัดไปที่เล็งกำแพงนี้จะได้อ่านรูปแบบที่ซ่อนอยู่ของมันในหัวพรอมป์ต",
        });
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
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
          l.id === entry.limit.id
            ? { ...l, status: "standing", broken_at: null, broken_by: null, silent_rounds: 0, last_seen_at: entry.rolled_back_at }
            : l
        );
        saveJson(LIMITS_FILE, limits);
        appendLimitEvent({
          limit_id: entry.limit.id,
          type: "unbroken",
          source: "rollback",
          evo_id: entry.id,
          from_status: "broken",
          to_status: "standing",
          title: entry.limit.title,
        });
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
// This engine is meant to sit running for days while nobody watches it. A stray error on
// some socket must not be the thing that ends a week of background evolution — log it,
// write it where the next introspection can read it, and stay up.
process.on("uncaughtException", (e) => {
  console.error("  [uncaught]", (e && e.stack) || e);
  try {
    const s = loadState();
    slog(s, "ข้อผิดพลาดที่ไม่ถูกดัก (เครื่องยนต์ยังทำงานต่อ): " + ((e && e.message) || e));
    saveState(s);
  } catch {}
});
process.on("unhandledRejection", (e) => {
  console.error("  [unhandled rejection]", (e && e.stack) || e);
});

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
/* Layer 10: walls recorded before the RemLedger existed have no aliases, no silence counter
 * and no last-seen stamp. Give them one, once, so the first merge after the upgrade treats
 * them as remanent rather than as strangers — and record the migration as an event, because
 * a register that quietly grows fields is exactly the thing this layer exists to stop. */
function migrateLimits() {
  const limits = loadJson(LIMITS_FILE, []);
  if (!limits.length) return;
  let changed = 0;
  const now = new Date().toISOString();
  for (const l of limits) {
    if (Array.isArray(l.aliases) && typeof l.silent_rounds === "number" && l.last_seen_at) continue;
    if (!Array.isArray(l.aliases)) l.aliases = [];
    if (typeof l.silent_rounds !== "number") l.silent_rounds = 0;
    if (!l.last_seen_at) l.last_seen_at = l.broken_at || l.found_at || now;
    changed++;
  }
  if (!changed) return;
  saveJson(LIMITS_FILE, limits);
  appendLimitEvent({
    limit_id: null,
    type: "migrated",
    source: "boot",
    count: changed,
    note: "ทะเบียนเดิมถูกยกระดับเป็นบัญชีสะสม (Layer 10) — ไม่มีข้อไหนถูกลบ",
  });
  console.log(`  [remledger] ยกระดับทะเบียนกำแพงเดิม ${changed} ข้อเป็นบัญชีสะสม`);
}

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
  migrateLimits();
  // Layer 9: the switch must exist on disk before the first forge round reads it, or a round
  // that creates it could quietly hand itself an autopilot no one turned on.
  ensureAutopilotFile();
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
  // The Distiller's clock starts here for the same reason: restarting the engine must not
  // make it rewrite its own repository ninety seconds later without being asked.
  const boot = loadState();
  const bootScout = scoutState(boot);
  let bootDirty = false;
  if (!boot.last_evolution || !bootScout.last_web_scout || !boot.last_distill) {
    const now = new Date().toISOString();
    if (!boot.last_evolution) boot.last_evolution = now;
    if (!boot.last_distill) boot.last_distill = now;
    if (!bootScout.last_web_scout) {
      boot.scout = { ...bootScout, last_web_scout: now };
    }
    bootDirty = true;
  }
  // "restart_required" means the code on disk is ahead of the code in memory. At the moment
  // this process starts, that is false by definition — it *is* the code on disk. Leaving the
  // flag set made the banner outlive the thing it was warning about, so every later restart
  // looked equally urgent and the one that mattered stopped being visible.
  if (boot.restart_required) {
    boot.restart_required = false;
    slog(boot, "บูตด้วยโค้ดล่าสุดบนดิสก์แล้ว — ป้าย \"ต้องรีสตาร์ต\" ถูกเคลียร์");
    bootDirty = true;
  }
  if (bootDirty) saveState(boot);

  console.log(`\n  The Dot-Connector AI v5 (The Self-Forge · The Ignition · The RemLedger)`);
  console.log(`  engine:  claude cli (connect: ${MODEL}, harvest: ${HARVEST_MODEL})`);
  console.log(`  forge:   ${FORGE_MODEL} — reads and rewrites this very file`);
  console.log(`  inbox:   ${INBOX_DIR}`);
  console.log(`  daemon:  every ${CHECK_MIN} min (auto-connect ≥ ${AUTO_HOURS}h apart)`);
  console.log(`  evolve:  ${EVOLVE_HOURS > 0 ? `every ${EVOLVE_HOURS}h (EVOLVE_HOURS=0 to disable)` : "off"}`);
  console.log(`  scout:   ${SCOUT_HOURS > 0 ? `every ${SCOUT_HOURS}h via ${SCOUT_MODEL} (SCOUT_HOURS=0 to disable)` : "off"} — evidence harvest always on`);
  console.log(`  distill: ${DISTILL_HOURS > 0 ? `every ${DISTILL_HOURS}h (DISTILL_HOURS=0 to disable)` : "off"} — connect prompt capped at ${CONNECT_FULL_DOTS} full dots`);
  console.log(`  adopt:   rounds scored ${ADOPTION_DAYS}d after shipping, once the ledger has seen ${ADOPTION_MIN_REQUESTS} requests (weight ${ADOPTION_WEIGHT})`);
  const ap = autopilot();
  console.log(
    `  ignition: ${ap.master ? "ON" : "OFF"} — ${
      ap.master
        ? [["connect", ap.can_connect], ["scout", ap.can_scout], ["distill", ap.can_distill], ["evolve", ap.can_evolve]]
            .map(([k, v]) => `${k}:${v ? "on" : "off"}`)
            .join(" ")
        : "ไม่มีอะไรทำงานตามเวลา · ทุกปุ่มในหน้าเว็บยังใช้ได้ตามปกติ"
    }`
  );
  console.log(`  open:    http://localhost:${PORT}\n`);

  // Ask the one external dependency whether it is there, before anything needs it to be.
  checkClaudeCli().then((h) => {
    if (h.ok) return console.log(`  [preflight] claude CLI พร้อมใช้งาน (${h.version})`);
    console.log(`  [preflight] ⚠ เรียก claude CLI ไม่ได้: ${h.error}`);
    console.log(`  [preflight]   ทุกชั้นที่ต้องใช้ AI จะล้มเหลวจนกว่าจะแก้ — ลองรัน "claude --version" ในเทอร์มินัลนี้`);
    const st = loadState();
    slog(st, `⚠ ตรวจก่อนเริ่ม: เรียก claude CLI ไม่ได้ (${h.error}) — ชั้นที่ต้องใช้ AI จะยังทำงานไม่ได้`);
    saveState(st);
  });

  // Serendipity daemon: first cycle after 90s, then on interval. Both are scheduled calls —
  // with the ignition off they return immediately without reading, writing or spending
  // anything, and the timer stays alive so the switch takes effect without a restart.
  setTimeout(() => serendipityCycle(false, true), 90 * 1000);
  setInterval(() => serendipityCycle(false, true), CHECK_MIN * 60 * 1000);
});
