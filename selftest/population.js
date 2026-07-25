/*
 * ไฟล์พิสูจน์ — Layer 15 "A Population Greater Than One": วิวัฒนาการที่เลิกไต่เขาด้วยมือเดียว
 *
 * กำแพงที่ถูกทำลาย (lim_5d5ed3d3): หนึ่งรอบ = หนึ่งกำแพง หนึ่งแนวทาง หนึ่งสายเลือด
 * ตัวแปร forging กันไม่ให้มีรอบซ้อนกันได้เลย และไม่มีที่ใดในระบบที่สร้าง "ผู้สมัคร" หลายตัว
 * แล้วเลือกตัวที่ดีที่สุด ทั้งที่กลไกแซนด์บ็อกซ์ (materializeTree + bootServer บนพอร์ตสุ่ม)
 * พร้อมสำหรับการรันคู่ขนานมาตั้งแต่ชั้น 6 — แนวทางแรกพลาดคือเสียทั้งรอบและหนึ่งโควตาของกำแพง
 *
 * ไฟล์นี้ตรวจสองชั้นแยกกัน เพราะมันพังคนละแบบ:
 *   · ตรรกะการ "เลือก" — ผ่าน /api/forge/population/simulate ด้วยผู้สมัครสมมติ (ไม่มีอะไรจริง)
 *   · เครื่องจักรการ "แข่ง" — ผ่าน /api/forge/population/dryrun ซึ่งสร้างสำเนาทรีจริง
 *     บูตเซิร์ฟเวอร์จริง กวาด endpoint จริง โดยแทนที่เฉพาะเซสชัน AI ด้วยตัวปลอม
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตกการทดสอบนี้: /api/forge/population ไม่มีอยู่ (404)
 */
const http = require("http");
const { URL } = require("url");

const BASE = process.env.DOT_TEST_URL;
if (!BASE) {
  console.error("✗ ต้องรันผ่าน Self-Forge หรือ verifier/audit.js: ไม่พบ DOT_TEST_URL");
  process.exit(2);
}

function request(method, pathname, body, timeout = 240000) {
  return new Promise((resolve) => {
    const u = new URL(pathname, BASE);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        timeout,
        agent: false,
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
const post = (p, b, t) => request("POST", p, b === undefined ? {} : b, t);

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(name);
}

(async () => {
  /* ---- 1. ประชากรเลิกเท่ากับหนึ่ง ---- */
  const r = await get("/api/forge/population");
  const P = r.json || {};
  check("GET /api/forge/population ตอบ 200 (โค้ดเดิมจะได้ 404)", r.status === 200, `ได้ ${r.status}`);
  check(
    "ค่าตั้งต้นของประชากรต้องมากกว่าหนึ่ง — นี่คือกำแพงที่ถูกทำลาย",
    P.k > 1 && P.enabled === true,
    `k=${P.k} enabled=${P.enabled}`
  );
  check(
    "แต่ละผู้สมัครถูกบังคับให้เดินคนละแนวทาง ไม่ใช่สุ่มโมเดลเดิมซ้ำ",
    Array.isArray(P.angles) && P.angles.length >= P.k && new Set(P.angles).size === P.angles.length,
    `${(P.angles || []).length} แนวทางที่ไม่ซ้ำกัน`
  );
  check("ปิดกลับไปเป็นพฤติกรรมเดิมได้ (ประกาศตัวแปรไว้ตรง ๆ)", P.env === "FORGE_POPULATION" && P.max >= P.k, `env=${P.env} max=${P.max}`);

  /* ---- 2. ตรรกะการเลือก: ผ่านด่านมาก่อน แล้วค่อยเล็กที่สุด ---- */
  const sim = await post("/api/forge/population/simulate", {
    candidates: [
      { index: 1, files: 5, score: { capability: true } },
      { index: 2, files: 2, score: { capability: true } },
      { index: 3, files: 1, score: { capability: false } },
    ],
  });
  const S = sim.json || {};
  check("POST /api/forge/population/simulate ตอบ 200", sim.status === 200, `ได้ ${sim.status}`);
  check(
    "ผู้สมัครที่แตะไฟล์น้อยที่สุดแต่พิสูจน์ไม่ผ่าน ต้องไม่ชนะ",
    S.winner && S.winner.index !== 3,
    `ผู้ชนะคือ #${S.winner && S.winner.index}`
  );
  check(
    "ในบรรดาคนที่ผ่านด่าน ผู้ชนะคือคนที่เปลี่ยนโค้ดน้อยที่สุด",
    S.winner && S.winner.index === 2 && S.passed === 2,
    `ผู้ชนะ #${S.winner && S.winner.index} · ผ่าน ${S.passed}/${S.total}`
  );
  check(
    "ผู้แพ้ทุกคนถูกส่งกลับมาด้วย ไม่ใช่ถูกทิ้งเงียบ ๆ (พวกเขาคือแผลเป็นของรอบนี้)",
    Array.isArray(S.losers) && S.losers.length === 2,
    `${(S.losers || []).length} คน`
  );
  const none = await post("/api/forge/population/simulate", {
    candidates: [{ index: 1, files: 1, score: { capability: false } }],
  });
  check(
    "ถ้าไม่มีใครผ่านเลย ต้องไม่มีผู้ชนะ — การแข่งไม่ใช่การบังคับให้เลือก",
    none.json && none.json.winner === null,
    JSON.stringify(none.json && none.json.why)
  );
  const empty = await post("/api/forge/population/simulate", { candidates: [] });
  check("ส่งผู้สมัครเปล่ามาต้องได้ 400", empty.status === 400, `ได้ ${empty.status}`);

  /* ---- 3. เครื่องจักรการแข่งจริง: ทรีจริง บูตจริง กวาดจริง ---- */
  const rootBefore = (await get("/api/self")).json || {};
  const dry = await post("/api/forge/population/dryrun", { k: 3 }, 240000);
  const D = dry.json || {};
  check("POST /api/forge/population/dryrun ตอบ 200", dry.status === 200, `ได้ ${dry.status} · ${dry.body.slice(0, 120)}`);
  check(
    "ผู้สมัครทุกคนถูกสร้างเป็นสำเนาทรีของตัวเอง และถูกให้คะแนนแยกกัน",
    Array.isArray(D.candidates) && D.candidates.length === 3 && D.candidates.every((c) => c.score),
    `${(D.candidates || []).length} คน · ${D.took_ms} ms`
  );
  const good = (D.candidates || []).find((c) => c.index === 1) || {};
  const bad = (D.candidates || []).filter((c) => c.index > 1);
  check(
    "ผู้สมัครที่เขียนโค้ดใช้ได้ ต้องบูตผ่านและกวาด endpoint เดิมผ่านในแซนด์บ็อกซ์ของตัวเอง",
    good.score && good.score.syntax === true && good.score.boot === true && good.score.regression === true,
    JSON.stringify(good.score && { syntax: good.score.syntax, boot: good.score.boot, regression: good.score.regression })
  );
  check(
    "ผู้สมัครที่เขียนโค้ดพัง ต้องตกตั้งแต่ syntax และไม่ถูกนับว่าผ่าน",
    bad.length >= 1 && bad.every((c) => c.score.syntax === false && c.score.boot === false),
    `${bad.length} คนที่เขียนพัง`
  );
  check(
    "ผู้สมัครที่บูตได้แต่ไม่ได้เขียนไฟล์พิสูจน์ ต้องไม่ผ่านด่านความสามารถ",
    good.score && good.score.capability === false && /ไฟล์พิสูจน์/.test(good.score.detail || ""),
    good.score && good.score.detail
  );
  check("การซ้อมทั้งหมดจบโดยไม่มีใครชนะ เพราะไม่มีใครพิสูจน์อะไรได้", D.winner === null && D.passed === 0, `winner=${D.winner}`);

  /* ---- 4. ข้อที่สำคัญที่สุดด้านความปลอดภัย: ROOT ต้องไม่ถูกแตะระหว่างการแข่ง ---- */
  const rootAfter = (await get("/api/self")).json || {};
  check(
    "ทรีจริงไม่ถูกแตะเลยตลอดการแข่ง — ผู้แพ้ทิ้งอะไรไว้ในระบบไม่ได้",
    Number.isFinite(D.root_untouched) &&
      rootBefore.metrics &&
      rootAfter.metrics &&
      rootBefore.metrics.code_chars === rootAfter.metrics.code_chars &&
      rootBefore.total_lines === rootAfter.total_lines,
    `ก่อน ${rootBefore.metrics && rootBefore.metrics.code_chars} · หลัง ${rootAfter.metrics && rootAfter.metrics.code_chars} ตัวอักษร`
  );

  /* ---- 5. ของเดิมยังครบ ---- */
  for (const ep of ["/api/dots", "/api/self", "/api/limits", "/api/judge", "/api/restart/status", "/api/forge/population"]) {
    const g = await get(ep);
    check(`endpoint เดิม ${ep} ยังตอบ 200`, g.status === 200, `ได้ ${g.status}`);
  }

  if (failures.length) {
    console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
    process.exit(1);
  }
  console.log("\n✓ ผ่านทั้งหมด — หนึ่งรอบมีได้หลายสายเลือด แข่งกันในแซนด์บ็อกซ์จริง แล้วรับเพียงคนเดียว");
  process.exit(0);
})();
