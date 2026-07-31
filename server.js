import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { getDefaultAIClient, createAIClient } from './lib/providers/index.js';
import { MODELS, PLANNER_MODEL } from './config/models.js';
import { matchLocalTool } from './lib/localTools.js';
import { routeSearchDecision } from './lib/searchRouter.js';
import { routeVision } from './lib/visionRouter.js';
import { recordEntityFromMessage } from './lib/contextResolver.js';
import * as SearchService from './services/search/index.js';
import { formatSearchContext } from './services/search/formatContext.js';
import * as VisionService from './services/vision/index.js';
import * as VisionContext from './services/vision/context.js';
import { buildGroundedPrompt as buildVisionGroundedPrompt } from './services/vision/promptBuilder.js';
import { score as scoreVisionRelevance } from './lib/visionRelevanceEngine.js';
import { initSSE, sendStage, sendFinal, sendErrorEvent } from './lib/sse.js';
import { routeDocument } from './lib/documentRouter.js';
import * as DocumentService from './services/document/index.js';
import * as DocumentContext from './services/document/context.js';
import { buildGroundedPrompt as buildDocumentGroundedPrompt } from './services/document/promptBuilder.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ─── CORS ALLOWLIST ────────────────────────────────────
// Dev: allow common localhost ports so the app works no matter which port
// Vite/live-server/etc picks. Production: ONLY the domain in FRONTEND_URL.
// Requests with no Origin header (curl, server-to-server, same-origin page
// loads) are allowed through — CORS only governs cross-origin browser fetches.
const devOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function corsOriginCheck(origin, callback) {
  if (!origin) return callback(null, true); // same-origin / non-browser requests
  if (NODE_ENV !== 'production' && devOrigins.includes(origin)) {
    return callback(null, true);
  }
  if (NODE_ENV === 'production' && origin === process.env.FRONTEND_URL) {
    return callback(null, true);
  }
  console.warn(`CORS: rejected origin ${origin}`);
  return callback(new Error('Not allowed by CORS'));
}

app.use(cors({ origin: corsOriginCheck }));

// ─── HELMET / CONTENT SECURITY POLICY ──────────────────
// CSP is scoped to exactly what this app actually loads:
//   - scriptSrc: 'self' (all local JS) + esm.sh (Supabase client is dynamically
//     imported from https://esm.sh/@supabase/supabase-js@2 in auth.js/script.js)
//   - connectSrc: 'self' + Supabase project URL (the browser's Supabase client
//     talks directly to Supabase Auth) + esm.sh (fetching the module itself)
//   - styleSrc: 'unsafe-inline' allowed because index.html/auth.html use
//     inline style="" attributes and a <style> block — rewriting those to
//     external classes is out of scope for this sprint and inline CSS carries
//     far less XSS risk than inline JS
//   - imgSrc: 'self' + data: + blob: (base64 chat images, data-URI favicon)
//   - fontSrc: Google Fonts CDN
const supabaseOrigin = process.env.SUPABASE_URL || '';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://esm.sh"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "https://esm.sh", supabaseOrigin].filter(Boolean),
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
    },
  },
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── APIS & CLIENT INITIALIZATION ─────────────────────
const aiClient = getDefaultAIClient();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ─── AUTH MIDDLEWARE ───────────────────────────────────
// Verifies the Supabase session token sent from the frontend and attaches
// req.userId. Every route that reads/writes chat_logs requires this.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authentication token.' });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session.' });

    // Sprint 8.3 — Email verification gate. Unverified accounts can hold a
    // valid session token (sign-up succeeds before confirmation) but must
    // not be able to use the app itself. email_confirmed_at is populated by
    // Supabase Auth the moment the confirmation link is clicked (or
    // immediately at sign-up if email confirmations are disabled project-
    // wide), so this check is safe either way.
    if (!user.email_confirmed_at) {
      return res.status(403).json({
        error: 'Please verify your email before using Nocturnal. Check your inbox for the confirmation link.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    req.userId = user.id;
    req.userEmail = user.email;
    next();
  } catch (err) {
    console.error('Auth verification failure:', err);
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

// ─── RATE LIMITING ─────────────────────────────────────
// /chat triggers a billed AI provider call, so it's the endpoint that
// actually needs protection from abuse. Keyed by authenticated user id when present
// (the normal case, since requireAuth runs first) with IP as a fallback for
// any request that somehow reaches here without one. Limits are intentionally
// generous for a demo/personal-use environment, not a hard product tier.
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 30,                  // 30 messages per 10 minutes per user/IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many messages. Please wait a few minutes and try again.',
    });
  },
});


// ─── AUTO ROUTER KEYWORD ENGINE (MODEL TIER ONLY) ─────
// NOTE: this selects which MODEL TIER answers (flash/insight/abyss) — it is
// entirely separate from the capability planner (lib/planner.js), which
// decides WHETHER live search is needed. The two run independently; a
// search-augmented question can still land on any tier.
function autoSelectMode(msg) {
  const m = msg.toLowerCase();

  const abyssKeywords = [
    "compare", "vs ", " versus ", "tradeoff", "pros and cons",
    "in detail", "analyze", "analyse", "research", "plan",
    "architecture", "scalable", "deep dive", "step by step",
    "semester", "strategy", "comprehensive", "thorough",
    "difference between", "which is better", "evaluate",
  ];

  const insightKeywords = [
    "code", "debug", "fix", "function", "class", "sql", "api",
    "algorithm", "javascript", "python", "java", "css", "html",
    "explain", "how does", "how do", "assignment", "study",
    "website", "backend", "frontend", "database", "ospf", "vlan",
    "network", "programming", "script", "error", "bug", "implement",
    "build", "create a", "write a",
  ];

  if (abyssKeywords.some(k => m.includes(k))) return "abyss";
  if (insightKeywords.some(k => m.includes(k))) return "insight";
  return "flash";
}

// ─── MODE INSTRUCTIONS ───────────────────────────────
const modeInstructions = {
  flash: `
- Be fast, warm, and helpful. Keep replies concise, but never terse to the point of feeling dismissive or nonchalant.
- For simple greetings or small talk, respond naturally and briefly (e.g. "Hey! What can I help you with today?") — no self-introductions, no robotic stock phrases.
- For general questions, answer directly in 1-4 short lines. Prefer short paragraphs over walls of text; use a brief bullet list only when it genuinely helps.
- For programming/coding questions: give the code first in a properly formatted triple-backtick code block, then a short explanation underneath (1-3 lines). Mention time/space complexity only when it's actually useful. No long essays.
- Do NOT use **bold**, headers, or other markdown styling — plain text and bullet points ("- ") are fine, and triple-backtick code blocks are always fine.
- If you don't know something, or it needs current/live information you don't have, say so plainly and naturally (e.g. "I don't have reliable information about that" or "I'm not certain — that may need a quick search"). Never guess or invent facts, and never sound dismissive or overconfident.
- Personality: calm, helpful, a little witty when it naturally fits — never sarcastic, dismissive, or over-the-top with jokes.
`,
  insight: `
- Give balanced, clear responses
- Help with code, debugging, and technical topics
- Explain concepts clearly when needed
- Be precise and practical
- Use markdown only for code blocks with triple backticks, not for bold or headers
`,
  abyss: `
- Think deeply and carefully before answering
- Give detailed, thorough explanations
- Consider alternatives and tradeoffs
- Think step by step
- Prioritize quality over speed
- Use markdown only for code blocks with triple backticks, not for bold or headers
`,
};

// Objective 4 — Mode-Aware Status Pipeline. Extra SSE stages emitted
// between "thinking" and "generating" (or "searching", if the planner
// routes to search), reflecting the depth of reasoning each mode
// actually promises in modeInstructions above. Stage keys only — display
// text lives entirely in the frontend's STAGE_LABELS map (public/script.js),
// same separation the rest of the stage system already uses.
const MODE_EXTRA_STAGES = {
  flash: [],
  insight: ['analyzing'],
  abyss: ['thinking_deeply', 'analyzing', 'reasoning'],
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Sprint 8A.8 — bounds a single async phase (currently: document
// parsing/extraction) to its own timeout budget, independent of any
// other phase's timer. Resolves to { ok: true, value } on success or
// { ok: false, timedOut: true } if `ms` elapses first — never throws,
// so callers can fail closed with a friendly message the same way the
// rest of the pipeline does. This is deliberately generic (not
// document-specific) so a future phase (e.g. OCR) can reuse it with its
// own budget without duplicating the race logic.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
  });
  return Promise.race([
    promise.then(value => ({ ok: true, value })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}


// ─── STRIP MARKDOWN PIPELINE ──────────────────────────
function stripMarkdown(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')  // remove deepseek think blocks
    .replace(/^#{1,6}\s+/gm, '')                // remove ### headers
    .replace(/\*\*(.*?)\*\*/g, '$1')            // remove **bold**
    .replace(/\*(.*?)\*/g, '$1')                // remove *italic*
    .replace(/^[-*_]{3,}\s*$/gm, '')            // remove --- dividers
    .replace(/^\s*[-*+]\s+/gm, '• ')            // convert - bullets to •
    .replace(/^\s*\d+\.\s+/gm, '')              // remove numbered list markers
    .trim();
}

// ─── INPUT VALIDATION ──────────────────────────────────
const MAX_MESSAGE_LENGTH = 4000;      // characters

// ═══════════════ SPRINT 7 — PERSONALIZATION ═══════════════
// AI Settings (BYOK) encryption + Personality server-side lookup.
// Nothing here is called yet by any existing route — wired into /chat below.

// ─── BYOK: AES-256-GCM ENCRYPTION FOR STORED API KEYS ──
// SETTINGS_ENCRYPTION_KEY must be a 64-char hex string (32 raw bytes).
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
function getEncryptionKeyBuffer() {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, 'hex');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

function encryptApiKey(plaintext) {
  const key = getEncryptionKeyBuffer();
  if (!key) throw new Error('SETTINGS_ENCRYPTION_KEY is not configured or invalid (expected 64-char hex).');
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Ciphertext + authTag stored together (base64); iv stored separately.
  return {
    encryptedApiKey: Buffer.concat([encrypted, authTag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

// Returns the decrypted plaintext key, or null on any failure (bad/rotated
// encryption key, corrupted row, etc). Callers must treat null as "no BYOK
// key available" and fall back — never throw a user-facing error from here.
function decryptApiKey(encryptedApiKey, ivBase64) {
  const key = getEncryptionKeyBuffer();
  if (!key || !encryptedApiKey || !ivBase64) return null;
  try {
    const iv = Buffer.from(ivBase64, 'base64');
    const combined = Buffer.from(encryptedApiKey, 'base64');
    const authTag = combined.subarray(combined.length - 16);
    const ciphertext = combined.subarray(0, combined.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    console.error('Failed to decrypt stored API key:', err.message);
    return null;
  }
}

// ─── BYOK: PER-USER AI PROVIDER CLIENT ─────────────────
// Looks up the caller's stored settings and, if present and decryptable,
// returns an AI provider client scoped to their own key + their preferred
// model. Returns null on ANY failure (no row, decrypt failure, DB error) —
// the caller always has a working default client to fall back to.
async function getUserAIClient(userId) {
  try {
    const { data, error } = await supabase
      .from('user_ai_settings')
      .select('encrypted_api_key, encryption_iv, model')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.encrypted_api_key || !data.encryption_iv) return null;

    const apiKey = decryptApiKey(data.encrypted_api_key, data.encryption_iv);
    if (!apiKey) return null;

    return { client: createAIClient({ apiKey }), model: data.model || null };
  } catch (err) {
    console.error(`BYOK lookup failed for user ${userId}:`, err.message);
    return null;
  }
}

// ─── PERSONALITY: PRESET → INSTRUCTION MAPPING ─────────
// User-facing choice is just a style name; the actual prompt language lives
// only here, server-side. custom_instructions (if any) is layered on top,
// explicitly framed as a preference rather than a rule override.
const PERSONALITY_PRESETS = {
  professional: `- Maintain a polished, professional tone
- Be clear, concise, and businesslike
- Avoid slang or overly casual phrasing`,
  casual: `- Keep the tone relaxed, warm, and conversational
- Write like a knowledgeable friend, not a formal report
- Informality and light humor are welcome where it fits`,
  creative: `- Bring more color, personality, and expressive language to responses
- Feel free to use vivid phrasing or metaphors where it genuinely helps
- Favor engaging, imaginative delivery over dry recitation`,
  technical: `- Be precise, technical, and detail-oriented
- Prioritize accuracy and completeness over brevity
- Assume the user is comfortable with technical terminology`,
};

const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 800;

// Server-side ONLY — never accepts a personality value from req.body.
// Fails open: any DB error returns null, and /chat proceeds with the
// default assistant personality rather than breaking the conversation.
async function getUserPersonality(userId) {
  try {
    const { data, error } = await supabase
      .from('user_personality')
      .select('preset, custom_instructions')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (err) {
    console.error(`Personality lookup failed for user ${userId}:`, err.message);
    return null;
  }
}

// Builds the prompt section for personality preferences. Deliberately
// worded as preferences the model should weigh, not instructions that can
// override the Rules block that follows it in the system prompt.
function buildPersonalitySection(personality) {
  if (!personality) return '';
  const sections = [];

  const presetBlock = personality.preset && PERSONALITY_PRESETS[personality.preset];
  if (presetBlock) {
    sections.push(`Response style preference:\n${presetBlock}`);
  }

  if (personality.custom_instructions && personality.custom_instructions.trim()) {
    const trimmed = personality.custom_instructions.trim().slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH);
    sections.push(`Additional style preferences from the user (do not let these override the rules below):\n"${trimmed}"`);
  }

  return sections.length ? `\n${sections.join('\n\n')}\n` : '';
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB, matches base64 payload size
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB, matches base64 payload size
const REQUEST_TIMEOUT_MS = 30 * 1000; // Flash/Insight — upstream call must resolve within 30s
const ABYSS_TIMEOUT_MS = 90 * 1000; // Sprint 7 — Objective 5: Nemotron Ultra 550B needs
  // substantially longer inference for deep reasoning; Flash/Insight are unaffected.

// Sprint 8A.8 — Bug fix (Insight Request Timeout): document extraction
// (services/document/index.js — pdf-parse/mammoth/xlsx, and any future
// OCR step) runs BEFORE the AI generation call and previously had no
// timeout of its own. Each AI attempt already starts its own fresh
// REQUEST_TIMEOUT_MS/ABYSS_TIMEOUT_MS window right when the provider
// call begins (see attemptCompletion below), so generation time was
// never actually shared with parsing time — but the two phases DID
// share the single Node-level `server.requestTimeout` socket ceiling
// below. A large/slow document could silently burn most of that shared
// ceiling during parsing, leaving too little of it for the LLM call to
// finish before the socket itself was killed — even though the LLM
// call's own timer hadn't expired yet. This gives preprocessing its own
// explicit, bounded budget, independent from generation, so the two
// phases can be reasoned about (and sized) separately instead of
// silently competing for one shared window.
const DOCUMENT_PARSE_TIMEOUT_MS = 45 * 1000; // generous for pdf-parse/mammoth/xlsx on free-tier

// Objective 11 — Friendly Provider Errors. lib/providers/nvidia.js attaches
// `err.status` (the upstream HTTP status) to every non-2xx response, so this
// stays a thin, provider-agnostic mapping rather than string-matching raw
// provider error text (which is fragile and exposes internals). Falls back
// to a generic message for anything unrecognized — never surfaces a raw
// stack trace or provider error string to the user.
function getFriendlyProviderError(err) {
  const status = err?.status;
  if (status === 429 || status === 503) {
    return "NVIDIA is at capacity right now. Please try again in a moment.";
  }
  if (status === 401 || status === 403) {
    return "There's a configuration issue with the AI provider. Please try again later.";
  }
  if (typeof status === 'number' && status >= 500) {
    return "The AI provider is having trouble right now. Please try again in a moment.";
  }
  return "❌ Something went wrong. Please try again.";
}

// Voice input/output is handled entirely client-side via the browser's
// native Web Speech API (SpeechRecognition/SpeechSynthesis) — see
// public/script.js. There is no backend speech-to-text provider.

// Validates the /chat request body. Returns an error string, or null if valid.
function validateChatRequest(body) {
  const { message, image, file } = body;

  if (typeof message !== 'string' || message.trim().length === 0) {
    return "Message cannot be empty.";
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`;
  }

  if (image) {
    if (typeof image !== 'string') {
      return "Invalid image data.";
    }
    // Expected format: data:image/<type>;base64,<data>
    const match = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!match) {
      return "Image must be a valid base64 data URL.";
    }
    const [, mimeType, base64Data] = match;
    if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
      return `Unsupported image type. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}.`;
    }
    // Approximate decoded byte size from base64 length (each 4 chars ≈ 3 bytes)
    const approxBytes = Math.ceil(base64Data.length * 0.75);
    if (approxBytes > MAX_IMAGE_BYTES) {
      return `Image is too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)}MB).`;
    }
  }

  // Non-image files (the ones the Document Router/Service will handle).
  // Images sent through the same unified "Attach Files" input are validated
  // above via the `image` branch instead — server.js bridges those before
  // this function ever sees the request (see the /chat handler).
  if (file && !(typeof file.type === 'string' && file.type.startsWith('image/'))) {
    if (typeof file !== 'object' || typeof file.name !== 'string' || typeof file.data !== 'string') {
      return "Invalid file data.";
    }
    const match = file.data.match(/^data:[^;]+;base64,(.+)$/);
    if (!match) {
      return "File must be a valid base64 data URL.";
    }
    const approxBytes = Math.ceil(match[1].length * 0.75);
    if (approxBytes > MAX_DOCUMENT_BYTES) {
      return `File is too large (max ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB).`;
    }
  }

  return null;
}

// ─── CORE CHAT PIPELINE ENDPOINT ──────────────────────
app.post("/chat", requireAuth, chatLimiter, async (req, res) => { 
  // Sprint 7: `personality` intentionally NOT destructured from req.body.
  // Personality is always loaded server-side via req.userId (see below) —
  // a client-supplied value is never trusted or used.
  const { message, history, mode, sessionId, image: rawImage, file, forceSearch } = req.body;

  // The single "Attach Files" input (public/index.html's attach-uploader,
  // accept="image/*,.pdf,.docx,.txt,.md,.xlsx") can produce either an image
  // or a document — the user never picks a pipeline manually (Objective 1).
  // This just normalizes that one entry point into the two variables the
  // rest of the handler expects; images must still never go through the
  // Document Router. This is entry-point normalization only, not a merge
  // of the two services: Vision and Document routers remain fully
  // independent below.
  const image = rawImage || (file && (file.type || '').startsWith('image/') ? file.data : null);
  const documentFile = (file && !(file.type || '').startsWith('image/')) ? file : null;

  const validationError = validateChatRequest(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  let timedOut = false;

  // Sprint 6 — REAL-TIME PROCESSING EVENTS: everything past this point is
  // committed to a streaming response (Objective 1). Headers go out now,
  // before any slow work starts, so the frontend's connection opens
  // immediately. From here on, failures must be reported as an SSE `error`
  // event (lib/sse.js) — res.status()/res.json() can no longer be used,
  // since HTTP headers are already flushed.
  initSSE(res);

  // Objective 9 — Premium Response Metadata: wall-clock time for this
  // request, measured from the moment the stream opens (matches what the
  // user actually perceives as "how long did that take").
  const requestStartedAt = Date.now();

  // If the client aborts (Stop button / navigates away), cancel whatever
  // upstream AI call is in flight instead of letting it run to completion
  // for nothing. attemptCompletion() (below) keeps this reference current
  // for whichever request is actually active.
  let currentController = null;
  req.on('close', () => {
    if (currentController) currentController.abort();
  });

  // Sprint 8.5.1 — LOCAL TOOLS: requests like "what time is it" or "what's
  // today's date" don't need the planner, a search provider, or the LLM at
  // all. Checked first, before mode selection/planner, and skipped when an
  // image is attached (that path is already deterministic — vision, not a
  // local tool). Consumes zero search credits, zero planner calls, zero AI
  // tokens. Still persisted to chat_logs like any other turn so history/
  // continuity behave the same as a normal reply.
  if (!image && !documentFile && !forceSearch) {
    const localMatch = matchLocalTool(message);
    if (localMatch) {
      console.log(`[LocalTool] ${localMatch.name}`);
      const localSelectedMode = mode === 'auto' ? 'flash' : (MODELS[mode] ? mode : 'flash');
      if (sessionId) {
        saveConversationToDatabase(sessionId, message, localMatch.reply, localSelectedMode, image, req.userId)
          .catch(dbErr => console.error("Database storage tracking failure:", dbErr));
      }
      sendFinal(res, {
        reply: localMatch.reply,
        mode: localSelectedMode,
        usedSearch: false,
        sources: [],
        elapsedMs: Date.now() - requestStartedAt,
        usedVision: false,
        usedDocument: false,
      });
      return;
    }
  }

  try {
    // Sprint 4 — VISION SERVICE: an attached image is never answered by the
    // Vision Model directly. VisionRouter still decides which model does
    // the *perception* (config/models.js VISION_MODEL), but the Vision
    // Model's structured analysis is then handed to whichever chat model
    // the user/Auto-mode actually selected (Flash/Insight/Abyss) — same
    // mode-selection logic as any text-only request. This replaces the
    // previous behavior where an image forced selectedMode = "abyss" and
    // was sent straight to the Vision Model as the final answerer.
    //
    // visionInstruction, when set, carries the internal "Vision Analysis +
    // question" prompt (services/vision/promptBuilder.js) that gets folded
    // into the system prompt below instead of a raw image content block.
    let selectedMode;
    let defaultModel;
    let visionInstruction = null;
    let documentInstruction = null;
    // Objective 2: only set when a NEW document is attached this turn
    // (mirrors how `image` itself is null on follow-up turns) — never
    // populated from the cache reuse branch below, so persistence only
    // ever writes the turn where the document was actually uploaded.
    let documentMeta = null;
    // Sprint 8A.5: the session's cached document (if any), fetched once in
    // the "no new attachment" branch below and handed to the planner as
    // documentContext — server.js no longer scores relevance itself (that
    // was Sprint 8A.3's direct call to DocumentRelevanceEngine; it's now
    // done once, inside the planner, which is the single source of truth
    // for whether/how a cached document gets injected this turn).
    let cachedDocumentForPlanner = null;

    if (image) {
      const vision = routeVision();
      if (!vision.ok) {
        sendErrorEvent(res, `I can't process images right now — ${vision.error}`, 503);
        return;
      }

      // Objective 2 — image request: "Reading image..." is the first stage
      // emitted, before "Thinking...".
      sendStage(res, 'reading_image');

      const visionResult = await VisionService.analyzeImage({
        client: aiClient,
        model: vision.model,
        image,
        question: message,
      });

      if (!visionResult.ok) {
        // Never expose raw provider errors — friendly message only.
        // visionResult.error is logged inside VisionService.
        sendErrorEvent(res, "I couldn't process that image right now. Please try again in a moment.", 503);
        return;
      }

      // Objective 8: cache this analysis so follow-up questions about the
      // same image don't re-trigger the Vision Model.
      VisionContext.setAnalysis(sessionId, visionResult.analysis);
      visionInstruction = buildVisionGroundedPrompt({ question: message, analysis: visionResult.analysis });
      console.log('[Vision] Prompt built');

      selectedMode = mode === "auto"
        ? autoSelectMode(message)
        : (MODELS[mode] ? mode : "flash");
      defaultModel = MODELS[selectedMode];
      console.log(`[Vision] Passing analysis to ${selectedMode} → Model: ${defaultModel}`);
    } else if (documentFile) {
      // Sprint 6b — DOCUMENT SERVICE: mirrors the Vision branch's shape
      // exactly, but stays fully independent (Objective 8: "Do not merge
      // Vision and Document logic. Keep both services independent.") —
      // its own router, its own service, its own prompt builder, and it
      // never touches VisionContext or the vision instruction.
      const docRoute = routeDocument(documentFile);
      if (!docRoute.ok) {
        sendErrorEvent(res, docRoute.error, 400);
        return;
      }

      // Objective 2 — document request: "Reading document..." first,
      // before "Thinking...".
      sendStage(res, 'reading_document');

      // Sprint 8A.8 — Bug fix: bounded so a large/slow document can't
      // silently consume the generation timeout's share of the shared
      // socket-level ceiling (see DOCUMENT_PARSE_TIMEOUT_MS above). The
      // AI generation call gets its own full timeout window regardless
      // of how long parsing took, as long as parsing itself finishes
      // within this budget.
      const parseOutcome = await withTimeout(
        DocumentService.extractText({ file: documentFile, type: docRoute.type }),
        DOCUMENT_PARSE_TIMEOUT_MS
      );
      if (!parseOutcome.ok) {
        sendErrorEvent(res, "That document is taking too long to process — please try a smaller file or try again in a moment.", 408);
        return;
      }
      const docResult = parseOutcome.value;
      if (!docResult.ok) {
        const friendly = docResult.error === 'no_text'
          ? "I couldn't find any readable text in that document."
          : "I couldn't process that document right now. Please try again in a moment.";
        sendErrorEvent(res, friendly, 400);
        return;
      }

      documentInstruction = buildDocumentGroundedPrompt({
        question: message,
        docType: docRoute.type,
        fileName: documentFile.name,
        text: docResult.text,
        truncated: docResult.truncated,
      });
      console.log('[Document] Prompt built');

      // Objective 8: cache this extraction so follow-up questions about
      // the same document don't re-trigger the Document Service.
      DocumentContext.setDocument(sessionId, {
        text: docResult.text,
        fileName: documentFile.name,
        docType: docRoute.type,
        truncated: docResult.truncated,
      });

      // Objective 2: extracted text + metadata only (no raw file bytes),
      // persisted below alongside this turn's chat_logs row.
      const docBase64 = (documentFile.data || '').split(',')[1] || '';
      documentMeta = {
        fileName: documentFile.name,
        docType: docRoute.type,
        size: Math.ceil(docBase64.length * 0.75),
        text: docResult.text,
        truncated: !!docResult.truncated,
      };

      selectedMode = mode === "auto"
        ? autoSelectMode(message)
        : (MODELS[mode] ? mode : "flash");
      defaultModel = MODELS[selectedMode];
      console.log(`[Document] Passing extracted text to ${selectedMode} → Model: ${defaultModel}`);
    } else {
      selectedMode = mode === "auto"
        ? autoSelectMode(message)
        : (MODELS[mode] ? mode : "flash");
      defaultModel = MODELS[selectedMode];
      console.log(`Mode: ${mode} → Selected: ${selectedMode} → Model: ${defaultModel}`);

      // Objective 8: no new image this turn — reuse the last analyzed
      // image's context (if any) for this session so follow-ups like
      // "what color is the car?" stay grounded without another Vision call.
      //
      // Sprint 8A.7 — VisionRelevanceEngine: previously this injected the
      // cached analysis unconditionally, so an unrelated follow-up ("who
      // is Messi?") kept getting the old image's description folded into
      // the prompt. Mirrors DocumentRelevanceEngine's fix for the same
      // "sticky" bug on the document side — score the question against
      // the cached analysis and only reuse it when actually relevant.
      const cachedVisionEntry = VisionContext.getAnalysisEntry(sessionId);
      if (cachedVisionEntry) {
        const visionRelevance = scoreVisionRelevance(message, cachedVisionEntry.analysis, cachedVisionEntry.updatedAt);
        if (visionRelevance.decision === 'USE_VISION') {
          visionInstruction = buildVisionGroundedPrompt({ question: message, analysis: cachedVisionEntry.analysis });
          console.log(`[Vision] Reusing cached analysis for follow-up (relevance=${visionRelevance.score})`);
        } else if (process.env.NODE_ENV !== 'production') {
          console.log(`[Vision] Cached analysis ignored — not relevant to this turn (relevance=${visionRelevance.score})`);
        }
      }

      // Sprint 8A.5: no new document this turn — there MAY be a cached
      // extraction from an earlier upload in this session. Whether it's
      // actually relevant to THIS question, and whether it should combine
      // with search (HYBRID), is now decided entirely by Planner V2 below
      // (see the SEARCH ROUTING block) — server.js just hands the raw
      // cached document over as documentContext and acts on plan.route.
      // This replaces Sprint 8A.3's direct DocumentRelevanceEngine.score()
      // call here, which duplicated a judgment the planner now also makes;
      // there is now exactly one place relevance is scored per request.
      cachedDocumentForPlanner = DocumentContext.getDocument(sessionId);
    }

    // Objective 2 — "Thinking..." always fires next: after vision analysis
    // (if any) has resolved, before search routing / prompt assembly. This
    // matches every flow in the spec (normal, search, vision, document all
    // pass through "Thinking..." at this point).
    sendStage(res, 'thinking');

    // Objective 4 — Mode-Aware Status Pipeline. Insight and Abyss get
    // additional stages reflecting the deeper reasoning those modes
    // actually do; Flash has none, so it's completely unaffected (no
    // added latency, same responsiveness as before this sprint — see
    // Objective 5's requirement that Flash/Insight stay fast). The small
    // delay between synthetic stages exists only so each one is actually
    // perceptible to the user (SSE writes are otherwise near-instant);
    // it's short and bounded (300ms × at most 3 stages for Abyss) and
    // dwarfed by real upstream latency in every mode.
    for (const stage of MODE_EXTRA_STAGES[selectedMode] || []) {
      await sleep(300);
      sendStage(res, stage);
    }

    const modeInstruction = modeInstructions[selectedMode];

    // Search context, sources, and clarify state — populated by the search
    // routing block below for ANY text mode (Flash/Insight/Abyss/Auto).
    // Only the image path (vision, handled deterministically above) leaves
    // all three null/false and goes straight to completion.
    let searchContextBlock = null;
    let searchSources = [];
    let searchFailed = false;

    // Computed fresh per request — single source of truth for "today" in both
    // the planner prompt and the main system prompt below.
    const currentDate = new Date();
    const currentDateString = currentDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // ── SEARCH ROUTING (Sprint 3, upgraded Sprint 8A.5) ─
    // Search/Document context is an independent capability that sits ABOVE
    // mode selection — it runs the same way regardless of whether the user
    // picked Flash, Insight, Abyss, or Auto. selectedMode (already resolved
    // above) is never read or altered here; this block only decides which
    // context (if any) gets injected before that model answers.
    //
    // Images still skip routing entirely: that path is deterministic and
    // already fully handled above (Vision Service analyzes the image, then
    // hands its analysis to whichever mode was selected). Vision context
    // injection is intentionally NOT gated by the planner — it has its own
    // independent, unconditional cache-reuse mechanism above, unchanged by
    // this sprint.
    //
    // lib/searchRouter.js owns the actual decision (via Planner V2) — this
    // block just acts on whatever it returns, injecting ONLY the context
    // the planner actually selected (Sprint 8A.5 — Smart Context
    // Injection: no more "search AND unconditionally-cached document"
    // stacking, no more scoring relevance a second time here):
    //   CHAT     → no document, no search — conversation memory only
    //   DOCUMENT → cached document only (already scored relevant by the planner)
    //   SEARCH   → live search context only
    //   HYBRID   → cached document AND live search — the only route where both combine
    //   CLARIFY  → ask a narrowing question before answering at all
    {
      const plan = await routeSearchDecision({
        aiClient,
        plannerModel: PLANNER_MODEL,
        message,
        history,
        currentDateString,
        image,
        sessionId,
        forceSearch,
        documentContext: cachedDocumentForPlanner,
      });

      if (plan.route === 'CLARIFY') {
        // Sprint 8A.7 fix: CLARIFY must terminate the request immediately —
        // no LLM call, no search, no document/vision context injection.
        // Previously this only set clarifyQuestion and fell through to the
        // normal pipeline, which still built the full prompt (including
        // any cached document/vision context) and called the LLM to ask
        // the clarifying question in its own words. That's unnecessary
        // cost and a violation of "CLARIFY should ask, not answer" — the
        // planner already produced the exact question to ask, so we send
        // it directly, same short-circuit shape as the local-tools branch
        // near the top of this handler.
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[Planner] clarify: "${plan.clarify}"`);
        }
        if (sessionId) {
          saveConversationToDatabase(sessionId, message, plan.clarify, selectedMode, image, req.userId)
            .catch(dbErr => console.error("Database storage tracking failure:", dbErr));
        }
        sendFinal(res, {
          reply: plan.clarify,
          mode: selectedMode,
          usedSearch: false,
          sources: [],
          elapsedMs: Date.now() - requestStartedAt,
          usedVision: false,
          usedDocument: false,
        });
        return;
      } else {
        // DOCUMENT or HYBRID: inject the cached document the planner
        // already judged relevant (document_relevance/decision computed
        // once, inside the planner — never re-scored here).
        if ((plan.route === 'DOCUMENT' || plan.route === 'HYBRID') && cachedDocumentForPlanner) {
          documentInstruction = buildDocumentGroundedPrompt({
            question: message,
            docType: cachedDocumentForPlanner.docType,
            fileName: cachedDocumentForPlanner.fileName,
            text: cachedDocumentForPlanner.text,
            truncated: cachedDocumentForPlanner.truncated,
          });
          console.log(`[Document] Planner selected ${plan.route} — injecting cached document (relevance=${plan.document_relevance})`);
        }

        // SEARCH or HYBRID: fetch live search context.
        if (plan.route === 'SEARCH' || plan.route === 'HYBRID') {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[Planner] query: "${plan.query}" (category: ${plan.category})`);
          }
          sendStage(res, 'searching');
          try {
            // server.js never talks to a provider or the cache directly —
            // SearchService owns cache lookup/write and provider resolution
            // internally and always returns a normalized { provider, query,
            // results } shape, regardless of which provider is active.
            const { provider, results } = await SearchService.search(plan.query, {
              category: plan.category,
            });
            console.log(`[Search] ${provider}`);
            searchContextBlock = formatSearchContext(results, plan.query);
            searchSources = Array.isArray(results)
              ? results.filter(r => r?.url && r?.title).map(r => ({ title: r.title, url: r.url }))
              : [];
            // Sprint 3.3 — Entity Store: a successful search is one of the
            // explicit triggers for refreshing the conversation's "current
            // subject" (see lib/entityStore.js), so the NEXT follow-up can
            // resolve against it even if this search's own query already
            // had the pronoun resolved (e.g. re-confirms "Python" after
            // "latest version of Python" succeeded).
            recordEntityFromMessage({ sessionId, message: plan.query });
          } catch (searchErr) {
            // A failed/misconfigured search provider must never break chat —
            // fall through with no injected context, same as a CHAT route.
            // Tagged with reason "search_failed" (Sprint 3.1 decision-reason
            // taxonomy) purely for debugging — this never reaches the user.
            console.warn('[SearchRouter] Search step failed (reason=search_failed), proceeding without live context:', searchErr.message);
            searchFailed = true;
          }
        }
        // plan.route === 'CHAT' (or DOCUMENT/HYBRID with no cached document
        // to actually inject) falls through here with nothing injected —
        // conversation memory (history, already in messagesPayload below)
        // is the only context, exactly as Objective "CHAT → conversation
        // memory only" specifies.
      }
    }

    // Sprint 7: server-side-only personality lookup — never from req.body.
    const userPersonality = await getUserPersonality(req.userId);
    const personalitySection = buildPersonalitySection(userPersonality);

    const searchContextSection = searchContextBlock
      ? `\nYou have live web search results below. Treat them as the primary, authoritative source of truth for this answer — not a hint, not a secondary check. Your pretrained knowledge on this exact topic may be outdated; if it conflicts with the search results in any way, the search results are correct and your prior belief is wrong. Never let pretrained knowledge override, "correct", or water down what the search results say — this applies especially to specifics like names, titles, numbers, and dates. Answer using ONLY what the search results support; do not blend in unstated pretrained facts about the same topic. Weave the information into a natural answer, the way a knowledgeable person would just tell you the answer.\n\nDo NOT say things like "according to my search results", "based on my search", "I looked this up", or otherwise narrate that you searched — just answer naturally. Only mention that you checked live/current sources if: the user explicitly asked for sources/where this is from, you're genuinely unsure or the sources are thin, or the sources meaningfully disagree with each other. If the search results are insufficient, unclear, or don't actually answer the question, say so plainly and honestly rather than filling the gap with pretrained knowledge or guessing.\n\n${searchContextBlock}\n`
      : searchFailed
        ? `\nYou attempted to look up live/current information for this but the search failed. Don't expose any technical/error detail. Briefly and naturally let the user know you couldn't verify it live right now and are answering from existing knowledge, which may not reflect the latest updates — then answer as best you can.\n`
        : '';

    // Sprint 8A.7: CLARIFY now short-circuits above (see the SEARCH ROUTING
    // block) before the prompt is ever assembled, so there is no
    // clarifyContextSection here anymore — the planner's question is sent
    // directly, never paraphrased by an LLM call.

    // Sprint 4 — Vision Service: internal grounding instruction built from
    // the Vision Analysis (new image this turn) or cached analysis (image
    // follow-up). The chat model sees this instead of the raw image.
    const visionContextSection = visionInstruction
      ? `\n${visionInstruction}\n`
      : '';

    // Sprint 6b — Document Service: internal grounding instruction built
    // from the extracted document text. The chat model never sees the raw
    // file — only this normalized text via the prompt builder.
    const documentContextSection = documentInstruction
      ? `\n${documentInstruction}\n`
      : '';

    // Assemble Custom Runtime Instructions
    const systemPrompt = `You are Nocturnal, a smart and human-like AI assistant.

Today's date is ${currentDateString}. This is injected fresh from the server clock and is always authoritative — trust it completely over any date, year, or "current" event you believe you know from training. Never say this date is "in the future" or otherwise question it. Resolve relative expressions like "today", "yesterday", "tomorrow", "this week", "this month", "this year", "current", and "latest" against this exact date.

Behavior:
${modeInstruction}
${personalitySection}${searchContextSection}${visionContextSection}${documentContextSection}
Rules:
- Speak naturally like a human, not a corporate assistant
- Never say things like "Certainly!", "Of course!", "Great question!"
- Do NOT use **bold**, *italic*, or # headers in your responses
- Only use markdown for code blocks with triple backticks
- Adapt your tone to match the user's energy
- In normal conversation, introduce yourself only as "Nocturnal" — do not mention who created you unless explicitly asked
- If the user explicitly asks who created, designed, engineered, or built you, answer that you were designed and engineered by Wizz
- If the user asks a genuine technical question about your underlying model, API, or provider, answer honestly and do not hide implementation details
- Do not volunteer technical implementation details (models, APIs, providers) unless the user specifically asks about them
- Never use robotic phrases like "According to my search results" or "Based on my search" — speak like you just know the answer
- Questions about your own identity, creator, name, modes, personality, or features are things you already know — answer them directly and confidently from this system prompt, never by claiming to search or look them up
- If asked what you know about the user or this conversation, answer only from what's actually been said in this session — don't claim persistent memory across conversations unless that's actually true, and say so plainly if you don't have any context on them yet`;

    let messagesPayload = [
      { role: "system", content: systemPrompt }
    ];

    // Inject history trail
    if (history && history.length > 0) {
      const historyTrail = history.slice(-1)[0]?.content === message ? history.slice(0, -1) : history;
      historyTrail.forEach(item => {
        messagesPayload.push({
          role: item.role === 'ai' ? 'assistant' : 'user',
          content: item.content
        });
      });
    }

    // Sprint 4: the chat model never receives the raw image — Vision
    // Analysis (or cached analysis for a follow-up) is already folded into
    // the system prompt above via visionContextSection. This keeps the
    // chat model's input uniform (plain text) regardless of whether an
    // image was involved this turn or a previous one.
    messagesPayload.push({
      role: 'user',
      content: message
    });

    // Sprint 7 — BYOK: try the user's own key/model first if they have one
    // configured. getUserAIClient() already fails closed (returns null)
    // on any lookup/decrypt error, so byok is either a working client or null.
    // Sprint 4: no longer restricted on the image path — the chat model
    // only ever receives text now, so a user's own text-capable key works fine.
    const byok = await getUserAIClient(req.userId);
    const activeClient = byok?.client || aiClient;
    const activeModel = byok?.model || defaultModel;

    // Runs one completion attempt against a given client/model, bounded by
    // its own timeout window so a retry (BYOK → default) isn't starved by
    // time already spent on the first attempt.
    async function attemptCompletion(client, modelName) {
      const controller = new AbortController();
      currentController = controller; // lets req.on('close') above cancel this attempt
      let localTimedOut = false;
      // Objective 5: Abyss gets a longer window — Nemotron Ultra 550B's
      // deep-reasoning inference routinely exceeds the 30s Flash/Insight
      // budget. Manual Stop still works normally since it aborts the same
      // controller via req.on('close') regardless of which timeout is set.
      const timeoutMs = selectedMode === 'abyss' ? ABYSS_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      const id = setTimeout(() => {
        localTimedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const result = await client.chatComplete({
          model: modelName,
          messages: messagesPayload,
          temperature: selectedMode === 'insight' ? 0.3 : 0.6,
          maxTokens: 2048,
          signal: controller.signal,
        });
        return { result, localTimedOut };
      } finally {
        clearTimeout(id);
      }
    }

    // Objective 2 — last stage before the reply itself: fires once, right
    // before the first completion attempt (BYOK retry-to-default below
    // reuses the same "Generating..." stage rather than re-emitting it).
    sendStage(res, 'generating');

    let completion;
    let modelUsed = activeModel;
    try {
      const { result, localTimedOut } = await attemptCompletion(activeClient, activeModel);
      completion = result;
      timedOut = localTimedOut;
    } catch (err) {
      // Never let a stale/invalid BYOK key interrupt the conversation —
      // silently retry once on the shared default client before failing.
      if (byok && err.name !== 'AbortError') {
        console.warn(`BYOK request failed for user ${req.userId}, falling back to default client:`, err.message);
        try {
          const { result, localTimedOut } = await attemptCompletion(aiClient, defaultModel);
          completion = result;
          timedOut = localTimedOut;
          modelUsed = defaultModel;
        } catch (fallbackErr) {
          throw fallbackErr; // both clients failed — let the outer catch respond
        }
      } else {
        throw err;
      }
    }

    const rawResponse = completion.choices[0]?.message?.content || "No response from AI";
    const reply = stripMarkdown(rawResponse);
    console.log(`  ✓ ${modelUsed} responded${byok && modelUsed === defaultModel ? ' (fell back from BYOK)' : ''}`);

    // Async Database Persistence
    if (sessionId) {
      saveConversationToDatabase(sessionId, message, reply, selectedMode, image, req.userId, documentMeta)
        .catch(dbErr => console.error("Database storage tracking failure:", dbErr));
    }

    sendFinal(res, {
      reply,
      mode: selectedMode,
      usedSearch: !!searchContextBlock,
      sources: searchContextBlock ? searchSources : [],
      elapsedMs: Date.now() - requestStartedAt,
      usedVision: !!visionInstruction,
      usedDocument: !!documentInstruction,
    });

  } catch (err) {
    if (err.name === "AbortError") {
      if (timedOut) {
        console.log("⏱️ Upstream AI request timed out");
        sendErrorEvent(res, "The AI provider took too long to respond. Please try again.", 504);
        return;
      }
      // Client disconnected (Stop button / navigation) — nothing to send
      // back, the connection is already gone.
      console.log("🛑 Request cancelled");
      if (!res.writableEnded) res.end();
      return;
    }
    console.error("AI Operations failure:", err);
    const status = (typeof err?.status === 'number' && err.status >= 400 && err.status < 600) ? err.status : 500;
    sendErrorEvent(res, getFriendlyProviderError(err), status);
  }
});

// ─── DATABASE PERSISTENCE ──────────────────────────────
// Inserts one completed turn (user message + AI reply) into chat_logs.
// Called fire-and-forget at both call sites (.catch() logs, never throws),
// so a DB failure never blocks the response already on its way to the client.
//
// Schema columns written here must stay in sync with the SELECT in
// GET /sessions/:sessionId (user_message, ai_response, mode, attached_asset,
// attached_document).
async function saveConversationToDatabase(sessionId, userMessage, aiResponse, mode, image, userId, documentMeta) {
  const { error } = await supabase
    .from('chat_logs')
    .insert({
      session_id:     sessionId,
      user_id:        userId,
      user_message:   userMessage,
      ai_response:    aiResponse,
      mode:           mode,
      // image is the raw base64 data-URL string when present, null otherwise.
      // Stored as `attached_asset` to keep the column name provider-agnostic
      // (future sprints may attach other asset types).
      attached_asset: image || null,
      // Objective 2 — documents persist as extracted text + metadata only
      // (no raw file bytes): { fileName, docType, size, text, truncated }.
      // null when no document was attached this turn.
      attached_document: documentMeta || null,
    });

  if (error) throw error;
}

// ─── ENDPOINT: RETRIEVE ALL DISTINCT SESSIONS ─────────
app.get('/history/all', requireAuth, async (req, res) => {
  try {
    // ascending: true so the FIRST message of each session is encountered first.
    // seenIds deduplication then locks the title to that first row and ignores
    // every subsequent message in the same session — title never shifts.
    const { data, error } = await supabase
      .from('chat_logs')
      .select('session_id, user_message, title, created_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    const firstMessageMap = {};  // session_id → { user_message, title }
    const sessionOrder = [];     // tracks insertion order (oldest session first)

    if (data) {
      data.forEach(row => {
        if (!firstMessageMap[row.session_id]) {
          firstMessageMap[row.session_id] = {
            user_message: row.user_message,
            title: row.title || null,
          };
          sessionOrder.push(row.session_id);
        }
      });
    }

    // Reverse so newest session appears at top of sidebar
    sessionOrder.reverse();

    const uniqueSessions = sessionOrder.map(id => {
      const { user_message, title } = firstMessageMap[id];
      // Use explicit title if set, otherwise fall back to first message text
      const raw = title || user_message;
      return {
        session_id: id,
        preview: raw.length > 28 ? raw.slice(0, 28) + "..." : raw,
      };
    });

    return res.json({ sessions: uniqueSessions });
  } catch (err) {
    console.error("Failed to parse distinct chat groups:", err);
    return res.status(500).json({ error: "Could not fetch side panel components." });
  }
});

// ─── ENDPOINT: FETCH CONVERSATION FOR SELECTED SESSION ──
app.get('/sessions/:sessionId', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  try {
    const { data, error } = await supabase
      .from('chat_logs')
      .select('user_message, ai_response, mode, attached_asset, attached_document, created_at')
      .eq('session_id', sessionId)
      .eq('user_id', req.userId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return res.json({ sessionLogs: data || [] });
  } catch (err) {
    console.error("Database connection fault:", err);
    return res.status(500).json({ error: "Could not pull thread logs." });
  }
});

// ─── ENDPOINT: DELETE A SESSION ───────────────────────
// FIX: New endpoint — deletes all chat_logs rows for a given session_id.
app.delete('/sessions/:sessionId', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  try {
    const { error } = await supabase
      .from('chat_logs')
      .delete()
      .eq('session_id', sessionId)
      .eq('user_id', req.userId);

    if (error) throw error;
    console.log(`Deleted session: ${sessionId}`);
    return res.json({ success: true });
  } catch (err) {
    console.error("Failed to delete session:", err);
    return res.status(500).json({ error: "Could not delete session." });
  }
});


// ─── ENDPOINT: RENAME A SESSION TITLE ────────────────
app.patch(`/sessions/:sessionId/title`, requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: "Title cannot be empty." });
  try {
    const { error } = await supabase.from(`chat_logs`).update({ title: title.trim() }).eq(`session_id`, sessionId).eq(`user_id`, req.userId);
    if (error) throw error;
    console.log(`Renamed session ${sessionId}`);
    return res.json({ success: true });
  } catch (err) {
    console.error("Failed to rename session:", err);
    return res.status(500).json({ error: "Could not rename session." });
  }
});

// ─── ENDPOINT: AI SETTINGS (BYOK — Sprint 7) ──────────
// GET returns only { hasSettings, model } — the API key itself is NEVER
// sent back to the browser, matching how settings.js already expects this.
app.get('/api/ai-settings', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_ai_settings')
      .select('model, encrypted_api_key')
      .eq('user_id', req.userId)
      .maybeSingle();
    if (error) throw error;

    return res.json({
      hasSettings: !!(data && data.encrypted_api_key),
      model: data?.model || null,
    });
  } catch (err) {
    console.error('Failed to load AI settings:', err);
    return res.status(500).json({ error: 'Could not load AI settings.' });
  }
});

app.post('/api/ai-settings', requireAuth, async (req, res) => {
  const { apiKey, model } = req.body;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'API key is required.' });
  }
  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: 'Model is required.' });
  }

  try {
    const { encryptedApiKey, iv } = encryptApiKey(apiKey.trim());
    const { error } = await supabase
      .from('user_ai_settings')
      .upsert(
        {
          user_id: req.userId,
          encrypted_api_key: encryptedApiKey,
          encryption_iv: iv,
          model: model.trim(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );
    if (error) throw error;

    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to save AI settings:', err);
    if (err.message && err.message.includes('SETTINGS_ENCRYPTION_KEY')) {
      return res.status(500).json({ error: 'Personal API keys are temporarily unavailable. Please try again later.' });
    }
    return res.status(500).json({ error: 'Could not save AI settings.' });
  }
});

app.delete('/api/ai-settings', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('user_ai_settings')
      .delete()
      .eq('user_id', req.userId);
    if (error) throw error;

    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to remove AI settings:', err);
    return res.status(500).json({ error: 'Could not remove AI settings.' });
  }
});

// ─── ENDPOINT: PERSONALITY (Sprint 7) ─────────────────
const VALID_PERSONALITY_PRESETS = Object.keys(PERSONALITY_PRESETS); // professional | casual | creative | technical

app.get('/api/personality', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_personality')
      .select('preset, custom_instructions')
      .eq('user_id', req.userId)
      .maybeSingle();
    if (error) throw error;

    return res.json({
      preset: data?.preset || null,
      customInstructions: data?.custom_instructions || '',
    });
  } catch (err) {
    console.error('Failed to load personality settings:', err);
    return res.status(500).json({ error: 'Could not load personality settings.' });
  }
});

app.post('/api/personality', requireAuth, async (req, res) => {
  const { preset, customInstructions } = req.body;

  if (preset !== null && preset !== undefined && !VALID_PERSONALITY_PRESETS.includes(preset)) {
    return res.status(400).json({ error: 'Invalid response style selected.' });
  }
  if (customInstructions && typeof customInstructions !== 'string') {
    return res.status(400).json({ error: 'Invalid custom instructions.' });
  }
  if (customInstructions && customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
    return res.status(400).json({ error: `Custom instructions must be under ${MAX_CUSTOM_INSTRUCTIONS_LENGTH} characters.` });
  }

  try {
    const { error } = await supabase
      .from('user_personality')
      .upsert(
        {
          user_id: req.userId,
          preset: preset || null,
          custom_instructions: (customInstructions || '').trim() || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );
    if (error) throw error;

    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to save personality settings:', err);
    return res.status(500).json({ error: 'Could not save personality settings.' });
  }
});

app.delete('/api/personality', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('user_personality')
      .delete()
      .eq('user_id', req.userId);
    if (error) throw error;

    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to remove personality settings:', err);
    return res.status(500).json({ error: 'Could not remove personality settings.' });
  }
});

// ─── ENDPOINT: DELETE ACCOUNT (Sprint 8.3) ────────────────────
// Permanently and irreversibly deletes every row this user owns, then the
// Supabase Auth account itself. Order matters: application tables first
// (chat_logs FKs reference auth.users(id) without ON DELETE CASCADE, so a
// leftover row would make the admin.deleteUser call fail), auth user last.
// Uses the service-role client already initialized above — never exposed
// to the browser.
app.delete('/api/account', requireAuth, async (req, res) => {
  const userId = req.userId;

  try {
    const tableDeletes = await Promise.all([
      supabase.from('chat_logs').delete().eq('user_id', userId),
      supabase.from('user_ai_settings').delete().eq('user_id', userId),
      supabase.from('user_personality').delete().eq('user_id', userId),
    ]);

    const tableError = tableDeletes.find((r) => r.error);
    if (tableError) throw tableError.error;

    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(userId);
    if (authDeleteError) throw authDeleteError;

    return res.json({ success: true });
  } catch (err) {
    console.error(`Account deletion failed for user ${userId}:`, err);
    return res.status(500).json({ error: 'Could not delete your account. Please try again or contact support.' });
  }
});

// ─── ENDPOINT: PUBLIC CONFIG FOR FRONTEND AUTH ────────────────
// Serves the Supabase URL and anon public key to the browser so they
// don't need to be hardcoded in static HTML/JS files.
// The service role key is intentionally EXCLUDED from this response.
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl:     process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// ─── SERVER LISTENER ───────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\x1b[35m[NOCTURNAL CORE ACTIVE]\x1b[0m Running on http://localhost:${PORT}`);
  console.log("NVIDIA KEY EXISTS:", !!process.env.NVIDIA_API_KEY);
});

// Defense-in-depth: caps how long ANY connection can stay open, independent
// of the per-request AI provider timeout above. Prevents slow/hung clients or
// network issues from holding sockets open indefinitely.
//
// Sprint 8A.8 — Bug fix (Insight Request Timeout): this ceiling covers the
// ENTIRE request lifecycle, including document parsing (DOCUMENT_PARSE_TIMEOUT_MS,
// which runs before generation starts) as well as the AI generation call
// itself (up to ABYSS_TIMEOUT_MS, the longest of the per-mode windows). It
// must exceed the sum of the two worst-case phases with margin — previously
// it only budgeted for ABYSS_TIMEOUT_MS alone, so a slow document parse could
// eat into generation's share of this shared ceiling and get a request
// killed here even though the LLM call's own timer hadn't expired yet.
const REQUEST_CEILING_MARGIN_MS = 15 * 1000;
server.requestTimeout = DOCUMENT_PARSE_TIMEOUT_MS + ABYSS_TIMEOUT_MS + REQUEST_CEILING_MARGIN_MS; // 45s + 90s + 15s = 150s hard ceiling per request
server.headersTimeout = server.requestTimeout + 5 * 1000;  // must exceed requestTimeout per Node docs