// ─── AUTH GUARD ─────────────────────────────────────────────────────────
// Synchronous check: reads the Supabase session from localStorage and
// redirects to /auth.html before the app body is rendered if no valid
// session is found.
//
// Why synchronous (not async): an async check would allow script.js to
// start executing and the sidebar / chat UI to flash before the redirect.
// A synchronous IIFE in <head> blocks rendering entirely until resolved.
//
// Key format: Supabase JS v2 always stores the session at:
//   sb-{project-ref}-auth-token
// The project ref is the subdomain of your Supabase URL.
// For https://pumnywxnpwgmurjqtdhr.supabase.co → ref = pumnywxnpwgmurjqtdhr
//
// Sprint 3 note: this was previously an inline <script> block in index.html.
// It was moved here unchanged (logic byte-for-byte identical) so that
// Content-Security-Policy can enforce script-src 'self' without an
// 'unsafe-inline' exception, which would otherwise defeat most of CSP's
// protection against injected scripts.
(function () {
  var STORAGE_KEY = 'sb-pumnywxnpwgmurjqtdhr-auth-token';
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) { window.location.replace('/auth.html'); return; }
    var session = JSON.parse(raw);
    if (!session || !session.access_token) {
      window.location.replace('/auth.html');
    }
  } catch (e) {
    // Malformed JSON or localStorage unavailable → redirect to be safe
    window.location.replace('/auth.html');
  }
}());
