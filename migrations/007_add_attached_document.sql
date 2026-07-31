-- Migration 007: Persistent document attachments (Sprint 7, Objective 2)
-- Additive only. Does not touch attached_asset (images) or any other column.
--
-- Mirrors attached_asset's role for images, but for documents (PDF, DOCX,
-- TXT, Markdown, XLSX): a single jsonb blob per turn, null when no document
-- was attached that turn.
--
-- Per architecture decision: this stores EXTRACTED TEXT + METADATA only,
-- not the raw file — { fileName, docType, size, text, truncated }. This
-- keeps storage light and is enough to restore the attachment chip and
-- reconstruct the same grounded prompt on reload, but does not allow
-- re-downloading the original file bytes.
--
-- This is Conversation Memory (scoped to one chat_logs row / one turn), not
-- the future cross-chat Knowledge Cache — no summarization or durable
-- cross-session storage happens here.

alter table chat_logs
  add column if not exists attached_document jsonb;
