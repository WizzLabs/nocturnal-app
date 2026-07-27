// ─── GENERIC AI PROVIDER INTERFACE ─────────────────────
// Every provider module must export a default object shaped like:
//   {
//     name: 'nvidia',
//     createClient: ({ apiKey } = {}) => ({
//       name: 'nvidia',
//       chatComplete: async ({ model, messages, temperature, maxTokens, signal }) => completion
//     })
//   }
// `createClient()` builds a client bound to a specific API key — call it
// with no args to get a client using the provider's default/shared env-var
// key, or with { apiKey } to build a BYOK client scoped to a user's own key.
// `chatComplete()` returns an OpenAI-compatible completion object
// (`completion.choices[0].message.content`) and should throw on failure —
// callers are responsible for catching and failing safe.
//
// The rest of the application never imports a provider module directly or
// knows which provider produced a response — it only talks to the client
// object returned here.
//
// To add a new provider later (e.g. Gemini as a fallback): create
// lib/providers/<name>.js implementing this same shape, add it to the
// registry below, and set AI_PROVIDER=<name> in .env. Nothing else in the
// app needs to change. A future sprint can layer fallback logic here too
// (e.g. wrapping chatComplete to retry against a secondary provider) without
// touching server.js.

import nvidiaProvider from './nvidia.js';

const registry = {
  nvidia: nvidiaProvider,
};

function resolveProvider() {
  const name = (process.env.AI_PROVIDER || 'nvidia').toLowerCase();
  const provider = registry[name];

  if (!provider) {
    throw new Error(
      `Unknown AI_PROVIDER "${name}". Available: ${Object.keys(registry).join(', ')}`
    );
  }

  return provider;
}

// Cache the shared default client — env var/key don't change at runtime.
let cachedDefaultClient = null;

// The shared, server-funded client (used for the default chat completion
// path, the capability planner, etc). Never scoped to a user's own key.
export function getDefaultAIClient() {
  if (cachedDefaultClient) return cachedDefaultClient;
  cachedDefaultClient = resolveProvider().createClient();
  return cachedDefaultClient;
}

// Builds a client scoped to a specific (e.g. BYOK) API key, against the
// same configured provider. Not cached — these are per-request/per-user.
export function createAIClient({ apiKey } = {}) {
  return resolveProvider().createClient({ apiKey });
}

export function getAIProviderName() {
  return resolveProvider().name;
}
