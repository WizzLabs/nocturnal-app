import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Groq from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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

// ─── BYOK: PERSONAL AI SETTINGS (Sprint 4) ────────────
// API keys are encrypted at rest with AES-256-GCM using a server-side
// secret. Never stored or logged in plaintext, never returned to the client.
const ENC_ALGO = 'aes-256-gcm';
const RAW_ENC_KEY = process.env.SETTINGS_ENCRYPTION_KEY || '';
// Derive a fixed 32-byte key from whatever string is provided so the env
// var doesn't have to be an exact-length hex/base64 value.
const ENC_KEY = crypto.createHash('sha256').update(RAW_ENC_KEY).digest();

function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together, base64-encoded, single column.
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptSecret(stored) {
  const raw = Buffer.from(stored, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ENC_ALGO, ENC_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// Validation constants — reused by both the POST route and defensively here.
const MIN_API_KEY_LENGTH = 20;
const MAX_API_KEY_LENGTH = 200;
const MAX_MODEL_NAME_LENGTH = 100;
const MODEL_NAME_PATTERN = /^[a-zA-Z0-9._\-\/]+$/;

// Looks up + decrypts the authenticated user's personal AI settings.
// Returns { apiKey, model } or null if the user has none configured.
// Never logs the decrypted key.
async function getUserAISettings(userId) {
  const { data, error } = await supabase
    .from('user_ai_settings')
    .select('api_key_enc, model_name')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('Failed to look up personal AI settings (user redacted):', error.message);
    return null;
  }
  if (!data) return null;

  try {
    const apiKey = decryptSecret(data.api_key_enc);
    return { apiKey, model: data.model_name };
  } catch (err) {
    console.error('Failed to decrypt personal AI settings:', err.message);
    return null; // fall back to server default rather than fail the request
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


// Flash  → llama-4-scout-17b-16e-instruct  (tiny, ultra fast, vision capable)
// Insight → llama-3.3-70b (smart, great for code)
// Abyss  → openai/gpt-oss-120b (reasoning)
const MODELS = {
  flash:   "meta-llama/llama-4-scout-17b-16e-instruct",
  insight: "llama-3.3-70b-versatile",
  abyss:   "openai/gpt-oss-120b",
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
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB, matches base64 payload size
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const REQUEST_TIMEOUT_MS = 30 * 1000; // upstream Groq call must resolve within 30s

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
  const { message, history, mode, personality, sessionId, image } = req.body;

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

    const model = MODELS[selectedMode];
    const modeInstruction = modeInstructions[selectedMode];

    // ─── BYOK: use the user's personal API key + model if configured ────
    // Mode/instruction selection above is unchanged (still drives the
    // system prompt's behavior text) — only the credentials and literal
    // model id used for the actual API call are swapped out here. If the
    // user has no personal settings, this is a no-op and behavior is
    // identical to before this sprint.
    let activeGroqClient = groq;
    let activeModel = model;
    const personalSettings = await getUserAISettings(req.userId);
    if (personalSettings) {
      activeGroqClient = new Groq({ apiKey: personalSettings.apiKey });
      activeModel = personalSettings.model;
      console.log(`Personal AI config in use for this request (model: ${activeModel})`);
    }

    // Assemble Custom Runtime Instructions
    const systemPrompt = `You are Nocturnal, a smart and human-like AI assistant.

Personality: ${personality || "calm, thoughtful, and direct"}

Behavior:
${modeInstruction}

Rules:
- Speak naturally like a human, not a corporate assistant
- Never say things like "Certainly!", "Of course!", "Great question!"
- Do NOT use **bold**, *italic*, or # headers in your responses
- Only use markdown for code blocks with triple backticks
- Do NOT mention your technical limitations or model name
- Adapt your tone to match the user's energy`;

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

    // Execute Inference — bounded by REQUEST_TIMEOUT_MS so a hung upstream
    // call can't hold the connection (and the frontend's "thinking" state)
    // open indefinitely.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, REQUEST_TIMEOUT_MS);

    let completion;
    try {
      completion = await activeGroqClient.chat.completions.create(
        {
          model: activeModel,
          messages: messagesPayload,
          temperature: selectedMode === 'insight' ? 0.3 : 0.6,
          max_completion_tokens: 2048,
        },
        { signal: timeoutController.signal }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const rawResponse = completion.choices[0]?.message?.content || "No response from AI";
    const reply = stripMarkdown(rawResponse);
    console.log(`  ✓ ${activeModel} responded`);

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

// ─── ENDPOINTS: PERSONAL AI SETTINGS (BYOK, Sprint 4) ─────────
// All three require auth and are scoped to req.userId — same ownership
// pattern as the chat_logs routes from Sprint 2. The API key itself is
// NEVER included in any response body, logged, or echoed back.

// GET: only reports whether settings exist + which model is configured.
app.get('/api/ai-settings', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_ai_settings')
      .select('model_name')
      .eq('user_id', req.userId)
      .maybeSingle();

    if (error) throw error;
    return res.json({
      hasSettings: !!data,
      model: data ? data.model_name : null,
    });
  } catch (err) {
    console.error('Failed to fetch AI settings status:', err.message);
    return res.status(500).json({ error: 'Could not load AI settings.' });
  }
});

// POST: validate, encrypt, upsert. Body: { apiKey, model }
app.post('/api/ai-settings', requireAuth, async (req, res) => {
  const { apiKey, model } = req.body;

  if (typeof apiKey !== 'string' || apiKey.trim().length < MIN_API_KEY_LENGTH || apiKey.length > MAX_API_KEY_LENGTH) {
    return res.status(400).json({ error: `API key must be between ${MIN_API_KEY_LENGTH} and ${MAX_API_KEY_LENGTH} characters.` });
  }
  if (typeof model !== 'string' || model.trim().length === 0 || model.length > MAX_MODEL_NAME_LENGTH) {
    return res.status(400).json({ error: `Model name is required (max ${MAX_MODEL_NAME_LENGTH} characters).` });
  }
  if (!MODEL_NAME_PATTERN.test(model.trim())) {
    return res.status(400).json({ error: 'Model name contains invalid characters.' });
  }

  try {
    const api_key_enc = encryptSecret(apiKey.trim());
    const { error } = await supabase
      .from('user_ai_settings')
      .upsert(
        { user_id: req.userId, api_key_enc, model_name: model.trim(), updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
    if (error) throw error;

    console.log(`Personal AI settings saved for user (key redacted, model: ${model.trim()})`);
    return res.json({ success: true, model: model.trim() });
  } catch (err) {
    console.error('Failed to save AI settings:', err.message);
    return res.status(500).json({ error: 'Could not save AI settings.' });
  }
});

// DELETE: remove personal config, reverting the user to server defaults.
app.delete('/api/ai-settings', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('user_ai_settings')
      .delete()
      .eq('user_id', req.userId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to remove AI settings:', err.message);
    return res.status(500).json({ error: 'Could not remove AI settings.' });
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