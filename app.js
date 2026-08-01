// ═══════════════════════════════════════════════════════════════
//  JARVIS v3 — GGUF файловая модель + офлайн TTS (mms-tts-rus)
// ═══════════════════════════════════════════════════════════════

const SYSTEM = `Ты голосовой ассистент Jarvis.
Отвечай кратко — 1-2 предложения на русском. Только простой текст, без markdown.
Если просят создать скилл, ответь ТОЛЬКО в JSON:
{"create_skill":{"name":"...","trigger":"...","code":"function(input){ return '...'; }"}}`;

// Формат промпта для Qwen2.5-Instruct (ChatML)
const buildPrompt = (userText) =>
  `<|im_start|>system\n${SYSTEM}<|im_end|>\n<|im_start|>user\n${userText}<|im_end|>\n<|im_start|>assistant\n`;

// wllama CDN (single-thread — работает без SharedArrayBuffer)
const WLLAMA = {
  'single-thread/wllama.js':   'https://cdn.jsdelivr.net/npm/@wllama/wllama/dist/single-thread/wllama.js',
  'single-thread/wllama.wasm': 'https://cdn.jsdelivr.net/npm/@wllama/wllama/dist/single-thread/wllama.wasm',
};

// ── Состояние ─────────────────────────────────────────────────
let appState    = 'idle';
let recognition = null;
let llm         = null;       // wllama instance
let ttsEngine   = null;       // Transformers.js TTS pipeline
let audioCtx    = null;       // Web Audio API context
let llmReady    = false;
let ttsReady    = false;
let apiKey      = localStorage.getItem('jarvis_key') || '';

// ── UI ────────────────────────────────────────────────────────
const app             = document.getElementById('app');
const chat            = document.getElementById('chat');
const micBtn          = document.getElementById('micBtn');
const micLabel        = document.getElementById('micLabel');
const stateLabel      = document.getElementById('stateLabel');
const orbWrapper      = document.getElementById('orbWrapper');
const statusText      = document.getElementById('statusText');
const settingsToggle  = document.getElementById('settingsToggle');
const settingsPanel   = document.getElementById('settingsPanel');
const apiKeyInput     = document.getElementById('apiKey');
const pickModelBtn    = document.getElementById('pickModelBtn');
const modelFilePicker = document.getElementById('modelFilePicker');
const modelProgressWrap  = document.getElementById('modelProgressWrap');
const modelProgressFill  = document.getElementById('modelProgressFill');
const modelProgressLabel = document.getElementById('modelProgressLabel');
const modelStatus     = document.getElementById('modelStatus');
const ttsDownloadBtn  = document.getElementById('ttsDownloadBtn');
const ttsProgressWrap = document.getElementById('ttsProgressWrap');
const ttsProgressFill = document.getElementById('ttsProgressFill');
const ttsProgressLabel= document.getElementById('ttsProgressLabel');
const ttsStatus       = document.getElementById('ttsStatus');
const tabChat         = document.getElementById('tabChat');
const tabSkills       = document.getElementById('tabSkills');
const skillsPanel     = document.getElementById('skillsPanel');
const skillsList      = document.getElementById('skillsList');
const addSkillBtn     = document.getElementById('addSkillBtn');
const skillForm       = document.getElementById('skillForm');
const skillName       = document.getElementById('skillName');
const skillTrigger    = document.getElementById('skillTrigger');
const skillCode       = document.getElementById('skillCode');
const saveSkillBtn    = document.getElementById('saveSkillBtn');
const cancelSkillBtn  = document.getElementById('cancelSkillBtn');

if (apiKey) { apiKeyInput.value = apiKey; statusText.textContent = 'Claude'; }

// ══════════════════════════════════════════════════════════════
//  IndexedDB — хранение GGUF blob между сессиями
// ══════════════════════════════════════════════════════════════
async function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('jarvis-store', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('blobs', { keyPath: 'id' });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = () => rej(req.error);
  });
}

async function saveBlob(id, blob, meta = {}) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put({ id, blob, ...meta, saved: Date.now() });
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}

async function loadBlob(id) {
  const db = await openDB();
  return new Promise((res) => {
    const req = db.transaction('blobs', 'readonly').objectStore('blobs').get(id);
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = () => res(null);
  });
}

async function deleteBlob(id) {
  const db = await openDB();
  return new Promise(res => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').delete(id);
    tx.oncomplete = res;
  });
}

// ══════════════════════════════════════════════════════════════
//  GGUF MODEL MANAGER (wllama)
// ══════════════════════════════════════════════════════════════
async function loadGGUF(blob, filename) {
  modelProgressWrap.hidden = false;
  modelProgressFill.style.width = '0%';
  modelProgressLabel.textContent = 'Инициализация wllama...';
  modelStatus.textContent = '';
  pickModelBtn.disabled   = true;

  try {
    // Динамический импорт wllama
    const { Wllama } = await import('https://esm.sh/@wllama/wllama@2');

    if (llm) { try { await llm.exit(); } catch {} }
    llm = new Wllama(WLLAMA);

    // Blob → URL → wllama
    const url = URL.createObjectURL(blob);
    modelProgressLabel.textContent = 'Загрузка модели в WASM...';

    await llm.loadModelFromUrl(url, {
      n_ctx:     1024,
      n_threads: 2,
    });

    URL.revokeObjectURL(url);

    llmReady = true;
    modelProgressFill.style.width  = '100%';
    modelProgressLabel.textContent = '100%';
    modelStatus.textContent  = `✓ ${filename} активна`;
    statusText.textContent   = filename.replace('.gguf', '');
    pickModelBtn.textContent = `✓ ${filename}`;

    // Сохраняем в IndexedDB для следующего запуска
    modelStatus.textContent = `✓ ${filename} — сохраняю...`;
    await saveBlob('gguf_model', blob, { filename });
    modelStatus.textContent = `✓ ${filename} — сохранена офлайн`;

    addMsg(`✓ Модель ${filename} загружена и сохранена!`, 'system');

  } catch (e) {
    modelStatus.textContent = '❌ ' + (e.message || String(e));
    pickModelBtn.disabled   = false;
    pickModelBtn.textContent = '📂 Открыть GGUF файл';
  }
}

// Авто-восстановление при старте
async function tryRestoreModel() {
  const stored = await loadBlob('gguf_model');
  if (!stored?.blob) return;

  modelStatus.textContent  = `⏳ Восстановление ${stored.filename}...`;
  pickModelBtn.disabled    = true;

  try {
    const { Wllama } = await import('https://esm.sh/@wllama/wllama@2');
    if (llm) { try { await llm.exit(); } catch {} }
    llm = new Wllama(WLLAMA);

    const url = URL.createObjectURL(stored.blob);
    await llm.loadModelFromUrl(url, { n_ctx: 1024, n_threads: 2 });
    URL.revokeObjectURL(url);

    llmReady = true;
    statusText.textContent   = stored.filename.replace('.gguf', '');
    modelStatus.textContent  = `✓ ${stored.filename} — офлайн`;
    pickModelBtn.textContent = `✓ ${stored.filename}`;
    addMsg(`✓ Модель ${stored.filename} восстановлена`, 'system');

  } catch (e) {
    await deleteBlob('gguf_model');
    modelStatus.textContent  = '⚠ Не удалось восстановить модель — выбери файл снова';
    pickModelBtn.disabled    = false;
    pickModelBtn.textContent = '📂 Открыть GGUF файл';
  }
}

// Генерация ответа через wllama
async function generateWithLLM(text) {
  if (!llm || !llmReady) return null;
  try {
    const prompt = buildPrompt(text);
    return await llm.createCompletion(prompt, {
      nPredict:    200,
      temperature: 0.7,
      stop:        ['<|im_end|>', '<|endoftext|>', '\n<|im_start|>'],
    });
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  TTS — офлайн русский голос (Xenova/mms-tts-rus)
// ══════════════════════════════════════════════════════════════
async function downloadTTS() {
  ttsDownloadBtn.disabled = true;
  ttsProgressWrap.hidden  = false;
  ttsStatus.textContent   = '';

  try {
    const { pipeline } = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3'
    );

    ttsEngine = await pipeline('text-to-speech', 'Xenova/mms-tts-rus', {
      progress_callback: (p) => {
        if (p.status === 'progress') {
          const pct = Math.round(p.progress || 0);
          ttsProgressFill.style.width  = pct + '%';
          ttsProgressLabel.textContent = `${pct}%`;
        }
      }
    });

    ttsReady = true;
    localStorage.setItem('jarvis_tts', '1');
    ttsProgressFill.style.width  = '100%';
    ttsProgressLabel.textContent = '100%';
    ttsStatus.textContent        = '✓ Голос загружен — офлайн';
    ttsDownloadBtn.textContent   = '✓ Голос активен';
    addMsg('✓ Офлайн голос готов — больше не нужен Safari TTS!', 'system');

  } catch (e) {
    ttsStatus.textContent   = '❌ ' + e.message;
    ttsDownloadBtn.disabled = false;
    ttsDownloadBtn.textContent = '⬇ Попробовать снова';
  }
}

async function tryRestoreTTS() {
  if (!localStorage.getItem('jarvis_tts')) return;
  ttsStatus.textContent = '⏳ Восстановление голоса...';
  try {
    const { pipeline } = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3'
    );
    ttsEngine = await pipeline('text-to-speech', 'Xenova/mms-tts-rus');
    ttsReady  = true;
    ttsStatus.textContent      = '✓ Голос активен — офлайн';
    ttsDownloadBtn.textContent = '✓ Голос активен';
    ttsDownloadBtn.disabled    = true;
  } catch {
    localStorage.removeItem('jarvis_tts');
    ttsStatus.textContent = '';
  }
}

// Воспроизведение Float32Array через Web Audio API
async function playAudio(audioArray, sampleRate) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const buffer = audioCtx.createBuffer(1, audioArray.length, sampleRate);
  buffer.copyToChannel(new Float32Array(audioArray), 0);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  return new Promise(resolve => {
    source.onended = resolve;
    source.start(0);
  });
}

// Главная функция озвучивания
async function speak(text) {
  setState('speaking');

  // 1. Офлайн TTS (приоритет — работает везде)
  if (ttsReady && ttsEngine) {
    try {
      const out = await ttsEngine(text);
      await playAudio(out.audio, out.sampling_rate);
      setState('idle');
      return;
    } catch (e) {
      console.warn('Custom TTS error:', e);
    }
  }

  // 2. Фолбэк: Web Speech API с iOS-фиксами
  await speakWebSpeech(text);
}

// Web Speech API с тремя уровнями защиты от iOS-багов
let speechPrimed = false;
setInterval(() => { if (window.speechSynthesis?.paused) window.speechSynthesis.resume(); }, 5000);

function speakWebSpeech(text) {
  return new Promise(resolve => {
    if (!window.speechSynthesis) { setState('idle'); return resolve(); }
    if (!speechPrimed) {
      const s = new SpeechSynthesisUtterance(' '); s.volume = 0; s.rate = 10;
      window.speechSynthesis.speak(s);
      speechPrimed = true;
    }
    window.speechSynthesis.cancel();

    const run = () => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU'; u.rate = 1.0; u.pitch = 0.88; u.volume = 1;
      const ruVoice = window.speechSynthesis.getVoices().find(v => v.lang.startsWith('ru'));
      if (ruVoice) u.voice = ruVoice;

      let done = false;
      const finish = () => { if (!done) { done = true; setState('idle'); resolve(); } };
      u.onend = finish; u.onerror = finish;
      setTimeout(finish, Math.max(4000, text.length * 70 + 3000));
      window.speechSynthesis.speak(u);
    };
    setTimeout(run, 120);
  });
}

// ══════════════════════════════════════════════════════════════
//  SKILLS MANAGER
// ══════════════════════════════════════════════════════════════
const Skills = {
  load()      { return JSON.parse(localStorage.getItem('jarvis_skills') || '[]'); },
  save(list)  { localStorage.setItem('jarvis_skills', JSON.stringify(list)); },
  add(name, trigger, code) {
    const list = this.load();
    const idx  = list.findIndex(s => s.name === name);
    const item = { name, trigger: trigger.toLowerCase(), code, created: Date.now() };
    if (idx >= 0) list[idx] = item; else list.push(item);
    this.save(list); renderSkills(); return item;
  },
  remove(name)  { this.save(this.load().filter(s => s.name !== name)); renderSkills(); },
  tryRun(text)  {
    const t = text.toLowerCase();
    for (const s of this.load()) {
      if (t.includes(s.trigger)) {
        try { return new Function('input', s.code)(text); }
        catch (e) { return `Ошибка скилла «${s.name}»: ${e.message}`; }
      }
    }
    return null;
  }
};

function renderSkills() {
  const list = Skills.load();
  if (!list.length) {
    skillsList.innerHTML = '<div class="empty-hint">Нет скиллов</div>';
    return;
  }
  skillsList.innerHTML = list.map(s => `
    <div class="skill-item">
      <div class="skill-info">
        <div class="skill-name">${s.name}</div>
        <div class="skill-trigger">«${s.trigger}»</div>
      </div>
      <button class="skill-del" data-name="${s.name}">✕</button>
    </div>`).join('');
  skillsList.querySelectorAll('.skill-del').forEach(b =>
    b.addEventListener('click', () => Skills.remove(b.dataset.name))
  );
}

// ══════════════════════════════════════════════════════════════
//  ОФЛАЙН КОМАНДЫ
// ══════════════════════════════════════════════════════════════
function offlineReply(text) {
  const t = text.toLowerCase();
  if (/(\bвремя\b|который час)/.test(t))
    return `Сейчас ${new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}.`;
  if (/(\bдата\b|какое число|какой день|сегодня)/.test(t))
    return `Сегодня ${new Date().toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'})}.`;
  if (/привет|здравствуй|хай/.test(t))   return 'Привет! Чем могу помочь?';
  if (/как (ты|дела)/.test(t))            return 'Отлично, готов работать!';
  if (/(кто ты|как тебя зовут)/.test(t)) return 'Я Jarvis, твой голосовой ассистент.';
  if (/спасибо|благодарю/.test(t))        return 'Пожалуйста!';
  return null;
}

// ══════════════════════════════════════════════════════════════
//  CLAUDE API
// ══════════════════════════════════════════════════════════════
async function askClaude(text) {
  if (!apiKey) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({model:'claude-haiku-4-5',max_tokens:200,
        system:SYSTEM,messages:[{role:'user',content:text}]})
    });
    const d = await r.json();
    return d.content?.[0]?.text?.trim() || null;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  АВТО-СОЗДАНИЕ СКИЛЛОВ
// ══════════════════════════════════════════════════════════════
async function handleReply(raw) {
  const m = raw.match(/\{"create_skill":\{.*?\}\}/s);
  if (m) {
    try {
      const cs = JSON.parse(m[0]).create_skill;
      Skills.add(cs.name, cs.trigger, cs.code);
      const msg = `✓ Скилл «${cs.name}» создан! Скажи «${cs.trigger}».`;
      addMsg(msg, 'jarvis'); await speak(msg); return;
    } catch {}
  }
  addMsg(raw, 'jarvis');
  await speak(raw);
}

// ══════════════════════════════════════════════════════════════
//  ОСНОВНОЙ ЦИКЛ АГЕНТА
// ══════════════════════════════════════════════════════════════
async function handleInput(text) {
  addMsg(text, 'user');
  setState('thinking');

  const skill = Skills.tryRun(text);
  if (skill !== null) { addMsg(skill, 'jarvis'); await speak(skill); return; }

  const quick = offlineReply(text);
  if (quick) { addMsg(quick, 'jarvis'); await speak(quick); return; }

  if (llmReady) {
    const local = await generateWithLLM(text);
    if (local) { await handleReply(local); return; }
  }

  if (apiKey) {
    const cloud = await askClaude(text);
    if (cloud) { await handleReply(cloud); return; }
  }

  const fb = llmReady
    ? 'Не смог ответить — попробуй переформулировать.'
    : 'Открой GGUF файл в настройках ⚙ для офлайн ответов.';
  addMsg(fb, 'jarvis'); await speak(fb);
}

// ══════════════════════════════════════════════════════════════
//  STATE + SPEECH RECOGNITION
// ══════════════════════════════════════════════════════════════
const SL = {idle:'нажми чтобы говорить',listening:'слушаю...',thinking:'думаю...',speaking:'говорю...'};
const ML = {idle:'Говорить',listening:'Стоп',thinking:'...',speaking:'Прервать'};
function setState(s) {
  appState=s; app.dataset.state=s;
  stateLabel.textContent=SL[s]??s; micLabel.textContent=ML[s]??s;
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function startListening() {
  if (!speechPrimed) { const u=new SpeechSynthesisUtterance(''); u.volume=0; window.speechSynthesis?.speak(u); speechPrimed=true; }
  if (appState==='listening') { stopListening(); return; }
  if (appState==='speaking')  { window.speechSynthesis?.cancel(); if(audioCtx) { try{audioCtx.suspend();}catch{} } setState('idle'); return; }
  if (appState==='thinking')  { return; }
  if (!SR) { addMsg('⚠️ Web Speech API не поддерживается в этом браузере.','system'); return; }

  recognition = new SR();
  recognition.lang='ru-RU'; recognition.interimResults=false; recognition.continuous=false;
  recognition.onstart  = () => setState('listening');
  recognition.onresult = (e) => { stopListening(false); handleInput(e.results[0][0].transcript); };
  recognition.onerror  = (e) => {
    if (e.error==='not-allowed') addMsg('⚠️ Нет доступа к микрофону.','system');
    else if (e.error==='no-speech') addMsg('Не услышал — нажми ещё раз.','system');
    else if (e.error!=='aborted') addMsg(`⚠️ Ошибка: ${e.error}`,'system');
    stopListening();
  };
  recognition.onend = () => { if(appState==='listening') setState('idle'); recognition=null; };
  try { recognition.start(); } catch { setState('idle'); }
}

function stopListening(reset=true) {
  try { recognition?.stop(); } catch {} recognition=null;
  if (reset) setState('idle');
}

// ══════════════════════════════════════════════════════════════
//  CHAT UI
// ══════════════════════════════════════════════════════════════
function addMsg(text, role='jarvis') {
  const el=document.createElement('div');
  el.className=`msg ${role}`; el.textContent=text;
  chat.appendChild(el);
  el.scrollIntoView({behavior:'smooth',block:'end'});
}

// ══════════════════════════════════════════════════════════════
//  СОБЫТИЯ
// ══════════════════════════════════════════════════════════════
micBtn.addEventListener('click', startListening);
orbWrapper.addEventListener('click', startListening);

settingsToggle.addEventListener('click', () => {
  settingsPanel.hidden=!settingsPanel.hidden; skillsPanel.hidden=true;
});
apiKeyInput.addEventListener('change', () => {
  apiKey=apiKeyInput.value.trim(); localStorage.setItem('jarvis_key', apiKey);
  if (!llmReady) statusText.textContent=apiKey?'Claude':'офлайн';
});

// Файловый пикер модели
pickModelBtn.addEventListener('click', () => modelFilePicker.click());
modelFilePicker.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await loadGGUF(file, file.name);
  modelFilePicker.value = ''; // сбрасываем input
});

// TTS
ttsDownloadBtn.addEventListener('click', downloadTTS);

// Табы
tabChat.addEventListener('click', () => {
  skillsPanel.hidden=true; settingsPanel.hidden=true;
  tabChat.classList.add('active'); tabSkills.classList.remove('active');
});
tabSkills.addEventListener('click', () => {
  skillsPanel.hidden=!skillsPanel.hidden; settingsPanel.hidden=true;
  tabSkills.classList.toggle('active',!skillsPanel.hidden); renderSkills();
});

addSkillBtn.addEventListener('click', () => { skillForm.hidden=!skillForm.hidden; if(!skillForm.hidden) skillName.focus(); });
cancelSkillBtn.addEventListener('click', () => { skillForm.hidden=true; skillName.value=skillTrigger.value=skillCode.value=''; });
saveSkillBtn.addEventListener('click', () => {
  const n=skillName.value.trim(), t=skillTrigger.value.trim(), c=skillCode.value.trim();
  if(!n||!t||!c){alert('Заполни все поля');return;}
  Skills.add(n,t,c); skillForm.hidden=true; skillName.value=skillTrigger.value=skillCode.value='';
  addMsg(`✓ Скилл «${n}» добавлен!`,'system');
});

// ══════════════════════════════════════════════════════════════
//  СТАРТ
// ══════════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', ()=>window.speechSynthesis.getVoices());
}

addMsg('Нажми на орб чтобы говорить','system');

// Авто-восстановление при старте (параллельно)
tryRestoreModel();
tryRestoreTTS();
