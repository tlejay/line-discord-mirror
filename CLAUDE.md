# CLAUDE.md — 128 LINE Discord Mirror

รีเลย์ทางเดียว: LINE OA webhook → Discord ห้องละกลุ่ม (สร้างห้อง + webhook ให้อัตโนมัติ)
repo: `github.com/tlejay/line-discord-mirror` (branch `main`)

## Stack

Next.js 16 (App Router, route handler อย่างเดียว ไม่มีหน้า UI) · TypeScript strict · Neon Postgres (`@neondatabase/serverless`) · Jest · pnpm · deploy Vercel

## ไฟล์หลัก

| ไฟล์ | ทำอะไร |
|---|---|
| `app/api/webhooks/line/route.ts` | รับ event → ตรวจลายเซ็น → หา route → ส่งต่อ (`forwardMessage` คือรูปแบบข้อความที่ Discord เห็น) |
| `lib/line-routes.ts` | ตาราง `line_routes` (สร้างเองตอนใช้ครั้งแรก) + สร้างห้อง/webhook ผ่าน Discord API |
| `lib/line-verify.ts` | HMAC-SHA256 timing-safe |
| `__tests__/verify.test.ts` | เทสลายเซ็น 5 เคส |

คำสั่ง: `pnpm dev` · `pnpm test` · `pnpm typecheck`

## ข้อควรรู้

- LINE ต้องได้ 200 เสมอ แม้ Discord ล่ม — error ฝั่ง Discord ให้ log แล้วกลืนไว้
- สร้างห้องตอน `join` ทำงานเฉพาะเมื่อมี `LINE_FALLBACK_WEBHOOK_URL` (ไม่งั้นรอข้อความแรก)
- แชท 1:1 ไม่ได้ห้องของตัวเอง ไปลง fallback

## README

ภาพใน `docs/` (hero, demo.gif, discord.png, line.png, social-preview.png) เป็น **ภาพประกอบจาก HTML mock** ไม่ใช่ screenshot จริง
เพราะโปรเจคไม่มี UI — ข้อความฝั่ง Discord ในภาพต้องตรงกับรูปแบบใน `forwardMessage`
ถ้าเปลี่ยนรูปแบบข้อความ ต้องทำภาพใหม่ทั้งชุดด้วย `/kiki-gh-readme`
