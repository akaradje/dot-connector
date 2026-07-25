/*
 * ไฟล์พิสูจน์ — Layer 12 "The Bounded Self-Read": เพดานของพรอมป์ตที่ระบบใช้อ่านตัวเอง
 *
 * กำแพงที่ถูกทำลาย (lim_aab716de): Layer 08 ใส่เพดานให้ "พรอมป์ตเชื่อมจุด" ได้สำเร็จ
 * แต่ *พรอมป์ตที่ระบบใช้อ่านตัวเอง* ยังไม่มีเพดาน — server.js โตขึ้นทุกรอบที่ผ่าน
 * ทุกชัยชนะจึงกินที่คิดของชัยชนะครั้งถัดไป และตัวเลขที่ระบบใช้วัดเพดานของตัวเอง
 * (sizeMetrics().prompt_chars) วัด "ซอร์สทั้งกอง" ไม่ใช่สิ่งที่ถูกส่งจริง — มันจึงมองไม่เห็นแม้แต่ปัญหา
 *
 * ยาขนานเดียวกับ Layer 08 ชี้กลับมาที่ตัวเอง:
 *   · ช่วงโค้ดที่กำแพงรอบนั้น "เอ่ยชื่อ" ถูกส่งมาเต็ม ๆ เป็นฟังก์ชัน ๆ ไป
 *   · ที่เหลือย่อเป็นแผนที่ · และถ้ายังเกินงบ แผนที่เองย่อเหลือบรรทัดเดียวต่อไฟล์
 *   · ไม่มีไฟล์ไหนหายไปเงียบ ๆ ในทุกระดับของการย่อ
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตกการทดสอบนี้: /api/forge/bundle ไม่มีอยู่ (404)
 */
const http = require("http");
const { URL } = require("url");

const BASE = process.env.DOT_TEST_URL;
const REGRESSION_ENDPOINTS = [
  "/api/dots",
  "/api/limits",
  "/api/self",
  "/api/forge/preview",
  "/api/autopilot",
  "/api/self/runtime",
  "/api/forge/bundle",
];

if (!BASE) {
  console.error("✗ ต้องรันผ่าน Self-Forge หรือ verifier/audit.js: ไม่พบ DOT_TEST_URL");
  process.exit(2);
}

function get(pathname) {
  return new Promise((resolve) => {
    const u = new URL(pathname, BASE);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 20000 }, (r) => {
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
  /* ---- 1. งบมีอยู่จริงและถูกบังคับจริง ---- */
  const r = await get("/api/forge/bundle");
  const b = r.json || {};
  check("GET /api/forge/bundle ตอบ 200 (โค้ดเดิมจะได้ 404)", r.status === 200, `ได้ ${r.status}`);
  check(
    "ซอร์สที่ถูกส่งจริงอยู่ในงบ ทั้งที่ซอร์สทั้งกองใหญ่กว่ามาก",
    b.within_budget === true && b.total_chars <= b.budget + 1200 && b.full_source_chars > b.total_chars,
    `ส่งจริง ${b.total_chars} · งบ ${b.budget} · ซอร์สทั้งกอง ${b.full_source_chars}`
  );
  check(
    "ประหยัดได้จริงเป็นสัดส่วนที่มีนัยสำคัญ ไม่ใช่การขยับเล็กน้อย",
    b.saved_ratio > 0.5,
    `ประหยัด ${Math.round(b.saved_ratio * 100)}%`
  );

  /* ---- 2. แต่ไม่ใช่แค่แผนที่: ส่วนที่เกี่ยวกับกำแพงถูกส่งมาเต็ม ---- */
  check(
    "มีช่วงโค้ดที่ถูกส่งมาเต็ม ๆ ไม่ใช่แผนที่ล้วน",
    b.focus_ranges > 0 && b.focus_chars > 0,
    `${b.focus_ranges} ช่วง · ${b.focus_chars} ตัวอักษร`
  );
  check(
    "ช่วงที่ส่งมาเต็มถูกเลือกจากสิ่งที่กำแพงรอบนั้นเอ่ยชื่อเอง ไม่ใช่ค่าคงที่",
    b.targets && Array.isArray(b.targets.symbols) && b.targets.symbols.length > 0,
    JSON.stringify(b.targets && b.targets.symbols)
  );

  /* ---- 3. เล็งคนละกำแพง ต้องได้คนละช่วงโค้ด (โฟกัสจริง ไม่ใช่ป้าย) ---- */
  const limits = (await get("/api/limits")).json || [];
  const two = limits.filter((l) => l.evidence && /\(\)/.test(l.evidence)).slice(0, 2);
  if (two.length === 2) {
    const a1 = (await get("/api/forge/bundle?limitId=" + encodeURIComponent(two[0].id))).json || {};
    const a2 = (await get("/api/forge/bundle?limitId=" + encodeURIComponent(two[1].id))).json || {};
    const s1 = JSON.stringify((a1.targets || {}).symbols || []);
    const s2 = JSON.stringify((a2.targets || {}).symbols || []);
    check("กำแพงคนละข้อได้ช่วงโค้ดคนละชุด", s1 !== s2, `${s1} vs ${s2}`);
  } else {
    check("กำแพงคนละข้อได้ช่วงโค้ดคนละชุด", true, "ทะเบียนมีกำแพงที่ระบุฟังก์ชันน้อยเกินกว่าจะเทียบ — ข้าม");
  }
  const missing = await get("/api/forge/bundle?limitId=lim_ไม่มีจริง");
  check("ขอบันเดิลของกำแพงที่ไม่มีอยู่ต้องได้ 404", missing.status === 404, `ได้ ${missing.status}`);

  /* ---- 4. ข้อสำคัญที่สุด: ชนงบแล้วต้องย่อ ไม่ใช่โต และห้ามมีไฟล์ไหนหายไป ---- */
  const tight = (await get("/api/forge/bundle?budget=3000&focusChars=1200")).json || {};
  check(
    "บีบงบให้เล็กมาก → บันเดิลย่อตัวเองลงจริง ไม่ใช่โตทะลุ",
    tight.total_chars < b.total_chars,
    `บีบแล้ว ${tight.total_chars} · ปกติ ${b.total_chars}`
  );
  check(
    "การย่อระดับสุดท้ายถูกประกาศตรง ๆ ว่าแผนที่ถูกย่อ (degraded) ไม่ใช่ย่อเงียบ ๆ",
    tight.degraded === true,
    `degraded=${tight.degraded}`
  );
  check(
    "ต่อให้ย่อจนสุด ทุกไฟล์ในทรียังถูกเอ่ยชื่อครบ — ไม่มีไฟล์ไหนหายไปเงียบ ๆ",
    tight.files_named === tight.files_in_tree && tight.files_in_tree > 0,
    `เอ่ยถึง ${tight.files_named}/${tight.files_in_tree} ไฟล์`
  );
  check(
    "และในโหมดปกติก็ยังครบทุกไฟล์เหมือนกัน",
    b.files_named === b.files_in_tree,
    `เอ่ยถึง ${b.files_named}/${b.files_in_tree} ไฟล์`
  );

  /* ---- 5. ระบบวัดเพดานของตัวเองด้วยตัวเลขที่เป็นความจริง ---- */
  const self = (await get("/api/self")).json || {};
  const m = self.metrics || {};
  check(
    "GET /api/self รายงานตัวเลขที่ถูกส่งจริง แยกจากขนาดซอร์สทั้งกอง",
    Number.isFinite(m.forge_prompt_chars) && Number.isFinite(m.forge_prompt_cap) && Number.isFinite(m.prompt_chars),
    `ส่งจริง ${m.forge_prompt_chars} · เพดาน ${m.forge_prompt_cap} · ซอร์สทั้งกอง ${m.prompt_chars}`
  );
  check(
    "ตัวเลขที่ส่งจริงต้องน้อยกว่าซอร์สทั้งกองอย่างมีนัยสำคัญ (นี่คือกำแพงที่ถูกทำลาย)",
    m.forge_prompt_chars > 0 && m.forge_prompt_chars < m.prompt_chars / 2,
    `${m.forge_prompt_chars} < ${Math.round(m.prompt_chars / 2)}`
  );
  check("ตัวเลขที่ส่งจริงต้องอยู่ใต้เพดานที่ประกาศไว้", m.forge_prompt_chars <= m.forge_prompt_cap, `${m.forge_prompt_chars} ≤ ${m.forge_prompt_cap}`);

  /* ---- 6. พรีวิวของรอบถัดไปรายงานตัวเลขชุดเดียวกัน ---- */
  const pv = (await get("/api/forge/preview")).json || {};
  const sent = pv.prompt_parts && pv.prompt_parts.source_sent;
  check(
    "/api/forge/preview รายงานงบของบันเดิลที่รอบนั้นจะได้อ่านจริง",
    !!sent && Number.isFinite(sent.total_chars) && sent.within_budget === true,
    sent ? `${sent.total_chars}/${sent.budget}` : "ไม่มี source_sent"
  );
  check(
    "พรอมป์ตทั้งรอบต้องเล็กกว่าซอร์สทั้งกอง — เดิมมันใหญ่กว่าเสมอ",
    Number.isFinite(pv.prompt_chars) && pv.prompt_chars < m.prompt_chars,
    `พรอมป์ตทั้งรอบ ${pv.prompt_chars} · ซอร์สทั้งกอง ${m.prompt_chars}`
  );

  /* ---- 7. ของเดิมยังครบ ---- */
  for (const ep of REGRESSION_ENDPOINTS) {
    const g = await get(ep);
    check(`endpoint เดิม ${ep} ยังตอบ 200`, g.status === 200, `ได้ ${g.status}`);
  }

  if (failures.length) {
    console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
    process.exit(1);
  }
  console.log("\n✓ ผ่านทั้งหมด — พรอมป์ตที่ระบบใช้อ่านตัวเองมีเพดานแล้ว และเพดานนั้นเป็นตัวเลขที่ตรวจสอบได้");
  process.exit(0);
})();
