-- Migration 006: Cascade deletes on account deletion (Sprint 8.3)
-- Additive/defensive only. Does not change any existing columns or data.
--
-- DELETE /api/account in server.js already deletes each user's rows from
-- chat_logs, voice_usage, user_ai_settings, and user_personality explicitly
-- before deleting the auth.users row, so this migration is not required for
-- that endpoint to work. It exists as a safety net: if a user is ever
-- removed some other way (Supabase Dashboard, direct SQL, a future admin
-- tool), their data is cleaned up automatically instead of being orphaned.

alter table chat_logs
  drop constraint if exists chat_logs_user_id_fkey,
  add constraint chat_logs_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;

alter table voice_usage
  drop constraint if exists voice_usage_user_id_fkey,
  add constraint voice_usage_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;

alter table user_ai_settings
  drop constraint if exists user_ai_settings_user_id_fkey,
  add constraint user_ai_settings_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;

alter table user_personality
  drop constraint if exists user_personality_user_id_fkey,
  add constraint user_personality_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;
