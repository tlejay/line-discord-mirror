/**
 * lib/line-routes.ts
 *
 * Where a LINE conversation gets forwarded to, and how a new one gets its own
 * Discord channel without human intervention.
 *
 * Routes are stored in a Postgres (Neon) table so the webhook can provision a
 * Discord channel + webhook the first time it sees a new LINE group, without a
 * redeployment.
 *
 * Required env:
 *   DATABASE_URL               Neon connection string
 *   DISCORD_BOT_TOKEN          Bot token with Manage Channels + Manage Webhooks
 *   DISCORD_GUILD_ID           Target Discord server
 *   DISCORD_LINE_CATEGORY_ID   Category where LINE mirror channels are created
 */

import { neon } from "@neondatabase/serverless";

const DISCORD_API = "https://discord.com/api/v10";

function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  return neon(url);
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const q = sql();
  await q`
    create table if not exists line_routes (
      line_source_id     text primary key,
      group_name         text,
      discord_channel_id text,
      webhook_url        text not null,
      created_at         timestamptz not null default now()
    )
  `;
  schemaReady = true;
}

/** Webhook URL for a LINE source, or null if it has never been provisioned. */
export async function lookupRoute(sourceId: string): Promise<string | null> {
  try {
    await ensureSchema();
    const q = sql();
    const rows = (await q`
      select webhook_url from line_routes where line_source_id = ${sourceId}
    `) as { webhook_url: string }[];
    return rows[0]?.webhook_url ?? null;
  } catch (e) {
    console.error("[line-routes] lookup failed", e);
    return null;
  }
}

async function discord(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN not configured");
  const res = await fetch(DISCORD_API + path, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/tlejay/line-discord-mirror, 1.0)",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Discord channel names: lowercase, no spaces, no punctuation runs. */
function slugify(name: string): string {
  const s = [...name]
    .map((ch) => (/[a-zA-Z0-9฀-๿]/.test(ch) ? ch.toLowerCase() : "-"))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (s || "line-group").slice(0, 90);
}

/**
 * Give a LINE conversation its own Discord channel + webhook and remember it.
 *
 * Safe to call concurrently: on conflict the winning row is returned. Returns
 * null if provisioning fails; the caller falls back to LINE_FALLBACK_WEBHOOK_URL.
 */
export async function provisionRoute(
  sourceId: string,
  groupName: string
): Promise<string | null> {
  const guildId = process.env.DISCORD_GUILD_ID;
  const categoryId = process.env.DISCORD_LINE_CATEGORY_ID;
  if (!guildId || !categoryId) {
    console.error("[line-routes] DISCORD_GUILD_ID or DISCORD_LINE_CATEGORY_ID not set");
    return null;
  }

  try {
    await ensureSchema();

    const existing = await lookupRoute(sourceId);
    if (existing) return existing;

    const name = slugify(groupName);

    // Reuse a same-named channel if one already exists under the category
    // (or anywhere in the guild if the channel was moved out of the category).
    const list = await discord("GET", `/guilds/${guildId}/channels`);
    const all = (Array.isArray(list.json) ? (list.json as unknown as Record<string, unknown>[]) : []);
    const sameName = all.filter((c) => c.name === name && c.type === 0);
    let channel = (sameName.find((c) => c.parent_id === categoryId) ?? sameName[0]) as
      | Record<string, unknown>
      | undefined;

    if (!channel) {
      const made = await discord("POST", `/guilds/${guildId}/channels`, {
        name,
        type: 0,
        parent_id: categoryId,
        topic: `LINE group: ${groupName}  (${sourceId})`,
      });
      if (made.status !== 200 && made.status !== 201) {
        console.error("[line-routes] channel create failed", made.status, made.json);
        return null;
      }
      channel = made.json;
    }

    const channelId = String(channel.id);
    const hooks = await discord("GET", `/channels/${channelId}/webhooks`);
    let hook = (Array.isArray(hooks.json) ? (hooks.json as unknown as Record<string, unknown>[]) : []).find(
      (h) => h.name === "LINE Bridge"
    );
    if (!hook) {
      const made = await discord("POST", `/channels/${channelId}/webhooks`, {
        name: "LINE Bridge",
      });
      if (made.status !== 200 && made.status !== 201) {
        console.error("[line-routes] webhook create failed", made.status, made.json);
        return null;
      }
      hook = made.json;
    }

    const url = `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;
    const q = sql();
    await q`
      insert into line_routes (line_source_id, group_name, discord_channel_id, webhook_url)
      values (${sourceId}, ${groupName}, ${channelId}, ${url})
      on conflict (line_source_id) do nothing
    `;
    return (await lookupRoute(sourceId)) ?? url;
  } catch (e) {
    console.error("[line-routes] provision failed", e);
    return null;
  }
}

/**
 * One-off migration: copy routes from the LINE_ROUTE_MAP env var (JSON object
 * mapping sourceId → webhookUrl) into the database.
 *
 * Call via GET /api/webhooks/line?seed=<LINE_ADMIN_TOKEN>
 */
export async function seedFromEnvMap(): Promise<number> {
  try {
    await ensureSchema();
    const map = JSON.parse(process.env.LINE_ROUTE_MAP || "{}") as Record<string, string>;
    const q = sql();
    let n = 0;
    for (const [sourceId, url] of Object.entries(map)) {
      await q`
        insert into line_routes (line_source_id, webhook_url)
        values (${sourceId}, ${url})
        on conflict (line_source_id) do nothing
      `;
      n++;
    }
    return n;
  } catch (e) {
    console.error("[line-routes] seed failed", e);
    return 0;
  }
}
