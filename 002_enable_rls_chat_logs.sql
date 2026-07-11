-- Migration 002: Enable RLS on chat_logs
-- DO NOT RUN until Steps 1-4 are confirmed working (backend scoping,
-- frontend auth headers, and manual multi-user testing all pass).
--
-- The backend uses the service role key, which bypasses RLS entirely.
-- This is defense-in-depth, not the primary enforcement mechanism —
-- the primary enforcement is the .eq('user_id', req.userId) filters
-- added to server.js in Step 2.

alter table chat_logs enable row level security;

create policy "own_rows_select" on chat_logs
  for select using (auth.uid() = user_id);

create policy "own_rows_insert" on chat_logs
  for insert with check (auth.uid() = user_id);

create policy "own_rows_update" on chat_logs
  for update using (auth.uid() = user_id);

create policy "own_rows_delete" on chat_logs
  for delete using (auth.uid() = user_id);
