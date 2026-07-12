import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Groq from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'crypto';

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
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
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
    req.userId = user.id;
    next();
  } catch (err) {
    console.error('Auth verification failure:', err);
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

// ─── RATE LIMITING ─────────────────────────────────────
// /chat triggers a billed Groq API call, so it's the endpoint that actually
// needs protection from abuse. Keyed by authenticated user id when present
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


// /voice/transcribe hits Whisper (also billed Groq usage), kept as its own
// limiter so voice traffic can never eat into or be starved by the /chat
// message quota above. Same key strategy (userId, IP fallback).
const voiceLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20,                  // 20 transcription requests per 10 minutes per user/IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many voice requests. Please wait a few minutes and try again.',
    });
  },
});

// Flash  → llama-4-scout-17b-16e-instruct  (tiny, ultra fast, vision capable)
// Insight → llama-3.3-70b (smart, great for code)
// Abyss  → qwen3-32b (reasoning)
const MODELS = {
  flash:   "meta-llama/llama-4-scout-17b-16e-instruct",
  insight: "llama-3.3-70b-versatile",
  abyss:   "qwen/qwen3-32b",
};

// ─── AUTO ROUTER KEYWORD ENGINE ───────────────────────
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
- Give very short, direct answers (1-3 lines max)
- No unnecessary explanation
- Be conversational and snappy
- Do NOT use markdown formatting like **bold** or bullet points
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

// ─── BYOK: PER-USER GROQ CLIENT ────────────────────────
// Looks up the caller's stored settings and, if present and decryptable,
// returns a Groq client scoped to their own key + their preferred model.
// Returns null on ANY failure (no row, decrypt failure, DB error) — the
// caller always has a working default client to fall back to.
async function getUserGroqClient(userId) {
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

    return { client: new Groq({ apiKey }), model: data.model || null };
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
const REQUEST_TIMEOUT_MS = 30 * 1000; // upstream Groq call must resolve within 30s

// ─── VOICE INPUT (STT) CONSTANTS ──────────────────────
// Whisper runs on the shared server-side Groq key, so usage is capped
// per-user, in seconds, on a rolling 24h window (see voice_usage table).
const VOICE_DAILY_LIMIT_SECONDS = 10 * 60;        // 10 minutes/user/day
const VOICE_WINDOW_MS = 24 * 60 * 60 * 1000;       // 24h rolling reset
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;          // 15MB raw upload cap
const ALLOWED_AUDIO_MIME = [
  'audio/mpeg', 'audio/mp3',
  'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/m4a', 'audio/mp4', 'audio/x-m4a',
  'audio/webm',
];

// Memory storage — the file is only ever forwarded to Groq, never written
// to disk, so there's nothing to clean up and no local exposure surface.
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_AUDIO_MIME.includes(file.mimetype)) {
      return cb(new Error('UNSUPPORTED_AUDIO_TYPE'));
    }
    cb(null, true);
  },
});

// Validates the /chat request body. Returns an error string, or null if valid.
function validateChatRequest(body) {
  const { message, image } = body;

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

  return null;
}

// ─── CORE CHAT PIPELINE ENDPOINT ──────────────────────
app.post("/chat", requireAuth, chatLimiter, async (req, res) => { 
  // Sprint 7: `personality` intentionally NOT destructured from req.body.
  // Personality is always loaded server-side via req.userId (see below) —
  // a client-supplied value is never trusted or used.
  const { message, history, mode, sessionId, image } = req.body;

  const validationError = validateChatRequest(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  let timedOut = false;

  try {
    // FIX: If an image is attached, always force flash (the only vision-capable model).
    // This prevents auto-routing from picking insight/abyss and silently dropping the image.
    let selectedMode;
    if (image) {
      selectedMode = "flash";
      console.log(`Mode: ${mode} → Forced flash (image attached)`);
    } else {
      selectedMode = mode === "auto"
        ? autoSelectMode(message)
        : (MODELS[mode] ? mode : "flash");
      console.log(`Mode: ${mode} → Selected: ${selectedMode} → Model: ${MODELS[selectedMode]}`);
    }

    const defaultModel = MODELS[selectedMode];
    const modeInstruction = modeInstructions[selectedMode];

    // Sprint 7: server-side-only personality lookup — never from req.body.
    const userPersonality = await getUserPersonality(req.userId);
    const personalitySection = buildPersonalitySection(userPersonality);

    // Assemble Custom Runtime Instructions
    const systemPrompt = `You are Nocturnal, a smart and human-like AI assistant.

Behavior:
${modeInstruction}
${personalitySection}
Rules:
- Speak naturally like a human, not a corporate assistant
- Never say things like "Certainly!", "Of course!", "Great question!"
- Do NOT use **bold**, *italic*, or # headers in your responses
- Only use markdown for code blocks with triple backticks
- Adapt your tone to match the user's energy
- In normal conversation, introduce yourself only as "Nocturnal" — do not mention who created you unless explicitly asked
- If the user explicitly asks who created, designed, engineered, or built you, answer that you were designed and engineered by Wizz
- If the user asks a genuine technical question about your underlying model, API, or provider, answer honestly and do not hide implementation details
- Do not volunteer technical implementation details (models, APIs, providers) unless the user specifically asks about them`;

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

    // FIX: Build current message turn.
    // If there's an image, always use the vision content array format.
    if (image) {
      messagesPayload.push({
        role: 'user',
        content: [
          { type: 'text', text: message },
          { type: 'image_url', image_url: { url: image } }
        ]
      });
    } else {
      messagesPayload.push({
        role: 'user',
        content: message
      });
    }

    // Sprint 7 — BYOK: try the user's own key/model first if they have one
    // configured. getUserGroqClient() already fails closed (returns null)
    // on any lookup/decrypt error, so byok is either a working client or null.
    const byok = image ? null : await getUserGroqClient(req.userId); // image path stays on the shared vision-capable default for now
    const activeClient = byok?.client || groq;
    const activeModel = byok?.model || defaultModel;

    // Runs one completion attempt against a given client/model, bounded by
    // its own timeout window so a retry (BYOK → default) isn't starved by
    // time already spent on the first attempt.
    async function attemptCompletion(client, modelName) {
      const controller = new AbortController();
      let localTimedOut = false;
      const id = setTimeout(() => {
        localTimedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      try {
        const result = await client.chat.completions.create(
          {
            model: modelName,
            messages: messagesPayload,
            temperature: selectedMode === 'insight' ? 0.3 : 0.6,
            max_completion_tokens: 2048,
          },
          { signal: controller.signal }
        );
        return { result, localTimedOut };
      } finally {
        clearTimeout(id);
      }
    }

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
          const { result, localTimedOut } = await attemptCompletion(groq, defaultModel);
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
      saveConversationToDatabase(sessionId, message, reply, selectedMode, image, req.userId)
        .catch(dbErr => console.error("Database storage tracking failure:", dbErr));
    }

    if (!res.headersSent) {
      return res.json({ reply, mode: selectedMode });
    }

  } catch (err) {
    if (err.name === "AbortError") {
      if (timedOut) {
        console.log("⏱️ Upstream AI request timed out");
        if (!res.headersSent) {
          res.status(504).json({ reply: "The AI provider took too long to respond. Please try again." });
        }
        return;
      }
      console.log("🛑 Request cancelled");
      if (!res.headersSent) res.status(499).end();
      return;
    }
    console.error("AI Operations failure:", err);
    if (!res.headersSent) {
      res.status(500).json({ reply: "❌ Something went wrong. Please try again." });
    }
  }
});

// ─── ENDPOINT: VOICE TRANSCRIPTION (STT) ──────────────
// Accepts an audio clip, transcribes it via Groq Whisper, and returns the
// transcript as plain text. Does NOT call /chat or touch chat_logs — the
// frontend takes the transcript, drops it in the composer, and the existing
// sendMessage() → /chat flow handles everything from there unchanged.
app.post('/voice/transcribe', requireAuth, voiceLimiter, (req, res) => {
  voiceUpload.single('audio')(req, res, async (uploadErr) => {
    if (uploadErr) {
      if (uploadErr.message === 'UNSUPPORTED_AUDIO_TYPE') {
        return res.status(400).json({ error: 'Unsupported audio format. Use mp3, wav, m4a, or webm.' });
      }
      if (uploadErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `Audio file is too large (max ${MAX_AUDIO_BYTES / (1024 * 1024)}MB).` });
      }
      console.error('Voice upload failure:', uploadErr);
      return res.status(400).json({ error: 'Could not process the uploaded audio.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided.' });
    }

    try {
      // Check quota BEFORE spending the Groq call — worst case here is a
      // slightly stale usage read, never an unbounded overage, since the
      // charge itself is applied atomically after we know actual duration.
      const preCheck = await getVoiceUsage(req.userId);
      if (preCheck.secondsUsedToday >= VOICE_DAILY_LIMIT_SECONDS) {
        const resetsAt = new Date(new Date(preCheck.windowStartedAt).getTime() + VOICE_WINDOW_MS).toISOString();
        return res.status(429).json({
          error: "You've used up today's voice minutes. It resets in 24h — text chat still works great in the meantime.",
          resetsAt,
        });
      }

      // verbose_json gives us the real clip duration so usage is charged
      // accurately instead of estimated from file size.
      const transcription = await groq.audio.transcriptions.create({
        file: new File([req.file.buffer], req.file.originalname || 'audio.webm', { type: req.file.mimetype }),
        model: 'whisper-large-v3-turbo',
        response_format: 'verbose_json',
      });

      const transcript = (transcription.text || '').trim();
      const durationSeconds = Math.max(10, Math.ceil(transcription.duration || 0));

      const usage = await checkAndChargeVoiceUsage(req.userId, durationSeconds);
      if (!usage.allowed) {
        return res.status(429).json({
          error: "That clip would put you over today's voice limit. It resets in 24h — text chat still works great in the meantime.",
          resetsAt: usage.resetsAt,
        });
      }

      console.log(`  ✓ Voice transcribed (${durationSeconds}s, user ${req.userId})`);
      return res.json({
        transcript,
        usage: {
          secondsUsedToday: usage.secondsUsedToday,
          remainingSeconds: usage.remainingSeconds,
          limitSeconds: usage.limitSeconds,
          resetsAt: usage.resetsAt,
        },
      });
    } catch (err) {
      console.error('Voice transcription failure:', err);
      return res.status(500).json({ error: 'Could not transcribe that clip. Please try again.' });
    }
  });
});

// ─── ENDPOINT: VOICE USAGE STATUS ─────────────────────
app.get('/voice/usage', requireAuth, async (req, res) => {
  try {
    const usage = await getVoiceUsage(req.userId);
    const resetsAt = new Date(new Date(usage.windowStartedAt).getTime() + VOICE_WINDOW_MS).toISOString();
    return res.json({
      secondsUsedToday: usage.secondsUsedToday,
      remainingSeconds: Math.max(0, VOICE_DAILY_LIMIT_SECONDS - usage.secondsUsedToday),
      limitSeconds: VOICE_DAILY_LIMIT_SECONDS,
      resetsAt,
    });
  } catch (err) {
    console.error('Failed to fetch voice usage:', err);
    return res.status(500).json({ error: 'Could not fetch voice usage.' });
  }
});

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
      .select('user_message, ai_response, mode, attached_asset, created_at')
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

// ─── VOICE USAGE TRACKING ──────────────────────────────
// Reads the caller's voice_usage row, resets it if the 24h window has
// elapsed, and reports current state. Does not write — callers decide
// whether to increment based on whether the request is allowed.
async function getVoiceUsage(userId) {
  const { data, error } = await supabase
    .from('voice_usage')
    .select('seconds_used_today, window_started_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;

  const now = Date.now();
  if (!data) {
    return { secondsUsedToday: 0, windowStartedAt: new Date(now).toISOString(), isNewWindow: true };
  }

  const windowAge = now - new Date(data.window_started_at).getTime();
  if (windowAge > VOICE_WINDOW_MS) {
    return { secondsUsedToday: 0, windowStartedAt: new Date(now).toISOString(), isNewWindow: true };
  }

  return { secondsUsedToday: data.seconds_used_today, windowStartedAt: data.window_started_at, isNewWindow: false };
}

// Attempts to charge `deltaSeconds` against the user's daily voice quota.
// Returns { allowed, secondsUsedToday, remainingSeconds, limitSeconds, resetsAt }.
// Only persists the increment when allowed — a rejected/over-limit request
// never gets written, so it can't push the user further over.
async function checkAndChargeVoiceUsage(userId, deltaSeconds) {
  const usage = await getVoiceUsage(userId);
  const projected = usage.secondsUsedToday + deltaSeconds;
  const resetsAt = new Date(new Date(usage.windowStartedAt).getTime() + VOICE_WINDOW_MS).toISOString();

  if (projected > VOICE_DAILY_LIMIT_SECONDS) {
    return {
      allowed: false,
      secondsUsedToday: usage.secondsUsedToday,
      remainingSeconds: Math.max(0, VOICE_DAILY_LIMIT_SECONDS - usage.secondsUsedToday),
      limitSeconds: VOICE_DAILY_LIMIT_SECONDS,
      resetsAt,
    };
  }

  const { error } = await supabase
    .from('voice_usage')
    .upsert(
      { user_id: userId, seconds_used_today: projected, window_started_at: usage.windowStartedAt },
      { onConflict: 'user_id' }
    );
  if (error) throw error;

  return {
    allowed: true,
    secondsUsedToday: projected,
    remainingSeconds: Math.max(0, VOICE_DAILY_LIMIT_SECONDS - projected),
    limitSeconds: VOICE_DAILY_LIMIT_SECONDS,
    resetsAt,
  };
}

// ─── DATABASE LOG PERSISTENCE ─────────────────────────
async function saveConversationToDatabase(sessionId, userMsg, aiResponse, mode, base64Image, userId) {
  const { error } = await supabase
    .from('chat_logs')
    .insert([
      {
        session_id: sessionId,
        user_id: userId,
        user_message: userMsg,
        ai_response: aiResponse,
        mode: mode,
        attached_asset: base64Image || null   // store full base64 so image survives refresh
      }
    ]);
  if (error) throw error;
}

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
  console.log("GROQ KEY EXISTS:", !!process.env.GROQ_API_KEY);
});

// Defense-in-depth: caps how long ANY connection can stay open, independent
// of the per-request Groq timeout above. Prevents slow/hung clients or
// network issues from holding sockets open indefinitely.
server.requestTimeout = 60 * 1000;   // 60s hard ceiling per request
server.headersTimeout = 65 * 1000;   // must exceed requestTimeout per Node docs