/*
 * ไฟล์พิสูจน์ (capability proof) — รอบที่ทำให้ "ผู้เขียนอยู่ในห้องตอนข้อสอบถูกตรวจ"
 *
 * กำแพงที่ถูกทำลาย: รอบหลอมตัวเองเป็นการยิงนัดเดียวจบ
 *   เดิม attemptEvolution() เรียก runClaude(prompt, {tools:[Read,Edit,Write,Glob,Grep]}) ครั้งเดียว
 *   แล้วโปรเซสของโมเดลก็ตาย · syntaxCheck / smokeTest / proveEvolution / proveConsolidation
 *   ทั้งหมดถูกเรียกหลังจากนั้น · runProof() พิมพ์ stdout จริงของไฟล์พิสูจน์ทิ้งไว้ใน
 *   checks.capability_detail ที่รอบนั้นไม่มีวันได้อ่าน ต้องรอ scar tissue ของรอบถัดไป
 *
 * รอบนี้เปลี่ยนรอบหลอมตัวเองเป็น "ลูปปิด" ที่มีสามชิ้นส่วนแยกจากกันโดยตั้งใจ:
 *   runForgeGates()     รันด่านทั้งชุดกับทรีที่อยู่บนดิสก์ตอนนั้น โดยไม่ย้อนกลับอะไรเลย
 *   buildGateFeedback() แปลงผลด่านเป็นพรอมป์ตเทิร์นถัดไป โดยพา stdout จริงไปทั้งดุ้น
 *   forgeConverge()     ตัวขับลูป: ถาม → ตรวจ → ป้อนกลับ → หยุด (ask/verify ถูกฉีดเข้ามา)
 *
 * ไฟล์นี้ทดสอบ *พฤติกรรมจริง* ผ่าน HTTP โดยเรียก forgeConverge() ตัวเดียวกับที่รอบจริงใช้
 * ผ่าน POST /api/forge/loop/simulate ซึ่งแทนที่เฉพาะ "ผู้ตอบ" และ "ผู้ตรวจ" ด้วยของจำลอง
 * (ไม่เรียก AI · ไม่ออกเน็ต · ไม่เขียนไฟล์) แล้วตรวจว่า:
 *   1. ลูปมีอยู่จริงและตั้งค่าได้ — GET /api/forge/loop บอกเพดานเทิร์นและเครื่องมือของโมเดล
 *   2. stdout จริงของด่านที่ตกในเทิร์นที่ 1 ไปโผล่ใน "พรอมป์ตที่เทิร์นที่ 2 ได้อ่าน" จริง ๆ
 *   3. ลูปหยุดทันทีที่ผ่าน · หยุดเมื่อครบเพดาน · และเทิร์นแรกไม่มีการป้อนกลับ (ยังไม่มีอะไรให้ป้อน)
 *   4. ข้อความที่ป้อนกลับสั่งห้ามแก้กลไกตรวจสอบให้อ่อนลง และบอกจำนวนโอกาสที่เหลือ
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตก: ไม่มี /api/forge/loop และ /api/forge/loop/simulate (404 ทั้งคู่)
 * เพราะรอบหลอมตัวเองของมันไม่มีลูป ไม่มีเทิร์นที่สอง และไม่มีทางส่งผลตรวจถึงโมเดลได้เลย
 *
 * exit 0 = ลูปปิดมีจริงและผลตรวจไหลกลับถึงโมเดลภายในรอบเดียวกัน · exit != 0 = ไม่มี
 */
const http = require("http");
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

/* stdout ปลอมที่เจาะจงพอจะพิสูจน์ได้ว่ามัน "ถูกยกมาทั้งดุ้น" ไม่ใช่ถูกสรุปทิ้ง */
const G1 = "PROBE_144fe35c_GATE1 exit 1 · ✗ endpoint ใหม่ /api/forge/loop ตอบ 404 แทนที่จะเป็น 200";
const G2 = "PROBE_144fe35c_GATE2 endpoint เดิมที่พัง: /api/lessons → 500 (TypeError: x is not a function)";
const G3 = "PROBE_144fe35c_GATE3 ไฟล์พิสูจน์ผ่านกับโค้ดเดิมด้วย — กำแพงนี้ไม่ได้ถูกทำลายจริง";

(async () => {
  /* ---- 1. ลูปปิดมีอยู่จริงและอ่านค่าตั้งต้นของมันได้ (โค้ดเดิมได้ 404) ---- */
  const cfg = await get("/api/forge/loop");
  const C = cfg.json || {};
  check(
    "GET /api/forge/loop ตอบ 200 พร้อมเพดานเทิร์นของรอบหลอมตัวเอง (โค้ดเดิมไม่มีเส้นทางนี้)",
    cfg.status === 200 && Number.isFinite(C.max_turns) && C.max_turns >= 1 && typeof C.enabled === "boolean",
    `ได้ ${cfg.status} · max_turns=${C.max_turns} enabled=${C.enabled}`
  );
  check(
    "รอบเดียวมีได้หลายเทิร์นจริง (ไม่ใช่ยิงนัดเดียวจบ) และเทิร์นซ่อมมีเวลาของตัวเอง",
    C.max_turns > 1 && C.enabled === true && Number.isFinite(C.retry_timeout_ms) && C.retry_timeout_ms > 0,
    `max_turns=${C.max_turns} · retry_timeout_ms=${C.retry_timeout_ms}`
  );
  check(
    "โมเดลได้เครื่องมือรัน node --check ในเทิร์นของตัวเองแล้ว (เดิมมีแค่ Read/Edit/Write/Glob/Grep)",
    Array.isArray(C.tools) && C.tools.some((t) => /^Bash\(node --check/.test(String(t))),
    JSON.stringify(C.tools || [])
  );
  const gateNames = (C.gates || []).map((g) => g.gate);
  check(
    "ระบบประกาศรายชื่อด่านที่ป้อนกลับได้ครบ รวมด่านของรอบยุบรวมด้วย",
    ["capability", "differential", "regression", "syntax", "smoke", "preservation", "shrink"].every((g) =>
      gateNames.includes(g)
    ),
    gateNames.join(", ")
  );
  check("บันทึกเทิร์นของรอบที่ผ่านมาเปิดอ่านได้", Array.isArray(C.rounds), `rounds=${(C.rounds || []).length}`);

  /* ---- 2. หัวใจของรอบนี้: ผลตรวจจริงของเทิร์นที่ 1 ต้องไปถึงเทิร์นที่ 2 ---- */
  const conv = await post("/api/forge/loop/simulate", {
    max_turns: 3,
    turns: [
      { failed_gates: ["capability"], detail: G1 },
      { failed_gates: ["regression"], detail: G2 },
      { failed_gates: [] },
    ],
  });
  const V = conv.json || {};
  const T = V.turns || [];
  check(
    "POST /api/forge/loop/simulate รันตัวขับลูปตัวจริงได้โดยไม่ต้องเรียก AI (โค้ดเดิมได้ 404)",
    conv.status === 200 && T.length === 3 && V.ok === true && V.stopped === "passed",
    `ได้ ${conv.status} · ${T.length} เทิร์น · stopped=${V.stopped}`
  );
  check(
    "เทิร์นแรกไม่มีอะไรถูกป้อนกลับ (ยังไม่มีผลตรวจให้ป้อน)",
    T[0] && T[0].prompt_received === null && T[0].fed_back_chars === 0 && T[0].ok === false,
    `prompt_received=${T[0] ? JSON.stringify(T[0].prompt_received) : "?"} fed_back=${T[0] && T[0].fed_back_chars}`
  );
  const t2 = String((T[1] || {}).prompt_received || "");
  check(
    "stdout จริงของด่านที่ตกในเทิร์นที่ 1 ถูกยกไปให้เทิร์นที่ 2 อ่านทั้งดุ้น",
    t2.includes(G1),
    t2 ? `เทิร์นที่ 2 ได้อ่าน ${t2.length} ตัวอักษร` : "(เทิร์นที่ 2 ไม่ได้รับอะไรเลย)"
  );
  check(
    "ข้อความที่ป้อนกลับบอกชัดว่ายังอยู่รอบเดิมและโค้ดยังไม่ถูกย้อนกลับ",
    /รอบเดียวกัน/.test(t2) && /ยังไม่ถูกย้อนกลับ/.test(t2) && /ตกที่ด่าน/.test(t2),
    t2.slice(0, 80)
  );
  check(
    "ข้อความที่ป้อนกลับสั่งห้ามแก้กลไกตรวจสอบให้อ่อนลง และนับโอกาสที่เหลือถูกต้อง (เทิร์น 1/3 → เหลืออีก 2)",
    /ห้ามแก้กลไกตรวจสอบให้อ่อนลง/.test(t2) && /เหลือโอกาสแก้ในรอบนี้อีก 2 ครั้ง/.test(t2),
    /เหลือโอกาสแก้ในรอบนี้อีก 2 ครั้ง/.test(t2) ? "นับโอกาสที่เหลือถูกต้อง" : "ไม่พบการนับโอกาสที่เหลือที่ถูกต้อง"
  );
  const t3 = String((T[2] || {}).prompt_received || "");
  check(
    "ด่านที่ตกในเทิร์นที่ 2 (คนละด่านกับเทิร์นแรก) ถูกป้อนต่อให้เทิร์นที่ 3",
    t3.includes(G2) && !t3.includes(G1),
    t3 ? `เทิร์นที่ 3 ได้อ่าน ${t3.length} ตัวอักษร` : "(เทิร์นที่ 3 ไม่ได้รับอะไรเลย)"
  );
  check(
    "ลูปบันทึกว่าแต่ละเทิร์นตกที่ด่านไหน และเทิร์นสุดท้ายผ่าน",
    T[0].failed_gates.join() === "capability" &&
      T[1].failed_gates.join() === "regression" &&
      T[2].ok === true &&
      T[2].failed_gates.length === 0,
    T.map((t) => `#${t.turn}:${t.ok ? "ผ่าน" : t.failed_gates.join("+")}`).join(" → ")
  );
  check(
    "จำนวนตัวอักษรที่ป้อนเข้า/ออกแต่ละเทิร์นถูกบันทึกไว้ให้ตรวจย้อนหลังได้",
    T[0].fed_forward_chars > 0 && T[1].fed_back_chars === T[0].fed_forward_chars,
    `เทิร์น 1 ส่งต่อ ${T[0].fed_forward_chars} ตัวอักษร → เทิร์น 2 รับ ${T[1].fed_back_chars}`
  );

  /* ---- 3. ลูปต้องหยุดถูกจังหวะทั้งสองทาง ---- */
  const once = await post("/api/forge/loop/simulate", { max_turns: 3, turns: [{ failed_gates: [] }] });
  const O = once.json || {};
  check(
    "ผ่านตั้งแต่เทิร์นแรก = จบทันที ไม่เผาเทิร์นที่เหลือ",
    once.status === 200 && (O.turns || []).length === 1 && O.ok === true && O.stopped === "passed",
    `${(O.turns || []).length} เทิร์น · stopped=${O.stopped}`
  );
  const dead = await post("/api/forge/loop/simulate", {
    max_turns: 2,
    turns: [{ failed_gates: ["differential"], detail: G3 }, { failed_gates: ["differential"], detail: G3 }],
  });
  const D = dead.json || {};
  check(
    "ตกครบเพดานเทิร์น = หยุดและตีตก (ลูปนี้วนไม่รู้จบไม่ได้)",
    dead.status === 200 && (D.turns || []).length === 2 && D.ok === false && D.stopped === "exhausted",
    `${(D.turns || []).length} เทิร์น · ok=${D.ok} · stopped=${D.stopped}`
  );
  const lastFeed = String(((D.turns || [])[1] || {}).prompt_received || "");
  check(
    "เทิร์นสุดท้ายถูกบอกตรง ๆ ว่าเป็นโอกาสสุดท้าย และได้เหตุผลจริงของด่าน differential",
    lastFeed.includes(G3) && /โอกาสสุดท้ายของรอบนี้/.test(lastFeed),
    lastFeed ? `${lastFeed.length} ตัวอักษร` : "(ไม่มีการป้อนกลับ)"
  );

  /* ---- 4. รอบยุบรวมใช้ลูปเดียวกัน แต่ถูกบอกว่ากติกากลับด้าน ---- */
  const cons = await post("/api/forge/loop/simulate", {
    mode: "consolidation",
    max_turns: 2,
    turns: [{ failed_gates: ["preservation", "shrink"], detail: "PROBE_144fe35c_CONS ชุดทดสอบพลิกผล 1 ไฟล์" }, { failed_gates: [] }],
  });
  const K = cons.json || {};
  const consFeed = String(((K.turns || [])[1] || {}).prompt_received || "");
  check(
    "รอบยุบรวมก็ได้ผลตรวจกลับเข้ารอบเดียวกัน และข้อความบอกว่ากติกากลับด้าน",
    cons.status === 200 &&
      K.mode === "consolidation" &&
      consFeed.includes("PROBE_144fe35c_CONS") &&
      /รอบยุบรวม/.test(consFeed) &&
      /shrink/.test(consFeed),
    consFeed ? `${consFeed.length} ตัวอักษร · ตก ${(K.turns || [])[0].failed_gates.join("+")}` : "(ไม่มีการป้อนกลับ)"
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
    "/api/consolidation/preview",
    "/api/endpoints",
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
    if (failures.length) {
      console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
      process.exit(1);
    }
    console.log("\n✓ ผ่านทั้งหมด — ผลตรวจจริงไหลกลับถึงโมเดลภายในรอบเดียวกันแล้ว ผู้เขียนไม่ได้ออกจากห้องก่อนข้อสอบถูกตรวจอีกต่อไป");
    process.exit(0);
  });
