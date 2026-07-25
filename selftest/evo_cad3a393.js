/*
 * ไฟล์พิสูจน์ (capability proof) — รอบที่ทำให้ "เครื่องมือเชื่อมจุด" ใช้จุดของตัวเองตอนเขียนโค้ดตัวเอง (Layer 6.9)
 *
 * กำแพงที่ถูกทำลาย: buildForgePrompt() ได้รับแค่สามอย่าง — ตัวขอบเขต ประวัติความล้มเหลว และซอร์สโค้ด
 *   ไม่มีจุดความรู้แม้แต่จุดเดียว ไม่มีนวัตกรรมที่ตัวเองเคยสังเคราะห์ ไม่มีบทเรียนจาก /api/lessons
 *   ทั้งที่สมมติฐานที่ระบบทั้งระบบตั้งอยู่บนนั้นคือ "คำตอบที่ดีเกิดจากการทาบโครงสร้างข้ามโดเมน"
 *   ชั้นที่สำคัญที่สุดของมันจึงทำงานในโดเมนเดียวคือซอร์สโค้ดของตัวเอง
 *   ส่วน buildIntrospectPrompt() เห็นคลังจุดก็จริง แต่เห็นแค่ d.title — คินสึงิ ภูมิคุ้มกันแบบจดจำ ทฤษฎีแถวคอย
 *   จึงเป็นได้แค่รายชื่อ ไม่เคยเป็นวัตถุดิบ
 *
 * ไฟล์นี้ทดสอบพฤติกรรมจริงผ่าน HTTP สามชั้น:
 *   ก. ชั้นที่ตัดสินด้วยของสมมติ — POST /api/forge/knowledge/dryrun เรียกฟังก์ชันตัวจริง
 *      (forgeKnowledge / wallRelevance / buildKnowledgeBlock / forgeFeedbackPlan / forgeFeedbackRecord)
 *      ด้วยกำแพงสมมติ คลังสมมติ และรอบสมมติ จึงตรวจได้ทันทีโดยไม่ต้องเสียรอบ AI ว่า:
 *        · จุดที่โครงสร้างทาบกับกำแพงได้ ถูกจัดอันดับสูงกว่าจุดที่ไม่เกี่ยว
 *        · บล็อกความรู้พา "เนื้อหาจริง" ของจุดเข้าไปในพรอมป์ต ไม่ใช่แค่ชื่อจุด
 *        · เพดานโดเมนละไม่เกิน N ทำให้จุดจากโดเมนอื่นได้เข้าบล็อกจริง แม้คะแนนความเกี่ยวต่ำกว่า
 *          (คลังที่โตขึ้นจึงไม่ทำให้บล็อกกลายเป็นโดเมนเดียว และบล็อกมีเพดาน ไม่โตตามคลัง)
 *        · การที่รอบหนึ่งประกาศว่า "ใช้หลักการจากจุดนี้" ทำให้คะแนนของจุดนั้นขยับจริงตาม Layer 4.5:
 *          รอบผ่าน → บวก · รอบตก → ติดลบ · ไม่ประกาศ → ไม่มีอะไรถูกเขียน · อ้าง id ที่ไม่มีจริง → ถูกรายงาน
 *   ข. ชั้นที่ตัดสินด้วยพรอมป์ตจริง — GET /api/forge/preview ต้องมีบล็อก "หลักการข้ามโดเมน" อยู่ในหัวพรอมป์ต
 *      พร้อมสัญญา used_dot_ids / used_principle และรายงานว่าแต่ละส่วนของพรอมป์ตกินที่เท่าไร
 *   ค. ชั้นที่ตัดสินด้วยคลังจริง — เขียนคลังจำลองลง data/ ของแซนด์บ็อกซ์ แล้วตรวจว่า /api/dots และ
 *      /api/forge/knowledge เห็น "คะแนนจากการช่วยทำลายกำแพง" ของจุดนั้นจริง
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตก: ไม่มี /api/forge/knowledge, /api/forge/knowledge/dryrun, /api/forge/insight (404)
 *   · prompt_head ของ /api/forge/preview ไม่มีบล็อกความรู้และไม่มี used_dot_ids
 *   · /api/dots ไม่มีสนาม forge_uses / forge_score · /api/self ไม่มี self_connector
 *
 * exit 0 = เครื่องมือเชื่อมจุดใช้จุดของตัวเองแล้ว · exit != 0 = ยังไม่ใช้
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
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

/* ================= ก. กำแพง คลัง และรอบสมมติ (ไม่ผูกกับเวลาจริง จึงได้ผลเดิมทุกครั้ง) ================= */
const MARK = "PROBE_cad3a393";
const BORN = "2026-01-01T00:00:00.000Z";

const DRY_LIMIT = {
  id: "lim_probe_cad3a393",
  title: MARK + " เครื่องมือเชื่อมจุดไม่เคยใช้จุดของตัวเองตอนเขียนโค้ดตัวเอง",
  category: "knowledge",
  description:
    "พรอมป์ตหลอมตัวเองได้รับแค่ตัวขอบเขต ประวัติความล้มเหลว และซอร์สโค้ด ไม่มีจุดความรู้แม้แต่จุดเดียว " +
    "ทั้งที่ระบบตั้งอยู่บนสมมติฐานว่าคำตอบที่ดีเกิดจากการทาบโครงสร้างข้ามโดเมน",
  evidence: "server.js: buildForgePrompt ไม่รับ dots/connections/lessons เลย",
  why_it_stands: "พรอมป์ตหลอมตัวเองใหญ่จนน่ากลัวอยู่แล้ว การเติมความรู้เข้าไปอีกดูเหมือนการทำร้ายตัวเองทันที",
  break_idea: "ยัดหลักการข้ามโดเมนเข้าหัวพรอมป์ต แล้วบังคับให้ประกาศว่ารอบนี้ใช้หลักการจากจุดไหน",
  unlock_score: 9,
  risk: 4,
  status: "standing",
  attempts: 0,
  found_at: BORN,
};

// จุดที่ "ทาบกับกำแพงได้" — ใช้ถ้อยคำเชิงโครงสร้างชุดเดียวกับกำแพง
const nearDot = (n) => ({
  id: `dot_probe_near_${n}`,
  title: `${MARK} หลักการทาบโครงสร้างข้ามโดเมนเข้ากับพรอมป์ตหลอมตัวเอง #${n}`,
  domain: "ระบบพรอมป์ตของตัวเอง",
  content:
    "พรอมป์ตหลอมตัวเองที่ได้รับแค่ตัวขอบเขตกับซอร์สโค้ด ทำงานในโดเมนเดียว " +
    "การทาบโครงสร้างข้ามโดเมนต้องมีจุดความรู้และเนื้อหาจริงของมันอยู่ในพรอมป์ต ไม่ใช่แค่ชื่อจุด " +
    `ประวัติความล้มเหลวเพียงอย่างเดียวไม่พอจะทำลายกำแพงเชิงสถาปัตยกรรม (ตัวอย่างที่ ${n})`,
  created_at: BORN,
  origin: "human",
});
// จุดจากโดเมนที่ไกลออกไป — คะแนนความเกี่ยวต่ำกว่าเสมอ แต่เพดานโดเมนต้องดันมันเข้าบล็อกให้ได้
const farDot = (n) => ({
  id: `dot_probe_far_${n}`,
  title: `${MARK} การถ่วงน้ำหนักท้องเรือให้ตั้งลำเองเมื่อโดนคลื่น #${n}`,
  domain: "การเดินเรือ",
  content:
    "เรือที่ถ่วงน้ำหนักไว้ต่ำกว่าจุดศูนย์กลางการลอย จะกลับมาตั้งลำเองหลังโดนคลื่นเอียง " +
    `โดยไม่ต้องมีใครหมุนพวงมาลัยแก้ (ตัวอย่างที่ ${n})`,
  created_at: BORN,
  origin: "human",
});
const DRY_DOTS = [
  ...Array.from({ length: 10 }, (_, i) => nearDot(i + 1)),
  farDot(1),
  farDot(2),
];

const round = (verdict, extra) => ({
  id: "evo_probe_cad3a393",
  at: BORN,
  mode: "expansion",
  verdict,
  limit: { id: DRY_LIMIT.id, title: DRY_LIMIT.title, category: DRY_LIMIT.category },
  reason: verdict === "accepted" ? MARK + " ผ่านทุกด่าน" : MARK + " ตกด่านความสามารถ",
  report: {
    broke_it: verdict === "accepted",
    summary: MARK + " สรุปของรอบสมมติ",
    new_capability: MARK + " ความสามารถใหม่ของรอบสมมติ",
    used_principle: MARK + " ทาบหลักการเรื่องการตั้งลำเองเข้ากับลูปป้อนกลับของพรอมป์ต",
    ...extra,
  },
});

/* ================= ค. คลังจำลองที่เขียนลงแซนด์บ็อกซ์จริง แล้วคืนค่าเดิมตอนจบ ================= */
const DOTS_FILE = path.join(ROOT, "data", "dots.json");
const CONN_FILE = path.join(ROOT, "data", "connections.json");
const LIVE_HELPER = "dot_probe_live_helper";
const LIVE_BYSTANDER = "dot_probe_live_bystander";
const LIVE_DOTS = [
  {
    id: LIVE_HELPER,
    title: MARK + " จุดจริงที่ถูกอ้างว่าช่วยทำลายกำแพงได้",
    domain: "ระบบตัวเอง",
    content: "หลักการที่รอบหลอมตัวเองอ้างว่าใช้ทาบกับกำแพงของตัวเองแล้วกำแพงล้มจริง",
    created_at: BORN,
    origin: "human",
  },
  {
    id: LIVE_BYSTANDER,
    title: MARK + " จุดจริงที่ไม่มีรอบไหนอ้างถึง",
    domain: "การเดินเรือ",
    content: "จุดที่อยู่ในคลังเฉย ๆ ไม่เคยถูกรอบหลอมตัวเองอ้างว่าใช้",
    created_at: BORN,
    origin: "human",
  },
];
// การเชื่อมจุดที่ "รอบหลอมตัวเอง" เขียนไว้เอง พร้อม outcome ที่ด่านของระบบให้คะแนน
const LIVE_CONNECTIONS = [
  {
    id: "conn_forge_evo_probe_live",
    created_at: BORN,
    model: "probe",
    focus: MARK + " ทำลายกำแพงของระบบตัวเอง",
    auto: true,
    wall: { id: DRY_LIMIT.id, title: DRY_LIMIT.title, category: "knowledge" },
    forge: {
      evo_id: "evo_probe_live",
      mode: "expansion",
      verdict: "accepted",
      limit: { id: DRY_LIMIT.id, title: DRY_LIMIT.title, category: "knowledge" },
      principle: MARK + " หลักการที่ถูกอ้าง",
      declared: [LIVE_HELPER],
      missing: [],
    },
    revived_dots: [],
    selected_dots: [{ id: LIVE_HELPER, title: LIVE_DOTS[0].title, domain: LIVE_DOTS[0].domain }],
    hidden_pattern: MARK + " รูปแบบที่ซ่อนอยู่",
    connection: MARK + " การลากเส้นเชื่อม",
    innovation: { name: MARK + " ทำลายกำแพงได้", description: "-", why_new: "-", first_step: "-" },
    evidence: null,
    outcome: { rated_at: BORN, rating: 5, status: "shipped", note: MARK + " ด่านทั้งหมดผ่าน" },
  },
];

const backup = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
const restore = (f, c) => {
  try {
    if (c === null) fs.rmSync(f, { force: true });
    else fs.writeFileSync(f, c, "utf8");
  } catch {}
};
const dotsBackup = backup(DOTS_FILE);
const connBackup = backup(CONN_FILE);

(async () => {
  /* ---- 1. เส้นทางใหม่ต้องมีอยู่จริง (โค้ดเดิมได้ 404 ทั้งสามเส้น) ---- */
  const know = await get("/api/forge/knowledge");
  const K = know.json || {};
  check(
    "GET /api/forge/knowledge ตอบ 200 พร้อมบล็อกความรู้ที่รอบถัดไปจะได้อ่านจริง (โค้ดเดิมได้ 404)",
    know.status === 200 && typeof K.block === "string" && Array.isArray(K.dots) && Number.isFinite(K.block_chars),
    `ได้ ${know.status} · บล็อก ${K.block_chars} ตัวอักษร · จุดในบล็อก ${(K.dots || []).length} จุดจากคลัง ${K.pool_dots} จุด`
  );
  check(
    "บล็อกนี้พา 'หลักการข้ามโดเมนที่อาจใช้กับกำแพงนี้' เข้ามาจริง และมีเพดานของตัวเอง",
    String(K.block || "").includes("หลักการข้ามโดเมนที่อาจใช้กับกำแพงนี้") &&
      K.caps &&
      Number.isFinite(K.caps.dots) &&
      Number.isFinite(K.caps.dot_chars) &&
      (K.dots || []).length <= K.caps.dots,
    K.caps ? `เพดาน ${K.caps.dots} จุด × ${K.caps.dot_chars} ตัวอักษร · โดเมนละไม่เกิน ${K.caps.per_domain}` : "(ไม่มี caps)"
  );
  check(
    "จุดในบล็อกมาพร้อม 'เนื้อหาจริง' ไม่ใช่แค่ชื่อจุด",
    (K.dots || []).length > 0 && (K.dots || []).every((d) => typeof d.content === "string") &&
      (K.dots || []).some((d) => d.content.length > 40 && String(K.block).includes(d.content.slice(0, 40))),
    (K.dots || []).map((d) => `${d.title} (${d.content_chars} ตัวอักษร)`).slice(0, 3).join(" · ")
  );
  check(
    "บล็อกพานวัตกรรมที่ระบบเคยสังเคราะห์เอง และบทเรียนจากเส้นตอบกลับเข้ามาด้วย",
    Array.isArray(K.innovations) && Array.isArray(K.lessons) && K.innovations.length > 0 &&
      String(K.block).includes("รูปแบบที่ซ่อนอยู่ที่มันเห็น"),
    `นวัตกรรม ${(K.innovations || []).length} ชิ้น · บทเรียน ${(K.lessons || []).length} ข้อ`
  );

  /* ---- 2. อีกครึ่งของกำแพงเดียวกัน: รอบส่องกระจกเคยเห็นแค่ชื่อจุด ---- */
  const dotsNow = await get("/api/dots");
  const allDots = Array.isArray(dotsNow.json) ? dotsNow.json : [];
  const withContent = allDots.filter((d) => norm(d.content).length >= 40);
  const inIntrospect = withContent.filter((d) => String(K.introspect_knowledge || "").includes(norm(d.content).slice(0, 40)));
  check(
    "พรอมป์ตส่องกระจก (buildIntrospectPrompt) เห็นเนื้อหาของจุดจริง ไม่ใช่แค่รายชื่อจุดอีกต่อไป",
    typeof K.introspect_knowledge === "string" && inIntrospect.length >= Math.min(5, withContent.length) &&
      K.introspect_chars > allDots.reduce((n, d) => n + String(d.title || "").length, 0),
    `เห็นเนื้อหาจริง ${inIntrospect.length}/${withContent.length} จุด · บล็อกยาว ${K.introspect_chars} ตัวอักษร`
  );

  /* ---- 3. หัวใจ: ฟังก์ชันเลือกความรู้ตัวจริง เรียกด้วยกำแพงและคลังสมมติ ---- */
  const dry = await post("/api/forge/knowledge/dryrun", { limit: DRY_LIMIT, dots: DRY_DOTS, connections: [] });
  const D = dry.json || {};
  check(
    "POST /api/forge/knowledge/dryrun เรียกฟังก์ชันเลือกความรู้ตัวจริงด้วยของสมมติได้ (โค้ดเดิมได้ 404)",
    dry.status === 200 && Array.isArray(D.ranking) && D.ranking.length === DRY_DOTS.length && D.brief,
    `ได้ ${dry.status} · จัดอันดับ ${(D.ranking || []).length} จุด`
  );
  const rank = (id) => (D.ranking || []).findIndex((r) => r.id === id);
  const near1 = (D.ranking || []).find((r) => r.id === "dot_probe_near_1") || {};
  const far1 = (D.ranking || []).find((r) => r.id === "dot_probe_far_1") || {};
  check(
    "จุดที่โครงสร้างทาบกับกำแพงได้ ถูกจัดอันดับสูงกว่าจุดที่ไม่เกี่ยวกับกำแพงเลย",
    rank("dot_probe_near_1") >= 0 && rank("dot_probe_far_1") > rank("dot_probe_near_1") &&
      near1.wall_overlap > far1.wall_overlap,
    `ทาบตรงกัน near ${near1.wall_overlap} (อันดับ ${rank("dot_probe_near_1") + 1}) > far ${far1.wall_overlap} (อันดับ ${rank("dot_probe_far_1") + 1})`
  );
  const picked = (D.brief && D.brief.dots) || [];
  const pickedDomains = [...new Set(picked.map((d) => d.domain))];
  const farPicked = picked.filter((d) => d.domain === "การเดินเรือ");
  const expectPicked = Math.min(D.caps.dots, DRY_DOTS.length);
  check(
    "เพดานโดเมนทำให้จุดจากโดเมนอื่นได้เข้าบล็อกจริง แม้คะแนนความเกี่ยวต่ำกว่าจุดที่ถูกตัดออก",
    picked.length === expectPicked && pickedDomains.length === 2 &&
      farPicked.length === Math.min(D.caps.per_domain, 2) &&
      D.brief.skipped_dots === DRY_DOTS.length - picked.length,
    `เลือก ${picked.length}/${DRY_DOTS.length} จุดจาก ${pickedDomains.length} โดเมน (การเดินเรือ ${farPicked.length} จุด) · ย่อทิ้ง ${D.brief.skipped_dots} จุด`
  );
  check(
    "โจทย์ที่จะตั้งให้รอบเชื่อมจุดของกำแพง = description + why_it_stands ตามที่วิเคราะห์ไว้",
    D.brief.wall && typeof D.brief.wall.focus === "string" &&
      D.brief.wall.focus.includes("กำแพงนี้ยังอยู่เพราะ") &&
      D.brief.wall.focus.includes("พรอมป์ตหลอมตัวเองได้รับแค่ตัวขอบเขต"),
    D.brief.wall ? D.brief.wall.focus.slice(0, 130) + "…" : "(ไม่มี)"
  );
  check(
    "บล็อกที่ได้บังคับสัญญาใหม่ของรอบ: ต้องประกาศ used_dot_ids และ used_principle",
    String(D.block || "").includes("used_dot_ids") && String(D.block || "").includes("used_principle") &&
      String(D.block).includes("ห้ามอ้างจุดที่ไม่ได้ใช้จริง"),
    `บล็อก ${D.block_chars} ตัวอักษร`
  );

  /* ---- 4. เส้นตอบกลับ: การประกาศว่าใช้จุดไหน ทำให้คะแนนของจุดนั้นขยับจริงตาม Layer 4.5 ---- */
  const okRun = await post("/api/forge/knowledge/dryrun", {
    limit: DRY_LIMIT,
    dots: DRY_DOTS,
    connections: [],
    round: round("accepted", { used_dot_ids: ["dot_probe_near_1", "dot_probe_far_1"] }),
  });
  const OK = (okRun.json || {}).feedback || {};
  const okMove = (OK.moves || []).find((m) => m.id === "dot_probe_far_1") || {};
  check(
    "รอบที่ผ่านทุกด่าน → จุดที่มันประกาศว่าใช้ ได้คะแนนบวกเท่าไอเดียที่ถูกเอาไปทำจริง",
    okRun.status === 200 && OK.plan && OK.plan.applicable === true && OK.signal === 1 &&
      okMove.value_after === 1 && okMove.forge_score_after === 1 && okMove.forge_uses_after === 1 &&
      okMove.proven_after === true && okMove.attention_after > okMove.attention_before,
    `สัญญาณ ${OK.signal} · คุณค่า ${okMove.value_before} → ${okMove.value_after} · ลำดับความสนใจ ${okMove.attention_before} → ${okMove.attention_after}`
  );
  check(
    "ผลนั้นถูกเขียนเป็น 'การเชื่อมจุด' จริง จึงใช้เส้นตอบกลับเดิมของ Layer 4.5 ไม่ใช่คะแนนระบบใหม่",
    OK.would_write && OK.would_write.outcome && OK.would_write.outcome.status === "shipped" &&
      OK.would_write.outcome.rating === 5 && (OK.would_write.selected_dots || []).length === 2 &&
      OK.would_write.forge && OK.would_write.forge.evo_id === "evo_probe_cad3a393",
    OK.would_write ? `${OK.would_write.id} · ${OK.would_write.outcome.status} ${OK.would_write.outcome.rating}/5` : "(ไม่มีอะไรจะเขียน)"
  );

  const badRun = await post("/api/forge/knowledge/dryrun", {
    limit: DRY_LIMIT,
    dots: DRY_DOTS,
    connections: [],
    round: round("rejected", { used_dot_ids: ["dot_probe_far_1"] }),
  });
  const BAD = (badRun.json || {}).feedback || {};
  const badMove = (BAD.moves || [])[0] || {};
  check(
    "รอบที่ตกและถูกย้อนกลับ → จุดที่มันอ้างว่าช่วย ถูกหักคะแนนเท่าไอเดียที่ตายแล้ว (คลังเริ่มถูกพิสูจน์ได้)",
    badRun.status === 200 && BAD.signal === -1 && badMove.value_after === -1 &&
      badMove.forge_score_after === -1 && badMove.dead_end_after === true &&
      badMove.attention_after < badMove.attention_before,
    `สัญญาณ ${BAD.signal} · คุณค่า ${badMove.value_before} → ${badMove.value_after} · ลำดับความสนใจ ${badMove.attention_before} → ${badMove.attention_after}`
  );

  const silent = await post("/api/forge/knowledge/dryrun", {
    limit: DRY_LIMIT,
    dots: DRY_DOTS,
    connections: [],
    round: round("accepted", { used_dot_ids: [] }),
  });
  const S = (silent.json || {}).feedback || {};
  check(
    "รอบที่ไม่ประกาศว่าใช้จุดไหน → ไม่มีอะไรถูกเขียนลงคลัง (ไม่เดาแทน ไม่ให้เครดิตฟรี)",
    silent.status === 200 && S.plan && S.plan.declared === false && S.plan.applicable === false &&
      S.would_write === null && (S.moves || []).length === 0,
    `declared=${S.plan && S.plan.declared} · applicable=${S.plan && S.plan.applicable}`
  );

  const ghost = await post("/api/forge/knowledge/dryrun", {
    limit: DRY_LIMIT,
    dots: DRY_DOTS,
    connections: [],
    round: round("accepted", { used_dot_ids: ["dot_probe_near_2", "dot_ที่ไม่มีอยู่จริง"] }),
  });
  const G = (ghost.json || {}).feedback || {};
  check(
    "id ที่อ้างแต่ไม่มีอยู่ในคลัง ถูกรายงานไว้ ไม่ถูกทิ้งเงียบ และไม่ทำให้จุดที่มีจริงเสียเครดิต",
    ghost.status === 200 && (G.plan.missing || []).includes("dot_ที่ไม่มีอยู่จริง") &&
      (G.plan.dot_ids || []).length === 1 && G.plan.applicable === true &&
      (G.would_write.forge.missing || []).includes("dot_ที่ไม่มีอยู่จริง"),
    `อ้าง ${(G.plan.claimed || []).length} id · มีจริง ${(G.plan.dot_ids || []).length} · ไม่มีจริง ${(G.plan.missing || []).join(", ")}`
  );

  const consol = await post("/api/forge/knowledge/dryrun", {
    limit: DRY_LIMIT,
    dots: DRY_DOTS,
    connections: [],
    round: { ...round("accepted", { used_dot_ids: ["dot_probe_near_1"] }), mode: "consolidation" },
  });
  const C = (consol.json || {}).feedback || {};
  check(
    "รอบยุบรวมไม่ถูกนับเป็นหลักฐานของคลัง (มันไม่ได้ทำลายกำแพงด้วยหลักการ)",
    consol.status === 200 && C.plan.applicable === false && C.would_write === null,
    `mode=${C.plan && C.plan.mode} · applicable=${C.plan && C.plan.applicable}`
  );

  /* ---- 5. พรอมป์ตจริงของรอบถัดไปต้องมีบล็อกนี้อยู่ในหัว ---- */
  const pv = await get("/api/forge/preview");
  const P = pv.json || {};
  const head = String(P.prompt_head || "");
  check(
    "หัวพรอมป์ตของรอบถัดไปมีบล็อกหลักการข้ามโดเมนจริง (โค้ดเดิมมีแค่ประวัติความล้มเหลวกับซอร์สโค้ด)",
    pv.status === 200 && head.includes("หลักการข้ามโดเมนที่อาจใช้กับกำแพงนี้") &&
      head.includes("used_dot_ids") && head.includes("used_principle"),
    `หัวพรอมป์ต ${head.length} ตัวอักษร จากพรอมป์ตเต็ม ${P.prompt_chars} ตัวอักษร`
  );
  const parts = P.prompt_parts || {};
  check(
    "ระบบรายงานว่าแต่ละส่วนของพรอมป์ตกินที่เท่าไร — 'อะไรควรถูกตัดออกเพื่อให้ความรู้เข้ามา' จึงเป็นตัวเลข ไม่ใช่ความรู้สึก",
    Number.isFinite(parts.knowledge_block) && parts.knowledge_block > 200 &&
      Number.isFinite(parts.failure_block) && Number.isFinite(parts.adoption_block) &&
      Number.isFinite(parts.source_bundle) && parts.knowledge_block < parts.source_bundle,
    `ความรู้ ${parts.knowledge_block} · แผลเป็น ${parts.failure_block} · การถูกใช้ ${parts.adoption_block} · ซอร์ส ${parts.source_bundle} ตัวอักษร`
  );
  check(
    "preview คืนบล็อกความรู้เป็นข้อมูลมีโครงสร้างด้วย (ตรวจได้ว่าจุดไหนถูกเลือกเพราะอะไร)",
    P.knowledge && Array.isArray(P.knowledge.dots) && P.knowledge.dots.length > 0 &&
      P.knowledge.dots.every((d) => Number.isFinite(d.relevance) && Number.isFinite(d.wall_overlap)) &&
      typeof P.knowledge.rule === "string",
    (P.knowledge && P.knowledge.dots || []).map((d) => `${d.title} (${d.relevance})`).slice(0, 3).join(" · ")
  );

  /* ---- 6. รอบเชื่อมจุดที่เล็งกำแพงมีอยู่จริงและถูกกันไม่ให้เรียก AI ในโหมดทดสอบ ---- */
  const insight = await post("/api/forge/insight", {});
  check(
    "POST /api/forge/insight มีอยู่จริงและเคารพ DOT_SELFTEST (โค้ดเดิมได้ 404)",
    insight.status === 503 && String((insight.json || {}).error || "").includes("โหมดทดสอบ"),
    `ได้ ${insight.status} · ${(insight.json || {}).error || ""}`
  );
  check(
    "กำแพงเป้าหมายจริงในคลังก็มีโจทย์ของรอบเชื่อมจุดรอไว้แล้ว (เล็งกำแพง ไม่ใช่เล็งลอย ๆ)",
    typeof K.insight_focus === "string" && K.insight_focus.length > 40 &&
      K.insight_focus.includes("ทำลายกำแพงในโค้ดของระบบตัวเอง"),
    K.insight_focus ? K.insight_focus.slice(0, 120) + "…" : "(ไม่มี)"
  );

  /* ---- 7. คลังจริง: คะแนน "ช่วยทำลายกำแพงได้จริงไหม" ปรากฏบนจุดจริง ---- */
  check(
    "GET /api/dots พกคะแนนการช่วยทำลายกำแพงมาด้วยทุกจุด (โค้ดเดิมไม่มีสนามนี้เลย)",
    dotsNow.status === 200 && allDots.length > 0 &&
      allDots.every((d) => Number.isFinite(d.forge_uses) && Number.isFinite(d.forge_score)),
    `ตรวจแล้ว ${allDots.length} จุด`
  );

  fs.writeFileSync(DOTS_FILE, JSON.stringify(LIVE_DOTS, null, 2), "utf8");
  fs.writeFileSync(CONN_FILE, JSON.stringify(LIVE_CONNECTIONS, null, 2), "utf8");

  const seeded = await get("/api/dots");
  const seededDots = Array.isArray(seeded.json) ? seeded.json : [];
  const helper = seededDots.find((d) => d.id === LIVE_HELPER) || {};
  const bystander = seededDots.find((d) => d.id === LIVE_BYSTANDER) || {};
  check(
    "จุดที่รอบหลอมตัวเองอ้างว่าใช้แล้วกำแพงล้ม ได้คะแนนจริงบนคลังจริง ส่วนจุดที่ไม่มีใครอ้างไม่ได้ฟรี",
    helper.forge_uses === 1 && helper.forge_score === 1 && helper.forge_proven === true && helper.proven === true &&
      bystander.forge_uses === 0 && bystander.forge_score === 0 && bystander.proven !== true,
    `helper: ใช้ ${helper.forge_uses} ครั้ง คะแนน ${helper.forge_score} · bystander: ใช้ ${bystander.forge_uses} ครั้ง คะแนน ${bystander.forge_score}`
  );

  const know2 = await get("/api/forge/knowledge");
  const K2 = know2.json || {};
  const board = (K2.dot_scoreboard || []).find((d) => d.id === LIVE_HELPER) || {};
  check(
    "ตารางคะแนนของคลัง (ใครช่วยทำลายกำแพงได้บ้าง) อ่านได้จริงจากเส้นทางเดียว",
    know2.status === 200 && board.forge_uses === 1 && board.forge_proven === true &&
      K2.status && K2.status.forge_scored_dots === 1 && K2.status.declared_rounds >= 0,
    `ในตาราง ${(K2.dot_scoreboard || []).length} จุด · จุดที่มีคะแนนจากรอบหลอมตัวเอง ${K2.status && K2.status.forge_scored_dots}`
  );
  const self = await get("/api/self");
  const SC = (self.json || {}).self_connector || null;
  check(
    "GET /api/self บอกได้ว่าคลังของตัวเองถูกใช้ตอนเขียนโค้ดตัวเองไปกี่รอบแล้ว",
    self.status === 200 && SC && Number.isFinite(SC.forge_scored_dots) && Number.isFinite(SC.declared_rounds) &&
      Number.isFinite(SC.undeclared_rounds) && SC.caps && Number.isFinite(SC.caps.dots),
    SC ? `จุดที่ถูกให้คะแนน ${SC.forge_scored_dots} · รอบที่ประกาศ ${SC.declared_rounds} · รอบที่ไม่ประกาศ ${SC.undeclared_rounds}` : "(ไม่มีสนาม self_connector)"
  );

  restore(DOTS_FILE, dotsBackup);
  restore(CONN_FILE, connBackup);

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
    "/api/forge/knowledge",
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
    // คืนคลังจำลองของแซนด์บ็อกซ์กลับให้เหมือนเดิมทุกตัวอักษร
    restore(DOTS_FILE, dotsBackup);
    restore(CONN_FILE, connBackup);
    if (failures.length) {
      console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
      process.exit(1);
    }
    console.log(
      "\n✓ ผ่านทั้งหมด — เครื่องมือเชื่อมจุดใช้จุดของตัวเองตอนเขียนโค้ดตัวเองแล้ว " +
        "และคลังความรู้เริ่มถูกพิสูจน์ด้วยการที่มันช่วยทำลายกำแพงได้จริงหรือไม่"
    );
    process.exit(0);
  });
