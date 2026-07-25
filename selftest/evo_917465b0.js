/*
 * ไฟล์พิสูจน์ (capability proof) — รอบที่ให้ "คลังความรู้" เดินได้สองทิศเหมือนที่โค้ดทำได้แล้ว
 *
 * กำแพงที่ถูกทำลาย: คลังความรู้โตทางเดียว — มีรอบยุบรวมให้โค้ด แต่ไม่มีให้ความรู้
 *   เดิมทุกทางเข้าของจุดเป็นการเพิ่มล้วน ๆ (capture · inbox · harvestEvidenceDots · scoutWeb ·
 *   หนึ่งจุดต่อหนึ่งรอบวิวัฒนาการที่ผ่าน) ทางออกมีทางเดียวคือมนุษย์กด DELETE
 *   และ buildConnectPrompt() ยัด d.content ของ *ทุกจุด* เข้าพรอมป์ตโดยไม่มีเพดาน
 *   จุดที่ระบบเรียกว่า "ถูกลืม" จึงยังถูกอ่านครบทุกตัวอักษรทุกรอบ — พรอมป์ตยาวขึ้นเชิงเส้นตลอดกาล
 *
 * ไฟล์นี้ทดสอบพฤติกรรมจริงผ่าน HTTP โดยเขียน "คลังจำลอง" ลงในทรีที่กำลังถูกทดสอบ
 * (DOT_TEST_ROOT ซึ่งเป็นแซนด์บ็อกซ์ ไม่ใช่ความทรงจำจริง) แล้วตรวจว่า:
 *   1. ระบบมองเห็นน้ำหนักของคลังตัวเอง และหา "จุดที่ซ้ำซ้อน" ได้เองโดยไม่ต้องเรียก AI
 *   2. ฟังก์ชันความเหมาะสมกลับด้านของความรู้มีอยู่จริงและ *ปฏิเสธ* สิ่งที่ต้องปฏิเสธ:
 *      · การเชื่อมที่เคยได้สัญญาณบวกต้องยังอธิบายได้ด้วยคลังที่เล็กลง
 *      · จุดที่ proven ห้ามหายแม้แต่จุดเดียว
 *      · พรอมป์ตเชื่อมจุดต้องสั้นลงจริง (วัดจาก buildConnectPrompt ตัวจริง)
 *   3. การยุบรวมที่ผ่านด่านทำงานจริง: จุดซ้ำซ้อนกลายเป็นจุดหลักการเดียวที่พก id เดิมติดตัวมา
 *   4. จุดเดิมถูกเก็บไว้ทั้งดวงและย้อนกลับได้ (archive เหมือน evolution ledger)
 *   5. พรอมป์ตเลิกโตเชิงเส้น: จุดเพิ่มสามเท่า พรอมป์ตต้องไม่โตตาม
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตก: ไม่มี /api/knowledge/* เลยสักเส้น (404)
 * และ buildConnectPrompt ของมันไม่มีเพดาน — พรอมป์ตโตตามจำนวนจุดแบบหนึ่งต่อหนึ่ง
 *
 * exit 0 = คลังความรู้เดินได้สองทิศจริง · exit != 0 = ยังโตทางเดียว
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

function request(method, pathname, payload, timeout = 30000) {
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

/* ---------- คลังจำลอง: เขียนลงแซนด์บ็อกซ์เท่านั้น แล้วคืนค่าเดิมตอนจบ ---------- */
const MARK = "PROBE_917465b0";
const DOTS_FILE = path.join(ROOT, "data", "dots.json");
const CONN_FILE = path.join(ROOT, "data", "connections.json");
const KN_FILE = path.join(ROOT, "data", "knowledge.json");

const PROVEN = "dot_pr_proven";
const POS = "dot_pr_pos";
const D1 = "dot_pr_dup1";
const D2 = "dot_pr_dup2";
const D3 = "dot_pr_dup3";

// สามจุดที่พูดเรื่องเดียวกันด้วยคำเกือบเดียวกัน — นี่คือหนี้ที่คลังสะสมไว้แล้วไม่เคยจ่าย
const DUP_BODY =
  "ระบบที่ป้อนผลลัพธ์ของตัวเองกลับเข้าไปเป็นข้อมูลเข้าของรอบถัดไป จะค่อย ๆ ปรับน้ำหนักของตัวเองให้เข้าใกล้สิ่งที่ได้ผลจริง " +
  "โดยไม่ต้องมีใครมาบอกว่าอะไรถูก กลไกนี้ทำงานได้ก็ต่อเมื่อสัญญาณที่ป้อนกลับวัดจากผลจริง ไม่ใช่จากความตั้งใจ " +
  "และต้องมีเส้นทางให้สัญญาณเดินกลับถึงจุดที่ตัดสินใจได้ทันก่อนที่การตัดสินใจนั้นจะกลายเป็นอดีตไปแล้ว";

function dot(id, title, domain, content, extra = {}) {
  return {
    id,
    title,
    domain,
    content,
    created_at: "2026-01-05T00:00:00.000Z",
    origin: "human",
    ...extra,
  };
}

const CORE_DOTS = [
  dot(PROVEN, `${MARK} หลักการที่พิสูจน์แล้วว่าให้ผลจริง`, "เศรษฐศาสตร์",
    "การออกแบบแรงจูงใจให้ผลตอบแทนของผู้เล่นแต่ละคนตรงกับผลลัพธ์ของทั้งระบบ ทำให้ไม่ต้องบังคับใครให้ทำสิ่งที่ถูก"),
  dot(POS, `${MARK} จุดที่เคยพาไปทั้งผลบวกและทางตัน`, "ชีววิทยา",
    "ภูมิคุ้มกันจดจำสิ่งแปลกปลอมด้วยการเก็บตัวอย่างไว้ ไม่ใช่การจำเหตุการณ์ทั้งหมด ทำให้ต้นทุนความจำคงที่แม้เจอของใหม่เรื่อย ๆ"),
  dot(D1, `${MARK} ลูปป้อนกลับที่ปรับน้ำหนักตัวเอง`, "ระบบพลวัต", DUP_BODY),
  dot(D2, `${MARK} ลูปป้อนกลับที่ปรับน้ำหนักของตัวเอง`, "ระบบพลวัต", DUP_BODY + " ตัวอย่างที่ชัดที่สุดคือระบบควบคุมอุณหภูมิ"),
  dot(D3, `${MARK} วงจรป้อนกลับที่ปรับน้ำหนักตัวเองได้`, "ไซเบอร์เนติกส์", DUP_BODY + " และเห็นได้ในการเรียนรู้ของสิ่งมีชีวิตเช่นกัน"),
];

// การเชื่อมที่ "ได้ผลจริง" — จุดสองจุดข้างล่างนี้คือสิ่งที่คลังที่เล็กลงต้องยังอธิบายได้
const CONNECTIONS = [
  {
    id: "conn_pr_good",
    created_at: "2026-02-01T00:00:00.000Z",
    focus: null,
    selected_dots: [
      { id: PROVEN, title: CORE_DOTS[0].title, domain: CORE_DOTS[0].domain },
      { id: POS, title: CORE_DOTS[1].title, domain: CORE_DOTS[1].domain },
    ],
    hidden_pattern: `${MARK} รูปแบบร่วม`,
    connection: `${MARK} การเชื่อมที่ได้ผลจริง`,
    innovation: { name: `${MARK} นวัตกรรมที่เอาไปทำจริงแล้ว` },
    evidence: null,
    outcome: { rated_at: "2026-02-02T00:00:00.000Z", rating: 5, status: "shipped", note: `${MARK} ได้ผลจริง` },
  },
  {
    // การเชื่อมที่ตายแล้ว มีไว้เพื่อกด value_score ของ POS ให้เป็นกลาง
    // จุดนั้นจึง "ไม่ proven" แต่ยังอยู่ในการเชื่อมที่ได้สัญญาณบวก — แยกด่านที่ 1 ออกจากด่านที่ 2 ได้
    id: "conn_pr_dead",
    created_at: "2026-02-03T00:00:00.000Z",
    focus: null,
    selected_dots: [{ id: POS, title: CORE_DOTS[1].title, domain: CORE_DOTS[1].domain }],
    hidden_pattern: `${MARK} ทางตัน`,
    connection: `${MARK} การเชื่อมที่ตายแล้ว`,
    innovation: { name: `${MARK} ไอเดียที่ตายแล้ว` },
    evidence: null,
    outcome: { rated_at: "2026-02-04T00:00:00.000Z", rating: 1, status: "dead", note: `${MARK} ไม่ได้ผล` },
  },
];

function filler(i) {
  return dot(
    `dot_pr_fill${i}`,
    `${MARK} จุดเติมหมายเลข ${i}`,
    `สาขาที่ ${i % 7}`,
    `รายละเอียดของจุดเติมหมายเลข ${i} ซึ่งถูกเขียนให้ยาวพอจะเห็นผลของเพดานพรอมป์ตอย่างชัดเจน ` +
      `หัวข้อย่อยที่ ${i} ว่าด้วยกลไกเฉพาะตัวหมายเลข ${i} ที่ไม่ซ้ำกับจุดอื่น ` +
      `พร้อมคำอธิบายเพิ่มเติมชุดที่ ${i} เพื่อให้เนื้อหาของจุดนี้ยาวเกินเพดานต่อจุด ` +
      `และรายละเอียดปลีกย่อยลำดับที่ ${i} ที่ไม่มีวันถูกอ่านจริงในรอบเชื่อมจุด ` +
      `ต่อด้วยส่วนขยายที่ ${i} ซึ่งมีไว้เพื่อกินที่ในพรอมป์ตล้วน ๆ ` +
      `แล้วตามด้วยข้อสังเกตชุดที่ ${i} ที่ไม่มีความหมายกับการเชื่อมจุดใด ๆ แต่ยังถูกอ่านครบทุกรอบในโค้ดเดิม ` +
      `และปิดท้ายด้วยหมายเหตุที่ ${i} ที่ยาวจนแน่ใจว่าเนื้อหาของจุดนี้เกินเพดานต่อจุดไปแล้วอย่างแน่นอน`
  );
}

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
function writeDots(list) {
  fs.writeFileSync(DOTS_FILE, JSON.stringify(list, null, 2), "utf8");
}

const dotsBackup = backup(DOTS_FILE);
const connBackup = backup(CONN_FILE);
const knBackup = backup(KN_FILE);

(async () => {
  writeDots(CORE_DOTS);
  fs.writeFileSync(CONN_FILE, JSON.stringify(CONNECTIONS, null, 2), "utf8");
  restore(KN_FILE, null);

  /* ---- 1. ระบบมองเห็นน้ำหนักของคลังตัวเอง และหาจุดซ้ำซ้อนได้เองโดยไม่ใช้ AI ---- */
  const pv = await get("/api/knowledge/preview");
  const P = pv.json || {};
  check(
    "GET /api/knowledge/preview ตอบ 200 พร้อมน้ำหนักของคลัง (โค้ดเดิมได้ 404 เพราะไม่มีทิศทางที่สองของความรู้เลย)",
    pv.status === 200 && P.metrics && Number.isFinite(P.metrics.dots) && Number.isFinite(P.metrics.prompt_chars),
    `ได้ ${pv.status} · ${P.metrics ? `${P.metrics.dots} จุด · พรอมป์ต ${P.metrics.prompt_chars} ตัวอักษร` : "(ไม่มี metrics)"}`
  );
  const dupCluster = (P.clusters || []).find(
    (c) => c.dot_ids.includes(D1) && c.dot_ids.includes(D2) && c.dot_ids.includes(D3)
  );
  check(
    "ระบบหา 'จุดที่ซ้ำซ้อน' ของตัวเองเจอโดยไม่ต้องเรียก AI",
    Boolean(dupCluster) && dupCluster.dot_ids.length === 3,
    dupCluster ? `คลัสเตอร์ ${dupCluster.dot_ids.length} จุด · ความคล้าย ${dupCluster.pairs.map((x) => x.similarity).join(", ")}` : "ไม่พบคลัสเตอร์ของจุดซ้ำ"
  );
  check(
    "ระบบชี้จุดที่ 'ห้ามยุบรวมเด็ดขาด' ได้เอง (จุดที่พิสูจน์แล้วว่าให้ผลจริง)",
    P.protected && (P.protected.proven || []).some((d) => d.id === PROVEN) && !(P.protected.proven || []).some((d) => d.id === POS),
    `proven: ${JSON.stringify((P.protected || {}).proven || [])}`
  );
  const promptBefore = P.metrics ? P.metrics.prompt_chars : 0;

  /* ---- 2. ฟังก์ชันความเหมาะสมกลับด้าน: ต้องปฏิเสธสิ่งที่ต้องปฏิเสธ ---- */
  const goodCluster = {
    dot_ids: [D1, D2, D3],
    title: `${MARK} หลักการ: ลูปป้อนกลับที่ปรับน้ำหนักตัวเอง`,
    domain: "ระบบพลวัต",
    content: "ระบบใดก็ตามที่วัดผลของตัวเองแล้วป้อนผลนั้นกลับเข้าไปเปลี่ยนน้ำหนักของรอบถัดไป จะไต่เข้าหาสิ่งที่ได้ผลจริงเองโดยไม่ต้องมีผู้ตัดสินจากภายนอก",
    principle: "ทั้งสามจุดพูดถึงกลไกเดียวกันด้วยคำต่างกัน",
  };
  const dryGood = await post("/api/knowledge/dryrun", { clusters: [goodCluster] });
  const G = dryGood.json || {};
  check(
    "POST /api/knowledge/dryrun เรียกฟังก์ชันความเหมาะสมกลับด้านได้โดยไม่เสียรอบ AI และไม่แตะคลัง",
    dryGood.status === 200 && G.gates && G.gates.coverage && G.gates.proven_kept && G.gates.shrunk,
    `ได้ ${dryGood.status} · ด่าน: ${Object.keys((G.gates || {})).join(", ") || "(ไม่มี)"}`
  );
  check(
    "แผนยุบรวมที่ถูกต้อง ผ่านทั้งสามด่าน และพรอมป์ตสั้นลงจริงตามตัวเลข",
    G.ok === true && G.metrics.prompt_delta < 0 && G.metrics.dots_delta === -2,
    `ok=${G.ok} · จุด ${G.metrics ? G.metrics.dots_delta : "?"} · พรอมป์ต ${G.metrics ? G.metrics.prompt_delta : "?"} ตัวอักษร`
  );

  const provenEating = await post("/api/knowledge/dryrun", {
    clusters: [{ ...goodCluster, dot_ids: [PROVEN, D1, D2] }],
  });
  const PE = provenEating.json || {};
  check(
    "ด่านที่ 2: แผนที่กลืนจุด proven ถูกปฏิเสธ (และปฏิเสธด้วยเหตุผลนั้นจริง ๆ ไม่ใช่ด่านอื่น)",
    provenEating.status === 200 &&
      PE.ok === false &&
      PE.gates.proven_kept.ok === false &&
      PE.gates.coverage.ok === true &&
      (PE.gates.proven_kept.lost || []).some((d) => d.id === PROVEN),
    `ok=${PE.ok} · proven_kept=${PE.gates ? PE.gates.proven_kept.ok : "?"} · coverage=${PE.gates ? PE.gates.coverage.ok : "?"} · ${PE.gates ? PE.gates.proven_kept.detail : ""}`
  );

  const orphaned = await post("/api/knowledge/dryrun", {
    before: CORE_DOTS,
    after: CORE_DOTS.filter((d) => d.id !== POS),
  });
  const O = orphaned.json || {};
  check(
    "ด่านที่ 1: จุดที่หายไปเฉย ๆ โดยไม่ถูกดูดเข้าจุดหลักการ ทำให้การเชื่อมที่เคยได้ผลจริงอธิบายไม่ได้ → ปฏิเสธ",
    orphaned.status === 200 &&
      O.ok === false &&
      O.gates.coverage.ok === false &&
      O.gates.proven_kept.ok === true &&
      (O.gates.coverage.orphans || []).some((x) => x.dot_id === POS),
    `coverage=${O.gates ? O.gates.coverage.ok : "?"} · ${O.gates ? O.gates.coverage.detail : ""}`
  );

  const noChange = await post("/api/knowledge/dryrun", { before: CORE_DOTS, after: CORE_DOTS });
  const N = noChange.json || {};
  check(
    "ด่านที่ 3: คลังที่ไม่ได้เล็กลงเลยไม่นับเป็นรอบยุบรวม",
    noChange.status === 200 && N.ok === false && N.gates.shrunk.ok === false && N.gates.coverage.ok === true,
    N.gates ? N.gates.shrunk.detail : `ได้ ${noChange.status}`
  );

  /* ---- 3. ด่านถูกบังคับใช้บนเส้นทางจริง ไม่ใช่แค่ในโหมดลอง ---- */
  const badMerge = await post("/api/knowledge/merge", {
    clusters: [{ ...goodCluster, dot_ids: [PROVEN, D1, D2] }],
  });
  const afterBad = await get("/api/dots");
  const idsAfterBad = new Set((afterBad.json || []).map((d) => d.id));
  check(
    "การยุบรวมจริงที่ตกด่าน ถูกปฏิเสธและไม่ขยับจุดแม้แต่จุดเดียว",
    badMerge.status === 400 &&
      (badMerge.json || {}).applied === false &&
      idsAfterBad.has(PROVEN) &&
      idsAfterBad.has(D1) &&
      idsAfterBad.has(D2) &&
      (afterBad.json || []).length === CORE_DOTS.length,
    `ได้ ${badMerge.status} · คลังยังมี ${(afterBad.json || []).length} จุด`
  );

  const merge = await post("/api/knowledge/merge", { clusters: [goodCluster], note: `${MARK} รอบทดสอบ` });
  const M = merge.json || {};
  check(
    "POST /api/knowledge/merge ยุบรวมจุดซ้ำซ้อนสามจุดเป็นจุดหลักการเดียวได้จริง",
    merge.status === 200 && M.applied === true && M.verdict === "accepted" && M.round && M.round.id,
    `ได้ ${merge.status} · ${M.reason || M.error || ""}`.slice(0, 160)
  );

  const afterMerge = await get("/api/dots");
  const dots2 = afterMerge.json || [];
  const principle = dots2.find((d) => d.origin === "distill");
  check(
    "คลังเล็กลงจริง และจุดเดิมทั้งสามหายไปจากคลัง",
    dots2.length === CORE_DOTS.length - 2 && ![D1, D2, D3].some((id) => dots2.some((d) => d.id === id)),
    `${CORE_DOTS.length} → ${dots2.length} จุด`
  );
  check(
    "จุดหลักการที่มาแทน พก id ของจุดเดิมทั้งสามติดตัวมาด้วย (จึงยังชี้กลับได้ว่าความรู้เดิมไปอยู่ไหน)",
    Boolean(principle) &&
      principle.absorbed_count === 3 &&
      [D1, D2, D3].every((id) => (principle.distilled.absorbed || []).some((a) => a.id === id)) &&
      principle.origin_label.length > 0,
    principle ? `${principle.title} · ดูดมา ${principle.absorbed_count} จุด · ${principle.origin_label}` : "ไม่พบจุดหลักการ"
  );
  check(
    "จุดที่ proven และจุดที่การเชื่อมเชิงบวกใช้ ยังอยู่ครบทั้งคู่",
    dots2.some((d) => d.id === PROVEN) && dots2.some((d) => d.id === POS),
    `proven=${dots2.some((d) => d.id === PROVEN)} · pos=${dots2.some((d) => d.id === POS)}`
  );

  const pv2 = await get("/api/knowledge/preview");
  const P2 = pv2.json || {};
  check(
    "พรอมป์ตเชื่อมจุดที่ระบบวัดเองสั้นลงจริงหลังยุบรวม",
    pv2.status === 200 && P2.metrics.prompt_chars < promptBefore,
    `${promptBefore} → ${P2.metrics ? P2.metrics.prompt_chars : "?"} ตัวอักษร`
  );

  /* ---- 4. ย้อนกลับได้เหมือน evolution ledger ---- */
  const arch = await get("/api/knowledge/archive");
  const A = arch.json || {};
  const roundRow = (A.rounds || []).find((r) => r.id === M.round.id);
  check(
    "GET /api/knowledge/archive มีรอบนี้อยู่ พร้อมจำนวนจุดเดิมที่เก็บไว้ และบอกว่าย้อนกลับได้",
    arch.status === 200 && roundRow && roundRow.archived_dots === 3 && roundRow.restorable === true,
    roundRow ? `${roundRow.id} · เก็บจุดเดิม ${roundRow.archived_dots} จุด` : `ได้ ${arch.status}`
  );
  const full = await get("/api/knowledge/archive?roundId=" + encodeURIComponent(M.round.id));
  const F = full.json || {};
  check(
    "จุดเดิมถูกเก็บไว้ 'ทั้งดวง' ไม่ใช่แค่ชื่อ (เนื้อหาเดิมครบทุกตัวอักษร)",
    full.status === 200 &&
      (F.archived || []).length === 3 &&
      (F.archived || []).some((d) => d.id === D1 && d.content === CORE_DOTS[2].content),
    `เก็บไว้ ${(F.archived || []).length} จุด`
  );

  const restored = await post("/api/knowledge/restore", { roundId: M.round.id });
  const afterRestore = await get("/api/dots");
  const dots3 = afterRestore.json || [];
  const d1back = dots3.find((d) => d.id === D1);
  check(
    "POST /api/knowledge/restore คืนจุดเดิมกลับมาครบและถอนจุดหลักการออก — การยุบรวมไม่ใช่ประตูทางเดียว",
    restored.status === 200 &&
      dots3.length === CORE_DOTS.length &&
      [D1, D2, D3].every((id) => dots3.some((d) => d.id === id)) &&
      !dots3.some((d) => d.id === principle.id) &&
      d1back &&
      d1back.content === CORE_DOTS[2].content,
    `ได้ ${restored.status} · คลังกลับมา ${dots3.length} จุด`
  );

  /* ---- 5. หัวใจของกำแพง: พรอมป์ตต้องเลิกโตเชิงเส้นตามจำนวนจุด ---- */
  writeDots([...CORE_DOTS, ...Array.from({ length: 55 }, (_, i) => filler(i))]);
  const small = await get("/api/knowledge/preview");
  writeDots([...CORE_DOTS, ...Array.from({ length: 175 }, (_, i) => filler(i))]);
  const big = await get("/api/knowledge/preview");
  const S = (small.json || {}).metrics || {};
  const B = (big.json || {}).metrics || {};
  const ratio = S.prompt_chars ? B.prompt_chars / S.prompt_chars : 99;
  check(
    "จุดในคลังเพิ่มขึ้น 3 เท่า แต่พรอมป์ตไม่ได้โตตาม (โค้ดเดิมโตแบบหนึ่งต่อหนึ่งเสมอ)",
    small.status === 200 && big.status === 200 && S.dots === 60 && B.dots === 180 && ratio < 2,
    `${S.dots} จุด → ${S.prompt_chars} ตัวอักษร · ${B.dots} จุด → ${B.prompt_chars} ตัวอักษร · โตขึ้น ${Math.round(ratio * 100) / 100} เท่า (เชิงเส้นคือ 3 เท่า)`
  );
  check(
    "ระบบวัดได้เองว่าเพดานพรอมป์ตประหยัดไปเท่าไหร่ และยังคงเลือกจุดจากดัชนีได้ทุกจุด",
    B.full_dots > 0 && B.indexed_dots > 0 && B.full_dots + B.indexed_dots === B.dots && B.unbudgeted_chars > B.budgeted_chars * 1.5,
    `แสดงเต็ม ${B.full_dots} · ย่อเป็นดัชนี ${B.indexed_dots} · ถ้าไม่มีเพดานจะกิน ${B.unbudgeted_chars} แทน ${B.budgeted_chars} ตัวอักษร`
  );

  /* ---- 6. ความสามารถเดิมต้องครบ ---- */
  for (const ep of [
    "/api/dots",
    "/api/connections",
    "/api/limits",
    "/api/self",
    "/api/evolution",
    "/api/forgotten",
    "/api/serendipity/status",
    "/api/lessons",
    "/api/scout/status",
    "/api/scout/gaps",
    "/api/consolidation/preview",
    "/api/endpoints",
    "/api/forge/preview",
    "/api/forge/loop",
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
    restore(KN_FILE, knBackup);
    if (failures.length) {
      console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
      process.exit(1);
    }
    console.log("\n✓ ผ่านทั้งหมด — คลังความรู้เดินได้สองทิศแล้ว: ยุบรวมได้โดยพิสูจน์ได้ ย้อนกลับได้ และพรอมป์ตเลิกโตเชิงเส้น");
    process.exit(0);
  });
