/**
 * /api/webhooks/line
 *
 * LINE Messaging API webhook. Receives every event from LINE, verifies the
 * signature, then forwards messages to Discord as "Sender: text".
 *
 * Pure relay — no AI, no reply logic. Every message (1:1 and group) is
 * forwarded to a Discord webhook. For group chats, a dedicated Discord channel
 * and webhook are provisioned automatically on the first message from an
 * unknown group (or on the join event if available).
 *
 * LINE always expects a fast 200. Downstream Discord errors are logged and
 * swallowed so LINE does not disable the endpoint.
 *
 * Env:
 *   LINE_CHANNEL_SECRET          required — HMAC-SHA256 signing key
 *   LINE_CHANNEL_ACCESS_TOKEN    required — to fetch content and display names
 *   LINE_FALLBACK_WEBHOOK_URL    optional — Discord webhook for unrouted groups
 *   DISCORD_BOT_TOKEN            required — bot with Manage Channels + Webhooks
 *   DISCORD_GUILD_ID             required — target Discord server id
 *   DISCORD_LINE_CATEGORY_ID     required — category for auto-created channels
 *   DATABASE_URL                 required — Neon connection string
 *   LINE_ADMIN_TOKEN             optional — guards the ?seed migration endpoint
 */

import { NextRequest, NextResponse } from "next/server";
import { verify } from "@/lib/line-verify";
import { lookupRoute, provisionRoute, seedFromEnvMap } from "@/lib/line-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: {
    id?: string;
    type?: string;
    text?: string;
    fileName?: string;
    fileSize?: number;
    packageId?: string;
    stickerId?: string;
    title?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
  };
};

async function resolveDisplayName(userId?: string): Promise<string | null> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !userId) return null;
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const p = (await res.json()) as { displayName?: string };
    return p.displayName ?? null;
  } catch {
    return null;
  }
}

async function resolveGroupMemberProfile(
  groupId: string,
  userId: string
): Promise<{ displayName: string }> {
  const tok = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!tok) return { displayName: userId };
  try {
    const res = await fetch(
      `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`,
      { headers: { Authorization: `Bearer ${tok}` } }
    );
    if (!res.ok) return { displayName: userId };
    const p = (await res.json()) as { displayName?: string };
    return { displayName: p.displayName ?? userId };
  } catch {
    return { displayName: userId };
  }
}

/**
 * Fetch the LINE group's display name. Retries a couple of times because the
 * bot may not be registered as a member yet on the join event.
 */
async function resolveGroupName(groupId: string): Promise<string> {
  const tok = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!tok) return groupId;
  const delays = [0, 700, 1800];
  for (const wait of delays) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (res.ok) {
        const p = (await res.json()) as { groupName?: string };
        if (p.groupName) return p.groupName;
      }
    } catch {
      // keep retrying
    }
  }
  return groupId;
}

/** Called when the bot is added to a group/room: provision a channel immediately. */
async function handleJoinEvent(ev: LineEvent): Promise<void> {
  const groupId = ev.source?.groupId ?? ev.source?.roomId;
  if (!groupId) return;
  try {
    const name = await resolveGroupName(groupId);
    const url = fallbackWebhook();
    if (!url) return;
    const named = name !== groupId;
    const provisioned = named ? await provisionRoute(groupId, name) : null;
    const target = provisioned ?? url;
    await relayToDiscordAt(
      target,
      `🆕 Joined new LINE group: **${name}**\n` +
        `\`${groupId}\`\n` +
        (named
          ? provisioned
            ? "Channel created — messages from this group will appear here."
            : "Channel creation failed — messages will land in the fallback channel."
          : "(Could not resolve group name yet.) Messages will land in the fallback channel."),
      "LINE Bridge"
    );
  } catch (e) {
    console.error("[line-webhook] join handling failed", e);
  }
}

/** Returns the fallback Discord webhook URL, or undefined if not configured. */
function fallbackWebhook(): string | undefined {
  return process.env.LINE_FALLBACK_WEBHOOK_URL;
}

const DISCORD_UPLOAD_LIMIT = 8 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "video/mp4": "mp4", "video/quicktime": "mov",
  "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/x-m4a": "m4a",
  "application/pdf": "pdf",
};

async function fetchLineContent(
  messageId: string
): Promise<{ buf: ArrayBuffer; contentType: string } | null> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !messageId) return null;
  try {
    const res = await fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      console.error("[line-webhook] content fetch failed", messageId, res.status);
      return null;
    }
    return {
      buf: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") || "application/octet-stream",
    };
  } catch (e) {
    console.error("[line-webhook] content fetch threw", e);
    return null;
  }
}

async function relayFileToDiscord(
  url: string,
  content: string,
  username: string,
  file: { buf: ArrayBuffer; contentType: string; name: string }
): Promise<void> {
  try {
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({ content, username, allowed_mentions: { parse: [] } })
    );
    form.append("files[0]", new Blob([file.buf], { type: file.contentType }), file.name);
    const res = await fetch(url, { method: "POST", body: form });
    if (!res.ok) {
      console.error("[line-webhook] discord upload failed", res.status);
    }
  } catch (e) {
    console.error("[line-webhook] discord upload threw", e);
  }
}

async function forwardMessage(url: string, sender: string, ev: LineEvent): Promise<void> {
  const m = ev.message ?? {};
  const kind = m.type ?? "unknown";

  if (kind === "text") {
    await relayToDiscordAt(url, `${sender}: ${m.text ?? ""}`, "LINE Bridge");
    return;
  }

  if (kind === "sticker") {
    await relayToDiscordAt(url, `${sender}: [sticker]`, "LINE Bridge");
    return;
  }

  if (kind === "location") {
    const map =
      m.latitude != null && m.longitude != null
        ? `https://maps.google.com/?q=${m.latitude},${m.longitude}`
        : "";
    await relayToDiscordAt(
      url,
      `${sender}: [location] ${m.title ?? ""} ${m.address ?? ""}\n${map}`.trim(),
      "LINE Bridge"
    );
    return;
  }

  if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
    const got = m.id ? await fetchLineContent(m.id) : null;
    if (!got) {
      await relayToDiscordAt(url, `${sender}: [${kind}] failed to fetch from LINE`, "LINE Bridge");
      return;
    }
    if (got.buf.byteLength > DISCORD_UPLOAD_LIMIT) {
      const mb = (got.buf.byteLength / 1024 / 1024).toFixed(1);
      await relayToDiscordAt(
        url,
        `${sender}: [${kind}] file too large for Discord (${mb} MB)`,
        "LINE Bridge"
      );
      return;
    }
    const ext = EXT_BY_MIME[got.contentType.split(";")[0]] || "bin";
    const name = m.fileName || `${kind}-${m.id}.${ext}`;
    const kindLabel: Record<string, string> = {
      image: "[image]", video: "[video]", audio: "[audio]", file: "[file]",
    };
    const label = m.fileName || kindLabel[kind] || `[${kind}]`;
    await relayFileToDiscord(url, `${sender}: ${label}`, "LINE Bridge", { ...got, name });
    return;
  }

  await relayToDiscordAt(url, `${sender}: [${kind}]`, "LINE Bridge");
}

async function relayToDiscordAt(url: string, content: string, username: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, username, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) {
      console.error("[line-webhook] discord relay failed", res.status);
    }
  } catch (e) {
    console.error("[line-webhook] discord relay failed", e);
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  const rawBody = await req.text();

  if (!secret) {
    console.error("[line-webhook] LINE_CHANNEL_SECRET not configured");
    return NextResponse.json({ ok: true, note: "secret not configured" });
  }

  const signature = req.headers.get("x-line-signature");
  if (!verify(rawBody, signature, secret)) {
    return NextResponse.json({ ok: false, error: "bad signature" }, { status: 401 });
  }

  let events: LineEvent[] = [];
  try {
    events = (JSON.parse(rawBody)?.events ?? []) as LineEvent[];
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  for (const ev of events) {
    const sourceType = ev.source?.type;

    if (ev.type === "join" && (sourceType === "group" || sourceType === "room")) {
      await handleJoinEvent(ev);
      continue;
    }

    if (ev.type !== "message") continue;

    const sourceId =
      sourceType === "user"
        ? ev.source?.userId
        : ev.source?.groupId ?? ev.source?.roomId;

    // Route: DB first, auto-provision on first message from unknown group
    let url: string | null = sourceId ? await lookupRoute(sourceId) : null;
    const wasProvisioned = !!url;
    if (!url && sourceId && (sourceType === "group" || sourceType === "room")) {
      const gname = await resolveGroupName(sourceId);
      if (gname !== sourceId) url = await provisionRoute(sourceId, gname);
    }
    const isUsingFallback = !url;
    const resolved = url ?? fallbackWebhook();
    if (!resolved) {
      console.error("[line-webhook] no webhook resolved for", sourceId);
      continue;
    }

    let sender = "LINE user";
    if (sourceType === "user") {
      sender = (await resolveDisplayName(ev.source?.userId)) ?? sender;
    } else if ((sourceType === "group" || sourceType === "room") && ev.source?.userId && sourceId) {
      sender = (await resolveGroupMemberProfile(sourceId, ev.source.userId)).displayName;
      // When falling back to the shared channel, prefix with the group name so
      // the source is identifiable.
      if (isUsingFallback && !wasProvisioned) {
        const gname = await resolveGroupName(sourceId);
        sender = `[${gname}] ${sender}`;
      }
    }

    await forwardMessage(resolved, sender, ev);
  }

  return NextResponse.json({ ok: true });
}

// GET: liveness check + optional one-off migration from LINE_ROUTE_MAP env var
export async function GET(req: NextRequest) {
  const seed = req.nextUrl.searchParams.get("seed");
  const admin = process.env.LINE_ADMIN_TOKEN;
  if (seed && admin && seed === admin) {
    const n = await seedFromEnvMap();
    return NextResponse.json({ ok: true, seeded: n });
  }
  return NextResponse.json({ ok: true, service: "line-discord-mirror" });
}
