-- Migration 005: Personality preferences (Sprint 7)
-- Additive only. Does not touch chat_logs, voice_usage, or user_ai_settings.
--
-- One row per user. `preset` is one of: professional | casual | creative |
-- technical | null (no preset selected). `custom_instructions` is optional
-- freeform text for advanced users, length-capped in application code.
-- Both fields are only ever read server-side using req.userId — never
-- trusted from client request bodies (see server.js /chat pipeline).

create table if not exists user_personality (
  user_id uuid primary key references auth.users(id),
  preset text,
  custom_instructions text,
  updated_at timestamptz not null default now()
);

-- Defense-in-depth, mirrors the existing RLS pattern.
-- The backend uses the service role key and bypasses RLS; primary
-- enforcement is the .eq('user_id', req.userId) filtering in server.js.
alter table user_personality enable row level security;

create policy "own_row_select" on user_personality
  for select using (auth.uid() = user_id);

create policy "own_row_insert" on user_personality
  for insert with check (auth.uid() = user_id);

create policy "own_row_update" on user_personality
  for update using (auth.uid() = user_id);

create policy "own_row_delete" on user_personality
  for delete using (auth.uid() = user_id);
