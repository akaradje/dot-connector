/*
 * ไฟล์พิสูจน์ — Layer 13 "The External Judge": ผู้ตัดสินออกไปอยู่นอกห้องสอบ
 *
 * กำแพงที่ถูกทำลาย (lim_3368cc67): runForgeGates, proveEvolution, REGRESSION_ENDPOINTS
 * อยู่ใน server.js ไฟล์เดียวกับที่รอบหลอมตัวเองมีสิทธิ์แก้ และสิ่งที่ห้ามไม่ให้มันแก้ผู้ตัดสิน
 * คือ "กฎข้อ 10 ที่เป็นข้อความในพรอมป์ต" ไม่ใช่กลไก · ส่วนไฟล์พิสูจน์ก็เขียนโดยรอบที่กำลังถูกตัดสิน
 * ในเซสชันเดียวกัน และตั้งแต่ Layer 6.7 ยังกลับไปแก้ไฟล์พิสูจน์ได้อีกหลังเห็นว่าตัวเองตกด่านไหน
 *
 * รูปแบบที่คมที่สุดของรูนี้: รอบหนึ่งทำ endpoint เดิมพัง แล้วลบบรรทัดนั้นออกจาก
 * REGRESSION_ENDPOINTS ในคอมมิตเดียวกัน → ผ่านด่าน regression อย่างสะอาดโดยไม่มีใครรู้
 *
 * สามอย่างที่ชั้นนี้เปลี่ยน:
 *   1. รายการกวาดกลายเป็น "พื้น" ที่อยู่ใน verifier/contract.json — นอก walkSelf() และถูกเทียบไบต์ต่อไบต์
 *   2. verifier/audit.js กลายเป็น "ด่าน" ที่รันทุกรอบ ไม่ใช่เครื่องมือที่มนุษย์ต้องนึกได้เอง
 *   3. ผู้ออกข้อสอบเป็นคนละเซสชันกับผู้เข้าสอบ และไม่เห็น diff (พิสูจน์ผ่าน blind/simulate)
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตกการทดสอบนี้: /api/judge ไม่มีอยู่ (404)
 */
const http = require("http");
const { URL } = require("url");

const BASE = process.env.DOT_TEST_URL;
const ROOT = process.env.DOT_TEST_ROOT;

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
        timeout: 20000,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
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

(async () => {
  /* ---- 1. สัญญาการตรวจมีอยู่จริง และอยู่นอกมือของผู้ถูกตัดสิน ---- */
  const r = await get("/api/judge");
  const j = r.json || {};
  check("GET /api/judge ตอบ 200 (โค้ดเดิมจะได้ 404)", r.status === 200, `ได้ ${r.status}`);
  check("มีสัญญาการตรวจอยู่บนดิสก์จริง ไม่ใช่กติกาที่เป็นข้อความในพรอมป์ต", j.contract_present === true, `frozen_at=${j.frozen_at}`);
  check(
    "สัญญาอยู่นอกขอบเขตที่รอบหลอมตัวเองแก้ได้ (ไม่อยู่ใน walkSelf)",
    j.outside_editable_scope === true,
    `outside_editable_scope=${j.outside_editable_scope}`
  );
  check(
    "และถูกเทียบไบต์ต่อไบต์เหมือนความทรงจำ — รอบที่แตะมันเป็นโมฆะ",
    j.guarded === true,
    `guarded=${j.guarded}`
  );

  /* ---- 2. รายการกวาดเป็น "พื้น" ที่การแก้ซอร์สลดไม่ได้ ---- */
  check(
    "รายการกวาดที่ใช้จริงต้องครอบคลุมพื้นที่แช่แข็งไว้ครบ ไม่มีเส้นไหนหลุด",
    j.honours_contract === true && Array.isArray(j.dropped_from_source) && j.dropped_from_source.length === 0,
    `พื้น ${j.floor} เส้น · กวาดจริง ${j.sweeping} เส้น · หลุด ${JSON.stringify(j.dropped_from_source)}`
  );
  check("พื้นต้องไม่ว่างเปล่า (สัญญาที่ไม่บังคับอะไรเลยก็ไม่ใช่สัญญา)", j.floor >= 10, `${j.floor} เส้น`);
  const eps = (await get("/api/endpoints")).json || {};
  check(
    "ทุกเส้นในพื้นต้องอยู่ในรายการกวาดที่ใช้งานจริง",
    Array.isArray(j.floor_endpoints) && j.floor_endpoints.every((ep) => (eps.endpoints || []).some((e) => e.endpoint === ep)),
    `พื้น ${(j.floor_endpoints || []).length} · ทะเบียน ${(eps.endpoints || []).length}`
  );

  /* ---- 3. ด่าน contract และ audit ถูกประกาศเป็นด่านบังคับ ---- */
  const req_ = j.required_gates || {};
  check(
    "สัญญาบังคับให้ทุกรอบต้องผ่านด่าน contract และ audit ทั้งรอบขยายและรอบยุบรวม",
    Array.isArray(req_.expansion) &&
      req_.expansion.includes("audit") &&
      req_.expansion.includes("contract") &&
      Array.isArray(req_.consolidation) &&
      req_.consolidation.includes("audit") &&
      req_.consolidation.includes("contract"),
    JSON.stringify(req_.expansion)
  );
  check(
    "ผู้ตรวจอิสระมีอยู่จริงในทรี และตั้งค่าให้ล้มเหลวแบบปิด (รันไม่ได้ = ไม่ผ่าน)",
    j.audit && j.audit.auditor_present === true && j.audit.required === true && j.audit.fail_closed === true,
    JSON.stringify({ present: j.audit && j.audit.auditor_present, closed: j.audit && j.audit.fail_closed })
  );
  check(
    "ผู้ตรวจอิสระมีไฟล์พิสูจน์สะสมให้ตรวจจริง และมีเพดานจำนวนไฟล์ต่อรอบ",
    j.audit.proofs_on_disk > 3 && Number.isFinite(j.audit.max_proofs) && j.audit.max_proofs > 0,
    `${j.audit.proofs_on_disk} ไฟล์บนดิสก์ · เพดาน ${j.audit.max_proofs}`
  );

  /* ---- 4. ข้อสำคัญที่สุด: ผู้ออกข้อสอบไม่เห็น diff ---- */
  const sim = await post("/api/forge/blind/simulate", {
    spec: {
      wall: "กำแพงสมมติสำหรับการทดสอบ",
      new_capability: "ความสามารถสมมติที่รอบนั้นอ้าง",
      summary: "สรุปสมมติ",
      endpoints: ["/api/dots"],
    },
  });
  const S = sim.json || {};
  check("POST /api/forge/blind/simulate ตอบ 200 (โค้ดเดิมจะได้ 404)", sim.status === 200, `ได้ ${sim.status}`);
  check(
    "ผู้ออกข้อสอบได้เห็น 'คำประกาศ' ของรอบนั้น — มิฉะนั้นก็เขียนข้อสอบไม่ได้",
    S.examiner_saw && S.examiner_saw.wall === true && S.examiner_saw.declared_capability === true,
    JSON.stringify(S.examiner_saw)
  );
  check(
    "ผู้ออกข้อสอบ **ไม่ได้เห็น diff** ของรอบนั้นเลย (นี่คือกำแพงที่ถูกทำลาย)",
    S.examiner_saw && S.examiner_saw.diff === false && S.saw_diff === false,
    `diff=${S.examiner_saw && S.examiner_saw.diff}`
  );
  check(
    "และไม่ได้เห็นไฟล์พิสูจน์ที่รอบนั้นเขียนเอง",
    S.examiner_saw && S.examiner_saw.round_own_proof === false,
    `round_own_proof=${S.examiner_saw && S.examiner_saw.round_own_proof}`
  );
  check(
    "ผู้ออกข้อสอบยังได้แผนที่ซอร์สเพื่อเขียนข้อสอบที่ยิงถูกเส้นทาง",
    S.examiner_saw && S.examiner_saw.source_map === true,
    `source_map=${S.examiner_saw && S.examiner_saw.source_map}`
  );
  // การส่ง diff เข้าไปตรง ๆ ต้องถูกปฏิเสธ ไม่ใช่ถูกส่งต่อเงียบ ๆ
  const leak = await post("/api/forge/blind/simulate", {
    spec: { wall: "x", new_capability: "y", diff: "--- FILE: server.js ---\n+ยัดโค้ดเข้าไป" },
  });
  check(
    "ถ้ามีใครพยายามยัด diff ให้ผู้ออกข้อสอบ ต้องถูกปฏิเสธด้วย 400 ไม่ใช่ถูกส่งต่อ",
    leak.status === 400 && /ต้องไม่เห็น/.test((leak.json && leak.json.error) || ""),
    `ได้ ${leak.status} · ${(leak.json && leak.json.error) || ""}`
  );

  /* ---- 5. ของเดิมยังครบ (ใช้พื้นจากสัญญาเป็นรายการกวาด — ไม่ใช่รายการที่โค้ดบอกเอง) ---- */
  for (const ep of j.floor_endpoints || []) {
    const g = await get(ep);
    check(`endpoint ตามสัญญา ${ep} ยังตอบ 200`, g.status === 200, `ได้ ${g.status}`);
  }

  if (failures.length) {
    console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
    process.exit(1);
  }
  console.log("\n✓ ผ่านทั้งหมด — ผู้ตัดสินอยู่นอกไฟล์ที่ผู้ถูกตัดสินแก้ได้ และผู้ออกข้อสอบไม่ใช่ผู้เข้าสอบ");
  process.exit(0);
})();
