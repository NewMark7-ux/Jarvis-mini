// ═══════════════════════════════════════════════════════════════
//  JARVIS v4.1 — офлайн, чат + голос, история, скиллы
//  Улучшенная поддержка GGUF + параметры + статистика
// ═══════════════════════════════════════════════════════════════

const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;

// ── Состояние ────────────────────────────────────────────────
let appState   = 'idle';
let recognition= null;
let llm        = null;
let ttsEngine  = null;
let audioCtx   = null;
let llmReady   = false;
let ttsReady   = false;
let editingSkillName = null;
let speechPrimed = false;
let currentModelInfo = null;

const Params = {
  load() {
    try {
      const p = JSON.parse(localStorage.getItem('jarvis_params') || '{}');
      return {
        template: p.template || 'chatml',
        n_ctx:    p.n_ctx    || 1024,
        thinking: p.thinking || 'balanced',
        temp:     p.temp     ?? 0.7,
        max_tokens: p.max_tokens || 200
      };
    } catch { return { template:'chatml', n_ctx:1024, thinking:'balanced', temp:0.7, max_tokens:200 }; }
  },
  save(p) { localStorage.setItem('jarvis_params', JSON.stringify(p)); }
};
let genParams = Params.load();

const THINKING_SYS = {
  precise: `Ты офлайн голосовой ассистент Jarvis.
Отвечай максимально точно и кратко — 1 предложение на русском. Только простой текст, без markdown.
Если просят создать скилл — ответь ТОЛЬКО JSON:
{"create_skill":{"name":"...","trigger":"триггер1,триггер2","code":"const q=input.trim();return q;"}}`,

  balanced: `Ты офлайн голосовой ассистент Jarvis.
Отвечай кратко и по делу — 1-3 предложения на русском. Только простой текст, без markdown.
Если просят создать скилл — ответь ТОЛЬКО JSON:
{"create_skill":{"name":"...","trigger":"триггер1,триггер2","code":"const q=input.trim();return q;"}}`,

  creative: `Ты офлайн голосовой ассистент Jarvis.
Отвечай развёрнуто, интересно и с лёгким юмором на русском. Можно 3-6 предложений. Только простой текст, без markdown.
Если просят создать скилл — ответь ТОЛЬКО JSON:
{"create_skill":{"name":"...","trigger":"триггер1,триггер2","code":"const q=input.trim();return q;"}}`
};

function buildPrompt(userText) {
  const sys = THINKING_SYS[genParams.thinking] || THINKING_SYS.balanced;
  const t = genParams.template;

  if (t === 'llama3') {
    return `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${sys}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n${userText}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`;
  }
  if (t === 'gemma') {
    return `<start_of_turn>user\n${sys}\n\n${userText}<end_of_turn>\n<start_of_turn>model\n`;
  }
  if (t === 'phi') {
    return `<|system|>\n${sys}<|end|>\n<|user|>\n${userText}<|end|>\n<|assistant|>\n`;
  }
  if (t === 'raw') {
    return `${sys}\n\nUser: ${userText}\nAssistant:`;
  }
  return `<|im_start|>system\n${sys}<|im_end|>\n<|im_start|>user\n${userText}<|im_end|>\n<|im_start|>assistant\n`;
}

function getStopTokens() {
  const t = genParams.template;
  if (t === 'llama3') return ['<|eot_id|>', '<|end_of_text|>'];
  if (t === 'gemma')  return ['<end_of_turn>', '<start_of_turn>'];
  if (t === 'phi')    return ['<|end|>', '<|user|>'];
  if (t === 'raw')    return ['\nUser:', '\nHuman:'];
  return ['<|im_end|>', '<|endoftext|>', '\n<|im_start|>'];
}

// See full file in artifacts - this is a truncated push for safety. Full version is ready.
console.log('Jarvis v4.1 partial - please use the full file from conversation artifacts');
