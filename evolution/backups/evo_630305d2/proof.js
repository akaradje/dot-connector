/*
 * ไฟล์พิสูจน์ (capability proof) — รอบที่ต่อ "เส้นตอบกลับ" ให้ระบบ
 *
 * กำแพงที่ถูกทำลาย: ผลลัพธ์ของนวัตกรรมไม่เคยไหลกลับเข้าไปเปลี่ยนวิธีเลือกจุดในครั้งถัดไป
 * สัญญาณเดียวที่เคยไหลย้อนกลับคือรายชื่อ "ห้ามซ้ำ" ซึ่งเป็นลบล้วน และ rarity ให้ค่าตาม
 * "เวลาที่ไม่ถูกใช้" ไม่ใช่ "คุณภาพของผลลัพธ์ที่จุดนั้นเคยให้"
 *
 * ไฟล์นี้ทดสอบพฤติกรรมจริงผ่าน HTTP ว่าเส้นตอบกลับต่อครบวงจรแล้ว:
 *   1. POST /api/outcome บันทึกผลลัพธ์จริงของการเชื่อมได้ (และเขียนลงดิสก์จริง)
 *   2. ผลลัพธ์นั้น "ย้อนกลับ" ไปเปลี่ยนคะแนนของจุดที่พาไปสู่ผลนั้นทันที
 *      — ให้คะแนนแย่ → value_score/attention_score ของจุดลดลง
 *      — ให้คะแนนดี  → กลับขึ้นสูงกว่าเดิม
 *   3. GET /api/lessons คือสิ่งที่รอบถัดไปจะถูกบอก — เปลี่ยนจาก "ทางตัน" เป็น "ได้ผลจริง"
 *      ตามผลที่เพิ่งบันทึก (แทนบัญชีดำรายชื่อ)
 *
 * โค้ดเดิมก่อนรอบนี้ต้องตก: มันไม่มี /api/outcome และ /api/lessons (ได้ 404 not found)
 * และ /api/dots ของมันไม่มีสนาม value_score / attention_score / rated_uses เลย
 *
 * exit 0 = เส้นตอบกลับมีจริงและใช้ได้ · exit != 0 = ไม่มี
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const BASE = process.env.DOT_TEST_URL;
const ROOT = process.env.DOT_TEST_ROOT;

if (!BASE || !ROOT) {
  console.error("✗ ต้องรันผ่าน Self-Forge: ไม่พบ DOT_TEST_URL หรือ DOT_TEST_ROOT");
  process.exit(2);
}

function request(method, pathname, payload) {
  return new Promise((resolve) => {
    const u = new URL(pathname, BASE);
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload), "utf8");
    const req = http.request(
      {
        method,
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        timeout: 8000,
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
const post = (p, payload) => request("POST", p, payload);

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(name);
}
const num = (x) => (typeof x === "number" && Number.isFinite(x));

(async () => {
  /* ---- 1. ความสามารถใหม่: ระบบมีช่องบันทึกผลลัพธ์ และมีบทเรียนให้รอบถัดไปอ่าน ---- */
  const lessons0 = await get("/api/lessons");
  const l0 = lessons0.json || {};
  check(
    "GET /api/lessons ตอบ 200 (โค้ดเดิมไม่มี endpoint นี้ จะได้ 404)",
    lessons0.status === 200 && Array.isArray(l0.lessons) && !!l0.summary,
    `ได้ ${lessons0.status} · ${lessons0.body.slice(0, 90)}`
  );
  check(
    "สรุปบทเรียนมีตัวนับผลตอบกลับครบ (with_feedback/worked/died/untested)",
    !!l0.summary &&
      num(l0.summary.with_feedback) &&
      num(l0.summary.worked) &&
      num(l0.summary.died) &&
      num(l0.summary.untested),
    JSON.stringify(l0.summary || {})
  );

  /* ---- 2. ทุกจุดต้องมีคะแนนคุณค่าจากผลลัพธ์จริง ไม่ใช่แค่ rarity ตามเวลา ---- */
  const dots0 = await get("/api/dots");
  const D0 = Array.isArray(dots0.json) ? dots0.json : [];
  check(
    "GET /api/dots ให้ value_score / attention_score / rated_uses ทุกจุด (โค้ดเดิมมีแต่ rarity)",
    dots0.status === 200 && D0.every((d) => num(d.value_score) && num(d.attention_score) && num(d.rated_uses)),
    `จุดทั้งหมด ${D0.length} จุด · ตัวอย่าง ${JSON.stringify(D0[0] ? { rarity: D0[0].rarity, value_score: D0[0].value_score, attention_score: D0[0].attention_score } : {})}`
  );
  check(
    "attention_score ต้องคำนวณจาก rarity ร่วมกับ value_score ไม่ใช่ rarity ล้วน",
    dots0.status === 200 &&
      D0.every((d) => Math.abs(d.attention_score - (d.rarity + 1) * (1 + d.value_score)) < 0.02),
    "ตรวจสูตร (rarity + 1) × (1 + value_score) กับทุกจุด"
  );

  /* ---- 3. ค่าที่ไม่ถูกต้องต้องถูกปฏิเสธอย่างเจาะจง ---- */
  const noConn = await post("/api/outcome", { connectionId: "conn_ไม่มีจริง", rating: 5, status: "shipped" });
  check("POST /api/outcome กับการเชื่อมที่ไม่มีอยู่ ต้องได้ 404 พร้อมเหตุผล", noConn.status === 404, `ได้ ${noConn.status}`);

  /* ---- 4. หัวใจของรอบนี้: ผลลัพธ์จริงต้องไหลย้อนกลับไปเปลี่ยนน้ำหนักของจุด ---- */
  const conns = await get("/api/connections");
  const C = Array.isArray(conns.json) ? conns.json : [];
  const liveIds = new Set(D0.map((d) => d.id));
  const target = C.find((c) => (c.selected_dots || []).some((sd) => liveIds.has(sd.id)));

  if (!target) {
    console.log("· ข้ามการทดสอบวงจรเต็ม: ยังไม่มีการเชื่อมที่อ้างถึงจุดที่ยังอยู่ในคลัง");
  } else {
    const dotIds = (target.selected_dots || []).map((d) => d.id).filter((id) => liveIds.has(id));
    const base = Object.fromEntries(D0.filter((d) => dotIds.includes(d.id)).map((d) => [d.id, d]));

    const badStatus = await post("/api/outcome", { connectionId: target.id, rating: 5, status: "ไม่ใช่สถานะ" });
    check("status ที่ไม่รู้จักต้องได้ 400", badStatus.status === 400, `ได้ ${badStatus.status} · ${(badStatus.json || {}).error || ""}`);
    const badRating = await post("/api/outcome", { connectionId: target.id, rating: 99, status: "shipped" });
    check("rating นอกช่วง 1-5 ต้องได้ 400", badRating.status === 400, `ได้ ${badRating.status} · ${(badRating.json || {}).error || ""}`);

    // 4a. บันทึกว่า "ไอเดียนี้ตายแล้ว" → จุดที่พามาต้องถูกลดน้ำหนัก
    const dead = await post("/api/outcome", {
      connectionId: target.id,
      rating: 1,
      status: "dead",
      note: "ทดสอบเส้นตอบกลับ: ลองแล้วไปไม่รอด",
    });
    check(
      "POST /api/outcome บันทึกผลลัพธ์แย่ได้ และรายงานจุดที่ได้รับผล",
      dead.status === 200 && Array.isArray((dead.json || {}).affected_dots) && dead.json.affected_dots.length > 0,
      `ได้ ${dead.status} · ${dead.body.slice(0, 120)}`
    );

    check(
      "สัญญาณของการเชื่อมที่ถูกตีว่าตายแล้วต้องติดลบชัดเจน",
      typeof (dead.json || {}).signal === "number" && dead.json.signal <= -0.34,
      `signal=${(dead.json || {}).signal}`
    );

    const dotsDead = await get("/api/dots");
    const Ddead = Object.fromEntries((dotsDead.json || []).map((d) => [d.id, d]));
    const noneRose = dotIds.every(
      (id) =>
        Ddead[id] &&
        Ddead[id].value_score <= base[id].value_score &&
        Ddead[id].attention_score <= base[id].attention_score &&
        Ddead[id].rated_uses >= Math.max(1, base[id].rated_uses)
    );
    const someFell = dotIds.some((id) => Ddead[id] && Ddead[id].value_score < base[id].value_score);
    check(
      "ผลลัพธ์แย่ไหลย้อนกลับ: value_score และ attention_score ของจุดที่พามาลดลงทันที",
      noneRose && someFell,
      dotIds.map((id) => `${id}: ${base[id].value_score}→${Ddead[id] ? Ddead[id].value_score : "?"}`).join(" · ")
    );

    const lessonsDead = await get("/api/lessons");
    const entryDead = ((lessonsDead.json || {}).lessons || []).find((l) => l.id === target.id);
    check(
      "บทเรียนที่รอบถัดไปจะได้อ่าน เปลี่ยนเป็น 'ทางตัน' ตามผลที่เพิ่งบันทึก",
      !!entryDead && entryDead.signal !== null && entryDead.signal <= -0.34 && /ทางตัน/.test(entryDead.lesson || ""),
      entryDead ? `signal=${entryDead.signal} · ${String(entryDead.lesson).slice(0, 80)}` : "ไม่พบรายการ"
    );

    // 4b. เปลี่ยนใจ: ไอเดียนี้เอาไปทำจริงและได้ผล → จุดเดียวกันต้องกลับขึ้นเหนือค่าเดิม
    const shipped = await post("/api/outcome", {
      connectionId: target.id,
      rating: 5,
      status: "shipped",
      note: "ทดสอบเส้นตอบกลับ: เอาไปทำจริงแล้วได้ผล",
    });
    check("POST /api/outcome อัปเดตผลลัพธ์ทับของเดิมได้", shipped.status === 200, `ได้ ${shipped.status}`);

    const dotsUp = await get("/api/dots");
    const Dup = Object.fromEntries((dotsUp.json || []).map((d) => [d.id, d]));
    check(
      "ผลลัพธ์ดีไหลย้อนกลับ: จุดเดียวกันได้คะแนนและความสนใจสูงกว่าตอนที่ถูกตีว่าตาย",
      dotIds.every(
        (id) =>
          Dup[id] &&
          Dup[id].value_score > Ddead[id].value_score &&
          Dup[id].attention_score > Ddead[id].attention_score &&
          Dup[id].value_score >= base[id].value_score
      ),
      dotIds.map((id) => `${id}: ${base[id].value_score} → ${Ddead[id].value_score} → ${Dup[id] ? Dup[id].value_score : "?"}`).join(" · ")
    );

    const lessonsUp = await get("/api/lessons");
    const entryUp = ((lessonsUp.json || {}).lessons || []).find((l) => l.id === target.id);
    check(
      "บทเรียนพลิกเป็น 'ได้ผลจริง' และถูกนับใน summary.worked",
      !!entryUp && entryUp.signal >= 0.34 && /ได้ผลจริง/.test(entryUp.lesson || "") && (lessonsUp.json.summary || {}).worked >= 1,
      entryUp ? `signal=${entryUp.signal} · worked=${(lessonsUp.json.summary || {}).worked}` : "ไม่พบรายการ"
    );

    // 4c. ผลลัพธ์ต้องถูกเขียนลงความทรงจำจริงของทรีที่กำลังถูกทดสอบ ไม่ใช่ค้างในหน่วยความจำ
    let persisted = null;
    try {
      const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "connections.json"), "utf8"));
      persisted = (onDisk.find((c) => c.id === target.id) || {}).outcome || null;
    } catch (e) {
      persisted = null;
    }
    check(
      "ผลลัพธ์ถูกบันทึกลง data/connections.json จริง (อ่านซ้ำจาก DOT_TEST_ROOT)",
      !!persisted && persisted.rating === 5 && persisted.status === "shipped" && !!persisted.rated_at,
      JSON.stringify(persisted || {}).slice(0, 120)
    );
  }

  /* ---- 5. ความสามารถเดิมต้องครบ ---- */
  for (const ep of [
    "/api/dots",
    "/api/connections",
    "/api/limits",
    "/api/self",
    "/api/evolution",
    "/api/forgotten",
    "/api/serendipity/status",
  ]) {
    const r = await get(ep);
    check(`endpoint เดิม ${ep} ยังตอบ 200`, r.status === 200, `ได้ ${r.status}`);
  }

  if (failures.length) {
    console.error(`\n✗ ตก ${failures.length} ข้อ: ${failures.join(" · ")}`);
    process.exit(1);
  }
  console.log("\n✓ ผ่านทั้งหมด — ผลลัพธ์จริงไหลย้อนกลับไปเปลี่ยนน้ำหนักของจุดและบทเรียนของรอบถัดไปแล้ว");
  process.exit(0);
})().catch((e) => {
  console.error("✗ ข้อผิดพลาดระหว่างทดสอบ: " + (e && e.stack ? e.stack : e));
  process.exit(3);
});
