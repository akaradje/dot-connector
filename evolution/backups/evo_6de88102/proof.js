/*
 * ไฟล์พิสูจน์ (capability proof) — รอบที่เปิดประตูให้ความรู้เดินเข้ามาเอง (Layer 07: The Scout)
 *
 * กำแพงที่ถูกทำลาย: "ความรู้เข้าได้ทางเดียว — ต้องรอมนุษย์ป้อน"
 *   เดิม harvestText() ถูกเรียกจากแค่ processInbox() กับ POST /api/capture ซึ่งทั้งคู่เริ่มจากการกระทำของมนุษย์
 *   ส่วน ev.novelty.similar_found — "สิ่งใกล้เคียงที่มีอยู่จริงในโลก" ที่ Evidence Agent ค้นเว็บเจอทุกครั้ง —
 *   ถูกเขียนลง connections.json เป็นเชิงอรรถของคำตัดสิน แล้วไม่มีโค้ดใดอ่านมันอีกเลยนอกจาก renderEvidence()
 *   ระบบจึงค้นโลกมาแล้วทิ้งทุกครั้ง และคลังหยุดโตทันทีที่เจ้าของไม่ว่าง
 *
 * ไฟล์นี้ทดสอบพฤติกรรมจริงผ่าน HTTP โดยเขียน "คลังจำลอง" ลงในทรีที่กำลังถูกทดสอบ
 * (DOT_TEST_ROOT ซึ่งเป็นแซนด์บ็อกซ์ ไม่ใช่ความทรงจำจริง) แล้วตรวจว่า:
 *   1. ทุกจุดใน /api/dots มีป้ายที่มา (origin) และระบบอนุมานที่มาของจุดเก่าที่ไม่มีป้ายได้ถูกต้อง
 *   2. /api/scout/candidates เห็น "ของที่เคยค้นเจอแล้วทิ้ง" ทุกชิ้น ตัดวงเล็บอ้างอิงออกเป็นชื่อจุด
 *      และดึง URL ที่ค้นเจอจริงเก็บไว้ พร้อมข้ามชิ้นที่เคยเป็นจุดอยู่แล้ว
 *   3. /api/scout/harvest เปลี่ยนมันเป็นจุดจริงที่เอาไปเชื่อมได้ ติดป้าย source: evidence:<conn-id>
 *      และรันซ้ำไม่เกิดจุดซ้ำ (idempotent)
 *   4. /api/scout/gaps ตั้งชื่อ "โดเมนที่คลังไม่มีตัวแทนเลย" ได้เอง และเขียนคำค้นของตัวเองแบบคงที่
 *   5. สิทธิ์ยับยั้งของเจ้าของทำงานจริง: กดปฏิเสธแล้วจุดหาย และ "หยิบกลับมาไม่ได้อีก"
 *      แม้จะสั่งกู้หลักฐานชิ้นเดิมซ้ำ — รวมถึงการกดลบจุดที่ระบบหามาเองก็นับเป็นการยับยั้ง
 *   6. /api/scout/web มีอยู่จริงและถูกล็อกไว้ในโหมดทดสอบ (503) — ระบบไม่แอบออกเน็ตตอนถูกทดสอบ
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตก: /api/dots ของมันไม่มีสนาม origin เลย และ /api/scout/* ทุกเส้นได้ 404
 *
 * exit 0 = ความรู้ไหลเข้าเองได้แล้วโดยที่คลังยังเป็นของเจ้าของ · exit != 0 = ยังไม่ได้
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
const del = (p) => request("DELETE", p);

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(name);
}

/* ---------- คลังจำลอง: เขียนลงแซนด์บ็อกซ์เท่านั้น แล้วคืนค่าเดิมตอนจบ ---------- */
const MARK = "PROBE_6de88102";
const DOTS_FILE = path.join(ROOT, "data", "dots.json");
const CONN_FILE = path.join(ROOT, "data", "connections.json");
const STATE_FILE = path.join(ROOT, "data", "serendipity.json");

const CONN_ID = "conn_probe6de88102";
// ชิ้นที่ 1: มีวงเล็บอ้างอิงติดมาแบบที่ Evidence Agent เขียนจริง
const FOUND_A = `${MARK} ระบบสะสมความต่อเนื่องรายวันที่รีเซ็ตเมื่อขาดหนึ่งวัน (อ้างอิง: probe-streak.example/how-it-works, probe-habit.example/loop)`;
const FOUND_A_TITLE = `${MARK} ระบบสะสมความต่อเนื่องรายวันที่รีเซ็ตเมื่อขาดหนึ่งวัน`;
const FOUND_A_HOW = `${MARK}_HOWCLOSE ใกล้ตรงที่ใช้การกลัวสูญเสียเป็นเครื่องยนต์ แต่ต่างตรงที่ของเดิมไม่มีการเชื่อมข้ามโดเมน`;
// ชิ้นที่ 2: ไม่มีวงเล็บอ้างอิง
const FOUND_B = `${MARK} ตลาดจับคู่ผู้ผลิตรายย่อยแบบเรียลไทม์`;
const FOUND_B_HOW = `${MARK}_HOWCLOSE2 มีของจริงอยู่แล้วในระดับเมือง แต่ยังไม่มีใครทำข้ามสาขา`;
// ชิ้นที่ 3: ซ้ำกับจุดที่มีอยู่แล้วในคลัง — ต้องไม่ถูกสร้างซ้ำ
const DUP_TITLE = `${MARK} ของเดิมที่เคยถูกเก็บเป็นจุดไปแล้ว`;

const SEED_DOTS = [
  {
    id: "dot_probe_human",
    title: `${MARK} จุดที่เจ้าของพิมพ์เอง`,
    domain: "ศิลปะ",
    content: "จุดของมนุษย์ ไม่มีสนาม origin ติดมา — ระบบต้องอนุมานให้ได้ว่าเป็นของเจ้าของ",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "dot_probe_forge",
    title: `${MARK} จุดที่เกิดจากการหลอมตัวเอง`,
    domain: "ระบบตัวเอง",
    content: "จุดที่ระบบได้มาตอนทำลายกำแพงของตัวเอง — อนุมานจาก source ได้",
    created_at: "2026-01-02T00:00:00.000Z",
    source: "self-forge:evo_probe",
  },
  {
    id: "dot_probe_dup",
    title: DUP_TITLE,
    domain: "โลกภายนอก",
    content: "หลักฐานชิ้นนี้ถูกกู้เป็นจุดไปแล้วในอดีต ระบบต้องไม่กู้ซ้ำ",
    created_at: "2026-01-03T00:00:00.000Z",
    source: "evidence:conn_probe_old",
  },
];

const SEED_CONNS = [
  {
    id: CONN_ID,
    created_at: "2026-02-01T00:00:00.000Z",
    selected_dots: [{ id: "dot_probe_human", title: SEED_DOTS[0].title, domain: "ศิลปะ" }],
    hidden_pattern: `${MARK} รูปแบบจำลอง`,
    connection: `${MARK} การเชื่อมจำลอง`,
    innovation: { name: `${MARK} ไอเดียที่เคยถูกพิสูจน์`, description: "", why_new: "", first_step: "" },
    evidence: {
      created_at: "2026-02-02T00:00:00.000Z",
      novelty: {
        verdict: "similar_exists",
        similar_found: [
          { name: FOUND_A, how_close: FOUND_A_HOW },
          { name: FOUND_B, how_close: FOUND_B_HOW },
          { name: DUP_TITLE, how_close: "ชิ้นนี้เคยถูกกู้เป็นจุดไปแล้ว" },
        ],
        novel_angle: "มุมที่ยังใหม่",
      },
      feasibility: { score: 7, biggest_risk: "-", mitigation: "-" },
      experiment: { design: "-", success_metric: "-", duration: "-" },
      prototype: null,
    },
    outcome: null,
  },
  {
    id: "conn_probe_noevidence",
    created_at: "2026-02-03T00:00:00.000Z",
    selected_dots: [],
    innovation: { name: `${MARK} ไอเดียที่ยังไม่เคยพิสูจน์` },
    evidence: null,
    outcome: null,
  },
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

const dotsBackup = backup(DOTS_FILE);
const connBackup = backup(CONN_FILE);
const stateBackup = backup(STATE_FILE);

function seed() {
  const prevState = JSON.parse(stateBackup || "{}");
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(DOTS_FILE, JSON.stringify(SEED_DOTS, null, 2), "utf8");
  fs.writeFileSync(CONN_FILE, JSON.stringify(SEED_CONNS, null, 2), "utf8");
  // ล้างสถานะ Scout เดิมออก เพื่อให้ผลการทดสอบไม่ขึ้นกับประวัติจริงของเครื่อง
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ ...prevState, scout: {}, log: [], notified_forgotten: [] }, null, 2),
    "utf8"
  );
}

const byId = (list, id) => (Array.isArray(list) ? list.find((d) => d.id === id) : null) || {};
const titles = (list) => (Array.isArray(list) ? list.map((d) => d.title) : []);

(async () => {
  seed();

  /* ---- 1. ทุกจุดต้องบอกได้ว่ามาจากไหน (โค้ดเดิมไม่มีสนามนี้เลย) ---- */
  const d0 = await get("/api/dots");
  const D0 = Array.isArray(d0.json) ? d0.json : [];
  check(
    "GET /api/dots ติดป้ายที่มาให้ทุกจุด (origin + origin_label + self_sourced)",
    d0.status === 200 &&
      D0.length === 3 &&
      D0.every((d) => typeof d.origin === "string" && d.origin && typeof d.origin_label === "string" && typeof d.self_sourced === "boolean"),
    `ได้ ${d0.status} · ${JSON.stringify(D0.map((d) => d.origin))}`
  );
  check(
    "อนุมานที่มาของจุดเก่าที่ไม่มีป้ายได้ถูกต้องทั้งสามแบบ",
    byId(D0, "dot_probe_human").origin === "human" &&
      byId(D0, "dot_probe_forge").origin === "self-forge" &&
      byId(D0, "dot_probe_dup").origin === "scout:evidence",
    `human=${byId(D0, "dot_probe_human").origin} · forge=${byId(D0, "dot_probe_forge").origin} · evidence=${byId(D0, "dot_probe_dup").origin}`
  );
  check(
    "แยกได้ว่าจุดไหน 'ระบบหามาเอง' และจุดไหนเป็นของเจ้าของ",
    byId(D0, "dot_probe_dup").self_sourced === true &&
      byId(D0, "dot_probe_human").self_sourced === false &&
      byId(D0, "dot_probe_forge").self_sourced === false,
    `dup=${byId(D0, "dot_probe_dup").self_sourced} human=${byId(D0, "dot_probe_human").self_sourced}`
  );

  /* ---- 2. หัวใจของรอบนี้: ของที่ระบบเคยค้นเจอแล้วทิ้ง ต้องถูกมองเห็น ---- */
  const cand = await get("/api/scout/candidates");
  const C = cand.json || {};
  const list = Array.isArray(C.candidates) ? C.candidates : [];
  check(
    "GET /api/scout/candidates ตอบ 200 และเห็นหลักฐานที่เคยถูกทิ้ง (โค้ดเดิมได้ 404)",
    cand.status === 200 && C.count === 2 && list.length === 2,
    `ได้ ${cand.status} · เจอ ${list.length} ชิ้น: ${JSON.stringify(titles(list))}`
  );
  const a = list.find((x) => String(x.title).startsWith(FOUND_A_TITLE.slice(0, 40))) || {};
  check(
    "ตัดวงเล็บอ้างอิงออกจากชื่อจุด แล้วเก็บ URL ที่ค้นเจอจริงไว้ต่างหาก",
    a.title === FOUND_A_TITLE &&
      Array.isArray(a.scout && a.scout.references) &&
      a.scout.references.includes("probe-streak.example/how-it-works") &&
      a.scout.references.includes("probe-habit.example/loop"),
    `title="${a.title}" · refs=${JSON.stringify((a.scout || {}).references)}`
  );
  check(
    "ผูกจุดกลับไปยังการเชื่อมที่เป็นต้นทางของหลักฐาน (source: evidence:<conn-id>)",
    a.source === "evidence:" + CONN_ID && a.origin === "scout:evidence" && a.scout.from_connection === CONN_ID,
    `source=${a.source} · origin=${a.origin} · from=${(a.scout || {}).from_connection}`
  );
  check(
    "เนื้อหาของจุดคือคำอธิบายจริงว่าของชิ้นนั้นใกล้เคียงอย่างไร ไม่ใช่ข้อความเปล่า",
    String(a.content || "").includes(`${MARK}_HOWCLOSE`) && String(a.content || "").includes(`${MARK} ไอเดียที่เคยถูกพิสูจน์`),
    String(a.content || "").slice(0, 90)
  );
  check(
    "จัดโดเมนให้จุดที่กู้มาเสมอ (ไม่ปล่อยว่าง) และไม่เดาซี้ซั้วเป็นโดเมนของเจ้าของ",
    typeof a.domain === "string" && a.domain.length > 0 && a.domain !== "ศิลปะ",
    `domain=${a.domain}`
  );
  check(
    "ข้ามหลักฐานชิ้นที่เคยถูกกู้เป็นจุดไปแล้ว (ไม่เสนอซ้ำ)",
    !titles(list).includes(DUP_TITLE),
    `รายการที่เสนอ: ${JSON.stringify(titles(list))}`
  );
  check(
    "ยังมองไม่เห็นการเชื่อมที่ไม่เคยถูกพิสูจน์ (ไม่มีหลักฐานก็ไม่มีอะไรให้กู้)",
    C.searched_connections === 1,
    `นับการเชื่อมที่มีหลักฐาน = ${C.searched_connections}`
  );

  /* ---- 3. กู้จริง: หลักฐานกลายเป็นจุดที่เอาไปเชื่อมได้ และรันซ้ำไม่เกิดจุดซ้ำ ---- */
  const h1 = await post("/api/scout/harvest");
  const H1 = h1.json || {};
  check(
    "POST /api/scout/harvest เปลี่ยนหลักฐานเป็นจุดจริงในคลัง (โค้ดเดิมได้ 404)",
    h1.status === 200 && H1.count === 2 && Array.isArray(H1.created) && H1.created.length === 2,
    `ได้ ${h1.status} · สร้าง ${H1.count} จุด`
  );
  const d1 = await get("/api/dots");
  const D1 = Array.isArray(d1.json) ? d1.json : [];
  const born = D1.find((d) => d.title === FOUND_A_TITLE) || {};
  check(
    "จุดที่กู้มาอยู่ในคลังจริงและใช้งานได้เหมือนจุดอื่น (มีสถิติ HexKern ครบ)",
    D1.length === 5 &&
      born.id &&
      born.origin === "scout:evidence" &&
      born.self_sourced === true &&
      Number.isFinite(born.attention_score) &&
      born.never_connected === true,
    `คลังมี ${D1.length} จุด · attention=${born.attention_score}`
  );
  const h2 = await post("/api/scout/harvest");
  check(
    "สั่งกู้ซ้ำไม่เกิดจุดซ้ำ (idempotent — daemon จึงเรียกได้ทุกรอบโดยไม่ทำคลังบวม)",
    h2.status === 200 && (h2.json || {}).count === 0,
    `รอบสองสร้างเพิ่ม ${(h2.json || {}).count} จุด`
  );
  const d2 = await get("/api/dots");
  check("จำนวนจุดไม่ขยับหลังกู้ซ้ำ", Array.isArray(d2.json) && d2.json.length === 5, `คลังมี ${(d2.json || []).length} จุด`);

  /* ---- 4. ระบบตั้งชื่อช่องว่างของตัวเองและเขียนคำค้นของตัวเองได้ ---- */
  const g1 = await get("/api/scout/gaps");
  const G = g1.json || {};
  const gapNames = (G.gaps || []).map((x) => x.domain);
  check(
    "GET /api/scout/gaps ตอบ 200 พร้อมสำมะโนโดเมนของคลังตัวเอง (โค้ดเดิมได้ 404)",
    g1.status === 200 && Array.isArray(G.census) && G.census.some((c) => c.domain === "ศิลปะ" && c.count === 1),
    `ได้ ${g1.status} · โดเมนในคลัง: ${JSON.stringify((G.census || []).map((c) => c.domain))}`
  );
  check(
    "ระบุ 'โดเมนที่คลังไม่มีตัวแทนเลย' ได้เอง และไม่นับโดเมนที่มีจุดอยู่แล้วเป็นช่องว่าง",
    gapNames.includes("ดนตรี") && gapNames.includes("การเกษตร") && !gapNames.includes("ศิลปะ"),
    `ช่องว่าง ${gapNames.length} โดเมน: ${gapNames.slice(0, 6).join(", ")}…`
  );
  const top = (G.gaps || [])[0] || {};
  check(
    "แต่ละช่องว่างมาพร้อม 'คำค้นที่ระบบเขียนให้ตัวเอง' ซึ่งอ้างถึงโดเมนนั้นจริง",
    typeof top.query === "string" && top.query.length > 20 && top.query.includes(top.domain) && String(top.why || "").includes(top.domain),
    `“${String(top.query || "").slice(0, 80)}”`
  );
  const g2 = await get("/api/scout/gaps");
  check(
    "คำค้นเป็นค่าที่คำนวณได้แน่นอน (ผู้ใช้ตรวจก่อนได้ว่าระบบจะออกไปค้นอะไร)",
    JSON.stringify(((g2.json || {}).gaps || []).map((x) => x.query)) === JSON.stringify((G.gaps || []).map((x) => x.query)),
    "เรียกสองครั้งได้คำค้นชุดเดียวกัน"
  );

  /* ---- 5. สิทธิ์ยับยั้งของเจ้าของ: คลังโตเองได้ แต่ยังเป็นของเจ้าของ ---- */
  const victim = D1.find((d) => d.title === FOUND_A_TITLE) || {};
  const rej = await post("/api/scout/reject", { dotId: victim.id });
  const R = rej.json || {};
  check(
    "POST /api/scout/reject ลบจุดที่ระบบหามาเองได้ (โค้ดเดิมได้ 404)",
    rej.status === 200 && R.rejected === FOUND_A_TITLE && R.vetoed === true,
    `ได้ ${rej.status} · ${JSON.stringify(R.rejected || R.error)}`
  );
  const d3 = await get("/api/dots");
  check(
    "จุดที่ถูกปฏิเสธหายออกจากคลังจริง",
    Array.isArray(d3.json) && d3.json.length === 4 && !titles(d3.json).includes(FOUND_A_TITLE),
    `คลังเหลือ ${(d3.json || []).length} จุด`
  );
  const h3 = await post("/api/scout/harvest");
  const d4 = await get("/api/dots");
  check(
    "★ คำปฏิเสธถูกจำไว้: สั่งกู้หลักฐานชิ้นเดิมอีกกี่ครั้ง ระบบก็หยิบกลับมาไม่ได้",
    h3.status === 200 && (h3.json || {}).count === 0 && !titles(d4.json).includes(FOUND_A_TITLE),
    `กู้ใหม่ได้ ${(h3.json || {}).count} จุด · ยังไม่มีของที่ถูกปฏิเสธกลับมา`
  );

  const st = await get("/api/scout/status");
  const S = st.json || {};
  check(
    "GET /api/scout/status สรุปที่มาของทั้งคลังให้เจ้าของตรวจสอบได้",
    st.status === 200 &&
      S.total_dots === 4 &&
      S.self_sourced === 2 &&
      S.origins &&
      S.origins["scout:evidence"] === 2 &&
      S.origins.human === 1 &&
      S.origins["self-forge"] === 1,
    `ได้ ${st.status} · ${JSON.stringify(S.origins)}`
  );
  check(
    "สถานะรายงานคำปฏิเสธ หลักฐานที่ยังค้าง และคำค้นถัดไปที่ระบบตั้งเอง",
    S.rejected_total === 1 &&
      Array.isArray(S.rejected) &&
      S.rejected[0] &&
      S.rejected[0].title === FOUND_A_TITLE &&
      S.pending_evidence === 0 &&
      typeof S.next_query === "string" &&
      S.next_query.length > 20 &&
      Number.isFinite(S.scout_hours),
    `ปฏิเสธ ${S.rejected_total} · ค้าง ${S.pending_evidence} · ทุก ${S.scout_hours} ชม.`
  );

  /* ---- 6. การลบจุดที่ระบบหามาเอง ก็นับเป็นการยับยั้งเช่นกัน ---- */
  const madeByHand = await request("POST", "/api/dots", {
    title: `${MARK} จุดที่เจ้าของเพิ่มสด ๆ`,
    domain: "ศิลปะ",
    content: "ต้องถูกติดป้ายว่าเป็นของเจ้าของทันทีที่สร้าง",
  });
  check(
    "จุดที่เจ้าของเพิ่มเองถูกติดป้าย human ตั้งแต่ตอนสร้าง",
    madeByHand.status === 201 && (madeByHand.json || {}).origin === "human",
    `ได้ ${madeByHand.status} · origin=${(madeByHand.json || {}).origin}`
  );
  const delHuman = await del("/api/dots/" + (madeByHand.json || {}).id);
  check(
    "ลบจุดของเจ้าของ = ลบเฉย ๆ ไม่ใช่การยับยั้ง (ระบบไม่ขึ้นบัญชีดำความรู้ของเจ้าของ)",
    delHuman.status === 200 && (delHuman.json || {}).deleted === 1 && (delHuman.json || {}).vetoed === false,
    JSON.stringify(delHuman.json)
  );
  const survivor = (d4.json || []).find((d) => String(d.title).startsWith(`${MARK} ตลาดจับคู่`)) || {};
  const delScouted = await del("/api/dots/" + survivor.id);
  check(
    "ลบจุดที่ระบบหามาเอง = การยับยั้ง (ระบบต้องจำ ไม่ใช่แค่ลบ)",
    delScouted.status === 200 && (delScouted.json || {}).vetoed === true && (delScouted.json || {}).origin === "scout:evidence",
    JSON.stringify(delScouted.json)
  );
  const h4 = await post("/api/scout/harvest");
  const d5 = await get("/api/dots");
  check(
    "★ หลังยับยั้งครบทั้งสองชิ้น การกู้หลักฐานไม่คืนอะไรกลับมาอีกเลย",
    h4.status === 200 && (h4.json || {}).count === 0 && (d5.json || []).length === 3,
    `กู้ได้ ${(h4.json || {}).count} จุด · คลังเหลือ ${(d5.json || []).length} จุด`
  );

  /* ---- 7. ประตูออกสู่โลกมีอยู่จริง และถูกล็อกไว้ตอนถูกทดสอบ ---- */
  const web = await post("/api/scout/web", {});
  check(
    "POST /api/scout/web มีอยู่จริงแต่ถูกล็อกในโหมดทดสอบ (503 ไม่ใช่ 404 — และไม่แอบออกเน็ต)",
    web.status === 503,
    `ได้ ${web.status} · ${String((web.json || {}).error || "").slice(0, 60)}`
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
    "/api/evolution/attempted",
  ]) {
    const r = await get(ep);
    check(`endpoint เดิม ${ep} ยังตอบ 200`, r.status === 200, `ได้ ${r.status}`);
  }
})()
  .catch((e) => {
    console.error("✗ ข้อผิดพลาดระหว่างทดสอบ: " + (e && e.stack ? e.stack : e));
    failures.push("exception");
  })
  .finally(() => {
    // คืนความทรงจำจำลองของแซนด์บ็อกซ์กลับให้เหมือนเดิม
    restore(DOTS_FILE, dotsBackup);
    restore(CONN_FILE, connBackup);
    restore(STATE_FILE, stateBackup);
    if (failures.length) {
      console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
      process.exit(1);
    }
    console.log("\n✓ ผ่านทั้งหมด — ความรู้เดินเข้าคลังได้เองแล้ว โดยที่เจ้าของยังมีสิทธิ์ยับยั้งและระบบจำคำยับยั้งนั้นได้");
    process.exit(0);
  });
