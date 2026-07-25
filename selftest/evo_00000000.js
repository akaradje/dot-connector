/*
 * ไฟล์พิสูจน์ (capability proof) — รอบที่เปลี่ยนฟังก์ชันความเหมาะสมของ Layer 6
 * จาก "ไม่ตาย" (syntax ผ่าน + บูตแล้วตอบ 200) เป็น "เก่งขึ้นจริง"
 *
 * ไฟล์นี้เป็น "ตัวอย่างสัญญา" ให้รอบวิวัฒนาการถัด ๆ ไปเขียนตาม:
 *   - รับ base URL ของเซิร์ฟเวอร์ที่กำลังถูกทดสอบจาก process.env.DOT_TEST_URL
 *   - รับพาธของซอร์สทรีที่กำลังถูกทดสอบจาก process.env.DOT_TEST_ROOT (ห้ามใช้พาธตายตัว)
 *   - ทดสอบ "พฤติกรรมจริง" ผ่าน HTTP ไม่ใช่การ grep หาชื่อฟังก์ชันในซอร์ส
 *   - exit 0 = ความสามารถใหม่มีจริง · exit != 0 = ไม่มี
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตกการทดสอบนี้: มันยังไม่มี /api/evolution/proof
 * คำขอจึงตกไปที่ 404 "not found" ทั่วไป แทนที่จะเป็น 400 สำหรับ evoId ผิดรูปแบบ
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
];

if (!BASE) {
  console.error("✗ ต้องรันผ่าน Self-Forge: ไม่พบ DOT_TEST_URL");
  process.exit(2);
}

function get(pathname) {
  return new Promise((resolve) => {
    const u = new URL(pathname, BASE);
    const req = http.get(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 8000 },
      (r) => {
        let body = "";
        r.setEncoding("utf8");
        r.on("data", (d) => (body += d));
        r.on("end", () => resolve({ status: r.statusCode, body }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
  });
}

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

(async () => {
  // 1. ความสามารถใหม่: อ่านไฟล์พิสูจน์ของแต่ละรอบวิวัฒนาการได้ผ่าน API
  const bad = await get("/api/evolution/proof?evoId=ไม่ใช่รหัสรอบ");
  check("evoId ผิดรูปแบบต้องได้ 400 (โค้ดเดิมจะได้ 404 not found)", bad.status === 400, `ได้ ${bad.status}`);

  const missing = await get("/api/evolution/proof?evoId=evo_ffffffff");
  const mj = asJson(missing.body);
  check(
    "รอบที่ไม่มีไฟล์พิสูจน์ต้องได้ 404 พร้อมเหตุผลเฉพาะเจาะจง",
    missing.status === 404 && /ไฟล์พิสูจน์/.test(mj.error || ""),
    `ได้ ${missing.status} · ${mj.error || missing.body.slice(0, 80)}`
  );

  // 2. ความสามารถเดิมต้องครบ — กฎ "ห้ามทำให้ของเดิมพัง" ที่บังคับด้วยโค้ด ไม่ใช่แค่พรอมป์ต์
  for (const ep of REGRESSION_ENDPOINTS) {
    const r = await get(ep);
    check(`endpoint เดิม ${ep} ยังตอบ 200`, r.status === 200, `ได้ ${r.status}`);
  }

  // 3. ledger ต้องยังเป็น array ที่อ่านได้ (โครงสร้างความทรงจำไม่ถูกทำพัง)
  const evo = await get("/api/evolution");
  check("/api/evolution คืนค่าเป็น array", Array.isArray(asJson(evo.body)), evo.body.slice(0, 60));

  if (failures.length) {
    console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
    process.exit(1);
  }
  console.log("\n✓ ผ่านทั้งหมด — ความสามารถใหม่ใช้ได้จริงและของเดิมยังครบ");
  process.exit(0);
})();
