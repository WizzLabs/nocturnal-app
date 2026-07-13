// ─── LOCAL TOOLS ────────────────────────────────────────
// Sprint 8.5.1: lightweight, deterministic handlers for requests that don't
// need the planner, a search provider, or an LLM call at all — right now
// just local time/date. Runs BEFORE the planner in server.js and, on a
// match, short-circuits the whole pipeline (zero search credits, zero
// planner calls, zero AI tokens).
//
// Extending later: add another entry to TOOLS below (e.g. calculator, UUID,
// hashing, timestamps). Each entry just needs a `test` regex and a `run`
// function — matchLocalTool() and the server.js call site never need to
// change.
//
// Deliberately uses only the built-in Date object, per Sprint 8.5.1 scope —
// no external time API, no hardcoded year.

function formatTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function formatFullDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatWeekday(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long' });
}

// Order matters: more specific patterns (date AND time together) are
// checked before the single-purpose ones, so "current date and time"
// doesn't get eaten by the plain "date" or "time" matcher first.
const TOOLS = [
  {
    name: 'datetime',
    test: /\b(current date and time|date and time|time and date)\b/i,
    run: (now) => `It's ${formatTime(now)} on ${formatFullDate(now)}.`,
  },
  {
    name: 'time',
    test: /\b(what(?:'s| is) the time|what time is it|current time|time right now)\b/i,
    run: (now) => `It's ${formatTime(now)}.`,
  },
  {
    name: 'day',
    test: /\b(what day is (?:it|today)|what(?:'s| is) today'?s day|current day)\b/i,
    run: (now) => `Today is ${formatWeekday(now)}.`,
  },
  {
    name: 'date',
    test: /\b(what(?:'s| is) (?:today'?s|the) date|current date|what date is it|today'?s date)\b/i,
    run: (now) => `Today's date is ${formatFullDate(now)}.`,
  },
];

// Keep this tight: only fires for short, clearly local-tool-shaped
// messages, never for something that merely mentions "time" or "date" in
// passing partway through a longer message.
const MAX_MATCH_LENGTH = 60;

// Returns { name, reply } on a match, or null if nothing matched — callers
// should fall through to the normal planner/search/LLM pipeline on null.
export function matchLocalTool(message) {
  if (!message || typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > MAX_MATCH_LENGTH) return null;

  for (const tool of TOOLS) {
    if (tool.test.test(trimmed)) {
      const now = new Date();
      return { name: tool.name, reply: tool.run(now) };
    }
  }
  return null;
}
