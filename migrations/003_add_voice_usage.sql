-- Migration 003: Voice usage tracking (Sprint — Voice Input/Output)
-- Additive only. Does not touch chat_logs or any existing table.
--
-- One row per user. Usage resets on a rolling 24h window measured from
-- window_started_at (checked/reset in application code on each request,
-- not via a cron job — keeps this sprint infra-free).

create table if not exists voice_usage (
  user_id uuid primary key references auth.users(id),
  seconds_used_today integer not null default 0,
  window_started_at timestamptz not null default now()
);

-- Defense-in-depth, mirrors the chat_logs RLS pattern (002_enable_rls_chat_logs.sql).
-- The backend uses the service role key and bypasses RLS; primary enforcement
-- is the .eq('user_id', req.userId) filtering in server.js.
alter table voice_usage enable row level security;

create policy "own_row_select" on voice_usage
  for select using (auth.uid() = user_id);

create policy "own_row_insert" on voice_usage
  for insert with check (auth.uid() = user_id);

create policy "own_row_update" on voice_usage
  for update using (auth.uid() = user_id);
