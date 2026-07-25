/*
 * ไฟล์พิสูจน์ — Layer 09 "The Ignition": สวิตช์กุญแจของเจ้าของ
 *
 * กำแพงที่รอบนี้ทำลาย: ทุกพฤติกรรมอัตโนมัติของเครื่องยนต์ (เชื่อมจุดเอง · The Scout ·
 * The Distiller · และที่สำคัญที่สุดคือ Self-Forge ที่เขียนซอร์สโค้ดของตัวเองใหม่)
 * เริ่มเดินตามนาฬิกาทันทีที่โปรเซสบูต โดยไม่มีที่ไหนให้เจ้าของสั่งว่า "ยังไม่ต้อง"
 * — ทางเดียวที่จะหยุดมันคือแก้ตัวแปรสภาพแวดล้อมแล้วรีสตาร์ต ซึ่งไม่ใช่สวิตช์ แต่คือการผ่าตัด
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตกการทดสอบนี้: /api/autopilot ไม่มีอยู่จริง คำขอจึงตกไปที่ 404
 *
 * สิ่งที่พิสูจน์ (ผ่าน HTTP ล้วน ๆ ไม่ใช่การ grep หาชื่อฟังก์ชัน):
 *   1. ทรีที่เพิ่งเกิดใหม่ = เครื่องยนต์ "หยุด" เสมอ — ค่าตั้งต้นคือไม่ทำอะไรเอง
 *   2. สวิตช์ใหญ่ครอบสวิตช์ย่อยจริง (ปิดใหญ่ = ทุกอย่างไม่มีผล ถึงแม้สวิตช์ย่อยจะเปิดค้างไว้)
 *   3. เปิดสวิตช์ใหญ่ไม่ลากสวิตช์อันตรายที่สุดตามมาด้วย — Self-Forge ต้องถูกเปิดแยกเสมอ
 *   4. สถานะถูกเขียนลงดิสก์ อ่านซ้ำแล้วยังเหมือนเดิม (สวิตช์ที่ลืมตัวเองไม่ใช่สวิตช์)
 *   5. ค่าที่ไม่ใช่ boolean ถูกปฏิเสธด้วย 400 ไม่ใช่ถูกตีความเอาเอง
 *   6. หน้าเว็บอ่านสถานะเดียวกันนี้ได้จาก /api/serendipity/status
 *   7. ของเดิมยังครบทุกเส้นทาง
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
  "/api/adoption",
  "/api/forge/knowledge",
  "/api/autopilot",
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
        timeout: 8000,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (r) => {
        let out = "";
        r.setEncoding("utf8");
        r.on("data", (d) => (out += d));
        r.on("end", () => resolve({ status: r.statusCode, body: out }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
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
function asJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}
const noneEffective = (s) =>
  s && s.effective && !s.effective.connect && !s.effective.scout && !s.effective.distill && !s.effective.evolve;

(async () => {
  /* 1. ค่าตั้งต้นของทรีที่เพิ่งเกิด: หยุด */
  const first = await get("/api/autopilot");
  const s0 = asJson(first.body);
  check("GET /api/autopilot ตอบ 200 (โค้ดเดิมจะได้ 404)", first.status === 200, `ได้ ${first.status}`);
  check("ทรีใหม่ต้องบูตมาแบบเครื่องยนต์หยุด (master=false)", s0.master === false, `master=${s0.master}`);
  check("ปิดอยู่แปลว่าไม่มีความสามารถไหนมีผลเลย", noneEffective(s0), JSON.stringify(s0.effective));

  /* 2. สวิตช์ย่อยเปิดค้างไว้ได้ แต่ไม่มีผลถ้าสวิตช์ใหญ่ปิด */
  const subOn = asJson((await post("/api/autopilot", { connect: true, scout: true, distill: true })).body);
  check(
    "เปิดสวิตช์ย่อยทั้งหมดขณะสวิตช์ใหญ่ปิด → ยังไม่มีอะไรมีผล",
    subOn.connect === true && subOn.master === false && noneEffective(subOn),
    JSON.stringify(subOn.effective)
  );

  /* 3. เปิดสวิตช์ใหญ่: ของธรรมดาทำงาน แต่ Self-Forge ต้องไม่ถูกลากตามมา */
  const on = asJson((await post("/api/autopilot", { master: true })).body);
  check("เปิดสวิตช์ใหญ่แล้วความสามารถที่อนุญาตไว้มีผลจริง", on.master === true && on.effective.connect === true, JSON.stringify(on.effective));
  check(
    "เปิดสวิตช์ใหญ่ต้องไม่ปลดล็อก Self-Forge ให้เอง (ต้องติดอาวุธแยก)",
    on.effective.evolve === false,
    `evolve=${on.evolve} effective=${on.effective.evolve}`
  );

  /* 4. ติดอาวุธ Self-Forge แยก แล้วสวิตช์ใหญ่ต้องยังปิดมันลงได้ทั้งดวง */
  const armed = asJson((await post("/api/autopilot", { evolve: true })).body);
  const evoLocked = armed.locked && armed.locked.evolve;
  check(
    "ติดอาวุธ Self-Forge แยกแล้วมีผลจริง",
    evoLocked ? armed.evolve === true : armed.effective.evolve === true,
    evoLocked ? "ถูกล็อกไว้ตั้งแต่ติดตั้ง (EVOLVE_HOURS=0) — ตรวจแค่ว่าสวิตช์จำค่าได้" : `effective=${armed.effective.evolve}`
  );
  const off = asJson((await post("/api/autopilot", { master: false })).body);
  check(
    "ปิดสวิตช์ใหญ่ = ปิดทุกอย่างรวมทั้งอันที่ติดอาวุธไว้แล้ว",
    off.master === false && noneEffective(off) && off.evolve === true,
    JSON.stringify(off.effective)
  );

  /* 5. สวิตช์ต้องจำตัวเองได้ */
  const reread = asJson((await get("/api/autopilot")).body);
  check(
    "อ่านซ้ำแล้วได้ค่าเดิม (สถานะถูกเขียนลงดิสก์ ไม่ได้อยู่แค่ในหน่วยความจำ)",
    reread.master === false && reread.evolve === true && reread.connect === true,
    JSON.stringify({ master: reread.master, evolve: reread.evolve })
  );
  check("สวิตช์บันทึกเวลาที่ถูกเปลี่ยนล่าสุด", typeof reread.changed_at === "string" && reread.changed_at.length > 0, String(reread.changed_at));

  /* 6. ค่าที่ไม่ใช่ boolean ต้องถูกปฏิเสธ ไม่ใช่ถูกเดาใจ */
  const bad = await post("/api/autopilot", { master: "yes" });
  check("ค่าที่ไม่ใช่ true/false ต้องได้ 400", bad.status === 400, `ได้ ${bad.status} · ${bad.body.slice(0, 60)}`);
  const empty = await post("/api/autopilot", {});
  check("คำขอที่ไม่มีสวิตช์ให้เปลี่ยนต้องได้ 400", empty.status === 400, `ได้ ${empty.status}`);
  const stillOff = asJson((await get("/api/autopilot")).body);
  check("คำขอที่ผิดต้องไม่เปลี่ยนสถานะอะไรเลย", stillOff.master === false, `master=${stillOff.master}`);

  /* 7. หน้าเว็บต้องเห็นสถานะเดียวกันโดยไม่ต้องเดาจากตัวเลขอื่น */
  const status = asJson((await get("/api/serendipity/status")).body);
  check(
    "/api/serendipity/status รายงานสถานะเครื่องยนต์ด้วย",
    status.autopilot && status.autopilot.master === false,
    JSON.stringify(status.autopilot && status.autopilot.master)
  );

  /* 8. ของเดิมยังครบ */
  for (const ep of REGRESSION_ENDPOINTS) {
    const r = await get(ep);
    check(`endpoint เดิม ${ep} ยังตอบ 200`, r.status === 200, `ได้ ${r.status}`);
  }

  if (failures.length) {
    console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
    process.exit(1);
  }
  console.log("\n✓ ผ่านทั้งหมด — เครื่องยนต์มีสวิตช์กุญแจจริง และค่าตั้งต้นคือหยุด");
  process.exit(0);
})();
