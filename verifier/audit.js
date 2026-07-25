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
const SKIP = new Set([".git", "node_modules", "lab", "evolution", "verifier"]);
const BOOT_TIMEOUT_MS = 30000;
const PROOF_TIMEOUT_MS = 90000;

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const treeArg = argv.indexOf("--tree") >= 0 ? argv[argv.indexOf("--tree") + 1] : null;

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
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
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();

    const results = [];
    for (const f of files) results.push(await runOne(tree, f));

    const broken = results.filter((r) => !r.ok);
    const report = {
      at: new Date().toISOString(),
      total: results.length,
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
