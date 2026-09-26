# line-discord-mirror

Forward every LINE Official Account message to Discord — automatically. Each LINE group gets its own Discord channel with a dedicated webhook, created on the spot when the bot first sees a new group.

**What it does**

- Receives events from a LINE OA via Messaging API webhook
- Verifies LINE signatures (HMAC-SHA256)
- Forwards text, images, video, audio, files, stickers, and locations to Discord
- Files ≤ 8 MB are re-uploaded to Discord; larger files are announced as text
- Provisions a Discord channel + webhook per LINE group automatically (on `join` event or first message)
- Reuses an existing same-named channel if one already exists
- Stores routes in a Postgres (Neon) table so provisioning survives redeploys
- Falls back to `LINE_FALLBACK_WEBHOOK_URL` for groups not yet in the database

---

## Discord Bot Permissions

Create a Bot application and add it to your server with these permissions only:

- **Manage Channels** — to create mirror channels under the LINE category
- **Manage Webhooks** — to create webhooks in those channels

Do **not** request Administrator.

---

## LINE OA Setup

1. Go to the [LINE Developers Console](https://developers.line.biz/console/) and open your Messaging API channel.
2. Set the **Webhook URL** to `https://<your-domain>/api/webhooks/line`.
3. Enable **Use webhook**.
4. Disable **Auto-reply messages** and **Greeting messages** (the bot is a silent relay).
5. Copy the **Channel secret** → `LINE_CHANNEL_SECRET`
6. Issue a **Channel access token (long-lived)** → `LINE_CHANNEL_ACCESS_TOKEN`

---

## Discord Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot.
2. Under **Bot**, copy the token → `DISCORD_BOT_TOKEN`.
3. Enable **Server Members Intent** if you want member display names (optional).
4. Invite the bot to your server with `guilds` + `channels` + `webhooks` scopes.
5. Create a **Category** in your server for LINE mirror channels.
6. Copy the **Server ID** (right-click server → Copy Server ID) → `DISCORD_GUILD_ID`
7. Copy the **Category ID** (right-click category → Copy ID) → `DISCORD_LINE_CATEGORY_ID`

---

## Neon Setup

1. Create a project at [neon.tech](https://neon.tech) (free tier works).
2. Copy the connection string → `DATABASE_URL`
3. Optionally run `migrations/001_init.sql` manually; the app also creates the table on startup.

---

## Deploy to Vercel

```bash
# 1. Fork / clone this repo
git clone https://github.com/tlejay/line-discord-mirror
cd line-discord-mirror

# 2. Install dependencies
pnpm install

# 3. Deploy
vercel --prod
```

In the Vercel dashboard → your project → **Settings → Environment Variables**, add all variables from `.env.example`.

After deployment, paste `https://<your-vercel-domain>/api/webhooks/line` into the LINE Developers Console webhook field and click **Verify**.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `LINE_CHANNEL_SECRET` | ✅ | HMAC-SHA256 signing key from LINE |
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | Long-lived token for content + profile APIs |
| `DISCORD_BOT_TOKEN` | ✅ | Bot token with Manage Channels + Webhooks |
| `DISCORD_GUILD_ID` | ✅ | Discord server (guild) id |
| `DISCORD_LINE_CATEGORY_ID` | ✅ | Category where mirror channels are created |
| `DATABASE_URL` | ✅ | Neon (Postgres) connection string |
| `LINE_FALLBACK_WEBHOOK_URL` | — | Discord webhook for groups not yet in DB |
| `LINE_ADMIN_TOKEN` | — | Protects the one-off `?seed` migration endpoint |

---

## Migration from env-var routing

If you previously stored routes in a `LINE_ROUTE_MAP` JSON environment variable
(`{"groupId":"https://discord.com/api/webhooks/...","..."}`), you can copy them
into the database with a single request:

```
GET /api/webhooks/line?seed=<LINE_ADMIN_TOKEN>
```

Set `LINE_ADMIN_TOKEN` and `LINE_ROUTE_MAP` in your Vercel environment, hit the
endpoint once, then remove `LINE_ROUTE_MAP`.

---

## Local Development

```bash
cp .env.example .env.local
# fill in real values
pnpm dev
# expose via ngrok or similar, then set webhook URL in LINE console
```

---

## Tests

```bash
pnpm test
```

Runs a unit test for LINE signature verification.

---

## License

MIT — see [LICENSE](LICENSE).

---

> **ภาษาไทย (สั้นๆ)**
> โปรเจคนี้รับ webhook จาก LINE OA แล้วส่งต่อทุกข้อความเข้า Discord โดยอัตโนมัติ แต่ละกลุ่ม LINE จะได้ห้อง Discord ของตัวเองทันทีที่บอทเจอกลุ่มใหม่ ไม่ต้องตั้งค่าเพิ่ม ไม่มี AI ในเส้นทางนี้
