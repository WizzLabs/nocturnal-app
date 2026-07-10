# Nocturnal AI

A full-stack, self-hosted AI chat application with per-user authentication, isolated chat history, and optional "bring your own key" (BYOK) support — built with Node.js, Express, Groq, and Supabase.

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License](https://img.shields.io/badge/license-ISC-blue)

**Live:**
- 🌐 Landing page — [nocturnal-app.vercel.app](https://nocturnal-app.vercel.app/)
- 💬 App / chat — [nocturnal-app.onrender.com](https://nocturnal-app.onrender.com/)

---

## Landing Page

The landing page is a dark, "classified terminal" style aesthetic — black background, emerald/neon-green accents, monospace/technical typography — separate from the chat app itself and hosted independently on Vercel.

- **Hero section** — animated 3D bot model (Spline) centered over an emerald glow effect, with a glitch-style animated headline introducing Nocturnal.
- **Tagline / intro copy** — short pitch on what Nocturnal is and does, styled to match the terminal/HUD aesthetic.
- **Feature highlights** — scrollable sections calling out the app's core capabilities (multi-model AI routing, chat history, secure auth, image understanding).
- **Call-to-action** — button(s) directing visitors into the live chat app.
- **Consistent theming** — the same emerald glow / dark palette carries through from the landing page into the chat app itself, so the transition feels like one product rather than two separately hosted pieces.

---

## Features (App)

- 🔐 **Authentication** — Supabase email/password auth with session persistence and an auth guard on every protected route.
- 🔒 **Per-user chat isolation** — every conversation is scoped to its owner; no user can read, rename, or delete another user's sessions.
- 💬 **AI chat with auto-routing** — messages are automatically routed to the right model based on content:
  - **Flash** — fast, short answers (also the vision-capable model for image uploads)
  - **Insight** — balanced, code/technical-focused responses
  - **Abyss** — deep, deliberate reasoning for complex questions
- 🖼️ **Image upload with vision** — attach an image and ask questions about it.
- 📝 **Markdown + code blocks** — clean rendering with copyable code blocks.
- 🗂️ **Session management** — rename, delete, and revisit past conversations from the sidebar.
- 🔑 **Personal AI configuration (BYOK)** — optionally configure your own API key and model. When active, it's used for every request instead of Nocturnal's defaults, and image uploads are validated against known vision-capable models rather than silently falling back.
- 🛡️ **Security hardening**
  - Helmet.js with a scoped Content Security Policy
  - Per-user (fallback per-IP) rate limiting on AI requests
  - Input validation (message length, image size/type)
  - Environment-aware CORS allowlist
  - Request timeouts with graceful upstream-failure handling
  - Personal API keys encrypted at rest (AES-256-GCM)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, vanilla JavaScript |
| Backend | Node.js, Express |
| AI Inference | [Groq](https://groq.com) |
| Auth & Database | [Supabase](https://supabase.com) (Postgres + Auth, with Row Level Security) |
| Security | Helmet, express-rate-limit |

---

## Getting Started

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project
- A [Groq](https://console.groq.com) API key

### 1. Clone and install

```bash
git clone https://github.com/<your-username>/nocturnal-ai.git
cd nocturnal-ai
npm install
```

### 2. Configure environment variables

Copy the example file and fill in your own values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (defaults to 3000) | Port the server runs on |
| `GROQ_API_KEY` | Yes | Your Groq API key (server default, used when a user has no personal config) |
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-side only — **never expose this to the browser**) |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon/public key (safe for the browser) |
| `NODE_ENV` | No | Set to `production` when deploying |
| `FRONTEND_URL` | Only in production | Your deployed frontend's exact origin, used for the CORS allowlist |
| `SETTINGS_ENCRYPTION_KEY` | Yes | Long random secret used to encrypt personal API keys at rest. Generate one with `openssl rand -hex 32` |

### 3. Set up the database

Run the migrations in `migrations/` against your Supabase project, **in order**, via the Supabase SQL editor:

1. `001_add_user_id_to_chat_logs.sql` — adds per-user ownership to chat history
2. `002_enable_rls_chat_logs.sql` — enables Row Level Security (run only after confirming the app works correctly with #1)
3. `003_create_user_ai_settings.sql` — creates the table for personal AI (BYOK) configuration

### 4. Run the app

```bash
npm start
```

Visit `http://localhost:3000`.

---

## Project Structure

```
nocturnal-ai/
├── server.js              # Express server, API routes, AI pipeline, auth/security middleware
├── migrations/             # SQL migrations (run in order against Supabase)
├── public/
│   ├── index.html          # Main chat interface
│   ├── auth.html           # Login / signup page
│   ├── auth-guard.js       # Client-side session check (redirects unauthenticated users)
│   ├── auth.js              # Login / signup logic
│   ├── script.js            # Chat UI logic
│   ├── settings.js          # Personal AI (BYOK) settings modal
│   └── style.css             # App styling
├── .env.example
└── package.json
```

---

## Security Notes

- Never commit your `.env` file — it contains live secrets. It's excluded via `.gitignore`.
- The Supabase **service role key** bypasses Row Level Security and must only ever be used server-side (as it is here).
- Personal API keys submitted via the BYOK settings are encrypted before being stored and are never returned in any API response or logged in plaintext.
- Rate limits are tuned for demo/personal use, not high-traffic production load — adjust `chatLimiter` in `server.js` if deploying more broadly.

---

## Deployment

This project is deployed as two separate services:
- **Landing page** → Vercel (static frontend)
- **Chat app + API** → Render (Node/Express server)

Because these are on different domains, `FRONTEND_URL` on the Render service must be set to the exact Vercel origin so the CORS allowlist accepts requests from the landing page in production.

## Roadmap

- [ ] Deployment guide / production polish
- [ ] Spend tracking per user
- [ ] Migrate stored images from base64 to Supabase Storage

---

## License

ISC
