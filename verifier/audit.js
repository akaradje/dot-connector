/*
 * The Dot-Connector AI — Independent Auditor
 *
 * This file lives OUTSIDE the Self-Forge's editable scope (verifier/ is skipped by walkSelf
 * and guarded byte-for-byte like data/). It shares no code with server.js on purpose: the
 * engine's own gates are written by the same model they judge, so a second opinion is only
 * worth something if it cannot be edited by the thing it audits.
 *
 * What it does, from the outside:
 *   1. Boots a throwaway copy of the tree — one fresh server per proof file, so no proof
 *      can pollute the state of the next one (a shared boot makes later proofs fail for
 *      reasons that have nothing to do with the code).
 *   2. Runs every accumulated proof in selftest/ and reports pass/fail per file.
 *   3. Flags rot: proofs that no longer pass, so a suite cannot quietly decay while the
 *      engine keeps stamping rounds "accepted".
 *
 * Usage:  node verifier/audit.js [--json] [--tree <path>]
 * Exit:   0 = every proof passes · 1 = at least one proof is broken · 2 = could not run
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
/* สิ่งที่ไม่ต้องคัดลอกลงทรีชั่วคราว
 * แก้ 25/7/2026 (Layer 13/14/15): เดิมข้าม evolution/ กับ verifier/ ทั้งก้อน ซึ่งเคยถูกตอนที่
 * สองโฟลเดอร์นั้นมีแต่ของที่ไม่จำเป็นต่อการรัน แต่ตอนนี้ verifier/contract.json คือสัญญาที่
 * เซิร์ฟเวอร์ต้องอ่าน และ evolution/restart-watchdog.js คือส่วนหนึ่งของพฤติกรรมที่ต้องพิสูจน์
 * — ทรีที่ขาดสองไฟล์นี้ไม่ใช่สำเนาของระบบ มันคือระบบคนละตัว
 * ที่ยังข้ามคือของหนัก ๆ ที่ไม่มีผลต่อพฤติกรรม: ไฟล์สำรองของทุกรอบ และทรีผู้สมัครที่ค้างอยู่ */
const SKIP = new Set([".git", "node_modules", "lab"]);
/* จาก evolution/ คัดลอกเฉพาะโค้ดที่ทรีต้องใช้เพื่อ "เป็นระบบเดียวกัน" เท่านั้น
 * ส่วนบัญชีทั้งหลาย (การใช้งาน endpoint · การปลดระวาง · การรีสตาร์ต · สวิตช์) ต้อง **ไม่** ถูกคัดลอก:
 * ทรีที่ตรวจต้องเป็นทรีที่เพิ่งเกิด ไม่ใช่ทรีที่สืบทอดประวัติของเครื่องจริงมา — ไม่งั้นไฟล์พิสูจน์ที่
 * ตั้งอยู่บนสมมติฐาน "ยังไม่มีใครเรียกอะไรเลย" จะตกเพราะประวัติ ไม่ใช่เพราะโค้ด */
const EVO_KEEP = new Set(["restart-watchdog.js"]);
const BOOT_TIMEOUT_MS = 30000;
const PROOF_TIMEOUT_MS = 90000;

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const treeArg = argv.indexOf("--tree") >= 0 ? argv[argv.indexOf("--tree") + 1] : null;

function copyTree(src, dst, rel = "") {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const here = rel ? rel + "/" + e.name : e.name;
    if (rel === "evolution" && !EVO_KEEP.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d, here);
    else fs.copyFileSync(s, d);
  }
}

const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (port) =>
  new Promise((res) => {
    const r = http.get({ host: "127.0.0.1", port, path: "/api/dots", timeout: 2000 }, (x) => {
      x.resume();
      res(x.statusCode === 200);
    });
    r.on("timeout", () => {
      r.destroy();
      res(false);
    });
    r.on("error", () => res(false));
  });

// One proof, one fresh engine. Slower than sharing a boot, and that is the point.
async function runOne(tree, proofFile) {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(tree, "server.js")], {
    cwd: tree,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DOT_SELFTEST: "1",
      CHECK_MIN: "999999",
      AUTO_HOURS: "999999",
      EVOLVE_HOURS: "0",
      SCOUT_HOURS: "0",
    },
  });
  let boot = "";
  server.stdout.on("data", (d) => (boot += d));
  server.stderr.on("data", (d) => (boot += d));

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let up = false;
  while (!up && Date.now() < deadline) {
    await wait(500);
    up = await alive(port);
  }
  if (!up) {
    server.kill();
    return { file: proofFile, ok: false, code: null, reason: "เซิร์ฟเวอร์บูตไม่ขึ้น: " + boot.slice(-300).trim() };
  }

  const proof = spawn(process.execPath, [path.join(tree, "selftest", proofFile)], {
    cwd: tree,
    windowsHide: true,
    env: { ...process.env, DOT_TEST_URL: `http://127.0.0.1:${port}`, DOT_TEST_ROOT: tree },
  });
  let out = "";
  proof.stdout.on("data", (d) => (out += d));
  proof.stderr.on("data", (d) => (out += d));

  const killer = setTimeout(() => proof.kill(), PROOF_TIMEOUT_MS);
  const code = await new Promise((r) => {
    proof.on("close", r);
    proof.on("error", () => r(-1));
  });
  clearTimeout(killer);
  server.kill();

  const failed = out
    .split("\n")
    .filter((l) => l.trim().startsWith("✗"))
    .map((l) => l.replace(/^\s*✗\s*/, "").slice(0, 160));
  return { file: proofFile, ok: code === 0, code, failures: failed };
}

(async () => {
  let tree = treeArg;
  let temp = null;
  try {
    if (!tree) {
      temp = fs.mkdtempSync(path.join(os.tmpdir(), "dot-audit-"));
      tree = path.join(temp, "tree");
      copyTree(ROOT, tree);
    }
    const dir = path.join(tree, "selftest");
    if (!fs.existsSync(dir)) {
      console.error("ไม่พบโฟลเดอร์ selftest/ — ยังไม่มีชุดทดสอบให้ตรวจ");
      process.exit(2);
    }
    let files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
    /* Layer 13 runs this file as a gate inside every forge round, so the suite's runtime is
     * now on the critical path of the engine's own evolution. AUDIT_MAX_PROOFS caps it —
     * newest first, because the newest proofs guard the newest code. A cap that hid what it
     * dropped would turn "12 passed" into a sentence that means nothing, so it is reported. */
    const cap = Number(process.env.AUDIT_MAX_PROOFS);
    let skipped = [];
    if (Number.isFinite(cap) && cap > 0 && files.length > cap) {
      const byAge = files
        .map((f) => ({ f, m: (() => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } })() }))
        .sort((a, b) => b.m - a.m);
      const keep = new Set(byAge.slice(0, cap).map((x) => x.f));
      skipped = files.filter((f) => !keep.has(f));
      files = files.filter((f) => keep.has(f));
      console.error(`[audit] จำกัดที่ ${cap} ไฟล์ล่าสุด — ข้าม ${skipped.length}: ${skipped.join(", ")}`);
    }

    const results = [];
    for (const f of files) results.push(await runOne(tree, f));

    const broken = results.filter((r) => !r.ok);
    const report = {
      at: new Date().toISOString(),
      total: results.length,
      skipped,
      passed: results.length - broken.length,
      broken: broken.length,
      results,
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\n  ผู้ตรวจอิสระ — ชุดทดสอบสะสม ${report.total} ไฟล์\n`);
      for (const r of results) {
        console.log(`  ${r.ok ? "✓" : "✗"} ${r.file}${r.ok ? "" : "  (exit " + r.code + ")"}`);
        if (!r.ok) {
          if (r.reason) console.log(`      ${r.reason}`);
          for (const f of (r.failures || []).slice(0, 4)) console.log(`      ↳ ${f}`);
        }
      }
      console.log(
        `\n  ผ่าน ${report.passed}/${report.total}` +
          (broken.length ? `  ⚠ ข้อสอบที่เน่าแล้ว ${broken.length} ไฟล์ — ความสามารถเก่ากำลังผุโดยไม่มีใครรู้` : "  — ไม่มีข้อสอบเน่า") +
          "\n"
      );
    }
    process.exit(broken.length ? 1 : 0);
  } catch (e) {
    console.error("ตรวจไม่สำเร็จ: " + ((e && e.stack) || e));
    process.exit(2);
  } finally {
    if (temp) {
      try {
        fs.rmSync(temp, { recursive: true, force: true });
      } catch {}
    }
  }
})();
