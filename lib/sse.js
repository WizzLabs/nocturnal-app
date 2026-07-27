// ─── SSE (SERVER-SENT EVENTS) HELPER ───────────────────
// Sprint 6: single-responsibility module for the wire format used to stream
// live processing stage events (Objective 1/2) to the frontend during
// /chat. server.js decides WHEN to emit a stage — this module only owns
// HOW an event gets written to the response stream, so the route handler
// itself doesn't fill up with res.write/JSON.stringify boilerplate.
//
// Event shapes (one JSON object per SSE "data:" line):
//   { type: 'stage', stage: 'thinking' | 'searching' | 'reading_image' |
//                            'reading_document' | 'generating' }
//   { type: 'final', reply, mode, usedSearch, sources }
//   { type: 'error', error, status }
//
// The frontend maps `stage` keys to display text — server.js never sends
// human-facing copy, only stable stage identifiers (Objective 3: "never
// display incorrect stages" is easier to guarantee when the vocabulary is
// a fixed, small set of keys rather than free-text labels).

export function initSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // Disables buffering on common reverse proxies (nginx) so events reach
    // the client as they're written rather than batched.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function writeEvent(res, payload) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sendStage(res, stage) {
  writeEvent(res, { type: 'stage', stage });
}

export function sendFinal(res, { reply, mode, usedSearch, sources }) {
  writeEvent(res, { type: 'final', reply, mode, usedSearch, sources: sources || [] });
  if (!res.writableEnded) res.end();
}

export function sendErrorEvent(res, error, status = 500) {
  writeEvent(res, { type: 'error', error, status });
  if (!res.writableEnded) res.end();
}

export default { initSSE, sendStage, sendFinal, sendErrorEvent };
