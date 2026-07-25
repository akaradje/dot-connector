/*
 * ไฟล์พิสูจน์ (capability proof) — รอบที่ให้ระบบ "เล็กลงได้" เป็นครั้งแรก
 *
 * กำแพงที่ถูกทำลาย: ฟังก์ชันความเหมาะสมอนุญาตให้โตอย่างเดียว
 *   เดิม proveEvolution() ตัดสินด้วย `out.differential.ok = !oldProof.ok` — ไฟล์พิสูจน์ต้อง "ตกกับโค้ดเดิม"
 *   แปลว่าการรวบโค้ดซ้ำ ลบของที่ไม่มีใครใช้ หรือถอด endpoint ที่ตายแล้ว พิสูจน์ไม่ได้โดยนิยาม
 *   เพราะการทดสอบพฤติกรรมของโค้ดที่รีแฟกเตอร์แล้วย่อม "ผ่านทั้งสองเวอร์ชัน"
 *   และ REGRESSION_ENDPOINTS ก็มีแต่ต่อท้าย ไม่มีกลไกถอดออก ระบบจึงมีทิศทางเดียวคือใหญ่ขึ้นทุกรอบ
 *
 * ไฟล์นี้ทดสอบพฤติกรรมจริงผ่าน HTTP ว่าตอนนี้มี "รอบยุบรวม" (consolidation round) อยู่จริง:
 *   1. GET /api/consolidation/preview — ระบบวัดขนาดตัวเองเป็นตัวเลขได้ และบอกชุดทดสอบสะสมของตัวเอง
 *   2. POST /api/consolidation/dryrun — ฟังก์ชันความเหมาะสม "กลับด้าน" เรียกใช้ได้จริงและตัดสินกลับด้านจริง:
 *      · ผ่านทั้งเก่าและใหม่ + เล็กลง            → ผ่าน   (รอบขยายจะตีตกกรณีนี้ว่า "ไม่ได้ทำอะไรใหม่")
 *      · ผ่านทั้งเก่าและใหม่ แต่ขนาดเท่าเดิม     → ตก     (ยุบรวมต้องขยับตัวเลข)
 *      · ตกกับเก่า/ผ่านกับใหม่ (ลายเซ็นรอบขยาย) → ตก     (นี่คือหัวใจของการกลับด้าน)
 *      · ชุดทดสอบเดิมพลิกผลแม้ไฟล์เดียว         → ตก
 *   3. GET/POST /api/endpoints[/retire|/restore] — REGRESSION_ENDPOINTS เลิกเป็น append-only:
 *      เส้นทางที่ "ถูกเรียก 0 ครั้ง" ถอดออกจาก sweep ได้จริง (sweeping ลดลงจริง) ·
 *      เส้นทางที่ยังมีคนเรียกถอดไม่ได้ · ถอดแล้วกดคืนได้ · เส้นทางที่ไม่มีอยู่จริงถอดไม่ได้
 *   4. POST /api/consolidate — รอบยุบรวมมีอยู่จริงและถูกล็อกในโหมดทดสอบ (503 ไม่ใช่ 404)
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตก: ไม่มี /api/consolidation/* /api/endpoints* /api/consolidate เลย (404 ทุกเส้น)
 * และ /api/self ของมันไม่มีสนาม metrics / endpoints / rounds_since_consolidation
 *
 * exit 0 = ระบบยุบรวมตัวเองได้และวัดผลได้ · exit != 0 = ยังโตได้ทางเดียวเหมือนเดิม
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

/* ชุดตัวเลขจำลองสำหรับ dry-run: ตัวเดียวกันทุกกรณี ต่างกันแค่สิ่งที่ต้องการทดสอบ */
const BIG = { code_files: 6, code_lines: 5000, code_chars: 200000, prompt_chars: 260000, endpoints: 15, total_lines: 5400 };
const SMALL = { code_files: 6, code_lines: 4820, code_chars: 193000, prompt_chars: 251000, endpoints: 15, total_lines: 5300 };
const PASS_BOTH = [
  { file: "selftest/old_a.js", own: false, old_ok: true, new_ok: true },
  { file: "selftest/old_b.js", own: false, old_ok: true, new_ok: true },
  { file: "selftest/own.js", own: true, old_ok: true, new_ok: true },
];

// ไฟล์บันทึกการถอด endpoint อยู่นอก data/ (เพราะ data/ ถูกเทียบไบต์ต่อไบต์ตอนหลอมตัวเอง)
const DEP_FILE = path.join(ROOT, "evolution", "deprecations.json");
const depBackup = (() => {
  try {
    return fs.readFileSync(DEP_FILE, "utf8");
  } catch {
    return null;
  }
})();

(async () => {
  /* ---- 1. ระบบมองเห็น "ขนาด" ของตัวเองเป็นตัวเลข (โค้ดเดิมได้ 404) ---- */
  const pv = await get("/api/consolidation/preview");
  const P = pv.json || {};
  const m = P.metrics || {};
  check(
    "GET /api/consolidation/preview ตอบ 200 พร้อมเมตริกขนาดของตัวเอง",
    pv.status === 200 &&
      Number.isFinite(m.code_lines) &&
      Number.isFinite(m.code_chars) &&
      Number.isFinite(m.prompt_chars) &&
      Number.isFinite(m.endpoints) &&
      m.code_lines > 100 &&
      m.prompt_chars > 10000,
    `ได้ ${pv.status} · code_lines=${m.code_lines} prompt_chars=${m.prompt_chars} endpoints=${m.endpoints}`
  );
  check(
    "preview บอกชุดทดสอบสะสมที่รอบยุบรวมต้องทำให้ผ่านเหมือนเดิมทุกไฟล์",
    Array.isArray(P.suite) &&
      P.suite.length >= 2 &&
      P.suite.every((f) => /^selftest\/.+\.js$/.test(f)) &&
      P.suite.includes("selftest/evo_3e84f032.js"),
    `${(P.suite || []).length} ไฟล์: ${(P.suite || []).join(", ").slice(0, 160)}`
  );
  check(
    "preview บอกหนี้การเติบโต (รอบขยายที่สะสมมาตั้งแต่รอบยุบรวมล่าสุด) และกติกาของรอบยุบรวม",
    Number.isFinite(P.rounds_since_consolidation) &&
      Number.isFinite(P.consolidate_every) &&
      typeof P.due === "boolean" &&
      /ผ่านทั้งก่อนและหลัง/.test(String(P.rule || "")),
    `since=${P.rounds_since_consolidation}/${P.consolidate_every} due=${P.due}`
  );

  /* ---- 2. ฟังก์ชันความเหมาะสมกลับด้าน — ตัดสินได้จริงโดยไม่ต้องเสียรอบ AI ---- */
  const dry = (before, after, suite, retiring) =>
    post("/api/consolidation/dryrun", { before, after, suite, retiring: retiring || 0 });

  const okCase = await dry(BIG, SMALL, PASS_BOTH);
  const A = okCase.json || {};
  check(
    "ผ่านทั้งโค้ดเดิมและโค้ดใหม่ + เล็กลงจริง = รอบยุบรวมผ่าน (รอบขยายจะตีตกกรณีเดียวกันนี้)",
    okCase.status === 200 && A.ok === true && A.gates.preserved.ok === true && A.gates.shrunk.ok === true && A.delta.code_lines === -180,
    `ok=${A.ok} · ${A.gates ? A.gates.shrunk.detail : okCase.status}`
  );

  const flatCase = await dry(BIG, BIG, PASS_BOTH);
  const B = flatCase.json || {};
  check(
    "พฤติกรรมเหมือนเดิมแต่ขนาดไม่ลด = ตก (ยุบรวมต้องขยับตัวเลขจริง ไม่ใช่แค่ไม่พัง)",
    B.ok === false && B.gates.preserved.ok === true && B.gates.shrunk.ok === false,
    B.gates ? B.gates.shrunk.detail : String(flatCase.status)
  );

  const growCase = await dry(SMALL, BIG, PASS_BOTH);
  const C = growCase.json || {};
  check(
    "โตขึ้นในรอบยุบรวม = ตกทันที",
    C.ok === false && C.gates.shrunk.ok === false && (C.gates.shrunk.grew || []).includes("code_lines"),
    (C.gates ? C.gates.shrunk.grew : []) + ""
  );

  // หัวใจของการกลับด้าน: ลายเซ็นที่ "รอบขยาย" ต้องการ (ตกกับเก่า ผ่านกับใหม่) ต้องถูกรอบยุบรวมปฏิเสธ
  const expansionSig = await dry(BIG, SMALL, [
    { file: "selftest/old_a.js", own: false, old_ok: true, new_ok: true },
    { file: "selftest/own.js", own: true, old_ok: false, new_ok: true },
  ]);
  const D = expansionSig.json || {};
  check(
    "ลายเซ็นของรอบขยาย (ตกกับโค้ดเดิม/ผ่านกับโค้ดใหม่) ถูกรอบยุบรวมปฏิเสธ — ฟังก์ชันความเหมาะสมกลับด้านจริง",
    D.ok === false && D.gates.preserved.ok === false && D.gates.shrunk.ok === true,
    D.gates ? String(D.gates.preserved.detail).slice(0, 120) : String(expansionSig.status)
  );

  const brokenCase = await dry(BIG, SMALL, [
    { file: "selftest/old_a.js", own: false, old_ok: true, new_ok: false },
    { file: "selftest/own.js", own: true, old_ok: true, new_ok: true },
  ]);
  const E = brokenCase.json || {};
  check(
    "ชุดทดสอบเดิมพลิกผลแม้ไฟล์เดียว = ตก (พฤติกรรมเปลี่ยน ไม่ใช่การยุบรวม)",
    E.ok === false &&
      E.gates.preserved.ok === false &&
      (E.gates.preserved.flipped || []).some((f) => f.file === "selftest/old_a.js"),
    E.gates ? String(E.gates.preserved.detail).slice(0, 120) : String(brokenCase.status)
  );

  const retireCase = await dry(BIG, { ...BIG }, PASS_BOTH, 2);
  const F = retireCase.json || {};
  check(
    "การถอด endpoint ที่ตายแล้วนับเป็น 'เล็กลง' ได้ด้วยตัวมันเอง",
    F.ok === true && F.delta.endpoints === -2 && F.gates.shrunk.shrank.includes("endpoints"),
    `delta.endpoints=${F.delta ? F.delta.endpoints : "?"}`
  );

  /* ---- 3. บันทึกการใช้งานจริง + การถอด endpoint ออกจาก sweep ---- */
  const led0 = await get("/api/endpoints");
  const L0 = led0.json || {};
  const declared = L0.declared;
  check(
    "GET /api/endpoints ตอบ 200 พร้อมบันทึกการใช้งานจริงของทุกเส้นทางใน sweep",
    led0.status === 200 &&
      Number.isFinite(declared) &&
      declared >= 13 &&
      L0.sweeping === declared &&
      Array.isArray(L0.endpoints) &&
      L0.endpoints.some((e) => e.endpoint === "/api/lessons"),
    `ได้ ${led0.status} · ประกาศ ${declared} · sweep ${L0.sweeping}`
  );

  const lessonsBefore = (L0.endpoints || []).find((e) => e.endpoint === "/api/lessons") || {};
  check(
    "เส้นทางที่ยังไม่มีใครเรียกในรอบนี้ ถูกทำเครื่องหมายว่า 'ถอดได้'",
    lessonsBefore.hits === 0 && lessonsBefore.retirable === true,
    `hits=${lessonsBefore.hits} retirable=${lessonsBefore.retirable}`
  );

  await get("/api/lessons");
  await get("/api/lessons");
  const led1 = await get("/api/endpoints");
  const lessonsAfter = ((led1.json || {}).endpoints || []).find((e) => e.endpoint === "/api/lessons") || {};
  check(
    "เรียกจริง 2 ครั้งแล้วบันทึกการใช้งานขยับตาม และเส้นทางนั้นเลิกเป็นเส้นทางที่ถอดได้",
    lessonsAfter.hits >= 2 && lessonsAfter.retirable === false && lessonsAfter.last_hit,
    `hits=${lessonsAfter.hits} retirable=${lessonsAfter.retirable}`
  );

  const refused = await post("/api/endpoints/retire", { endpoint: "/api/lessons" });
  check(
    "ถอดเส้นทางที่ยังมีคนเรียก = ถูกปฏิเสธ (การรับรองว่าไม่มีใครเรียกแล้วเป็นเงื่อนไขบังคับ)",
    refused.status === 400 && /ยังมีคนเรียกอยู่จริง/.test(String((refused.json || {}).error || "")),
    `ได้ ${refused.status} · ${String((refused.json || {}).error || "").slice(0, 80)}`
  );

  const bogus = await post("/api/endpoints/retire", { endpoint: "/api/ไม่มีอยู่จริง" });
  check("ถอดเส้นทางที่ไม่ได้อยู่ใน sweep ไม่ได้", bogus.status === 400, `ได้ ${bogus.status}`);

  const victim = "/api/scout/candidates"; // ยังไม่ถูกเรียกเลยในรอบทดสอบนี้
  const retired = await post("/api/endpoints/retire", { endpoint: victim, reason: "ทดสอบทะเบียนการถอดเส้นทาง" });
  const R = retired.json || {};
  check(
    "ถอดเส้นทางที่ถูกเรียก 0 ครั้งได้จริง — REGRESSION_ENDPOINTS เลิกเป็นรายการที่ต่อท้ายได้อย่างเดียว",
    retired.status === 200 && R.retired === victim && R.sweeping === declared - 1 && R.declared === declared,
    `ได้ ${retired.status} · sweep ${R.sweeping}/${R.declared}`
  );

  const pv2 = await get("/api/consolidation/preview");
  const M2 = (pv2.json || {}).metrics || {};
  const led2 = (pv2.json || {}).endpoints || {};
  check(
    "จำนวน endpoint ที่ต้อง sweep ลดลงจริงตามทะเบียน และประวัติการถอดถูกบันทึกไว้",
    M2.endpoints === m.endpoints - 1 &&
      M2.retired_endpoints === 1 &&
      (led2.deprecations || []).some((d) => d.endpoint === victim && d.by === "owner" && d.active !== false),
    `endpoints ${m.endpoints} → ${M2.endpoints} · deprecations ${(led2.deprecations || []).length}`
  );

  const twice = await post("/api/endpoints/retire", { endpoint: victim });
  check("ถอดซ้ำเส้นทางเดิมไม่ได้", twice.status === 400, `ได้ ${twice.status}`);

  const restored = await post("/api/endpoints/restore", { endpoint: victim });
  const RS = restored.json || {};
  check(
    "การถอดย้อนกลับได้เสมอ — sweep กลับมาครบเท่าเดิม",
    restored.status === 200 && RS.restored === victim && RS.sweeping === declared,
    `ได้ ${restored.status} · sweep ${RS.sweeping}`
  );

  /* ---- 4. รอบยุบรวมมีอยู่จริงในฐานะรอบวิวัฒนาการอีกชนิดหนึ่ง ---- */
  const runIt = await post("/api/consolidate", {});
  check(
    "POST /api/consolidate มีอยู่จริงและถูกล็อกในโหมดทดสอบ (503 ไม่ใช่ 404)",
    runIt.status === 503,
    `ได้ ${runIt.status}`
  );

  const self = await get("/api/self");
  const S = self.json || {};
  check(
    "GET /api/self รายงานขนาดตัวเองและหนี้การเติบโตให้หน้าเว็บใช้ได้",
    self.status === 200 &&
      S.metrics &&
      Number.isFinite(S.metrics.code_lines) &&
      S.endpoints &&
      S.endpoints.declared === declared &&
      Number.isFinite(S.rounds_since_consolidation),
    `ได้ ${self.status} · code_lines=${S.metrics ? S.metrics.code_lines : "?"}`
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
    "/api/forge/preview",
    "/api/evolution/attempted",
    "/api/scout/status",
    "/api/scout/candidates",
    "/api/scout/gaps",
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
    // คืนทะเบียนการถอดเส้นทางของแซนด์บ็อกซ์ให้เหมือนเดิม
    try {
      if (depBackup === null) fs.rmSync(DEP_FILE, { force: true });
      else fs.writeFileSync(DEP_FILE, depBackup, "utf8");
    } catch {}
    if (failures.length) {
      console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
      process.exit(1);
    }
    console.log("\n✓ ผ่านทั้งหมด — ระบบมีรอบที่ทำให้ตัวเองเล็กลงได้แล้ว และการถอด endpoint ที่ตายแล้วทำได้จริงโดยมีทะเบียนกำกับ");
    process.exit(0);
  });
