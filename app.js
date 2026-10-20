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
let currentModelInfo = null; // {filename, sizeMB, quant, n_ctx}

// ── Параметры генерации (сохраняются) ────────────────────────
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

// ── Системные промпты по уровню мышления ─────────────────────
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

// ── Шаблоны промптов ─────────────────────────────────────────
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
  // default ChatML
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

// ── UI ───────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const app           = $('app');
const chat          = $('chat');
const textInput     = $('textInput');
const sendBtn       = $('sendBtn');
const micBtn        = $('micBtn');
const stateLbl      = $('stateLbl');
const statusText    = $('statusText');
const settingsPanel = $('settingsPanel');
const skillsPanel   = $('skillsPanel');
const btnSettings   = $('btnSettings');
const btnSkills     = $('btnSkills');
const pickModelBtn  = $('pickModelBtn');
const clearModelBtn = $('clearModelBtn');
const modelFilePicker=$('modelFilePicker');
const modelProgressWrap=$('modelProgressWrap');
const modelProgressFill=$('modelProgressFill');
const modelProgressLabel=$('modelProgressLabel');
const modelStatus   = $('modelStatus');
const modelInfo     = $('modelInfo');
const ttsBtn        = $('ttsBtn');
const ttsProgressWrap=$('ttsProgressWrap');
const ttsProgressFill=$('ttsProgressFill');
const ttsProgressLabel=$('ttsProgressLabel');
const ttsStatus     = $('ttsStatus');
const clearHistoryBtn=$('clearHistoryBtn');
const skillsList    = $('skillsList');
const addSkillBtn   = $('addSkillBtn');
const skillForm     = $('skillForm');
const sName         = $('sName');
const sTrigger      = $('sTrigger');
const sCode         = $('sCode');
const saveSkillBtn  = $('saveSkillBtn');
const cancelSkillBtn= $('cancelSkillBtn');

// Параметры UI
const promptTemplate = $('promptTemplate');
const nCtxSel        = $('nCtx');
const thinkingLevel  = $('thinkingLevel');
const temperature    = $('temperature');
const tempVal        = $('tempVal');
const maxTokens      = $('maxTokens');
const maxTokensVal   = $('maxTokensVal');

// ══════════════════════════════════════════════════════════════
//  IndexedDB — хранение GGUF blob
// ══════════════════════════════════════════════════════════════
const openDB = () => new Promise((res,rej) => {
  const r = indexedDB.open('jarvis-db',1);
  r.onupgradeneeded = e => e.target.result.createObjectStore('store',{keyPath:'id'});
  r.onsuccess = e => res(e.target.result);
  r.onerror   = () => rej(r.error);
});

async function dbPut(id, value) {
  const db = await openDB();
  return new Promise((res,rej) => {
    const tx = db.transaction('store','readwrite');
    tx.objectStore('store').put({id,...value});
    tx.oncomplete=res; tx.onerror=()=>rej(tx.error);
  });
}

async function dbGet(id) {
  const db = await openDB();
  return new Promise(res => {
    const r = db.transaction('store','readonly').objectStore('store').get(id);
    r.onsuccess = e => res(e.target.result||null);
    r.onerror   = () => res(null);
  });
}

async function dbDel(id) {
  const db = await openDB();
  return new Promise(res => {
    const tx = db.transaction('store','readwrite');
    tx.objectStore('store').delete(id);
    tx.oncomplete=res;
  });
}

// ══════════════════════════════════════════════════════════════
//  ИСТОРИЯ ЧАТА (localStorage)
// ══════════════════════════════════════════════════════════════
const MAX_HISTORY = 120;

function histLoad() {
  try { return JSON.parse(localStorage.getItem('jarvis_history')||'[]'); }
  catch { return []; }
}

function histSave(msgs) {
  localStorage.setItem('jarvis_history', JSON.stringify(msgs.slice(-MAX_HISTORY)));
}

function histAdd(role, text, stats=null) {
  const h = histLoad();
  h.push({role, text, time: Date.now(), stats});
  histSave(h);
}

function histClear() {
  localStorage.removeItem('jarvis_history');
  chat.innerHTML = '';
  addMsg('История очищена', 'system', false);
}

// ══════════════════════════════════════════════════════════════
//  CHAT UI
// ══════════════════════════════════════════════════════════════
function addMsg(text, role='jarvis', save=true, stats=null) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);

  if (role === 'user' || role === 'jarvis' || role === 'skill') {
    const t = document.createElement('div');
    t.className = 'msg-time';
    t.textContent = new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
    wrap.appendChild(t);
  }

  if (stats && role === 'jarvis') {
    const s = document.createElement('div');
    s.className = 'msg-stats';
    s.innerHTML = `
      <span>⚡ ${stats.tps.toFixed(1)} t/s</span>
      <span>⏱ ${stats.ms} ms</span>
      <span>🔤 ${stats.tokens} tok</span>
      ${stats.ctx ? `<span>📐 ctx ${stats.ctx}</span>` : ''}
    `;
    wrap.appendChild(s);
  }

  chat.appendChild(wrap);
  wrap.scrollIntoView({behavior:'smooth',block:'end'});

  if (save && (role==='user'||role==='jarvis'||role==='skill')) histAdd(role, text, stats);
}

function renderHistory() {
  const h = histLoad();
  if (!h.length) return;
  const d = document.createElement('div');
  d.className='history-divider';
  d.textContent=`— предыдущие ${h.length} сообщений —`;
  chat.appendChild(d);
  h.forEach(m => {
    const wrap=document.createElement('div'); wrap.className=`msg ${m.role}`;
    const b=document.createElement('div'); b.className='bubble'; b.textContent=m.text;
    const t=document.createElement('div'); t.className='msg-time';
    t.textContent=new Date(m.time).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
    wrap.appendChild(b); wrap.appendChild(t);
    if (m.stats && m.role==='jarvis') {
      const s = document.createElement('div');
      s.className = 'msg-stats';
      s.innerHTML = `
        <span>⚡ ${m.stats.tps?.toFixed(1) || '?'} t/s</span>
        <span>⏱ ${m.stats.ms || '?'} ms</span>
        <span>🔤 ${m.stats.tokens || '?'} tok</span>
      `;
      wrap.appendChild(s);
    }
    chat.appendChild(wrap);
  });
  chat.scrollTop = chat.scrollHeight;
}

// ══════════════════════════════════════════════════════════════
//  СКИЛЛЫ
// ══════════════════════════════════════════════════════════════
const BUILTIN = [
  {
    name: 'Поиск в интернете',
    trigger: 'найди,поищи,поиск,ищи,погода,новости,search',
    builtin: true,
    code: `const stop=/найди|поищи|ищи|поиск|search|в интернете/gi;
const q=input.replace(stop,'').trim()||input.trim();
window.open('https://duckduckgo.com/?q='+encodeURIComponent(q),'_blank');
return 'Открываю поиск: "'+q+'"';`
  }
];

const Skills = {
  load()     { return JSON.parse(localStorage.getItem('jarvis_skills')||'[]'); },
  save(list) { localStorage.setItem('jarvis_skills', JSON.stringify(list)); },

  all()      { return [...BUILTIN, ...this.load()]; },

  add(name, trigger, code) {
    const list = this.load();
    const idx  = list.findIndex(s=>s.name===name);
    const item = {name, trigger:trigger.toLowerCase(), code, created:Date.now()};
    if(idx>=0) list[idx]=item; else list.push(item);
    this.save(list); renderSkills(); return item;
  },

  remove(name) {
    this.save(this.load().filter(s=>s.name!==name));
    renderSkills();
  },

  async tryRun(text) {
    const t = text.toLowerCase();
    for (const s of this.all()) {
      const triggers = s.trigger.split(',').map(x=>x.trim());
      if (triggers.some(tr=>tr&&t.includes(tr))) {
        try {
          const fn = new AsyncFn('input', s.code);
          return await fn(text);
        } catch(e) { return `Ошибка скилла «${s.name}»: ${e.message}`; }
      }
    }
    return null;
  }
};

function renderSkills() {
  const list = Skills.all();
  if(!list.length){skillsList.innerHTML='<div class="empty-hint">Нет скиллов</div>';return;}
  skillsList.innerHTML = list.map(s=>`
    <div class="skill-card" data-name="${s.name}">
      <div class="skill-card-top">
        <div>
          <div class="skill-name">${s.name} ${s.builtin?'<span class="skill-builtin">встроен</span>':''}</div>
          <div class="skill-trigger">триггеры: ${s.trigger}</div>
        </div>
      </div>
      <div class="skill-actions">
        <button class="skill-btn run" data-action="run" data-name="${s.name}">▶ Запустить</button>
        ${!s.builtin?`
        <button class="skill-btn" data-action="edit" data-name="${s.name}">✏ Изменить</button>
        <button class="skill-btn" data-action="del"  data-name="${s.name}">✕ Удалить</button>`:''}
      </div>
    </div>`).join('');

  skillsList.querySelectorAll('[data-action]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const {action,name} = btn.dataset;
      if(action==='del') { if(confirm(`Удалить скилл «${name}»?`)) Skills.remove(name); }
      else if(action==='run') {
        const input = prompt(`Тестовый ввод для «${name}»:`);
        if(input!==null) Skills.tryRun(input).then(r=>r&&addMsg('[skill] '+r,'skill'));
      }
      else if(action==='edit') {
        const all=Skills.all(); const s=all.find(x=>x.name===name);
        if(!s) return;
        editingSkillName=name; sName.value=s.name; sTrigger.value=s.trigger; sCode.value=s.code;
        skillForm.hidden=false; sName.focus();
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  БЫСТРЫЕ ОФЛАЙН ОТВЕТЫ
// ══════════════════════════════════════════════════════════════
function offlineReply(text) {
  const t = text.toLowerCase();
  if(/(\bвремя\b|который час|сколько время)/.test(t))
    return `Сейчас ${new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}.`;
  if(/(\bдата\b|какое число|какой день|сегодня)/.test(t))
    return `Сегодня ${new Date().toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'})}.`;
  if(/привет|здравствуй|хай/.test(t))   return 'Привет! Чем могу помочь?';
  if(/как (ты|дела)/.test(t))            return 'Отлично, готов работать!';
  if(/(кто ты|как тебя зовут)/.test(t)) return 'Я Jarvis, офлайн ассистент.';
  if(/спасибо|благодарю/.test(t))        return 'Пожалуйста!';
  return null;
}

// ══════════════════════════════════════════════════════════════
//  МОДЕЛЬ (wllama + GGUF)
// ══════════════════════════════════════════════════════════════
const WLLAMA_CDN = {
  default: 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/esm/wasm/wllama.wasm',
};

function guessQuant(filename) {
  const m = filename.match(/(q[2-8](_[0kmsk]+)?|iq[1-4]_[a-z0-9]+|f16|f32|bf16)/i);
  return m ? m[0].toUpperCase() : 'unknown';
}

function formatSize(bytes) {
  if (bytes < 1024*1024) return (bytes/1024).toFixed(0) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function updateModelInfoUI(info) {
  if (!info) { modelInfo.hidden = true; return; }
  modelInfo.hidden = false;
  modelInfo.innerHTML = `
    <b>${info.filename}</b><br>
    Размер: ${info.sizeStr} · Quant: ${info.quant}<br>
    Контекст: ${info.n_ctx} · Потоки: 1 (iOS)
  `;
}

async function loadGGUF(blob, filename) {
  modelProgressWrap.hidden=false; modelProgressFill.style.width='0%';
  modelStatus.textContent=''; pickModelBtn.disabled=true;

  const sizeMB = blob.size / (1024*1024);
  const sizeStr = formatSize(blob.size);
  const quant = guessQuant(filename);

  // Предупреждение для iOS
  if (sizeMB > 1800) {
    const ok = confirm(`Модель большая (${sizeStr}). На iPhone/iPad с высокой вероятностью не хватит памяти.\n\nРекомендуется ≤ 1.5–2 ГБ (Qwen 0.5B–1.5B Q4).\n\nВсё равно попробовать?`);
    if (!ok) {
      pickModelBtn.disabled=false;
      modelProgressWrap.hidden=true;
      return;
    }
  }

  const step = (n, txt) => {
    modelProgressLabel.textContent = `Шаг ${n}/4: ${txt}`;
    modelProgressFill.style.width  = (n*22)+'%';
    addMsg(`[${n}/4] ${txt}`, 'system', false);
  };

  try {
    // Шаг 1 — импорт библиотеки
    step(1,'Загрузка wllama...');
    let WllamaClass;
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/esm/index.js');
      WllamaClass = mod.Wllama ?? mod.default?.Wllama ?? mod.default;
      if (typeof WllamaClass !== 'function') throw new Error('Класс Wllama не найден в модуле');
    } catch(e) { throw new Error('Шаг 1 — импорт: ' + e.message); }

    // Шаг 2 — создание движка
    step(2,'Инициализация движка...');
    try {
      if(llm){ try{await llm.exit();}catch{} }
      llm = new WllamaClass(WLLAMA_CDN);
    } catch(e) { throw new Error('Шаг 2 — движок: ' + e.message); }

    // Шаг 3 — загрузка модели
    step(3,`Загрузка модели (${sizeStr})...`);
    const url = URL.createObjectURL(blob);
    const n_ctx = parseInt(nCtxSel.value) || genParams.n_ctx || 1024;
    try {
      // Пробуем современный API, fallback на старый
      if (typeof llm.loadModelFromUrl === 'function') {
        await llm.loadModelFromUrl(url, { n_ctx, n_threads: 1 });
      } else if (typeof llm.loadModel === 'function') {
        await llm.loadModel([blob], { n_ctx, n_threads: 1 });
      } else {
        throw new Error('Нет метода loadModel / loadModelFromUrl');
      }
    } catch(e) {
      URL.revokeObjectURL(url);
      throw new Error('Шаг 3 — модель: ' + e.message);
    }
    URL.revokeObjectURL(url);

    // Шаг 4 — сохранение
    step(4,'Сохранение в память...');
    llmReady=true;
    currentModelInfo = { filename, sizeStr, quant, n_ctx, sizeMB };
    modelProgressFill.style.width='100%';
    modelProgressLabel.textContent='100% — готово';
    modelStatus.textContent=`✓ ${filename} — офлайн`;
    statusText.textContent=filename.replace(/\.gguf$/i,'').slice(0,18);
    pickModelBtn.textContent=`✓ ${filename.length>22 ? filename.slice(0,20)+'…' : filename}`;
    updateModelInfoUI(currentModelInfo);

    try { await dbPut('gguf',{blob,filename, n_ctx}); }
    catch(e) { addMsg('⚠ Не удалось сохранить в память (работает до перезагрузки): '+e.message,'system'); }

    addMsg(`✓ Модель ${filename} загружена (${sizeStr}, ${quant}, ctx=${n_ctx})`,'system');

  } catch(e) {
    modelStatus.textContent='❌ '+e.message;
    addMsg('❌ Ошибка: '+e.message,'system');
    pickModelBtn.disabled=false; pickModelBtn.textContent='📂 Открыть файл';
    currentModelInfo = null;
    updateModelInfoUI(null);
  }
}

async function tryRestoreModel() {
  const r = await dbGet('gguf');
  if(!r?.blob) return;
  modelProgressWrap.hidden=false;
  modelProgressLabel.textContent='Восстановление из памяти...';
  pickModelBtn.disabled=true;
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/esm/index.js');
    const WllamaClass = mod.Wllama ?? mod.default?.Wllama ?? mod.default;
    if(llm){try{await llm.exit();}catch{}}
    llm = new WllamaClass(WLLAMA_CDN);
    const n_ctx = r.n_ctx || genParams.n_ctx || 1024;
    const url=URL.createObjectURL(r.blob);
    if (typeof llm.loadModelFromUrl === 'function') {
      await llm.loadModelFromUrl(url,{n_ctx, n_threads:1});
    } else {
      await llm.loadModel([r.blob],{n_ctx, n_threads:1});
    }
    URL.revokeObjectURL(url);
    llmReady=true;
    const quant = guessQuant(r.filename||'');
    const sizeStr = formatSize(r.blob.size);
    currentModelInfo = { filename: r.filename, sizeStr, quant, n_ctx, sizeMB: r.blob.size/(1024*1024) };
    modelProgressFill.style.width='100%';
    modelProgressLabel.textContent='100%';
    statusText.textContent=(r.filename||'model').replace(/\.gguf$/i,'').slice(0,18);
    modelStatus.textContent=`✓ ${r.filename} — офлайн`;
    pickModelBtn.textContent=`✓ ${r.filename}`;
    updateModelInfoUI(currentModelInfo);
    addMsg(`✓ Модель восстановлена из памяти`,'system');
  } catch(e) {
    await dbDel('gguf');
    modelProgressWrap.hidden=true;
    modelStatus.textContent='⚠ Не удалось восстановить — выбери файл снова';
    pickModelBtn.disabled=false; pickModelBtn.textContent='📂 Открыть файл';
    currentModelInfo = null;
  }
}

async function generateLLM(text) {
  if(!llm||!llmReady) return null;
  const prompt = buildPrompt(text);
  const stop = getStopTokens();
  const start = performance.now();

  try {
    let raw;
    // Поддержка старого и нового API wllama
    if (typeof llm.createCompletion === 'function') {
      // Пробуем новый OAI-стиль
      try {
        const res = await llm.createCompletion({
          prompt,
          max_tokens: genParams.max_tokens,
          temperature: genParams.temp,
          stop,
          // старые поля на всякий
          nPredict: genParams.max_tokens
        });
        raw = typeof res === 'string' ? res : (res?.choices?.[0]?.text || res?.choices?.[0]?.message?.content || String(res));
      } catch {
        // fallback на старый стиль
        raw = await llm.createCompletion(prompt, {
          nPredict: genParams.max_tokens,
          temperature: genParams.temp,
          stop
        });
      }
    } else {
      return null;
    }

    const ms = Math.round(performance.now() - start);
    // Грубая оценка токенов (для русского ~1.6–2 символа на токен)
    const tokens = Math.max(1, Math.round((raw || '').length / 1.8));
    const tps = tokens / (ms / 1000);

    return {
      text: (raw || '').trim(),
      stats: {
        tokens,
        ms,
        tps,
        ctx: currentModelInfo?.n_ctx || genParams.n_ctx
      }
    };
  } catch(e) {
    console.warn('generateLLM error', e);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//  TTS (mms-tts-rus через Transformers.js)
// ══════════════════════════════════════════════════════════════
async function downloadTTS() {
  ttsBtn.disabled=true; ttsProgressWrap.hidden=false; ttsStatus.textContent='';
  try {
    const {pipeline} = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
    ttsEngine = await pipeline('text-to-speech','Xenova/mms-tts-rus',{
      progress_callback: p=>{
        if(p.status==='progress'){
          const pct=Math.round(p.progress||0);
          ttsProgressFill.style.width=pct+'%'; ttsProgressLabel.textContent=pct+'%';
        }
      }
    });
    ttsReady=true; localStorage.setItem('jarvis_tts','1');
    ttsProgressFill.style.width='100%'; ttsProgressLabel.textContent='100%';
    ttsStatus.textContent='✓ Голос загружен — офлайн';
    ttsBtn.textContent='✓ Голос активен';
    addMsg('Офлайн голос готов ✓','system');
  } catch(e){
    ttsStatus.textContent='❌ '+e.message;
    ttsBtn.disabled=false; ttsBtn.textContent='⬇ Загрузить голос (~270 МБ)';
  }
}

async function tryRestoreTTS() {
  if(!localStorage.getItem('jarvis_tts')) return;
  ttsStatus.textContent='⏳ Восстановление голоса...';
  try {
    const {pipeline} = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
    ttsEngine = await pipeline('text-to-speech','Xenova/mms-tts-rus');
    ttsReady=true; ttsStatus.textContent='✓ Голос активен';
    ttsBtn.textContent='✓ Голос активен'; ttsBtn.disabled=true;
  } catch{localStorage.removeItem('jarvis_tts'); ttsStatus.textContent='';}
}

async function playFloat32(audio, sampleRate) {
  if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended') await audioCtx.resume();
  const buf=audioCtx.createBuffer(1,audio.length,sampleRate);
  buf.copyToChannel(new Float32Array(audio),0);
  const src=audioCtx.createBufferSource();
  src.buffer=buf; src.connect(audioCtx.destination);
  return new Promise(r=>{src.onended=r; src.start(0);});
}

async function speakWebSpeech(text) {
  return new Promise(resolve => {
    if (!window.speechSynthesis) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    u.rate = 1.0;
    u.onend = resolve;
    u.onerror = resolve;
    window.speechSynthesis.speak(u);
  });
}

async function speak(text) {
  setState('speaking');
  if(ttsReady&&ttsEngine){
    try{const o=await ttsEngine(text);await playFloat32(o.audio,o.sampling_rate);setState('idle');return;}
    catch(e){console.warn('TTS err:',e);}
  }
  await speakWebSpeech(text);
  setState('idle');
}

// ══════════════════════════════════════════════════════════════
//  ОСНОВНОЙ ЦИКЛ
// ══════════════════════════════════════════════════════════════
async function handleInput(text) {
  if(!text.trim()) return;
  addMsg(text,'user');
  setState('thinking');

  // 1. Скиллы
  const sr = await Skills.tryRun(text);
  if(sr!==null){
    addMsg(sr,'skill'); await speak(sr); return;
  }

  // 2. Быстрые ответы
  const qr = offlineReply(text);
  if(qr){addMsg(qr,'jarvis'); await speak(qr); return;}

  // 3. Локальная модель
  if(llmReady){
    const result = await generateLLM(text);
    if(result && result.text){
      // Попытка распарсить create_skill
      const m=result.text.match(/\{"create_skill":\{.*?\}\}/s);
      if(m){
        try{
          const cs=JSON.parse(m[0]).create_skill;
          Skills.add(cs.name,cs.trigger,cs.code);
          const msg=`✓ Скилл «${cs.name}» создан! Скажи «${cs.trigger.split(',')[0]}».`;
          addMsg(msg,'skill'); await speak(msg); return;
        }catch{}
      }
      addMsg(result.text,'jarvis', true, result.stats);
      await speak(result.text); return;
    }
  }

  const fb='Загрузи GGUF модель в настройках ⚙ для умных ответов.';
  addMsg(fb,'jarvis'); await speak(fb);
}

// ══════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════
const SL={idle:'',listening:'слушаю...',thinking:'думаю...',speaking:'говорю...'};
function setState(s){
  appState=s; app.dataset.state=s; stateLbl.textContent=SL[s]??s;
}

// ══════════════════════════════════════════════════════════════
//  SPEECH RECOGNITION
// ══════════════════════════════════════════════════════════════
const SR_API=window.SpeechRecognition||window.webkitSpeechRecognition;

function startListening(){
  if(!speechPrimed){const u=new SpeechSynthesisUtterance('');u.volume=0;window.speechSynthesis?.speak(u);speechPrimed=true;}
  if(appState==='listening'){try{recognition?.stop();}catch{}recognition=null;setState('idle');return;}
  if(appState==='speaking'){window.speechSynthesis?.cancel();setState('idle');return;}
  if(appState==='thinking') return;
  if(!SR_API){addMsg('⚠️ Web Speech не поддерживается в этом браузере.','system');return;}
  recognition=new SR_API();
  recognition.lang='ru-RU'; recognition.interimResults=false; recognition.continuous=false;
  recognition.onstart=()=>setState('listening');
  recognition.onresult=e=>{const t=e.results[0][0].transcript;try{recognition.stop();}catch{}recognition=null;handleInput(t);};
  recognition.onerror=e=>{
    if(e.error==='not-allowed') addMsg('⚠️ Нет доступа к микрофону.','system');
    else if(e.error!=='aborted'&&e.error!=='no-speech') addMsg(`⚠️ Ошибка: ${e.error}`,'system');
    setState('idle');
  };
  recognition.onend=()=>{if(appState==='listening')setState('idle'); recognition=null;};
  try{recognition.start();}catch{setState('idle');}
}

// ══════════════════════════════════════════════════════════════
//  СОБЫТИЯ
// ══════════════════════════════════════════════════════════════

// Отправка текста
function sendText(){
  const t=textInput.value.trim();
  if(!t) return;
  textInput.value=''; textInput.style.height=''; handleInput(t);
}
sendBtn.addEventListener('click', sendText);
textInput.addEventListener('keydown', e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault(); sendText();}
});
// Авторост textarea
textInput.addEventListener('input',()=>{
  textInput.style.height='auto';
  textInput.style.height=Math.min(textInput.scrollHeight,120)+'px';
});

micBtn.addEventListener('click', startListening);

// Панели
btnSettings.addEventListener('click',()=>{
  settingsPanel.hidden = !settingsPanel.hidden;
  skillsPanel.hidden = true;
});
btnSkills.addEventListener('click',()=>{
  skillsPanel.hidden = !skillsPanel.hidden;
  settingsPanel.hidden = true;
  if (!skillsPanel.hidden) renderSkills();
});

// Модель
pickModelBtn.addEventListener('click',()=>modelFilePicker.click());
modelFilePicker.addEventListener('change',async e=>{
  const f=e.target.files?.[0]; if(!f) return;
  modelFilePicker.value='';

  // Проверка: GGUF начинается с байт 47 47 55 46 ("GGUF")
  try {
    const buf  = await f.slice(0,4).arrayBuffer();
    const b    = new Uint8Array(buf);
    const isGGUF = b[0]===0x47&&b[1]===0x47&&b[2]===0x55&&b[3]===0x46;
    const nameOk = /\.(gguf|bin|ggml)$/i.test(f.name);

    if (!isGGUF && !nameOk) {
      modelStatus.textContent='⚠️ Это не GGUF файл — выбери правильный файл модели';
      return;
    }
  } catch {
    // Не удалось прочесть — всё равно пробуем загрузить
  }

  await loadGGUF(f, f.name);
});
clearModelBtn.addEventListener('click',async()=>{
  if(!confirm('Удалить сохранённую модель из памяти?')) return;
  await dbDel('gguf'); llm=null; llmReady=false;
  modelStatus.textContent='Модель удалена'; pickModelBtn.textContent='📂 Открыть файл';
  pickModelBtn.disabled=false; modelProgressWrap.hidden=true;
  statusText.textContent='офлайн';
  currentModelInfo = null;
  updateModelInfoUI(null);
});

// TTS
ttsBtn.addEventListener('click',downloadTTS);

// История
clearHistoryBtn.addEventListener('click',()=>{if(confirm('Очистить всю историю?'))histClear();});

// Скиллы
addSkillBtn.addEventListener('click',()=>{
  editingSkillName=null; sName.value=''; sTrigger.value=''; sCode.value='';
  skillForm.hidden=!skillForm.hidden;
  if(!skillForm.hidden) sName.focus();
});
cancelSkillBtn.addEventListener('click',()=>{skillForm.hidden=true; editingSkillName=null;});
saveSkillBtn.addEventListener('click',()=>{
  const n=sName.value.trim(),t=sTrigger.value.trim(),c=sCode.value.trim();
  if(!n||!t||!c){alert('Заполни все поля');return;}
  if(editingSkillName&&editingSkillName!==n) Skills.remove(editingSkillName);
  Skills.add(n,t,c); skillForm.hidden=true; editingSkillName=null;
  addMsg(`Скилл «${n}» сохранён ✓`,'system');
});

// Параметры генерации
function syncParamsUI() {
  promptTemplate.value = genParams.template;
  nCtxSel.value = String(genParams.n_ctx);
  thinkingLevel.value = genParams.thinking;
  temperature.value = genParams.temp;
  tempVal.textContent = genParams.temp.toFixed(2);
  maxTokens.value = genParams.max_tokens;
  maxTokensVal.textContent = genParams.max_tokens;
}
syncParamsUI();

function saveParamsFromUI() {
  genParams = {
    template: promptTemplate.value,
    n_ctx: parseInt(nCtxSel.value) || 1024,
    thinking: thinkingLevel.value,
    temp: parseFloat(temperature.value) || 0.7,
    max_tokens: parseInt(maxTokens.value) || 200
  };
  Params.save(genParams);
}
promptTemplate.addEventListener('change', saveParamsFromUI);
nCtxSel.addEventListener('change', saveParamsFromUI);
thinkingLevel.addEventListener('change', saveParamsFromUI);
temperature.addEventListener('input', () => {
  tempVal.textContent = parseFloat(temperature.value).toFixed(2);
  saveParamsFromUI();
});
maxTokens.addEventListener('input', () => {
  maxTokensVal.textContent = maxTokens.value;
  saveParamsFromUI();
});

// ══════════════════════════════════════════════════════════════
//  СТАРТ
// ══════════════════════════════════════════════════════════════
if('serviceWorker'in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
if(window.speechSynthesis){
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged',()=>window.speechSynthesis.getVoices());
}

// Загружаем историю и рендерим скиллы
renderHistory();
renderSkills();

// Авто-восстановление (параллельно, не блокирует)
tryRestoreModel();
tryRestoreTTS();
