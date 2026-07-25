/*
 * ไฟล์พิสูจน์ (capability proof) — รอบที่ต่อ "เส้นตอบกลับของตัวระบบเอง" (Layer 6.8)
 *
 * กำแพงที่ถูกทำลาย: ทุกด่านของรอบหลอมตัวเองตัดสินที่วินาทีที่โค้ดเขียนเสร็จ
 *   ไม่มีด่านไหนถามว่าความสามารถที่เพิ่มมาเมื่อยี่สิบรอบก่อน "มีใครเรียกใช้จริงหรือไม่"
 *   ทั้งที่ evolution/endpoint-usage.json บันทึกคำตอบไว้ครบตั้งแต่ Layer 6.6 — แต่มันถูกอ่าน
 *   เป็นแค่ "ใบอนุญาตให้ถอดเส้นทาง" (retireEndpoint / planRetirements) ไม่ใช่สัญญาณคุณค่า
 *   เดิม proveEvolution() และ consolidationVerdict() ไม่เรียก loadUsage() เลยแม้แต่ครั้งเดียว
 *
 * ไฟล์นี้ทดสอบพฤติกรรมจริงผ่าน HTTP สองชั้น:
 *   ก. ชั้นที่ตัดสินด้วยตัวเลขสมมติ — POST /api/adoption/dryrun เรียกฟังก์ชันตัวจริง
 *      (adoptionRound / adoptionReport / targetRanking) ด้วยบันทึกและนาฬิกาสมมติ จึงตรวจได้
 *      ทันทีโดยไม่ต้องรอเจ็ดวันว่า:
 *        · รอบที่เส้นทางถูกเรียกจริง → "ถูกใช้จริง" คะแนนบวก
 *        · รอบที่ครบกำหนดแล้วไม่มีใครเรียก → "ไม่มีใครเรียกเลย" คะแนน −1 และถูกเสนอเป็นเป้าหมายรอบยุบรวม
 *        · รอบที่ยังไม่ครบกำหนด → คะแนน null ไม่ใช่ติดลบ (ความเงียบยังไม่นับเป็นคำตัดสิน)
 *        · รอบที่อ้างเส้นทางเดิมซึ่งถูกเรียกครั้งสุดท้าย *ก่อน* วันที่ประกาศ → ไม่ถูกนับว่าใช้ (กันการซื้อคะแนน)
 *        · และคะแนนนั้นย้อนกลับไปจัดลำดับกำแพงถัดไปจริง: หมวดที่เคยผลิตของที่ไม่มีใครใช้ถูกลดลำดับ
 *          จนกำแพงที่คะแนนพื้นฐานสูงสุดไม่ได้ถูกเลือก
 *   ข. ชั้นที่ตัดสินด้วยบันทึกจริง — เขียนประวัติจำลองลง data/ ของแซนด์บ็อกซ์ ยิง /api/lessons จริง
 *      แล้วตรวจว่า GET /api/adoption · /api/limits · /api/consolidation/preview · /api/forge/preview
 *      เห็น "การถูกเรียกจริง" นั้นและเปลี่ยนการตัดสินใจตามจริง
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตก: ไม่มี /api/adoption และ /api/adoption/dryrun (404)
 *   · /api/limits ของมันไม่มีสนาม category_adoption / priority_score / adoption_adjust
 *   · /api/forge/loop ของมันไม่มีด่าน declared_usage
 *   · /api/consolidation/preview ของมันไม่มี unused_capabilities
 *
 * exit 0 = ระบบรู้แล้วว่ามีใครใช้ของที่มันสร้าง · exit != 0 = ยังไม่รู้
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const BASE = process.env.DOT_TEST_URL;
const ROOT = process.env.DOT_TEST_ROOT;

if (!BASE || !ROOT) {
  console.error("✗ ต้องรันผ่าน Self-Forge: ไม่พบ DOT_TEST_URL หรือ DOT_TEST_ROOT");
  process.exit(2);
}

function request(method, pathname, payload, timeout = 20000) {
  return new Promise((resolve) => {
    const u = new URL(pathname, BASE);
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload), "utf8");
    const req = http.request(
      {
        method,
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        timeout,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
      },
      (r) => {
        let body = "";
        r.setEncoding("utf8");
        r.on("data", (d) => (body += d));
        r.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({ status: r.statusCode, body, json });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", json: null });
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message), json: null }));
    if (data) req.write(data);
    req.end();
  });
}
const get = (p) => request("GET", p);
const post = (p, body) => request("POST", p, body || {});

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(name);
}

/* ================= ก. ฟังก์ชันตัดสินตัวจริง เรียกด้วยบันทึกและนาฬิกาสมมติ ================= */
const MARK = "PROBE_d0f8d35b";
// นาฬิกาคงที่ ไม่ผูกกับเวลาจริง — ผลลัพธ์ของส่วนนี้จึงเหมือนกันทุกครั้งตลอดไป
const NOW = "2026-06-01T00:00:00.000Z";
const day = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();

const DRY_USAGE = {
  started_at: day(60),
  endpoints: {
    // เส้นทางใหม่ที่มีคนเรียกจริง
    "/api/probe_live": { hits: 12, first_hit: day(20), last_hit: day(2) },
    // เส้นทางเดิมที่มีคนเรียกเยอะ แต่ครั้งสุดท้าย "ก่อน" รอบที่มาอ้างมันจะประกาศ
    "/api/probe_old": { hits: 40, first_hit: day(59), last_hit: day(40) },
    // ทราฟฟิกอื่น ๆ ที่ทำให้บันทึกโตพอจะตัดสินได้
    "/api/probe_filler": { hits: 60, first_hit: day(59), last_hit: day(1) },
  },
};

const declared = (endpoints, detected, at) => ({
  endpoints,
  claimed: endpoints.filter((e) => !detected.includes(e)),
  detected,
  ignored: [],
  note: MARK + " คำสัญญาจำลอง",
  declared_at: at,
  matures_at: new Date(Date.parse(at) + 7 * 86400000).toISOString(),
  grace_days: 7,
  min_requests: 50,
});
const round = (id, at, limit, extra) => ({
  id,
  at,
  mode: "expansion",
  verdict: "accepted",
  limit,
  report: { new_capability: `${MARK} ความสามารถของ ${id}`, summary: `${MARK} ${id}` },
  ...extra,
});
const KNOW = { id: "lim_p_know", title: MARK + " กำแพงหมวดความรู้", category: "knowledge" };
const ARCH = { id: "lim_p_arch", title: MARK + " กำแพงหมวดสถาปัตยกรรม", category: "architecture" };

const DRY_ROUNDS = [
  // ถูกเรียกจริง 12 ครั้งผ่านเส้นทางใหม่ที่มันสร้าง
  round("evo_p_used", day(30), KNOW, { adoption: declared(["/api/probe_live"], ["/api/probe_live"], day(30)) }),
  // ครบกำหนดแล้ว ไม่มีใครเรียกเลย
  round("evo_p_dead1", day(20), ARCH, { adoption: declared(["/api/probe_ghost"], ["/api/probe_ghost"], day(20)) }),
  // อ้างเส้นทางเดิมที่ "เคย" มีคนเรียก 40 ครั้ง แต่ครั้งสุดท้ายก่อนวันประกาศ → ต้องไม่ถูกนับว่าใช้
  round("evo_p_dead2", day(10), ARCH, { adoption: declared(["/api/probe_old"], [], day(10)) }),
  // ยังไม่ครบกำหนด — ความเงียบยังไม่ใช่คำตัดสิน
  round("evo_p_pending", day(1), ARCH, { adoption: declared(["/api/probe_ghost2"], ["/api/probe_ghost2"], day(1)) }),
  // เกิดก่อนชั้นนี้ ไม่มีคำประกาศ → วัดย้อนหลังไม่ได้
  round("evo_p_undecl", day(40), KNOW, {}),
  // รอบยุบรวมไม่ได้เพิ่มความสามารถ → ไม่ต้องวัด
  round("evo_p_consol", day(15), ARCH, { mode: "consolidation", adoption: declared(["/api/probe_ghost3"], ["/api/probe_ghost3"], day(15)) }),
  // รอบที่ตก → ไม่ใช่ "ความสามารถที่ไม่มีใครใช้" เพราะไม่เคยมีอยู่จริง
  round("evo_p_reject", day(5), { id: "lim_p_other", title: MARK + " อื่น ๆ", category: "autonomy" }, {
    verdict: "rejected",
    adoption: declared(["/api/probe_ghost4"], ["/api/probe_ghost4"], day(5)),
  }),
];

// กำแพงสมมติ: หมวด architecture มีคะแนนพื้นฐานสูงสุด (8) แต่เคยผลิตของที่ไม่มีใครเรียกสองรอบ
const DRY_LIMITS = [
  { id: "lim_p_arch", title: MARK + " กำแพงหมวดสถาปัตยกรรม", category: "architecture", unlock_score: 10, risk: 4, status: "standing", attempts: 0 },
  { id: "lim_p_know", title: MARK + " กำแพงหมวดความรู้", category: "knowledge", unlock_score: 9, risk: 4, status: "standing", attempts: 0 },
  { id: "lim_p_new", title: MARK + " กำแพงหมวดที่ยังไม่เคยวัด", category: "interface", unlock_score: 8, risk: 4, status: "standing", attempts: 0 },
];

/* ================= ข. ประวัติจำลองที่เขียนลงแซนด์บ็อกซ์จริง แล้วคืนค่าเดิมตอนจบ ================= */
const LIMITS_FILE = path.join(ROOT, "data", "limits.json");
const EVO_FILE = path.join(ROOT, "data", "evolution.json");
const LIVE_GHOST_A = "/api/probe_ghost_a_d0f8d35b";
const LIVE_GHOST_B = "/api/probe_ghost_b_d0f8d35b";
const realDay = (n) => new Date(Date.now() - n * 86400000).toISOString();

const LIVE_LIMITS = [
  {
    id: "lim_live_arch",
    title: MARK + " กำแพงจริงหมวดสถาปัตยกรรมที่เคยผลิตของที่ไม่มีใครใช้",
    category: "architecture",
    description: "กำแพงจำลองสำหรับตรวจว่าคะแนนการถูกใช้จริงถูกป้อนกลับเข้าการเลือกเป้าหมายหรือไม่",
    evidence: "server.js: targetRanking / adoptionReport",
    why_it_stands: "เดิมลำดับความคุ้มคิดจาก unlock − risk/2 เท่านั้น",
    break_idea: "ถ่วงลำดับด้วยคะแนนการถูกใช้จริงของหมวดนั้น",
    unlock_score: 10,
    risk: 4,
    status: "standing",
    attempts: 0,
    found_at: realDay(50),
  },
  {
    id: "lim_live_know",
    title: MARK + " กำแพงจริงหมวดความรู้ที่ของถูกใช้จริง",
    category: "knowledge",
    description: "กำแพงจำลองหมวดที่ของถูกเรียกใช้จริง",
    evidence: "server.js: adoptionRound",
    why_it_stands: "ไม่มีใครเคยวัดว่ามีคนใช้ไหม",
    break_idea: "วัดจากบันทึกการใช้งานจริง",
    unlock_score: 9,
    risk: 4,
    status: "standing",
    attempts: 0,
    found_at: realDay(50),
  },
];
const LIVE_ROUNDS = [
  // ใหม่สุด: ประกาศเส้นทางที่ไม่มีใครเรียก
  round("evo_live_dead2", realDay(10), { id: "lim_live_arch", title: LIVE_LIMITS[0].title, category: "architecture" }, {
    adoption: declared([LIVE_GHOST_B], [LIVE_GHOST_B], realDay(10)),
  }),
  round("evo_live_dead1", realDay(20), { id: "lim_live_arch", title: LIVE_LIMITS[0].title, category: "architecture" }, {
    adoption: declared([LIVE_GHOST_A], [LIVE_GHOST_A], realDay(20)),
  }),
  // เก่าสุด: ประกาศ /api/lessons ซึ่งไฟล์นี้จะยิงจริงหลายสิบครั้ง (หลังวันประกาศ)
  round("evo_live_used", realDay(30), { id: "lim_live_know", title: LIVE_LIMITS[1].title, category: "knowledge" }, {
    adoption: declared(["/api/lessons"], [], realDay(30)),
  }),
];

function backup(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function restore(file, content) {
  try {
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content, "utf8");
  } catch {}
}
const limitsBackup = backup(LIMITS_FILE);
const evoBackup = backup(EVO_FILE);

const byId = (rows, id) => (Array.isArray(rows) ? rows.find((r) => r.evo_id === id || r.id === id) : null) || {};

(async () => {
  /* ---- 1. เส้นทางใหม่ต้องมีอยู่จริง (โค้ดเดิมได้ 404 ทั้งคู่) ---- */
  const live0 = await get("/api/adoption");
  const A0 = live0.json || {};
  check(
    "GET /api/adoption ตอบ 200 พร้อมรายงานว่ามีใครใช้ของที่ระบบสร้างไว้บ้าง (โค้ดเดิมได้ 404)",
    live0.status === 200 && A0.counts && Array.isArray(A0.rounds) && Number.isFinite(A0.grace_days),
    `ได้ ${live0.status} · เกณฑ์รอ ${A0.grace_days} วัน · ต้องเห็นคำขอ ${A0.min_requests} ครั้ง`
  );
  check(
    "รายงานอ่านบันทึกการใช้งานจริงเป็นฐาน (นับคำขอที่เคยเข้ามาทั้งหมด)",
    Number.isFinite(A0.observed_requests) && typeof A0.rule === "string" && A0.rule.includes("endpoint-usage.json"),
    `เห็นคำขอมาแล้ว ${A0.observed_requests} ครั้ง`
  );

  /* ---- 2. หัวใจ: ฟังก์ชันตัดสินตัวจริง เรียกด้วยบันทึกสมมติ ---- */
  const dry = await post("/api/adoption/dryrun", { rounds: DRY_ROUNDS, usage: DRY_USAGE, now: NOW, limits: DRY_LIMITS });
  const D = dry.json || {};
  check(
    "POST /api/adoption/dryrun เรียกฟังก์ชันตัดสินตัวจริงด้วยบันทึกและนาฬิกาสมมติได้ (โค้ดเดิมได้ 404)",
    dry.status === 200 && D.counts && Array.isArray(D.rounds) && D.rounds.length === DRY_ROUNDS.length,
    `ได้ ${dry.status} · ${(D.rounds || []).length} รอบ · เห็นคำขอ ${D.observed_requests} ครั้ง`
  );

  const used = byId(D.rounds, "evo_p_used");
  check(
    "รอบที่เส้นทางถูกเรียกจริง → 'ถูกใช้จริง' และได้คะแนนบวก",
    used.status === "adopted" && used.signal > 0 && used.hits === 12 && used.used === 1,
    `status=${used.status} signal=${used.signal} hits=${used.hits}`
  );

  const dead1 = byId(D.rounds, "evo_p_dead1");
  check(
    "รอบที่ครบกำหนดแล้วไม่มีใครเรียกเลย → 'ไม่มีใครเรียกเลย' และได้คะแนนติดลบ",
    dead1.status === "unused" && dead1.signal === -1 && dead1.hits === 0 && dead1.mature === true,
    `status=${dead1.status} signal=${dead1.signal} ผ่านมา ${dead1.days} วัน`
  );

  const dead2 = byId(D.rounds, "evo_p_dead2");
  check(
    "เส้นทางเดิมที่ถูกเรียกครั้งสุดท้าย *ก่อน* วันประกาศ ไม่ถูกนับว่าใช้ (ซื้อคะแนนด้วยเส้นทางเดิมไม่ได้)",
    dead2.status === "unused" && dead2.hits === 0 && (dead2.endpoints || []).every((e) => e.used_since_declared === false),
    `status=${dead2.status} hits=${dead2.hits} · เส้นทางนั้นมีสถิติรวม 40 ครั้งแต่ทั้งหมดเกิดก่อนวันประกาศ`
  );

  const pending = byId(D.rounds, "evo_p_pending");
  check(
    "รอบที่ยังไม่ครบกำหนด → คะแนน null ไม่ใช่ติดลบ (ความเงียบยังไม่นับเป็นคำตัดสิน)",
    pending.status === "pending" && pending.signal === null && pending.mature === false,
    `status=${pending.status} signal=${JSON.stringify(pending.signal)} ผ่านมา ${pending.days} วัน`
  );

  const undecl = byId(D.rounds, "evo_p_undecl");
  const consol = byId(D.rounds, "evo_p_consol");
  const reject = byId(D.rounds, "evo_p_reject");
  check(
    "รอบที่เกิดก่อนชั้นนี้ / รอบยุบรวม / รอบที่ตก ถูกแยกออกจากการให้คะแนนอย่างซื่อสัตย์",
    undecl.status === "undeclared" && undecl.signal === null && consol.status === "exempt" && reject.status === "exempt",
    `undeclared=${undecl.status} consolidation=${consol.status} rejected=${reject.status}`
  );
  check(
    "สรุปจำนวนตรงกับความจริงทุกช่อง",
    D.counts.total === 7 &&
      D.counts.scored === 3 &&
      D.counts.adopted === 1 &&
      D.counts.unused === 2 &&
      D.counts.pending === 1 &&
      D.counts.undeclared === 1 &&
      D.counts.exempt === 2,
    JSON.stringify(D.counts)
  );
  check(
    "คะแนนรวมของทั้งระบบอยู่ในช่วง [-1,+1] และติดลบเพราะของที่ไม่มีใครใช้",
    D.signal !== null && D.signal >= -1 && D.signal <= 1 && D.signal < 0,
    `คะแนนเฉลี่ย ${D.signal}`
  );

  /* ---- 3. รอบที่ 0 hit ติดกันถูกเสนอเป็นเป้าหมายของรอบยุบรวมโดยอัตโนมัติ ---- */
  check(
    "นับ 'ไม่มีใครเรียกติดกัน' ได้ถูกต้อง และเสนอรอบยุบรวมเองเมื่อถึงเกณฑ์",
    D.unused_streak === 2 && D.consolidation_due === true,
    `ติดกัน ${D.unused_streak} รอบ (เกณฑ์ ${D.streak_trigger}) · เสนอรอบยุบรวม=${D.consolidation_due}`
  );
  const targets = (D.consolidation_targets || []).map((t) => t.evo_id);
  check(
    "เป้าหมายที่เสนอคือ 'รอบที่ทำได้แต่ไม่มีใครใช้' เท่านั้น ไม่ใช่รอบที่ตกหรือรอบที่ยังรอเวลา",
    targets.length === 2 && targets.includes("evo_p_dead1") && targets.includes("evo_p_dead2"),
    targets.join(", ") || "(ไม่มี)"
  );

  /* ---- 4. คะแนนถูกป้อนกลับเข้า selectTarget จริง ---- */
  const rank = D.ranking || [];
  const rArch = byId(rank, "lim_p_arch");
  const rKnow = byId(rank, "lim_p_know");
  const rNew = byId(rank, "lim_p_new");
  check(
    "หมวดที่เคยผลิตของที่ไม่มีใครใช้ถูกลดลำดับลงจริง",
    rArch.base === 8 && rArch.adoption_signal === -1 && rArch.adoption_adjust === -2 && rArch.score === 6,
    `พื้นฐาน ${rArch.base} → ${rArch.score} (ถ่วง ${rArch.adoption_adjust})`
  );
  check(
    "หมวดที่ของถูกใช้จริงถูกดันขึ้น",
    rKnow.base === 7 && rKnow.adoption_signal === 1 && rKnow.adoption_adjust === 2 && rKnow.score === 9,
    `พื้นฐาน ${rKnow.base} → ${rKnow.score} (ถ่วง ${rKnow.adoption_adjust})`
  );
  check(
    "หมวดที่ยังไม่เคยถูกวัดไม่ถูกลงโทษเพราะยังไม่มีข้อมูล (ถ่วง 0)",
    rNew.adoption_signal === null && rNew.adoption_adjust === 0 && rNew.score === rNew.base,
    `signal=${JSON.stringify(rNew.adoption_signal)} ถ่วง ${rNew.adoption_adjust}`
  );
  check(
    "ผลสุดท้าย: กำแพงที่คะแนนพื้นฐานสูงสุดไม่ได้ถูกเลือก เพราะประวัติการถูกใช้ของหมวดมันแย่กว่า",
    D.next_target && D.next_target.id === "lim_p_know" && rArch.base > rKnow.base,
    `เป้าหมายถัดไป: ${D.next_target ? D.next_target.id : "(ไม่มี)"} (พื้นฐาน arch ${rArch.base} > know ${rKnow.base} แต่ arch ตกไปอยู่ที่ ${rArch.score})`
  );

  /* ---- 5. ด่าน declared_usage มีอยู่จริงและป้อนกลับเข้าลูปของ Layer 6.7 ได้ ---- */
  const loop = await get("/api/forge/loop");
  const gateNames = ((loop.json || {}).gates || []).map((g) => g.gate);
  check(
    "ระบบมีด่านใหม่ 'declared_usage' — ทุกรอบขยายต้องประกาศเส้นทางที่ความสามารถจะถูกใช้ผ่าน",
    loop.status === 200 && gateNames.includes("declared_usage"),
    gateNames.join(", ")
  );
  const sim = await post("/api/forge/loop/simulate", {
    max_turns: 2,
    turns: [{ failed_gates: ["declared_usage"], detail: MARK + "_GATEOUT ไม่ได้ประกาศ usage_endpoints" }, { failed_gates: [] }],
  });
  const S = sim.json || {};
  const fed = String(((S.turns || [])[1] || {}).prompt_received || "");
  check(
    "ด่านนี้ถูกป้อนกลับเข้าเซสชันเดิมได้เหมือนด่านอื่น พร้อมชื่อด่านภาษาไทยและข้อความจริงของด่าน",
    sim.status === 200 &&
      fed.includes(MARK + "_GATEOUT") &&
      fed.includes("ไม่ได้ประกาศเส้นทางที่ความสามารถใหม่จะถูกใช้ผ่าน"),
    fed ? `ป้อนกลับ ${fed.length} ตัวอักษร` : "(ไม่มีการป้อนกลับ)"
  );

  /* ================= ข. บันทึกจริง: เขียนประวัติลงแซนด์บ็อกซ์แล้วยิงของจริง ================= */
  fs.writeFileSync(LIMITS_FILE, JSON.stringify(LIVE_LIMITS, null, 2), "utf8");
  fs.writeFileSync(EVO_FILE, JSON.stringify(LIVE_ROUNDS, null, 2), "utf8");

  // ทำให้บันทึกการใช้งานโตพอจะตัดสินได้ และให้เส้นทางที่รอบเก่าประกาศไว้ถูกเรียกจริง
  const need = Math.max(60, (A0.min_requests || 50) + 10);
  for (let i = 0; i < need; i++) await get("/api/lessons");

  const live = await get("/api/adoption");
  const L = live.json || {};
  const liveUsed = byId(L.rounds, "evo_live_used");
  const liveDead = byId(L.rounds, "evo_live_dead1");
  check(
    "บันทึกการใช้งานจริงในโปรเซสนี้ถูกนับ และครบเกณฑ์ที่จะตัดสินได้แล้ว",
    live.status === 200 && L.observed_requests >= (L.min_requests || 50),
    `เห็นคำขอ ${L.observed_requests} ครั้ง (เกณฑ์ ${L.min_requests})`
  );
  check(
    "รอบเก่าที่ประกาศ /api/lessons ไว้ ถูกตัดสินว่า 'ถูกใช้จริง' จากการที่มันถูกเรียกจริงเดี๋ยวนี้",
    liveUsed.status === "adopted" && liveUsed.hits >= 50 && liveUsed.signal > 0,
    `status=${liveUsed.status} hits=${liveUsed.hits} signal=${liveUsed.signal}`
  );
  check(
    "รอบเก่าที่ประกาศเส้นทางซึ่งไม่มีใครเรียก ถูกตัดสินว่า 'ไม่มีใครเรียกเลย'",
    liveDead.status === "unused" && liveDead.signal === -1,
    `status=${liveDead.status} signal=${liveDead.signal} ผ่านมา ${liveDead.days} วัน`
  );

  /* ---- 6. ทะเบียนกำแพงและรอบยุบรวมเห็นคะแนนนี้ด้วย ---- */
  const lim = await get("/api/limits");
  const LL = Array.isArray(lim.json) ? lim.json : [];
  const lArch = LL.find((l) => l.id === "lim_live_arch") || {};
  const lKnow = LL.find((l) => l.id === "lim_live_know") || {};
  check(
    "GET /api/limits พกคะแนนการถูกใช้จริงของหมวดมาด้วย (โค้ดเดิมไม่มีสนามเหล่านี้เลย)",
    lim.status === 200 &&
      lArch.category_adoption &&
      Number.isFinite(lArch.priority_base) &&
      Number.isFinite(lArch.priority_score) &&
      Number.isFinite(lArch.adoption_adjust),
    `arch: พื้นฐาน ${lArch.priority_base} → ${lArch.priority_score} (ถ่วง ${lArch.adoption_adjust})`
  );
  check(
    "เป้าหมายถัดไปของทะเบียนจริงเปลี่ยนตามคะแนนการถูกใช้: กำแพงหมวดที่ของไม่มีใครใช้แพ้กำแพงที่คะแนนพื้นฐานต่ำกว่า",
    lKnow.is_next_target === true && lArch.is_next_target === false && lArch.priority_base > lKnow.priority_base,
    `know=${lKnow.is_next_target} (พื้นฐาน ${lKnow.priority_base} → ${lKnow.priority_score}) · arch=${lArch.is_next_target} (พื้นฐาน ${lArch.priority_base} → ${lArch.priority_score})`
  );

  const cons = await get("/api/consolidation/preview");
  const C = cons.json || {};
  const unusedIds = (C.unused_capabilities || []).map((t) => t.evo_id);
  check(
    "รอบยุบรวมถูกเสนอเป้าหมายมาให้เองแล้ว: ความสามารถที่ไม่มีใครเรียก (โค้ดเดิมไม่มี unused_capabilities)",
    cons.status === 200 &&
      Array.isArray(C.unused_capabilities) &&
      unusedIds.includes("evo_live_dead1") &&
      unusedIds.includes("evo_live_dead2") &&
      C.adoption &&
      C.adoption.consolidation_due === true &&
      C.due === true &&
      typeof C.due_reason === "string" &&
      C.due_reason.length > 0,
    `เป้าหมาย ${unusedIds.join(", ") || "(ไม่มี)"} · ถึงคิว=${C.due} เพราะ ${C.due_reason}`
  );

  /* ---- 7. พรอมป์ตของรอบถัดไปได้อ่านเรื่องนี้จริง และถูกบังคับให้ประกาศ ---- */
  const pv = await get("/api/forge/preview");
  const P = pv.json || {};
  const head = String(P.prompt_head || "");
  check(
    "พรอมป์ตของรอบถัดไปมีบล็อกเส้นตอบกลับของตัวระบบเอง และรายชื่อของที่ไม่มีใครเรียก",
    pv.status === 200 &&
      head.includes("เส้นตอบกลับของตัวระบบเอง") &&
      head.includes("evo_live_dead1") &&
      head.includes(LIVE_GHOST_A),
    `หัวพรอมป์ต ${head.length} ตัวอักษร จากพรอมป์ตเต็ม ${P.prompt_chars} ตัวอักษร`
  );
  check(
    "พรอมป์ตบังคับให้รอบถัดไปประกาศเส้นทางที่ความสามารถจะถูกใช้ผ่าน",
    head.includes("usage_endpoints") && head.includes("usage_note"),
    "ตรวจสัญญาที่รอบถัดไปต้องตอบกลับ"
  );
  check(
    "preview คืนสถานะการถูกใช้จริงเป็นข้อมูลมีโครงสร้างด้วย ไม่ใช่แค่ข้อความในพรอมป์ต",
    P.adoption && Number.isFinite(P.adoption.unused_streak) && Array.isArray(P.adoption.targets) && P.adoption.rank,
    `เป้าหมายของรอบยุบรวม ${(P.adoption && P.adoption.targets || []).length} รอบ · ลำดับของกำแพงนี้ ${JSON.stringify((P.adoption || {}).rank || null)}`
  );

  const self = await get("/api/self");
  const SF = (self.json || {}).adoption || null;
  check(
    "GET /api/self บอกได้ว่าของที่ตัวเองสร้างถูกใช้ไปกี่รอบแล้ว",
    self.status === 200 && SF && SF.counts && Number.isFinite(SF.grace_days),
    SF ? `ถูกใช้จริง ${SF.counts.adopted} · ไม่มีใครเรียก ${SF.counts.unused} · ให้คะแนนได้ ${SF.counts.scored}` : "(ไม่มีสนาม adoption)"
  );

  /* ---- 8. ความสามารถเดิมต้องครบ ---- */
  for (const ep of [
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
    "/api/adoption",
  ]) {
    const r = await get(ep);
    check(`endpoint ${ep} ยังตอบ 200`, r.status === 200, `ได้ ${r.status}`);
  }
})()
  .catch((e) => {
    console.error("✗ ข้อผิดพลาดระหว่างทดสอบ: " + (e && e.stack ? e.stack : e));
    failures.push("exception");
  })
  .finally(() => {
    // คืนความทรงจำจำลองของแซนด์บ็อกซ์กลับให้เหมือนเดิม
    restore(LIMITS_FILE, limitsBackup);
    restore(EVO_FILE, evoBackup);
    if (failures.length) {
      console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
      process.exit(1);
    }
    console.log("\n✓ ผ่านทั้งหมด — ระบบรู้แล้วว่ามีใครใช้ของที่มันสร้าง และคะแนนนั้นย้อนกลับไปเปลี่ยนว่าจะสร้างอะไรต่อ");
    process.exit(0);
  });
