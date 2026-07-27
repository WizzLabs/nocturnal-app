// ─── NVIDIA NIM AI PROVIDER ─────────────────────────────
// Implements the generic AI provider interface (see lib/providers/index.js)
// against NVIDIA's hosted, OpenAI-compatible NIM chat-completions endpoint.
//
// Docs: https://docs.api.nvidia.com/nim/reference/llm-apis
//
// Uses plain fetch rather than an SDK — the endpoint is a standard
// OpenAI-shaped REST API, so pulling in a client library just for this
// would be an unnecessary dependency (keeps things lightweight, in line
// with the free-tier cost philosophy).

const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

function createClient({ apiKey } = {}) {
  const key = apiKey || process.env.NVIDIA_API_KEY;

  return {
    name: 'nvidia',

    // Mirrors the shape callers previously got from the Groq SDK:
    // client.chat.completions.create(...) → { choices: [{ message: { content } }] }.
    // Exposed here as a flat chatComplete() so the provider interface stays
    // provider-agnostic instead of mimicking any one SDK's method chain.
    async chatComplete({ model, messages, temperature, maxTokens, signal }) {
      if (!key) {
        throw new Error('NVIDIA_API_KEY is not configured.');
      }

      const response = await fetch(NVIDIA_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        const err = new Error(`NVIDIA API error ${response.status}: ${errText.slice(0, 300)}`);
        err.status = response.status;
        // fetch() only throws on network failure/abort, never on non-2xx —
        // callers rely on AbortError specifically for timeout handling, so
        // preserve that by NOT naming this error 'AbortError'.
        throw err;
      }

      // Already OpenAI-shaped: { choices: [{ message: { content } }], ... }
      return response.json();
    },
  };
}

export default {
  name: 'nvidia',
  createClient,
};
