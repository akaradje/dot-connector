/*
 * ไฟล์พิสูจน์ (capability proof) — รอบที่ต่อ "ความจำของความล้มเหลว" ให้ระบบ
 *
 * กำแพงที่ถูกทำลาย: รอบที่ล้มเหลวถูกลบทิ้งพร้อมบทเรียน — ลองสามครั้งเหมือนครั้งแรกทุกครั้ง
 *   เดิม buildForgePrompt(limit, body, evoId) ไม่รับประวัติความล้มเหลวเข้าไปเลย
 *   รอบที่ 2 จึงไม่มีทางรู้ว่ารอบที่ 1 ตกตรงไหน · restoreBackup() ลบโค้ดที่ตกทิ้งหมด
 *   และเพดาน (l.attempts || 0) < 3 เป็นค่าคงที่ ตัดสิทธิ์กำแพงถาวรจากความผิดพลาดซ้ำ ๆ แบบเดิม
 *
 * ไฟล์นี้ทดสอบพฤติกรรมจริงผ่าน HTTP โดยเขียน "ประวัติจำลอง" ลงในทรีที่กำลังถูกทดสอบ
 * (DOT_TEST_ROOT ซึ่งเป็นแซนด์บ็อกซ์ ไม่ใช่ความทรงจำจริง) แล้วตรวจว่า:
 *   1. GET /api/forge/preview คืน "พรอมป์ตจริงที่รอบถัดไปจะได้อ่าน" และในนั้นมี
 *      เหตุผลที่ตก + ด่านที่ไม่ผ่านแบบเจาะจง + สรุปไฟล์ที่เคยลอง + พาธของโค้ดที่ตก
 *      + คำสั่งห้ามใช้วิธีเดิมซ้ำ — ครบทุกรอบที่เคยล้มเหลวกับกำแพงนั้น
 *   2. GET /api/evolution/attempted อ่านโค้ดของรอบที่ถูกย้อนกลับได้จริง (ไม่ถูกลบทิ้งอีกต่อไป)
 *   3. เพดาน 3 ครั้งกลายเป็นเพดานที่ขยับได้: กำแพงที่ตก 3 ครั้งด้วย "วิธีเดียวกัน" ตัน (cap 3)
 *      แต่กำแพงที่ตก 3 ครั้งด้วย "วิธีที่ต่างกันจริง 3 แบบ" ได้เพดาน 5 และยังถูกเลือกเป็นเป้าหมายถัดไป
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตก: ไม่มี /api/forge/preview และ /api/evolution/attempted (404)
 * และ /api/limits ของมันไม่มีสนาม attempt_cap / attempts_left / exhausted เลย
 *
 * exit 0 = ความจำของความล้มเหลวมีจริงและถูกส่งต่อ · exit != 0 = ไม่มี
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

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(name);
}

/* ---------- ประวัติจำลอง: เขียนลงแซนด์บ็อกซ์เท่านั้น แล้วคืนค่าเดิมตอนจบ ---------- */
const MARK = "PROBE_b8abecbd";
const SAME_ID = "lim_probe_same";   // ตก 3 ครั้งด้วยวิธีเดียวกัน → เพดานไม่ขยับ
const DIFF_ID = "lim_probe_diff";   // ตก 3 ครั้งด้วยวิธีที่ต่างกันจริง → เพดานขยับ
const LIMITS_FILE = path.join(ROOT, "data", "limits.json");
const EVO_FILE = path.join(ROOT, "data", "evolution.json");

const limitBase = {
  description: "กำแพงจำลองสำหรับตรวจว่าเพดานการลองขยับตามความต่างของวิธีจริงหรือไม่",
  evidence: "server.js: attemptBudget / selectTarget",
  why_it_stands: "เพดานเดิมเป็นค่าคงที่ 3",
  break_idea: "ทำให้เพดานเป็นงบประมาณที่กำแพงหามาได้เอง",
  status: "standing",
  found_at: "2026-01-01T00:00:00.000Z",
};
const PROBE_LIMITS = [
  { ...limitBase, id: SAME_ID, title: `${MARK} กำแพงที่ถูกลองด้วยวิธีเดิมซ้ำสามครั้ง`, category: "autonomy", unlock_score: 10, risk: 0, attempts: 3 },
  { ...limitBase, id: DIFF_ID, title: `${MARK} กำแพงที่ถูกลองด้วยสามวิธีที่ต่างกันจริง`, category: "autonomy", unlock_score: 9, risk: 0, attempts: 3 },
];

// วิธีเดิมเป๊ะ ๆ ทั้งชุดไฟล์และคำอธิบาย → ระบบต้องนับเป็น "วิธีเดียว"
const SAME_APPROACH = `${MARK} แก้ server.js ให้เพิ่มตัวแปรนับรอบแล้วหวังว่ามันจะพอ`;
function sameRound(n) {
  return {
    id: `evo_probesame${n}`,
    at: `2026-02-0${n}T00:00:00.000Z`,
    limit: { id: SAME_ID, title: PROBE_LIMITS[0].title, category: "autonomy" },
    report: { broke_it: true, summary: SAME_APPROACH, what_changed: [`server.js: ${MARK} เพิ่มตัวแปรนับรอบ`] },
    files: [{ path: "server.js", action: "modified", lines: 10 }],
    checks: { proof_written: true, syntax: true, smoke: true, capability: false, capability_detail: `${MARK}_SAMEGATE ไฟล์พิสูจน์ตกกับโค้ดใหม่` },
    verdict: "rejected",
    reason: `${MARK} ความสามารถใหม่พิสูจน์ไม่ผ่าน — ย้อนกลับอัตโนมัติแล้ว`,
  };
}

// สามวิธีที่ต่างกันจริง: คนละชุดไฟล์ คนละกลไก และตกคนละด่าน
const DIFF_ROUNDS = [
  {
    id: "evo_probe1",
    at: "2026-03-01T00:00:00.000Z",
    limit: { id: DIFF_ID, title: PROBE_LIMITS[1].title, category: "autonomy" },
    report: {
      broke_it: true,
      summary: `${MARK}_R1 เก็บบทเรียนไว้ในหน่วยความจำของโปรเซสแล้วส่งต่อผ่านตัวแปรส่วนกลาง`,
      what_changed: [`server.js: ${MARK}_R1 เพิ่มตัวแปรส่วนกลางเก็บบทเรียน`],
      new_capability: `${MARK}_R1 รอบถัดไปอ่านบทเรียนจากตัวแปรส่วนกลาง`,
    },
    files: [{ path: "server.js", action: "modified", lines: 42 }],
    checks: { proof_written: true, syntax: true, smoke: true, capability: false, capability_detail: `${MARK}_GATE1 ไฟล์พิสูจน์ตกกับโค้ดใหม่ เพราะบทเรียนหายไปเมื่อรีสตาร์ต` },
    verdict: "rejected",
    reason: `${MARK}_R1 ความสามารถใหม่พิสูจน์ไม่ผ่าน — ย้อนกลับอัตโนมัติแล้ว`,
    attempted: "evolution/backups/evo_probe1/attempted",
  },
  {
    id: "evo_probe2",
    at: "2026-03-02T00:00:00.000Z",
    limit: { id: DIFF_ID, title: PROBE_LIMITS[1].title, category: "autonomy" },
    report: {
      broke_it: true,
      summary: `${MARK}_R2 แสดงบทเรียนบนหน้าเว็บอย่างเดียว ไม่ได้ส่งเข้าพรอมป์ตจริง`,
      what_changed: [`public/index.html: ${MARK}_R2 เพิ่มแผงแสดงบทเรียน`],
      new_capability: `${MARK}_R2 ผู้ใช้เห็นบทเรียนบนหน้าเว็บ`,
    },
    files: [{ path: "public/index.html", action: "modified", lines: 88 }],
    checks: { proof_written: true, syntax: true, smoke: true, capability: true, differential: false, differential_detail: `${MARK}_GATE2 ไฟล์พิสูจน์ผ่านกับโค้ดเดิมด้วย — กำแพงไม่ได้ถูกทำลายจริง` },
    verdict: "rejected",
    reason: `${MARK}_R2 พิสูจน์ไม่ได้ว่าโค้ดเดิมทำไม่ได้ — ย้อนกลับอัตโนมัติแล้ว`,
    attempted: "evolution/backups/evo_probe2/attempted",
  },
  {
    id: "evo_probe3",
    at: "2026-03-03T00:00:00.000Z",
    limit: { id: DIFF_ID, title: PROBE_LIMITS[1].title, category: "autonomy" },
    report: {
      broke_it: true,
      summary: `${MARK}_R3 เขียนบทเรียนลงไฟล์ใหม่นอก data/ แล้วรื้อเส้นทาง endpoint เดิมทิ้ง`,
      what_changed: [`README.md: ${MARK}_R3 อธิบายรูปแบบไฟล์ใหม่`, `server.js: ${MARK}_R3 ย้ายเส้นทาง endpoint`],
      new_capability: `${MARK}_R3 บทเรียนอยู่ในไฟล์ถาวร`,
    },
    files: [
      { path: "README.md", action: "modified", lines: 20 },
      { path: "server.js", action: "modified", lines: 130 },
    ],
    checks: { proof_written: true, syntax: true, smoke: true, capability: true, differential: true, regression: false, regression_detail: `${MARK}_GATE3 endpoint เดิมที่พัง: /api/lessons → 404` },
    verdict: "rejected",
    reason: `${MARK}_R3 ความสามารถเดิมพัง — ย้อนกลับอัตโนมัติแล้ว`,
    attempted: "evolution/backups/evo_probe3/attempted",
  },
];

const ATTEMPTED_CODE = `// ${MARK}_ATTEMPTED_CODE — โค้ดของรอบที่ถูกตีตกแล้วย้อนกลับ แต่ยังต้องอ่านย้อนหลังได้\nconst lessons = [];\n`;

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

function seed() {
  const ledger = JSON.parse(evoBackup || "[]");
  const probes = [sameRound(1), sameRound(2), sameRound(3), ...DIFF_ROUNDS];
  fs.writeFileSync(LIMITS_FILE, JSON.stringify(PROBE_LIMITS, null, 2), "utf8");
  fs.writeFileSync(EVO_FILE, JSON.stringify([...probes, ...(Array.isArray(ledger) ? ledger : [])], null, 2), "utf8");
  // โค้ดของรอบที่ตก ที่ระบบเก่าจะลบทิ้งไปแล้ว
  for (const r of DIFF_ROUNDS) {
    const dir = path.join(ROOT, "evolution", "backups", r.id, "attempted");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "server.js"), ATTEMPTED_CODE, "utf8");
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify([{ path: "server.js", action: "modified", saved: true }], null, 2),
      "utf8"
    );
  }
}

(async () => {
  seed();

  /* ---- 1. ทะเบียนขอบเขตต้องบอกงบการลองของตัวเอง (โค้ดเดิมไม่มีสนามเหล่านี้เลย) ---- */
  const limitsRes = await get("/api/limits");
  const L = Array.isArray(limitsRes.json) ? limitsRes.json : [];
  const same = L.find((l) => l.id === SAME_ID) || {};
  const diff = L.find((l) => l.id === DIFF_ID) || {};
  check(
    "GET /api/limits บอกเพดานการลองของแต่ละกำแพง (attempt_cap / attempts_left / exhausted)",
    limitsRes.status === 200 &&
      Number.isFinite(same.attempt_cap) &&
      Number.isFinite(same.attempts_left) &&
      typeof same.exhausted === "boolean",
    `ได้ ${limitsRes.status} · ${JSON.stringify({ cap: same.attempt_cap, left: same.attempts_left, exhausted: same.exhausted })}`
  );
  check(
    "กำแพงที่ถูกลองด้วยวิธีเดิมซ้ำ 3 ครั้ง: เพดานยังเป็น 3 และตันจริง",
    same.attempt_cap === 3 && same.attempts_left === 0 && same.exhausted === true && same.distinct_approaches === 1,
    `cap=${same.attempt_cap} left=${same.attempts_left} exhausted=${same.exhausted} distinct=${same.distinct_approaches}`
  );
  check(
    "กำแพงที่ถูกลองด้วย 3 วิธีที่ต่างกันจริง: เพดานขยับเป็น 5 และยังไปต่อได้",
    diff.attempt_cap === 5 && diff.attempts_left === 2 && diff.exhausted === false && diff.distinct_approaches === 3 && diff.cap_earned === 2,
    `cap=${diff.attempt_cap} left=${diff.attempts_left} distinct=${diff.distinct_approaches} earned=${diff.cap_earned}`
  );
  check(
    "ทุกกำแพงพกประวัติรอบที่ตกติดตัวมาด้วย พร้อมด่านที่ไม่ผ่าน",
    Array.isArray(diff.failed_attempts) &&
      diff.failed_attempts.length === 3 &&
      diff.failed_attempts.every((f) => f.evo_id && f.reason && Array.isArray(f.failed_gates) && f.failed_gates.length > 0),
    JSON.stringify((diff.failed_attempts || []).map((f) => `${f.evo_id}:${f.failed_gates}`))
  );

  /* ---- 2. หัวใจของรอบนี้: พรอมป์ตของรอบถัดไปต้องมีประวัติความล้มเหลวอยู่จริง ---- */
  const pv = await get("/api/forge/preview?limitId=" + DIFF_ID);
  const P = pv.json || {};
  const head = String(P.prompt_head || "");
  check(
    "GET /api/forge/preview ตอบ 200 พร้อมพรอมป์ตจริงที่รอบถัดไปจะได้อ่าน (โค้ดเดิมได้ 404)",
    pv.status === 200 && head.length > 0 && Number.isFinite(P.prompt_chars),
    `ได้ ${pv.status} · prompt_head ${head.length} ตัวอักษร · พรอมป์ตเต็ม ${P.prompt_chars} ตัวอักษร`
  );
  check(
    "พรอมป์ตนั้นเป็นพรอมป์ตหลอมตัวเองจริง (ส่วนหัวคือขอบเขตที่ต้องทำลาย และมีซอร์สโค้ดต่อท้ายอีกมหาศาล)",
    /ขอบเขตที่ต้องทำลายในรอบนี้/.test(head) && P.prompt_chars > head.length + 10000,
    `หัว ${head.length} · เต็ม ${P.prompt_chars}`
  );

  const reasonsIn = [`${MARK}_R1`, `${MARK}_R2`, `${MARK}_R3`].filter((m) => head.includes(m));
  check(
    "เหตุผลที่แต่ละรอบตก ถูกส่งเข้าพรอมป์ตครบทั้ง 3 รอบ",
    reasonsIn.length === 3,
    `พบ ${reasonsIn.join(", ") || "(ไม่พบเลย)"}`
  );
  const gatesIn = [`${MARK}_GATE1`, `${MARK}_GATE2`, `${MARK}_GATE3`].filter((m) => head.includes(m));
  check(
    "ผลของ 'ด่านที่ไม่ผ่าน' แบบเจาะจง (ข้อความจริงของด่าน) ถูกส่งเข้าพรอมป์ตครบทุกรอบ",
    gatesIn.length === 3,
    `พบ ${gatesIn.join(", ") || "(ไม่พบเลย)"}`
  );
  check(
    "สรุป diff ของโค้ดที่เคยลอง (ไฟล์ + จำนวนบรรทัด) อยู่ในพรอมป์ต",
    /public\/index\.html/.test(head) && /README\.md/.test(head) && /บรรทัด/.test(head),
    head.includes("public/index.html") ? "พบรายการไฟล์ที่เคยแตะ" : "ไม่พบรายการไฟล์"
  );
  check(
    "พรอมป์ตชี้พาธของโค้ดที่ตกไว้ให้รอบถัดไปเปิดอ่านได้",
    head.includes("evolution/backups/evo_probe1/attempted") &&
      head.includes("evolution/backups/evo_probe3/attempted"),
    "ต้องมี evolution/backups/<evoId>/attempted/ ของทุกรอบที่ตก"
  );
  check(
    "พรอมป์ตสั่งชัดว่าห้ามใช้วิธีเดิมซ้ำ และบังคับให้บอกว่ารอบนี้ต่างจากเดิมอย่างไร",
    head.includes("ห้ามใช้วิธีเดิมซ้ำ") && head.includes("differs_from_previous"),
    "ตรวจคำสั่งบังคับในบล็อกประวัติ"
  );
  check(
    "preview รายงานงบการลองที่ตรงกับทะเบียนขอบเขต",
    P.budget && P.budget.cap === 5 && P.budget.left === 2 && P.budget.distinct_approaches === 3 && P.blocked === false,
    JSON.stringify(P.budget || {})
  );
  check(
    "preview คืนประวัติเป็นข้อมูลมีโครงสร้าง เรียงจากรอบเก่าไปใหม่",
    Array.isArray(P.history) &&
      P.history.length === 3 &&
      P.history[0].evo_id === "evo_probe1" &&
      P.history[2].evo_id === "evo_probe3" &&
      P.history[0].failed_gates.some((g) => String(g.detail).includes(`${MARK}_GATE1`)),
    (P.history || []).map((h) => h.evo_id).join(" → ")
  );

  /* ---- 3. เพดานที่ขยับได้ต้องเปลี่ยน "ใครคือเป้าหมายถัดไป" จริง ๆ ---- */
  const next = await get("/api/forge/preview");
  const N = next.json || {};
  check(
    "กำแพงที่ตันเพราะทำซ้ำวิธีเดิม ถูกข้าม แม้จะมีคะแนนปลดล็อกสูงกว่า",
    next.status === 200 && N.target && N.target.id === DIFF_ID,
    `เป้าหมายถัดไป: ${N.target ? N.target.id : "(ไม่มี)"} (คาดว่า ${DIFF_ID} เพราะ ${SAME_ID} unlock 10 แต่ตันแล้ว)`
  );
  check(
    "ทะเบียนขอบเขตชี้เป้าหมายถัดไปตรงกัน",
    diff.is_next_target === true && same.is_next_target === false,
    `diff=${diff.is_next_target} same=${same.is_next_target}`
  );

  const blocked = await get("/api/forge/preview?limitId=" + SAME_ID);
  const B = blocked.json || {};
  check(
    "กำแพงที่ตันยังเปิดอ่านประวัติได้ (ตันไม่ได้แปลว่าถูกลบความทรงจำ)",
    blocked.status === 200 && B.blocked === true && Array.isArray(B.history) && B.history.length === 3 && B.budget.cap === 3,
    `blocked=${B.blocked} · ประวัติ ${(B.history || []).length} รอบ · cap=${B.budget ? B.budget.cap : "?"}`
  );
  check(
    "ระบบอธิบายเงื่อนไขการขยับเพดานให้มนุษย์อ่านได้",
    B.budget && /ต่างจากเดิมจริง/.test(String(B.budget.note || "")),
    String((B.budget || {}).note || "").slice(0, 90)
  );

  /* ---- 4. โค้ดของรอบที่ล้มเหลวไม่ถูกลบทิ้งอีกต่อไป ---- */
  const listed = await get("/api/evolution/attempted?evoId=evo_probe1");
  const LS = listed.json || {};
  check(
    "GET /api/evolution/attempted ลิสต์ไฟล์ที่รอบซึ่งถูกย้อนกลับเคยเขียนไว้ได้ (โค้ดเดิมได้ 404)",
    listed.status === 200 && Array.isArray(LS.files) && LS.files.some((f) => f.path === "server.js") && !LS.files.some((f) => f.path === "index.json"),
    `ได้ ${listed.status} · ${JSON.stringify((LS.files || []).map((f) => f.path))}`
  );
  const code = await get("/api/evolution/attempted?evoId=evo_probe1&file=server.js");
  check(
    "อ่านโค้ดจริงของรอบที่ตกได้ทั้งไฟล์",
    code.status === 200 && String((code.json || {}).code || "").includes(`${MARK}_ATTEMPTED_CODE`),
    `ได้ ${code.status} · ${String((code.json || {}).code || "").slice(0, 60)}`
  );
  const escape = await get("/api/evolution/attempted?evoId=evo_probe1&file=../../../server.js");
  check("อ่านไฟล์นอกโฟลเดอร์ attempted ไม่ได้", escape.status === 404, `ได้ ${escape.status}`);
  const roundsAll = await get("/api/evolution/attempted");
  check(
    "ไม่ระบุ evoId ต้องได้รายชื่อทุกรอบที่ยังเก็บโค้ดที่ตกไว้",
    roundsAll.status === 200 && Array.isArray((roundsAll.json || {}).rounds) && roundsAll.json.rounds.length >= 3,
    `ได้ ${roundsAll.status} · ${((roundsAll.json || {}).rounds || []).length} รอบ`
  );

  /* ---- 5. ความสามารถเดิมต้องครบ ---- */
  for (const ep of [
    "/api/dots",
    "/api/connections",
    "/api/limits",
    "/api/self",
    "/api/evolution",
    "/api/forgotten",
    "/api/serendipity/status",
    "/api/lessons",
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
    restore(LIMITS_FILE, limitsBackup);
    restore(EVO_FILE, evoBackup);
    if (failures.length) {
      console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
      process.exit(1);
    }
    console.log("\n✓ ผ่านทั้งหมด — บทเรียนของรอบที่ล้มเหลวไหลถึงรอบถัดไปแล้ว และเพดานการลองขยับตามความต่างของวิธีจริง");
    process.exit(0);
  });
