// ─── ENTITY TYPE CLASSIFIER ──────────────────────────────
// Sprint 8A.2: small, deterministic (no LLM call, no I/O) heuristic that
// assigns one of entityStore.ENTITY_TYPES to a freshly-extracted entity
// name. Exists purely so the Entity Store has real types to resolve
// pronouns against (Objective 4 — "he" should prefer a Person, "it"
// should prefer a non-Person) instead of everything landing in
// "Unknown". Free-tier philosophy: dictionary + pattern matching only,
// same "pure code" constraint as fastPathRouter.js — zero API cost.
//
// This is intentionally a small, easily-extended reference list, not a
// general-purpose NER system. Unknown terms fail safe to "Unknown"
// rather than guessing — a wrong type is worse than no type, since it
// would make pronoun resolution confidently pick the wrong entity.

const DICTIONARIES = {
  'Programming Language': [
    'python', 'javascript', 'typescript', 'java', 'c++', 'c#', 'golang',
    'go', 'rust', 'php', 'ruby', 'kotlin', 'swift', 'scala', 'perl', 'dart', 'lua',
  ],
  'Framework': [
    'react', 'vue', 'angular', 'django', 'flask', 'express', 'next.js',
    'nextjs', 'spring', 'laravel', 'svelte', 'fastapi', 'nestjs',
    'tensorflow', 'pytorch', 'bootstrap', 'tailwind',
  ],
  'Database': [
    'mongodb', 'postgresql', 'postgres', 'mysql', 'sqlite', 'redis',
    'firebase', 'supabase', 'oracle', 'cassandra', 'dynamodb', 'mariadb',
  ],
  'Hardware': [
    'esp32', 'esp8266', 'arduino', 'raspberry pi', 'stm32', 'jetson nano', 'nodemcu',
  ],
  'Sensor': [
    'mpu6050', 'dht11', 'dht22', 'bmp280', 'bme280', 'hc-sr04', 'ldr',
    'pir', 'gyroscope', 'accelerometer', 'ultrasonic sensor',
  ],
  'Library': [
    'numpy', 'pandas', 'lodash', 'axios', 'opencv', 'matplotlib',
    'scikit-learn', 'requests', 'beautifulsoup',
  ],
  'Company': [
    'nvidia', 'google', 'microsoft', 'openai', 'amazon', 'meta', 'apple',
    'tesla', 'anthropic', 'ibm', 'intel', 'amd', 'samsung',
  ],
  'Model': [
    'gpt-4', 'gpt-5', 'gemini', 'llama', 'claude', 'mistral', 'nemotron',
  ],
};

// Flat reverse lookup, built once: normalized term -> type.
const LOOKUP = new Map();
for (const [type, terms] of Object.entries(DICTIONARIES)) {
  for (const term of terms) LOOKUP.set(term.toLowerCase(), type);
}

// "Who is/was X" is a strong, cheap signal that X is a Person — no
// dictionary needed for the long tail of names.
const PERSON_QUESTION_PATTERN = /\bwho\s+(is|was|are|were)\b/i;

// Classifies an extracted entity name. Returns { type, confidence }.
// rawMessage (optional) supplies sentence-level context for pattern-based
// checks (currently just the "who is X" Person heuristic).
export function classifyEntityType(entityName, rawMessage = '') {
  if (typeof entityName !== 'string' || !entityName.trim()) {
    return { type: 'Unknown', confidence: 0 };
  }

  const key = entityName.trim().toLowerCase();

  const dictHit = LOOKUP.get(key);
  if (dictHit) return { type: dictHit, confidence: 0.9 };

  if (PERSON_QUESTION_PATTERN.test(rawMessage) && rawMessage.toLowerCase().includes(key)) {
    return { type: 'Person', confidence: 0.6 };
  }

  return { type: 'Unknown', confidence: 0.4 };
}

export default { classifyEntityType };
