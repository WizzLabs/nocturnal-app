-- Migration 004: AI Settings (BYOK — Sprint 7)
-- Additive only. Does not touch chat_logs or voice_usage.
--
-- One row per user. The API key is NEVER stored in plaintext — server.js
-- encrypts it with AES-256-GCM (SETTINGS_ENCRYPTION_KEY env var) before
-- insert and decrypts only in-memory right before the Groq call.
-- encryption_iv is the per-row initialization vector required to decrypt
-- encrypted_api_key; both are meaningless without SETTINGS_ENCRYPTION_KEY.

create table if not exists user_ai_settings (
  user_id uuid primary key references auth.users(id),
  encrypted_api_key text,
  encryption_iv text,
  model text,
  updated_at timestamptz not null default now()
);

-- Defense-in-depth, mirrors the chat_logs/voice_usage RLS pattern
-- (see 002_enable_rls_chat_logs.sql, 003_add_voice_usage.sql).
-- The backend uses the service role key and bypasses RLS; primary
-- enforcement is the .eq('user_id', req.userId) filtering in server.js.
alter table user_ai_settings enable row level security;

create policy "own_row_select" on user_ai_settings
  for select using (auth.uid() = user_id);

create policy "own_row_insert" on user_ai_settings
  for insert with check (auth.uid() = user_id);

create policy "own_row_update" on user_ai_settings
  for update using (auth.uid() = user_id);

create policy "own_row_delete" on user_ai_settings
  for delete using (auth.uid() = user_id);
