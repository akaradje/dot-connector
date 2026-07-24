# 🔗 The Dot-Connector AI — v3 "Serendipity Engine"

เครื่องมือสร้างนวัตกรรมตามปรัชญา "Connecting the Dots" ของ Steve Jobs —
เก็บ "จุดความรู้" จากชีวิตจริงโดยอัตโนมัติ → AI ลากเส้นเชื่อมข้ามโดเมนเองเบื้องหลัง →
**เด้งแจ้งเตือน Eureka บน Windows โดยไม่ต้องเปิดแอป** →
พิสูจน์ความใหม่กับโลกจริงด้วยการค้นเว็บ → ได้ต้นแบบที่รันได้จริง

> v2 "HexKern Memory" ออกแบบโดยตัวเครื่องมือเอง · v3 เติมเต็มวิสัยทัศน์ของ Jobs:
> "เชื่อมจุดได้เฉพาะตอนมองย้อนกลับ" — เครื่องนี้ทำการมองย้อนกลับแทนคุณตลอดเวลา

## สถาปัตยกรรม

| ชั้น | แนวคิด | ในแอปนี้ |
|---|---|---|
| Layer 00 | **The Collector** | โยนไฟล์ .txt/.md ลง `inbox/` หรือวางความคิดดิบในหน้าเว็บ — AI สกัดเป็นจุดความรู้เอง (แยกโดเมนให้เอง, กันจุดซ้ำ) |
| Layer 01 | Dot Repository + **HexKern Memory** | `data/dots.json` — ทุกจุดมีดัชนีความหายาก (rarity) จุดที่ไม่เคยถูกเชื่อมจะ "เรืองแสง" ได้พื้นที่ความสนใจมากกว่า |
| Layer 02 | Pattern Recognition | Claude สแกนจุดทั้งหมดหา structural isomorphism (ให้น้ำหนักจุดหายากมากกว่า) |
| Layer 03 | Connection + **Serendipity Revival** | จุดที่ถูกทิ้งเกิน 14 วันขึ้นแบนเนอร์ "กำลังจะตายจากคลัง" กดปลุกเพื่อบังคับเชื่อมมันเข้ากับจุดใหม่ (กลไก Loss Aversion) |
| Layer 04 | Combinatorial Innovation + **Eureka-to-Evidence** | ทุกไอเดียกด "พิสูจน์" ได้ — Evidence Agent ค้นเว็บจริงเช็กความใหม่ระดับโลก ประเมินความเสี่ยง ออกแบบการทดลอง และเขียนโค้ดต้นแบบลง `lab/` |
| Layer 05 | **Serendipity Daemon** | ลูปเบื้องหลังตรวจทุก 30 นาที: เก็บเกี่ยว inbox → ถ้ามีจุดใหม่หรือจุดเก่าครบกำหนด → เชื่อมจุดเอง → **เด้ง Windows toast แจ้ง Eureka** |

## เปิดเครื่องแล้วรันเอง (แนะนำ)

รันคำสั่งนี้ครั้งเดียวเพื่อให้ Serendipity Engine เริ่มพร้อม Windows:

```powershell
Copy-Item "C:\Users\akara\Steve Jobs\dot-connector\DotConnectorAI.vbs" ([Environment]::GetFolderPath('Startup'))
```

ถอนออก: `powershell -File uninstall-autostart.ps1`

## วิธีรัน

ต้องมี Node.js และ Claude Code CLI ที่ล็อกอินแล้ว (ไม่ต้องมี API key)

```powershell
node server.js
```

แล้วเปิด **http://localhost:4747**

## วิธีใช้

1. **เพิ่มจุด** — ยิ่งต่างสาขากันมาก การเชื่อมยิ่งคาดไม่ถึง
2. (ไม่บังคับ) เลือกจุดเฉพาะ / พิมพ์โจทย์ที่อยากปลดล็อก แล้วกด **⚡ เชื่อมจุด** (1–4 นาที)
3. ได้นวัตกรรมแล้ว กด **🧪 พิสูจน์ไอเดียนี้** — Evidence Agent จะค้นเว็บทั่วโลก (3–8 นาที) แล้วรายงาน:
   - **Novelty verdict**: ยังไม่มีใครทำ / มีของใกล้เคียง / มีแล้ว — พร้อมรายชื่อสิ่งที่เจอจริง
   - **Feasibility** คะแนน + ความเสี่ยงใหญ่สุด + ทางแก้
   - **การทดลองที่เล็กที่สุด** พร้อมเกณฑ์วัดผล
   - **ต้นแบบรันได้จริง** บันทึกเป็นไฟล์ใน `lab/<connection-id>/` เปิดจากลิงก์ในหน้าเว็บได้เลย
4. จุดที่ถูกทิ้งนานจะขึ้นแบนเนอร์ Serendipity ให้กด **⚡ ปลุกจุดนี้**

## API

| Endpoint | ความหมาย |
|---|---|
| `GET/POST/DELETE /api/dots` | จัดการคลังจุด (GET คืนค่าพร้อมสถิติ HexKern: uses, rarity, forgotten) |
| `POST /api/capture` | โยนความคิดดิบ — body: `{text}` → AI สกัดเป็นจุด |
| `GET /api/forgotten` | จุดที่กำลังจะถูกลืม (เรียงตาม rarity) |
| `POST /api/connect` | เชื่อมจุด — body: `{focus?, dotIds?, mustInclude?}` |
| `POST /api/evidence` | พิสูจน์ไอเดีย — body: `{connectionId}` (ใช้ web search จริง) |
| `GET /api/connections` | ประวัตินวัตกรรมทั้งหมด |
| `POST /api/serendipity/scan` | สั่งรอบ daemon ทันที — body: `{forceConnect?}` |
| `GET /api/serendipity/status` | สถานะ daemon + log ล่าสุด |

## ตั้งค่า

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `PORT` | `4747` | พอร์ตของเว็บ |
| `DOT_MODEL` | `claude-fable-5` | โมเดลเชื่อมจุด — ตั้งเป็น `sonnet` ถ้าอยากได้เร็ว/ประหยัดขึ้น |
| `HARVEST_MODEL` | `sonnet` | โมเดลเก็บเกี่ยวโน้ตเป็นจุด (งานเชิงกล ใช้ตัวเร็วพอ) |
| `FORGET_DAYS` | `14` | จำนวนวันก่อนจุดถูกนับว่า "กำลังจะถูกลืม" |
| `CHECK_MIN` | `30` | daemon ตรวจ inbox/จุดถูกลืมทุกกี่นาที |
| `AUTO_HOURS` | `24` | เว้นอย่างน้อยกี่ชั่วโมงระหว่างการเชื่อมอัตโนมัติ (คุมค่าใช้จ่าย) |

## โครงสร้างไฟล์

```
dot-connector/
├── server.js               เซิร์ฟเวอร์ + Serendipity Daemon (Node.js ไม่มี dependency)
├── public/index.html       หน้าเว็บ UI
├── DotConnectorAI.vbs      ตัวรันเงียบตอนเปิดเครื่อง (คัดลอกไป Startup folder)
├── uninstall-autostart.ps1 ถอนออกจาก Startup
├── inbox/                  Layer 00: โยนโน้ต .txt/.md ที่นี่ (processed/ = ที่เก็บไฟล์ที่อ่านแล้ว)
├── data/
│   ├── dots.json           Layer 01: คลังจุดความรู้
│   ├── connections.json    Layer 04: นวัตกรรม + หลักฐานการพิสูจน์
│   └── serendipity.json    Layer 05: สถานะ daemon + log
└── lab/<conn-id>/          ต้นแบบที่ Evidence Agent เขียน (รันได้จริง)
```
