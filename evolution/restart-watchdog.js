/*
 * The Dot-Connector AI — Restart Watchdog (Layer 14)
 *
 * ทำไมต้องมีไฟล์นี้: การให้โปรเซสฆ่าตัวเองเพื่อเกิดใหม่ด้วยโค้ดที่ตัวเองเพิ่งเขียน โดยไม่มีมนุษย์ดูอยู่
 * คือความเสี่ยงเดียวที่ถ้าพลาดแล้ว "ไม่มีใครเหลืออยู่ให้กดย้อนกลับ" — เพราะคนที่จะกดย้อนกลับ คือคนที่ตายไปแล้ว
 *
 * ไฟล์นี้จึงเป็นบุคคลที่สาม: ถูก spawn แบบ detached ก่อนที่โปรเซสเก่าจะปิดตัว ไม่ใช้หน่วยความจำร่วมกับใคร
 * ไม่ require server.js (ถ้ามันพังจนโหลดไม่ได้ ตัวเฝ้าก็ต้องยังทำงานได้) และรอดชีวิตอยู่ต่อทั้งจากตัวที่ตาย
 * และตัวที่กำลังจะเกิด
 *
 * สัญญา:
 *   1. อ่าน evolution/restart.json หา pending — ถ้าไม่มี ก็ไม่มีอะไรให้เฝ้า จบ
 *   2. รอให้ตัวใหม่ตอบ /api/dots ภายใน DOT_DEADLINE_MS แล้ว "เคลียร์ pending" ด้วยตัวมันเอง
 *   3. ถ้าหมดเวลาแล้ว pending ยังอยู่ = ตัวใหม่ไม่เคยมาถึงจริง → กู้ไฟล์สำรองของรอบนั้นกลับ
 *      แล้วบูตทรีที่รู้ว่าเคยทำงานได้ · บันทึกผลลง history ทุกกรณี
 *
 * รันเองก็ได้:  node evolution/restart-watchdog.js
 * ตัวแปร:      DOT_PORT · DOT_ROOT · DOT_DEADLINE_MS
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = process.env.DOT_ROOT || path.resolve(__dirname, "..");
const PORT = Number(process.env.DOT_PORT || 4747);
const DEADLINE_MS = Math.max(5000, Number(process.env.DOT_DEADLINE_MS || 45000));
const RESTART_FILE = path.join(ROOT, "evolution", "restart.json");
const POLL_MS = 1500;

function readRec() {
  try {
    return JSON.parse(fs.readFileSync(RESTART_FILE, "utf8"));
  } catch {
    return { pending: null, history: [] };
  }
}
function writeRec(rec) {
  rec.history = (rec.history || []).slice(-30);
  fs.writeFileSync(RESTART_FILE, JSON.stringify(rec, null, 2), "utf8");
}
function alive() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/dots", timeout: 2500 }, (r) => {
      r.resume();
      resolve(r.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* กู้ไฟล์สำรองของรอบกลับ — สำเนาตรรกะของ restoreBackup() ใน server.js โดยตั้งใจ
 * ตัวเฝ้าต้องทำงานได้แม้ server.js จะพังจนโหลดไม่ขึ้น ซึ่งเป็นกรณีเดียวที่มันถูกเรียกใช้จริง */
function restoreBackup(evoId) {
  const dir = path.join(ROOT, "evolution", "backups", evoId);
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, restored: 0, error: "ไม่พบไฟล์สำรองของรอบนี้" };
  }
  let restored = 0;
  for (const m of manifest) {
    const target = path.join(ROOT, m.path);
    try {
      if (m.existed) {
        const src = path.join(dir, "files", m.path);
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(src, target);
          restored++;
        }
      } else if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        restored++;
      }
    } catch {}
  }
  return { ok: true, restored };
}

(async () => {
  const start = Date.now();
  const rec0 = readRec();
  if (!rec0.pending) {
    console.log("[watchdog] ไม่มีการรีสตาร์ตที่ค้างอยู่ — ไม่มีอะไรให้เฝ้า");
    process.exit(0);
  }
  const pending = rec0.pending;
  console.log(`[watchdog] เฝ้าการรีสตาร์ต ${pending.reason || ""} (deadline ${DEADLINE_MS}ms)`);

  while (Date.now() - start < DEADLINE_MS) {
    await sleep(POLL_MS);
    // ตัวใหม่เป็นคนเคลียร์ pending เอง — การหายไปของมันคือหลักฐานว่าตัวใหม่ "มาถึงจริง"
    // ไม่ใช่แค่ port เปิด ซึ่งอาจเป็นตัวเก่าที่ยังไม่ตายก็ได้
    if (!readRec().pending) {
      console.log("[watchdog] ตัวใหม่ยืนยันตัวเองแล้ว — เลิกเฝ้า");
      process.exit(0);
    }
  }

  // หมดเวลา และ pending ยังอยู่: ตัวใหม่ไม่เคยมาถึง
  const up = await alive();
  const rec = readRec();
  if (!rec.pending) process.exit(0);

  const outcome = { ...rec.pending, failed_at: new Date().toISOString(), port_answered: up };
  if (!pending.evo_id) {
    // รีสตาร์ตที่ไม่ผูกกับรอบไหน (เช่นคนกดปุ่มเอง) — ไม่มีอะไรให้กู้ ปลุกทรีเดิมขึ้นมาใหม่พอ
    outcome.outcome = up ? "late" : "no_backup";
    rec.pending = null;
    rec.history.push(outcome);
    writeRec(rec);
    if (!up) {
      console.log("[watchdog] ตัวใหม่ไม่ตอบและไม่มีรอบให้ย้อนกลับ — ปลุกเซิร์ฟเวอร์ขึ้นใหม่");
      spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
    process.exit(0);
  }

  console.log(`[watchdog] ⚠ ตัวใหม่ไม่ยืนยันตัวเองใน ${DEADLINE_MS}ms — กู้รอบ ${pending.evo_id} กลับ`);
  const r = restoreBackup(pending.evo_id);
  outcome.outcome = r.ok ? "rolled_back" : "rollback_failed";
  outcome.restored_files = r.restored || 0;
  outcome.error = r.error || null;
  rec.pending = null;
  rec.history.push(outcome);
  writeRec(rec);

  // แล้วปลุกทรีที่รู้ว่าเคยทำงานได้ขึ้นมา — จบด้วยเครื่องยนต์ที่ยังมีชีวิต ไม่ใช่เครื่องเงียบ
  spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true }).unref();
  console.log(`[watchdog] กู้กลับ ${r.restored || 0} ไฟล์ แล้วบูตเวอร์ชันเดิมขึ้นมาใหม่`);
  process.exit(0);
})();
