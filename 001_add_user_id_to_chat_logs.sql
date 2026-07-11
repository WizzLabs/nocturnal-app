-- Migration 001: Add user_id to chat_logs
-- Sprint 2 — per-user chat isolation
--
-- This migration ONLY adds the column and FK reference.
-- RLS is intentionally NOT enabled here — that happens in migration 002,
-- after backend + frontend scoping is confirmed working end-to-end.

alter table chat_logs
  add column if not exists user_id uuid references auth.users(id);

-- Optional: if you have existing rows from before auth existed and want to
-- keep them instead of losing access to them, backfill with your own user id.
-- Find your id in Supabase Dashboard → Authentication → Users, then:
--
-- update chat_logs set user_id = '<your-uuid-here>' where user_id is null;

-- Index for query performance (history/session lookups filter by this constantly)
create index if not exists idx_chat_logs_user_id on chat_logs(user_id);
