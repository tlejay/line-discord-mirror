-- LINE Discord Mirror — initial schema
--
-- Run this once against your Neon database before the first deployment.
-- The application also runs CREATE TABLE IF NOT EXISTS on startup, so
-- this file is primarily for reference and manual setup.

create table if not exists line_routes (
  line_source_id     text primary key,
  group_name         text,
  discord_channel_id text,
  webhook_url        text not null,
  created_at         timestamptz not null default now()
);

comment on table line_routes is
  'Maps a LINE group/room/user id to the Discord webhook that receives its messages.';
comment on column line_routes.line_source_id is
  'LINE groupId, roomId, or userId.';
comment on column line_routes.group_name is
  'Human-readable LINE group name at provisioning time.';
comment on column line_routes.discord_channel_id is
  'Discord channel id of the mirror channel (null for manually-added entries).';
comment on column line_routes.webhook_url is
  'Discord webhook URL to POST messages to.';
