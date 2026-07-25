/*
 * ไฟล์พิสูจน์ — Layer 10 "The RemLedger": ทะเบียนกำแพงแบบแม่เหล็กค้าง
 *
 * ชั้นนี้ถูกออกแบบโดยตัวระบบเอง: POST /api/forge/insight เอากำแพงของตัวเอง
 * ("ทะเบียนกำแพงถูกเขียนทับทุกครั้งที่ส่องกระจก") ไปทาบกับสองจุดในคลัง —
 * ฮิสเทอรีซิสในฟิสิกส์ (dot_2c82d4bf) และภูมิคุ้มกันแบบจดจำ (dot_21a771d4) —
 * แล้วได้โครงสร้างร่วมที่กลายเป็นดีไซน์ทั้งหมดของชั้นนี้:
 *   · remanence  การยืนยันว่ากำแพงมีอยู่ต้องถูก แต่การประกาศว่ามันหายไปต้องจ่ายแรงย้อนศร
 *   · epitope    ความจำผูกกับ "ลายเซ็นเชิงโครงสร้าง" ไม่ใช่กับหมายเลขเคสที่ออกใหม่ทุกครั้ง
 *
 * กำแพงที่ถูกทำลาย: introspect() เขียน limits.json ทับทั้งไฟล์ด้วย [...broken, ...fresh]
 * กำแพงที่ยังจริงอยู่แต่โมเดลไม่เอ่ยถึงในรอบนั้น **หายไปทั้งดวง** พร้อมจำนวนครั้งที่เคยลอง
 * และเพราะ attemptBudget()/failureDossier() ค้นแผลเป็นด้วย limit.id ล้วน ๆ กำแพงเดิมที่ได้ id ใหม่
 * จึงกลายเป็นกำแพงที่ "ไม่เคยล้มเหลวมาก่อน" — ระบบลองวิธีเดิมซ้ำได้ไม่จำกัดโดยเชื่อว่าเป็นครั้งแรกทุกครั้ง
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตกการทดสอบนี้: /api/limits/merge/dryrun ไม่มีอยู่จริง (404)
 *
 * ทุกข้อทดสอบผ่าน HTTP และไม่เรียก AI เลย — mergeLimits() ถูกแยกเป็นฟังก์ชันบริสุทธิ์
 * เพื่อให้พฤติกรรมที่ตัดสินว่าประวัติของกำแพงจะรอดหรือไม่ ถูกตรวจได้ในหนึ่งวินาที
 * แทนที่จะต้องจ่ายรอบส่องกระจก 12 นาที
 */
const http = require("http");
const { URL } = require("url");

const BASE = process.env.DOT_TEST_URL;
const REGRESSION_ENDPOINTS = [
  "/api/dots",
  "/api/connections",
  "/api/limits",
  "/api/self",
  "/api/evolution",
  "/api/forgotten",
  "/api/serendipity/status",
  "/api/autopilot",
  "/api/limits/events",
];

if (!BASE) {
  console.error("✗ ต้องรันผ่าน Self-Forge หรือ verifier/audit.js: ไม่พบ DOT_TEST_URL");
  process.exit(2);
}

function request(method, pathname, body) {
  return new Promise((resolve) => {
    const u = new URL(pathname, BASE);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        timeout: 10000,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (r) => {
        let out = "";
        r.setEncoding("utf8");
        r.on("data", (d) => (out += d));
        r.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(out);
          } catch {}
          resolve({ status: r.statusCode, body: out, json });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", json: null });
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message), json: null }));
    if (payload) req.write(payload);
    req.end();
  });
}
const get = (p) => request("GET", p);
const post = (p, b) => request("POST", p, b === undefined ? {} : b);

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(name);
}

/* ทะเบียนสมมติสามข้อ ไม่แตะคลังจริง — dryrun ไม่เขียนอะไรลงดิสก์ */
const WALL_A = {
  id: "lim_aaaa1111",
  title: "ทะเบียนกำแพงถูกเขียนทับทุกครั้งที่ส่องกระจก",
  category: "architecture",
  description:
    "introspect() เขียน limits.json ทับทั้งไฟล์ เหลือไว้เฉพาะข้อที่ broken กับข้อที่โมเดลบังเอิญคืน id เดิมมา " +
    "กำแพงที่ยังจริงอยู่แต่ไม่ถูกเอ่ยถึงหายไปพร้อมจำนวนครั้งที่เคยลอง",
  evidence: "server.js: introspect() บรรทัด saveJson(LIMITS_FILE, merged)",
  status: "standing",
  attempts: 2,
  aliases: [],
  silent_rounds: 0,
  found_at: "2026-07-01T00:00:00.000Z",
};
const WALL_B = {
  id: "lim_bbbb2222",
  title: "ยิ่งเขียนตัวเองมาก ยิ่งอ่านตัวเองได้ครบน้อยลง",
  category: "physics",
  description: "promptBundle() ยัดซอร์สทั้งไฟล์เข้าพรอมป์ต ซึ่งโตขึ้นทุกรอบที่ผ่าน",
  evidence: "server.js: promptBundle()",
  status: "standing",
  attempts: 1,
  aliases: [],
  silent_rounds: 0,
  found_at: "2026-07-02T00:00:00.000Z",
};
const WALL_C = {
  id: "lim_cccc3333",
  title: "วิวัฒนาการที่มีประชากรเท่ากับหนึ่ง",
  category: "architecture",
  description: "หนึ่งรอบ = หนึ่งกำแพง หนึ่งแนวทาง ไม่มีที่ไหนสร้างผู้สมัครหลายตัวแล้วเลือกตัวที่ดีที่สุด",
  evidence: "server.js: ตัวแปร forging",
  status: "standing",
  attempts: 0,
  aliases: [],
  silent_rounds: 0,
  found_at: "2026-07-03T00:00:00.000Z",
};
const CURRENT = [WALL_A, WALL_B, WALL_C];
const byId = (list, id) => (list || []).find((l) => l.id === id) || null;
const typeOf = (events, id) => (events || []).filter((e) => e.limit_id === id).map((e) => e.type);

(async () => {
  /* ---- 1. กำแพงที่ไม่ถูกเอ่ยถึง ต้องไม่หาย (remanence) ---- */
  // รอบส่องกระจกที่พูดถึงแค่ข้อเดียวจากสามข้อ — พฤติกรรมเดิมคือ B กับ C หายไปทั้งคู่
  const r1 = await post("/api/limits/merge/dryrun", {
    current: CURRENT,
    incoming: [{ id: WALL_A.id, title: WALL_A.title, description: WALL_A.description, unlock_score: 9, risk: 3 }],
  });
  check("POST /api/limits/merge/dryrun ตอบ 200 (โค้ดเดิมจะได้ 404)", r1.status === 200, `ได้ ${r1.status}`);
  const m1 = r1.json || {};
  check(
    "รอบที่เอ่ยถึงกำแพงเดียวจากสามข้อ ต้องไม่ทำให้อีกสองข้อหายไป",
    (m1.limits || []).length === 3 && (m1.lost || []).length === 0,
    `เหลือ ${(m1.limits || []).length} ข้อ · หาย ${JSON.stringify(m1.lost)}`
  );
  check(
    "ข้อที่ไม่ถูกเอ่ยถึงต้องยังถือจำนวนครั้งที่เคยลองไว้ครบ",
    byId(m1.limits, WALL_B.id) && byId(m1.limits, WALL_B.id).attempts === 1,
    `attempts=${byId(m1.limits, WALL_B.id) && byId(m1.limits, WALL_B.id).attempts}`
  );
  check(
    "ข้อที่ไม่ถูกเอ่ยถึงต้องขึ้นตัวนับความเงียบ และยังเป็นเป้าหมายได้อยู่",
    byId(m1.limits, WALL_B.id).silent_rounds === 1 && byId(m1.limits, WALL_B.id).status === "standing",
    `silent=${byId(m1.limits, WALL_B.id).silent_rounds} status=${byId(m1.limits, WALL_B.id).status}`
  );
  check(
    "ทุกการเปลี่ยนสถานะถูกบันทึกเป็นเหตุการณ์ (ไม่ใช่การเปลี่ยนเงียบ ๆ)",
    typeOf(m1.events, WALL_A.id).includes("confirmed") && typeOf(m1.events, WALL_B.id).includes("remanent"),
    JSON.stringify((m1.events || []).map((e) => e.type))
  );

  /* ---- 2. Coercive field: เงียบครบเกณฑ์แล้วถึงจะเลิกเป็นเป้าหมาย — และยังไม่ถูกลบ ---- */
  const silent = { ...WALL_B, silent_rounds: 2 };
  const r2 = await post("/api/limits/merge/dryrun", {
    current: [WALL_A, silent, WALL_C],
    incoming: [{ id: WALL_A.id, title: WALL_A.title, description: WALL_A.description }],
  });
  const m2 = r2.json || {};
  const b2 = byId(m2.limits, WALL_B.id);
  check(
    "เงียบครบเกณฑ์ → เข้าสถานะ dormant (ยังอยู่ในทะเบียน ไม่ถูกลบ)",
    b2 && b2.status === "dormant" && (m2.lost || []).length === 0,
    `status=${b2 && b2.status} · หาย ${JSON.stringify(m2.lost)}`
  );
  check("การหลับถูกบันทึกเป็นเหตุการณ์", typeOf(m2.events, WALL_B.id).includes("dormant"), JSON.stringify(typeOf(m2.events, WALL_B.id)));

  /* ---- 3. เอ่ยถึงอีกครั้ง = ปลุกกลับมาพร้อมประวัติทั้งดวง ---- */
  const dormant = { ...WALL_B, status: "dormant", silent_rounds: 3, dormant_at: "2026-07-10T00:00:00.000Z" };
  const r3 = await post("/api/limits/merge/dryrun", {
    current: [WALL_A, dormant],
    incoming: [{ id: WALL_B.id, title: WALL_B.title, description: WALL_B.description }],
  });
  const m3 = r3.json || {};
  const b3 = byId(m3.limits, WALL_B.id);
  check(
    "กำแพงที่หลับอยู่ถูกเอ่ยถึงอีกครั้ง → กลับมา standing พร้อม attempts เดิม",
    b3 && b3.status === "standing" && b3.silent_rounds === 0 && b3.attempts === 1,
    `status=${b3 && b3.status} silent=${b3 && b3.silent_rounds} attempts=${b3 && b3.attempts}`
  );
  check("การปลุกกลับถูกบันทึกเป็นเหตุการณ์", typeOf(m3.events, WALL_B.id).includes("revived"), JSON.stringify(typeOf(m3.events, WALL_B.id)));

  /* ---- 4. Epitope: กำแพงเดิมที่ได้ id ใหม่ ต้องไม่กลายเป็นกำแพงใหม่ ---- */
  // เขียนใหม่ทั้งประโยค เปลี่ยนคำ เปลี่ยน id — แต่พูดถึงโค้ดชิ้นเดียวกันและความล้มเหลวแบบเดียวกัน
  const renamed = {
    id: "lim_zzzz9999",
    title: "บันทึกขอบเขตถูกทับใหม่ทุกครั้งที่ระบบส่องกระจกดูตัวเอง",
    description:
      "introspect() เขียน limits.json ทับทั้งไฟล์ เหลือไว้เฉพาะข้อที่ broken กับข้อที่โมเดลบังเอิญคืน id เดิมมา " +
      "กำแพงที่ยังจริงอยู่แต่ไม่ถูกเอ่ยถึงหายไปพร้อมจำนวนครั้งที่เคยลอง",
    evidence: "server.js: introspect() บรรทัด saveJson(LIMITS_FILE, merged)",
  };
  const r4 = await post("/api/limits/merge/dryrun", { current: CURRENT, incoming: [renamed] });
  const m4 = r4.json || {};
  const a4 = byId(m4.limits, WALL_A.id);
  check(
    "กำแพงเดิมที่ถูกคืนมาด้วย id ใหม่ ต้องถูกจับคู่กลับด้วยลายเซ็นเชิงโครงสร้าง ไม่ใช่ถูกนับเป็นข้อใหม่",
    (m4.limits || []).length === 3 && !!a4 && a4.attempts === 2,
    `ทะเบียนเหลือ ${(m4.limits || []).length} ข้อ · attempts ของข้อเดิม = ${a4 && a4.attempts}`
  );
  check(
    "id ใหม่ถูกเก็บเป็น alias เพื่อให้แผลเป็นที่บันทึกใต้ id นั้นยังตามหาเจอ",
    a4 && Array.isArray(a4.aliases) && a4.aliases.includes("lim_zzzz9999"),
    JSON.stringify(a4 && a4.aliases)
  );
  const ev4 = (m4.events || []).find((e) => e.limit_id === WALL_A.id) || {};
  check("เหตุการณ์บอกได้ว่าจับคู่ด้วยวิธีไหนและคล้ายกันแค่ไหน", ev4.matched_by === "epitope" && ev4.similarity > 0, JSON.stringify(ev4));

  /* ---- 5. แต่กำแพงคนละเรื่องต้องไม่ถูกกลืนรวมกัน ---- */
  const different = {
    title: "ตัวที่รันอยู่กับตัวที่อยู่บนดิสก์แยกจากกัน",
    description: "รอบที่ผ่านเขียนไฟล์ใหม่ลงดิสก์แล้วรอมนุษย์กดรีสตาร์ต ส่วนโปรเซสที่คิดอยู่ยังเป็นโค้ดเมื่อวาน",
    evidence: "server.js: state.restart_required",
  };
  const r5 = await post("/api/limits/merge/dryrun", { current: CURRENT, incoming: [different] });
  const m5 = r5.json || {};
  check(
    "กำแพงที่เป็นคนละเรื่องต้องถูกบันทึกเป็นข้อใหม่ ไม่ถูกกลืนเข้ากับข้อเดิม",
    (m5.limits || []).length === 4 && (m5.events || []).some((e) => e.type === "found"),
    `ทะเบียนเหลือ ${(m5.limits || []).length} ข้อ`
  );

  /* ---- 6. กำแพงที่ทำลายไปแล้วต้องไม่ถูกปลุกกลับด้วยความเงียบ ---- */
  const brokenWall = { ...WALL_C, status: "broken", broken_at: "2026-07-05T00:00:00.000Z", broken_by: "evo_test" };
  const r6 = await post("/api/limits/merge/dryrun", {
    current: [WALL_A, brokenWall],
    incoming: [{ id: WALL_A.id, title: WALL_A.title, description: WALL_A.description }],
  });
  const c6 = byId((r6.json || {}).limits, WALL_C.id);
  check(
    "กำแพงที่ทำลายแล้วยังเป็น broken และไม่ถูกนับตัวเงียบ",
    c6 && c6.status === "broken" && !c6.silent_rounds,
    `status=${c6 && c6.status} silent=${c6 && c6.silent_rounds}`
  );

  /* ---- 7. dryrun ต้องไม่แตะทะเบียนจริงเลย ---- */
  const before = (await get("/api/limits")).json || [];
  await post("/api/limits/merge/dryrun", { current: CURRENT, incoming: [] });
  const after = (await get("/api/limits")).json || [];
  check(
    "dryrun ไม่เขียนอะไรลงทะเบียนจริง",
    Array.isArray(before) && Array.isArray(after) && before.length === after.length,
    `ก่อน ${before.length} · หลัง ${after.length}`
  );

  /* ---- 8. บัญชีเหตุการณ์อ่านได้ผ่าน API ---- */
  const ev = await get("/api/limits/events");
  const E = ev.json || {};
  check(
    "GET /api/limits/events ตอบ 200 พร้อมพารามิเตอร์ของฮิสเทอรีซิส",
    ev.status === 200 && Array.isArray(E.events) && Number.isFinite(E.coercive_rounds) && Number.isFinite(E.epitope_match),
    `ได้ ${ev.status} · coercive=${E.coercive_rounds} match=${E.epitope_match}`
  );
  const missing = await get("/api/limits/events?limitId=lim_ไม่มีจริง");
  check("ถามประวัติของกำแพงที่ไม่มีอยู่ต้องได้ 404", missing.status === 404, `ได้ ${missing.status}`);

  /* ---- 9. ทะเบียนจริงต้องถูกยกระดับแล้ว (ไม่มีข้อไหนขาดสนามใหม่) ---- */
  const live = (await get("/api/limits")).json || [];
  check(
    "ทุกข้อในทะเบียนจริงมีสนามของบัญชีสะสมครบ (aliases · silent_rounds)",
    live.length > 0 && live.every((l) => Array.isArray(l.aliases) && typeof l.silent_rounds === "number"),
    `${live.filter((l) => !Array.isArray(l.aliases)).length} ข้อยังขาด`
  );

  /* ---- 10. ของเดิมยังครบ ---- */
  for (const ep of REGRESSION_ENDPOINTS) {
    const r = await get(ep);
    check(`endpoint เดิม ${ep} ยังตอบ 200`, r.status === 200, `ได้ ${r.status}`);
  }

  if (failures.length) {
    console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
    process.exit(1);
  }
  console.log("\n✓ ผ่านทั้งหมด — ทะเบียนกำแพงเป็นบัญชีสะสมจริง: ไม่มีอะไรหายจากความเงียบ และแผลเป็นไม่ขาดจากการเปลี่ยนชื่อ");
  process.exit(0);
})();
