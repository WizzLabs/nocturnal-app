-- Migration 003: Personal AI configuration (BYOK) — Sprint 4
--
-- One row per user, holding an encrypted API key + preferred model.
-- api_key_enc stores ciphertext only (AES-256-GCM, encrypted/decrypted in
-- server.js using SETTINGS_ENCRYPTION_KEY) — never plaintext.

create table if not exists user_ai_settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  api_key_enc text not null,
  model_name  text not null,
  updated_at  timestamptz not null default now()
);

-- Same ownership pattern as chat_logs (Sprint 2): the backend enforces
-- ownership via requireAuth + .eq('user_id', req.userId) since it uses the
-- service role key (which bypasses RLS). RLS here is defense-in-depth for
-- the same reason it was added to chat_logs.
alter table user_ai_settings enable row level security;

create policy "own_settings_select" on user_ai_settings
  for select using (auth.uid() = user_id);

create policy "own_settings_insert" on user_ai_settings
  for insert with check (auth.uid() = user_id);

create policy "own_settings_update" on user_ai_settings
  for update using (auth.uid() = user_id);

create policy "own_settings_delete" on user_ai_settings
  for delete using (auth.uid() = user_id);
