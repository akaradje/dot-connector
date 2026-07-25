/*
 * ไฟล์พิสูจน์ — Layer 14 "The Self-Replacing Process": ตัวที่คิดกับตัวที่เป็น เลิกแยกจากกัน
 *
 * กำแพงที่ถูกทำลาย (lim_0dede0b0): รอบที่ผ่านเขียนไฟล์ใหม่ลงดิสก์ ตั้ง restart_required = true
 * เด้ง toast แล้วรอ ส่วนโปรเซสที่กำลังคิดอยู่ยังเป็นโค้ดเมื่อวาน — ระบบที่ตั้งใจให้ทำงานเองตอนเจ้าของหลับ
 * จึงหลอมตัวเองซ้อนกันได้ทั้งคืนบนดิสก์ โดยที่ตัวซึ่ง *กำลังตัดสินใจ* ไม่ได้เก่งขึ้นแม้แต่รอบเดียว
 *
 * เหตุผลที่มันยังอยู่มาตลอด: การให้โปรเซสฆ่าตัวเองเพื่อเกิดใหม่ด้วยโค้ดที่ตัวเองเพิ่งเขียน
 * โดยไม่มีมนุษย์ดูอยู่ คือความเสี่ยงเดียวที่ถ้าพลาดแล้ว "ไม่มีใครเหลืออยู่ให้กดย้อนกลับ"
 * ชั้นนี้จึงย้ายปุ่มย้อนกลับออกไปนอกโปรเซส: evolution/restart-watchdog.js
 *
 * ข้อที่หนักที่สุดในไฟล์นี้ (ข้อ 4) ไม่ได้เชื่อคำโฆษณา — มันสร้างทรีจำลอง ทำ server.js พังจริง ๆ
 * แล้วรันสุนัขเฝ้าบ้านจริง เพื่อดูว่ามันกู้ทรีที่พังกลับมาได้จริงหรือไม่
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตกการทดสอบนี้: /api/restart/status ไม่มีอยู่ (404)
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { URL } = require("url");

const BASE = process.env.DOT_TEST_URL;
const ROOT = process.env.DOT_TEST_ROOT || path.resolve(__dirname, "..");

if (!BASE) {
  console.error("✗ ต้องรันผ่าน Self-Forge หรือ verifier/audit.js: ไม่พบ DOT_TEST_URL");
  process.exit(2);
}

function get(pathname) {
  return new Promise((resolve) => {
    const u = new URL(pathname, BASE);
    // agent:false โดยตั้งใจ — ไฟล์นี้บล็อกอีเวนต์ลูปหลายวินาทีตอนรันสุนัขเฝ้าบ้านด้วย spawnSync
    // และ Node 19+ เปิด keep-alive เป็นค่าตั้งต้น ซ็อกเก็ตที่ค้างไว้จะถูกฝั่งเซิร์ฟเวอร์ปิดระหว่างนั้น
    // แล้วคำขอถัดไปจะล้มด้วย ECONNRESET ทั้งที่เซิร์ฟเวอร์ปกติดี — ซึ่งจะเป็นการตกที่โกหก
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 15000, agent: false }, (r) => {
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
  /* ---- 1. ช่องว่างระหว่าง "ตัวที่คิด" กับ "ตัวที่เป็น" กลายเป็นตัวเลขที่อ่านได้ ---- */
  const r = await get("/api/restart/status");
  const S = r.json || {};
  check("GET /api/restart/status ตอบ 200 (โค้ดเดิมจะได้ 404)", r.status === 200, `ได้ ${r.status}`);
  check(
    "รายงานตรง ๆ ว่าโค้ดที่กำลังรันคือโค้ดบนดิสก์หรือยัง",
    typeof S.running_is_disk === "boolean" && typeof S.restart_required === "boolean" && S.running_is_disk === !S.restart_required,
    `running_is_disk=${S.running_is_disk} restart_required=${S.restart_required}`
  );
  check("รายงานเวลาที่โปรเซสนี้เกิด — ตัวเลขที่บอกได้ว่ามันคือรุ่นไหน", typeof S.booted_at === "string" && S.booted_at.length > 10, S.booted_at);

  /* ---- 2. รีสตาร์ตอัตโนมัติต้องผูกกับสวิตช์ Layer 9 ไม่ใช่เกิดเองตามใจ ---- */
  const ap = (await get("/api/autopilot")).json || {};
  const shouldArm = ap.master === true && ap.effective && ap.effective.evolve === true;
  check(
    "รีสตาร์ตอัตโนมัติถูกติดอาวุธก็ต่อเมื่อสวิตช์ใหญ่และสวิตช์ Self-Forge เปิดทั้งคู่",
    S.auto_restart && S.auto_restart.armed === shouldArm,
    `armed=${S.auto_restart && S.auto_restart.armed} · master=${ap.master} evolve=${ap.effective && ap.effective.evolve}`
  );
  check(
    "ถ้าไม่ได้ติดอาวุธ ต้องบอกเหตุผลตรง ๆ ว่าเพราะอะไร",
    S.auto_restart.armed === true ? S.auto_restart.reason === null : typeof S.auto_restart.reason === "string",
    `reason=${S.auto_restart.reason}`
  );
  check(
    "มีเส้นตายให้ตัวใหม่ยืนยันตัวเอง และเส้นตายนั้นเป็นตัวเลขจริง",
    Number.isFinite(S.auto_restart.proof_ms) && S.auto_restart.proof_ms >= 10000,
    `${S.auto_restart.proof_ms} ms`
  );

  /* ---- 3. ประวัติการรีสตาร์ตของเครื่องจริงต้องอ่านได้ และมีรูปร่างที่ตรวจสอบได้ ----
     ตรวจก่อนส่วนแซนด์บ็อกซ์ เพราะส่วนนั้น spawn โปรเซสจริงและไม่ควรมีอะไรมาแข่งกับคำขอนี้ */
  check(
    "ประวัติการรีสตาร์ตอ่านได้ และทุกรายการบอกผลลัพธ์ของตัวเอง",
    Array.isArray(S.history) && S.history.every((h) => typeof h.outcome === "string"),
    `${(S.history || []).length} รายการ`
  );

  /* ---- 4. สุนัขเฝ้าบ้านต้องมีอยู่จริง และต้องอยู่นอกโปรเซสที่มันเฝ้า ---- */
  const wd = path.join(ROOT, "evolution", "restart-watchdog.js");
  check("ไฟล์สุนัขเฝ้าบ้านมีอยู่จริงในทรี", fs.existsSync(wd), S.watchdog);
  const wdSrc = fs.existsSync(wd) ? fs.readFileSync(wd, "utf8") : "";
  check(
    "สุนัขเฝ้าบ้านไม่ require server.js — ถ้ามันพังจนโหลดไม่ได้ ตัวเฝ้าก็ต้องยังทำงานได้",
    wdSrc.length > 0 && !/require\(.*server\.js/.test(wdSrc),
    `${wdSrc.split("\n").length} บรรทัด`
  );

  /* ---- 5. ข้อที่สำคัญที่สุด: กู้ทรีที่พังจริงกลับได้จริง ----
     สร้างทรีจำลอง ทำ server.js พังของจริง แล้วรันสุนัขเฝ้าบ้านตัวจริงกับมัน */
  let sandbox = null;
  try {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dot-wd-"));
    const good = "// ทรีที่รู้ว่าทำงานได้\nconsole.log('ok');\n";
    fs.mkdirSync(path.join(sandbox, "evolution", "backups", "evo_rescue", "files"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "evolution", "backups", "evo_rescue", "files", "server.js"), good, "utf8");
    fs.writeFileSync(
      path.join(sandbox, "evolution", "backups", "evo_rescue", "manifest.json"),
      JSON.stringify([{ path: "server.js", existed: true }]),
      "utf8"
    );
    fs.copyFileSync(wd, path.join(sandbox, "evolution", "restart-watchdog.js"));
    // ทรีที่ "รอบใหม่" ทิ้งไว้: พังจน node โหลดไม่ขึ้น
    fs.writeFileSync(path.join(sandbox, "server.js"), "((( นี่คือโค้ดที่รอบใหม่เขียนแล้วพัง\n", "utf8");
    fs.writeFileSync(
      path.join(sandbox, "evolution", "restart.json"),
      JSON.stringify({
        pending: {
          at: new Date().toISOString(),
          reason: "proof: รอบที่เขียนโค้ดพังแล้วรีสตาร์ตตัวเอง",
          evo_id: "evo_rescue",
          backup: "evolution/backups/evo_rescue",
          auto: true,
          pid: 999,
          deadline_ms: 4000,
        },
        history: [],
      }),
      "utf8"
    );

    // พอร์ตที่ไม่มีใครฟัง = ตัวใหม่ไม่มีทางยืนยันตัวเองได้ ซึ่งคือสถานการณ์ที่ต้องกู้
    const run = spawnSync(process.execPath, [path.join(sandbox, "evolution", "restart-watchdog.js")], {
      cwd: sandbox,
      env: { ...process.env, DOT_ROOT: sandbox, DOT_PORT: "1", DOT_DEADLINE_MS: "4000" },
      timeout: 60000,
      encoding: "utf8",
    });
    const after = fs.readFileSync(path.join(sandbox, "server.js"), "utf8");
    const rec = JSON.parse(fs.readFileSync(path.join(sandbox, "evolution", "restart.json"), "utf8"));
    const last = (rec.history || [])[0] || {};

    check(
      "ตัวใหม่ไม่ยืนยันตัวเองภายในเส้นตาย → สุนัขเฝ้าบ้านกู้ทรีเดิมกลับมาจริง",
      after === good,
      after === good ? "ไฟล์ที่พังถูกแทนที่ด้วยเวอร์ชันที่ทำงานได้" : `ไฟล์ยังเป็น: ${after.slice(0, 40)}`
    );
    check("การกู้กลับถูกบันทึกไว้ว่าเกิดอะไรขึ้น ไม่ใช่กู้เงียบ ๆ", last.outcome === "rolled_back" && last.restored_files >= 1, JSON.stringify(last.outcome));
    check("เมื่อจัดการเสร็จ ต้องไม่มีการรีสตาร์ตค้างอยู่ในระบบอีก", rec.pending === null, `pending=${JSON.stringify(rec.pending)}`);
    check("สุนัขเฝ้าบ้านทำงานจนจบและออกด้วยรหัส 0", run.status === 0, `exit ${run.status} ${String(run.stderr || "").slice(0, 120)}`);

    /* ---- 6. และถ้าตัวใหม่มาถึงจริง ต้องไม่ถูกกู้กลับ (ไม่ใช่เฝ้าแบบตื่นตูม) ---- */
    fs.writeFileSync(path.join(sandbox, "server.js"), "// โค้ดใหม่ที่ดีและมาถึงจริง\n", "utf8");
    fs.writeFileSync(path.join(sandbox, "evolution", "restart.json"), JSON.stringify({ pending: null, history: [] }), "utf8");
    const run2 = spawnSync(process.execPath, [path.join(sandbox, "evolution", "restart-watchdog.js")], {
      cwd: sandbox,
      env: { ...process.env, DOT_ROOT: sandbox, DOT_PORT: "1", DOT_DEADLINE_MS: "4000" },
      timeout: 30000,
      encoding: "utf8",
    });
    check(
      "ถ้าตัวใหม่เคลียร์ pending แล้ว (= มาถึงจริง) สุนัขเฝ้าบ้านต้องไม่แตะอะไรเลย",
      run2.status === 0 && fs.readFileSync(path.join(sandbox, "server.js"), "utf8").includes("โค้ดใหม่ที่ดี"),
      "ไฟล์ใหม่ยังอยู่ครบ"
    );
  } catch (e) {
    check("ทดสอบการกู้ทรีที่พังกลับ", false, e.message);
  } finally {
    if (sandbox) {
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
      } catch {}
    }
  }

  /* ---- 7. ของเดิมยังครบ ---- */
  for (const ep of ["/api/dots", "/api/self", "/api/autopilot", "/api/judge", "/api/restart/status"]) {
    const g = await get(ep);
    check(`endpoint เดิม ${ep} ยังตอบ 200`, g.status === 200, `ได้ ${g.status}`);
  }

  if (failures.length) {
    console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
    process.exit(1);
  }
  console.log("\n✓ ผ่านทั้งหมด — เครื่องยนต์เปลี่ยนตัวเองเป็นโค้ดใหม่ได้เอง และมีคนนอกคอยกู้กลับถ้ามันพลาด");
  process.exit(0);
})();
