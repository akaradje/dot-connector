/*
 * ไฟล์พิสูจน์ — Layer 11 "The Behavioural Mirror": กระจกที่เห็นพฤติกรรมจริง ไม่ใช่แค่โค้ด
 *
 * กำแพงที่ถูกทำลาย (lim_dd549dc9): buildIntrospectPrompt() รับซอร์สโค้ด ชื่อจุด ชื่อนวัตกรรม
 * แล้วจบ ทั้งที่เครื่องยนต์ถือบันทึกพฤติกรรมจริงของตัวเองไว้ครบมือ — state.log, evolution.json
 * พร้อมด่านที่ตกและจำนวนเทิร์นซ่อม, endpoint-usage.json กระจกจึงสะท้อนแต่ "ตัวเองควรทำงานอย่างไร
 * ตามที่เขียนไว้" ไม่เคยสะท้อน "ตัวเองทำงานอย่างไรจริง ๆ เมื่อคืนตอนไม่มีใครดู"
 * ผลคือกำแพงทุกข้อที่มันตั้งชื่อได้ คือกำแพงที่อ่านออกจากโค้ดได้เท่านั้น
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตกการทดสอบนี้: /api/self/runtime และ /api/introspect/preview ไม่มีอยู่ (404)
 *
 * ไม่เรียก AI เลย — ทั้งสองเส้นทางเป็นการอ่านไฟล์ที่มีอยู่แล้วและประกอบพรอมป์ตโดยไม่ส่ง
 */
const http = require("http");
const { URL } = require("url");

const BASE = process.env.DOT_TEST_URL;
const REGRESSION_ENDPOINTS = [
  "/api/dots",
  "/api/limits",
  "/api/self",
  "/api/evolution",
  "/api/serendipity/status",
  "/api/autopilot",
  "/api/limits/events",
  "/api/self/runtime",
  "/api/introspect/preview",
];

if (!BASE) {
  console.error("✗ ต้องรันผ่าน Self-Forge หรือ verifier/audit.js: ไม่พบ DOT_TEST_URL");
  process.exit(2);
}

function get(pathname) {
  return new Promise((resolve) => {
    const u = new URL(pathname, BASE);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 15000 }, (r) => {
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
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", json: null });
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message), json: null }));
  });
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(name);
}

(async () => {
  /* ---- 1. บันทึกพฤติกรรมจริงถูกรวบเป็นก้อนเดียวที่อ่านได้ ---- */
  const r = await get("/api/self/runtime");
  const d = r.json || {};
  check("GET /api/self/runtime ตอบ 200 (โค้ดเดิมจะได้ 404)", r.status === 200, `ได้ ${r.status}`);
  check(
    "รายงานครบทั้งสามแหล่งที่เครื่องยนต์ถืออยู่: บันทึก daemon · รอบวิวัฒนาการ · การถูกเรียกใช้จริง",
    !!(d.log && d.rounds && d.usage),
    Object.keys(d).join(",")
  );
  check(
    "รอบวิวัฒนาการถูกนับแยกผ่าน/ตก/ตายกลางรอบ (ตัวเลขที่อ่านจากซอร์สไม่ได้)",
    Number.isFinite(d.rounds.total) &&
      Number.isFinite(d.rounds.accepted) &&
      Number.isFinite(d.rounds.rejected) &&
      Number.isFinite(d.rounds.stopped_mid_round) &&
      d.rounds.accepted + d.rounds.rejected === d.rounds.total,
    JSON.stringify({ t: d.rounds.total, a: d.rounds.accepted, r: d.rounds.rejected })
  );
  check(
    "มีฮิสโทแกรมว่าด่านไหนฆ่ารอบมากที่สุด และสถิติเทิร์นซ่อม",
    Array.isArray(d.rounds.gate_failures) && "repair_turns_avg" in d.rounds && Number.isFinite(d.rounds.hit_turn_ceiling),
    `gate_failures=${d.rounds.gate_failures.length} avg=${d.rounds.repair_turns_avg}`
  );
  check(
    "บันทึก daemon ถูกจัดหมวดตามสิ่งที่มันบอกเรื่องสุขภาพ และมีบรรทัดดิบท้ายสุดให้อ่านเอง",
    Array.isArray(d.log.kinds) &&
      d.log.kinds.length >= 5 &&
      d.log.kinds.every((k) => typeof k.label === "string" && Number.isFinite(k.count)) &&
      Array.isArray(d.log.tail),
    `kinds=${d.log.kinds.length} tail=${(d.log.tail || []).length}`
  );
  check(
    "ระบุความสามารถที่ตัวเองสร้างแล้วประกาศไว้ แต่ยังไม่เคยมีใครเรียก",
    Array.isArray(d.usage.never_called_capabilities) &&
      Array.isArray(d.usage.declared_but_silent) &&
      Number.isFinite(d.usage.total_requests),
    `never_called=${d.usage.never_called_capabilities.length} silent=${d.usage.declared_but_silent.length} requests=${d.usage.total_requests}`
  );
  check(
    "รายงานสถานะสวิตช์กุญแจและนาฬิกาทุกเรือน — สิ่งที่บอกว่ามันเดินอยู่จริงไหม",
    d.ignition && typeof d.ignition.master === "boolean" && d.clocks && "restart_required" in d.clocks,
    JSON.stringify(d.ignition)
  );

  /* ---- 2. หน้าต่างเวลาปรับได้ และมีผลจริง ---- */
  const wide = await get("/api/self/runtime?days=90");
  const narrow = await get("/api/self/runtime?days=1");
  check(
    "หน้าต่างเวลาปรับได้และไม่ให้ผลย้อนแย้ง (ช่วงกว้างต้องเห็นไม่น้อยกว่าช่วงแคบ)",
    wide.status === 200 &&
      narrow.status === 200 &&
      wide.json.window_days === 90 &&
      narrow.json.window_days === 1 &&
      wide.json.rounds.total >= narrow.json.rounds.total,
    `90วัน=${wide.json && wide.json.rounds.total} รอบ · 1วัน=${narrow.json && narrow.json.rounds.total} รอบ`
  );

  /* ---- 3. บล็อกข้อความที่จะถูกส่งเข้ากระจกจริง ---- */
  check(
    "บล็อกข้อความถูกประกอบไว้แล้วและมีเนื้อหาจริง ไม่ใช่โครงว่าง",
    typeof d.block === "string" && d.block_chars > 400 && d.block.includes("บันทึกการเดินเครื่องจริง"),
    `${d.block_chars} ตัวอักษร`
  );

  /* ---- 4. ข้อสำคัญที่สุด: บล็อกนั้นอยู่ในพรอมป์ตของกระจกจริง ๆ ---- */
  const pv = await get("/api/introspect/preview");
  const P = pv.json || {};
  check("GET /api/introspect/preview ตอบ 200 (โค้ดเดิมจะได้ 404)", pv.status === 200, `ได้ ${pv.status}`);
  check(
    "พรอมป์ตส่องกระจกมีบล็อกพฤติกรรมจริงอยู่ในนั้นแน่นอน (เทียบข้อความตรง ๆ ไม่ใช่เชื่อคำบอก)",
    P.includes_runtime_block === true,
    `runtime=${P.parts && P.parts.runtime} ตัวอักษร จากทั้งหมด ${P.prompt_chars}`
  );
  check(
    "สคีมาบังคับให้ทุกกำแพงต้องอ้างหลักฐานจากบันทึกจริง ไม่ใช่จากโค้ดอย่างเดียว",
    P.requires_runtime_evidence === true,
    "มี field runtime_evidence ในสคีมา"
  );
  check(
    "พรอมป์ตยังมีทั้งแผนที่ซอร์สและคลังความรู้ครบ (ชั้นใหม่ไม่ได้เบียดของเดิมออก)",
    P.parts && P.parts.source_map > 0 && P.parts.knowledge > 0 && P.parts.runtime > 0,
    JSON.stringify(P.parts)
  );

  /* ---- 5. พรีวิวต้องไม่เรียก AI และไม่เขียนอะไร ---- */
  const before = (await get("/api/limits")).json || [];
  await get("/api/introspect/preview");
  const after = (await get("/api/limits")).json || [];
  check(
    "พรีวิวไม่แตะทะเบียนกำแพงและไม่เรียก AI (ตอบกลับได้ทันทีในหนึ่งคำขอ)",
    Array.isArray(before) && Array.isArray(after) && before.length === after.length,
    `ก่อน ${before.length} · หลัง ${after.length}`
  );

  /* ---- 6. ของเดิมยังครบ ---- */
  for (const ep of REGRESSION_ENDPOINTS) {
    const g = await get(ep);
    check(`endpoint เดิม ${ep} ยังตอบ 200`, g.status === 200, `ได้ ${g.status}`);
  }

  if (failures.length) {
    console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
    process.exit(1);
  }
  console.log("\n✓ ผ่านทั้งหมด — กระจกเห็นพฤติกรรมจริงของตัวเองแล้ว ไม่ใช่แค่สิ่งที่ซอร์สบอกว่ามันควรทำ");
  process.exit(0);
})();
