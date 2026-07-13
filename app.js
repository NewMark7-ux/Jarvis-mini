// ═══════════════════════════════════════════════════════════════
//  JARVIS v2.1 — фиксы: авто-восстановление модели + iOS TTS
// ═══════════════════════════════════════════════════════════════

const MODELS = {
  small: { id: 'onnx-community/Qwen2.5-0.5B-Instruct', label: 'Qwen 0.5B', dtype: 'q4' },
  main:  { id: 'onnx-community/Qwen2.5-1.5B-Instruct', label: 'Qwen 1.5B', dtype: 'q4' }
};

const SYSTEM = `Ты голосовой ассистент Jarvis.
Отвечай кратко — 1-2 предложения на русском. Только простой текст, без markdown.
Если пользователь просит создать скилл, ответь ТОЛЬКО в формате JSON:
{"create_skill":{"name":"...","trigger":"...","description":"...","code":"function(input){ return '...'; }"}}`;

// ── Состояние ────────────────────────────────────────────────────
let appState    = 'idle';
let recognition = null;
let generator   = null;
let modelLoaded = false;
let modelChoice = localStorage.getItem('jarvis_model') || 'small';
let apiKey      = localStorage.getItem('jarvis_key')   || '';

// ── Элементы UI ──────────────────────────────────────────────────
const app            = document.getElementById('app');
const chat           = document.getElementById('chat');
const micBtn         = document.getElementById('micBtn');
const micLabel       = document.getElementById('micLabel');
const stateLabel     = document.getElementById('stateLabel');
const orbWrapper     = document.getElementById('orbWrapper');
const statusText     = document.getElementById('statusText');
const settingsToggle = document.getElementById('settingsToggle');
const settingsPanel  = document.getElementById('settingsPanel');
const apiKeyInput    = document.getElementById('apiKey');
const downloadBtn    = document.getElementById('downloadBtn');
const progressWrap   = document.getElementById('progressWrap');
const progressFill   = document.getElementById('progressFill');
const progressLabel  = document.getElementById('progressLabel');
const modelStatus    = document.getElementById('modelStatus');
const chooseSmall    = document.getElementById('chooseSmall');
const chooseMain     = document.getElementById('chooseMain');
const tabChat        = document.getElementById('tabChat');
const tabSkills      = document.getElementById('tabSkills');
const skillsPanel    = document.getElementById('skillsPanel');
const skillsList     = document.getElementById('skillsList');
const addSkillBtn    = document.getElementById('addSkillBtn');
const skillForm      = document.getElementById('skillForm');
const skillName      = document.getElementById('skillName');
const skillTrigger   = document.getElementById('skillTrigger');
const skillCode      = document.getElementById('skillCode');
const saveSkillBtn   = document.getElementById('saveSkillBtn');
const cancelSkillBtn = document.getElementById('cancelSkillBtn');

if (apiKey) { apiKeyInput.value = apiKey; statusText.textContent = 'Claude'; }

// ══════════════════════════════════════════════════════════════════
//  iOS TTS ФИКС — три уровня защиты
// ══════════════════════════════════════════════════════════════════
let speechPrimed = false;

// 1. "Разблокируем" синтез при первом касании пользователя
function primeSpeech() {
  if (speechPrimed || !window.speechSynthesis) return;
  const silent = new SpeechSynthesisUtterance(' ');
  silent.volume = 0; silent.rate = 10;
  window.speechSynthesis.speak(silent);
  speechPrimed = true;
}

// 2. iOS автоматически паузит синтез — раз в 5 сек возобновляем
setInterval(() => {
  if (window.speechSynthesis?.paused) window.speechSynthesis.resume();
}, 5000);

// 3. Говорить с задержкой и таймаутом-фолбэком
function speak(text) {
  return new Promise(resolve => {
    if (!window.speechSynthesis) { setState('idle'); return resolve(); }

    primeSpeech();
    window.speechSynthesis.cancel();
    setState('speaking');

    const run = () => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang   = 'ru-RU';
      u.rate   = 1.0;
      u.pitch  = 0.88;
      u.volume = 1.0;

      // Выбираем русский голос если есть
      const voices  = window.speechSynthesis.getVoices();
      const ruVoice = voices.find(v => v.lang.startsWith('ru'));
      if (ruVoice) u.voice = ruVoice;

      let finished = false;
      const finish = () => {
        if (!finished) { finished = true; setState('idle'); resolve(); }
      };

      u.onend   = finish;
      u.onerror = finish;

      // Таймаут — 70мс/символ + 3с запас (iOS иногда не вызывает onend)
      setTimeout(finish, Math.max(4000, text.length * 70 + 3000));

      window.speechSynthesis.speak(u);
    };

    // iOS требует паузу после cancel() перед speak()
    setTimeout(run, 120);
  });
}

// ══════════════════════════════════════════════════════════════════
//  MODEL MANAGER — авто-восстановление из кэша
// ══════════════════════════════════════════════════════════════════

// Вызывается при старте: если модель уже скачана — загружает из кэша (быстро, без скачивания)
async function tryRestoreModel() {
  const saved = localStorage.getItem('jarvis_model_ready');
  if (!saved || !MODELS[saved]) return;

  modelChoice = saved;
  modelStatus.textContent = `⏳ Восстановление ${MODELS[saved].label}...`;
  downloadBtn.textContent = '⏳ Загрузка из кэша...';
  downloadBtn.disabled    = true;
  progressWrap.hidden     = false;
  progressFill.style.width = '0%';
  progressLabel.textContent = 'читаю кэш...';

  try {
    const { pipeline, env } = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3'
    );
    env.useBrowserCache  = true;
    env.allowLocalModels = false;

    const cfg = MODELS[saved];
    generator = await pipeline('text-generation', cfg.id, {
      dtype:  cfg.dtype,
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress') {
          const pct = Math.round(p.progress || 0);
          progressFill.style.width   = pct + '%';
          progressLabel.textContent  = `${pct}%`;
        }
      }
    });

    modelLoaded = true;
    progressFill.style.width  = '100%';
    progressLabel.textContent = '100%';
    statusText.textContent    = cfg.label;
    modelStatus.textContent   = `✓ ${cfg.label} — офлайн активен`;
    downloadBtn.textContent   = `✓ ${cfg.label} активна`;
    addMsg(`✓ Модель ${cfg.label} восстановлена из кэша — работаю офлайн`, 'system');

    // Обновляем выбор кнопок
    if (saved === 'main') {
      chooseMain.classList.add('active');
      chooseSmall.classList.remove('active');
    }

  } catch (e) {
    // Кэш устарел или ошибка — сбрасываем
    localStorage.removeItem('jarvis_model_ready');
    downloadBtn.disabled    = false;
    downloadBtn.textContent = '⬇ Загрузить модель офлайн';
    progressWrap.hidden     = true;
    modelStatus.textContent = '⚠ Кэш не найден — загрузи снова';
  }
}

// Скачать (или переинициализировать) модель
async function downloadModel() {
  downloadBtn.disabled     = true;
  progressWrap.hidden      = false;
  progressFill.style.width = '0%';
  modelStatus.textContent  = '';

  try {
    const { pipeline, env } = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3'
    );
    env.useBrowserCache  = true;
    env.allowLocalModels = false;

    const cfg = MODELS[modelChoice];
    modelStatus.textContent = `Загрузка ${cfg.label}... (первый раз долго)`;

    generator = await pipeline('text-generation', cfg.id, {
      dtype:  cfg.dtype,
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress') {
          const pct = Math.round(p.progress || 0);
          progressFill.style.width  = pct + '%';
          progressLabel.textContent = `${pct}%`;
          // Обновляем каждые 5% чтобы не тормозило
        }
      }
    });

    // ✅ КЛЮЧЕВОЙ ФИКС: сохраняем что модель скачана
    localStorage.setItem('jarvis_model_ready', modelChoice);

    modelLoaded = true;
    progressFill.style.width  = '100%';
    progressLabel.textContent = '100% — готово!';
    statusText.textContent    = cfg.label;
    modelStatus.textContent   = `✓ ${cfg.label} сохранена — офлайн активен`;
    downloadBtn.textContent   = `✓ ${cfg.label} активна`;

    addMsg(`✓ Модель ${cfg.label} загружена и сохранена в кэше!`, 'system');
    await speak('Офлайн модель загружена, теперь работаю без интернета.');

  } catch (e) {
    modelStatus.textContent = '❌ Ошибка: ' + e.message;
    downloadBtn.disabled    = false;
    downloadBtn.textContent = '⬇ Попробовать снова';
  }
}

// Генерация ответа локальной моделью
async function generateLocal(text) {
  if (!generator) return null;
  try {
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user',   content: text   }
    ];
    const out = await generator(messages, {
      max_new_tokens: 180,
      do_sample:      true,
      temperature:    0.7,
    });
    return out[0].generated_text.at(-1).content?.trim() || null;
  } catch (e) {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  SKILLS MANAGER
// ══════════════════════════════════════════════════════════════════
const SkillsManager = {
  load()       { return JSON.parse(localStorage.getItem('jarvis_skills') || '[]'); },
  save(skills) { localStorage.setItem('jarvis_skills', JSON.stringify(skills)); },

  add(name, trigger, description, code) {
    const skills = this.load();
    const idx    = skills.findIndex(s => s.name === name);
    const skill  = { name, trigger: trigger.toLowerCase(), description, code, created: Date.now() };
    if (idx >= 0) skills[idx] = skill; else skills.push(skill);
    this.save(skills);
    renderSkills();
    return skill;
  },

  remove(name) {
    this.save(this.load().filter(s => s.name !== name));
    renderSkills();
  },

  tryRun(text) {
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
  const skills = SkillsManager.load();
  if (!skills.length) {
    skillsList.innerHTML = '<div class="empty-hint">Нет скиллов — скажи «создай скилл» или добавь вручную</div>';
    return;
  }
  skillsList.innerHTML = skills.map(s => `
    <div class="skill-item">
      <div class="skill-info">
        <div class="skill-name">${s.name}</div>
        <div class="skill-trigger">триггер: «${s.trigger}»</div>
      </div>
      <button class="skill-del" data-name="${s.name}">✕</button>
    </div>
  `).join('');
  skillsList.querySelectorAll('.skill-del').forEach(b =>
    b.addEventListener('click', () => SkillsManager.remove(b.dataset.name))
  );
}

// ══════════════════════════════════════════════════════════════════
//  OFFLINE КОМАНДЫ
// ══════════════════════════════════════════════════════════════════
function offlineReply(text) {
  const t = text.toLowerCase();
  if (/(\bвремя\b|который час)/.test(t))
    return `Сейчас ${new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' })}.`;
  if (/(\bдата\b|какое число|какой день|сегодня)/.test(t))
    return `Сегодня ${new Date().toLocaleDateString('ru-RU', { weekday:'long', day:'numeric', month:'long' })}.`;
  if (/привет|здравствуй|хай/.test(t))   return 'Привет! Чем могу помочь?';
  if (/как (ты|дела)/.test(t))            return 'Отлично, готов работать!';
  if (/(кто ты|как тебя зовут)/.test(t)) return 'Я Jarvis, твой голосовой ассистент.';
  if (/спасибо|благодарю/.test(t))        return 'Пожалуйста!';
  return null;
}

// ══════════════════════════════════════════════════════════════════
//  CLAUDE API
// ══════════════════════════════════════════════════════════════════
async function askClaude(text) {
  if (!apiKey) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:200,
        system: SYSTEM, messages:[{ role:'user', content:text }] })
    });
    const d = await r.json();
    return d.content?.[0]?.text?.trim() || null;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════
//  ПАРСИНГ ОТВЕТА — автосоздание скиллов
// ══════════════════════════════════════════════════════════════════
async function handleReply(raw) {
  const m = raw.match(/\{"create_skill":\{.*?\}\}/s);
  if (m) {
    try {
      const cs = JSON.parse(m[0]).create_skill;
      SkillsManager.add(cs.name, cs.trigger, cs.description || '', cs.code);
      const msg = `✓ Скилл «${cs.name}» создан! Скажи «${cs.trigger}» чтобы использовать.`;
      addMsg(msg, 'jarvis'); await speak(msg); return;
    } catch { /* обычный ответ */ }
  }
  addMsg(raw, 'jarvis');
  await speak(raw);
}

// ══════════════════════════════════════════════════════════════════
//  ОСНОВНОЙ ЦИКЛ
// ══════════════════════════════════════════════════════════════════
async function handleInput(text) {
  addMsg(text, 'user');
  setState('thinking');

  const skill = SkillsManager.tryRun(text);
  if (skill !== null) { addMsg(skill, 'jarvis'); await speak(skill); return; }

  const quick = offlineReply(text);
  if (quick) { addMsg(quick, 'jarvis'); await speak(quick); return; }

  if (modelLoaded) {
    const local = await generateLocal(text);
    if (local) { await handleReply(local); return; }
  }

  if (apiKey) {
    const cloud = await askClaude(text);
    if (cloud) { await handleReply(cloud); return; }
  }

  const fb = modelLoaded
    ? 'Не смог ответить — попробуй переформулировать.'
    : 'Загрузи модель в настройках ⚙ для офлайн ответов.';
  addMsg(fb, 'jarvis'); await speak(fb);
}

// ══════════════════════════════════════════════════════════════════
//  STATE MACHINE
// ══════════════════════════════════════════════════════════════════
const SL = { idle:'нажми чтобы говорить', listening:'слушаю...', thinking:'думаю...', speaking:'говорю...' };
const ML = { idle:'Говорить', listening:'Стоп', thinking:'...', speaking:'Прервать' };
function setState(s) {
  appState = s; app.dataset.state = s;
  stateLabel.textContent = SL[s] ?? s;
  micLabel.textContent   = ML[s] ?? s;
}

// ══════════════════════════════════════════════════════════════════
//  SPEECH RECOGNITION
// ══════════════════════════════════════════════════════════════════
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function startListening() {
  primeSpeech(); // разблокируем аудио при каждом нажатии
  if (appState === 'listening') { stopListening(); return; }
  if (appState === 'speaking')  { window.speechSynthesis?.cancel(); setState('idle'); return; }
  if (appState === 'thinking')  { return; }
  if (!SR) { addMsg('⚠️ Web Speech API не поддерживается. Нужен Safari 14.5+ или Orion.', 'system'); return; }

  recognition = new SR();
  recognition.lang = 'ru-RU';
  recognition.interimResults = false;
  recognition.continuous = false;

  recognition.onstart  = () => setState('listening');
  recognition.onresult = (e) => {
    const txt = e.results[0][0].transcript;
    stopListening(false);
    handleInput(txt);
  };
  recognition.onerror  = (e) => {
    if      (e.error === 'not-allowed') addMsg('⚠️ Нет доступа к микрофону. Разреши в настройках.', 'system');
    else if (e.error === 'no-speech')   addMsg('Не услышал — нажми ещё раз.', 'system');
    else if (e.error !== 'aborted')     addMsg(`⚠️ Ошибка: ${e.error}`, 'system');
    stopListening();
  };
  recognition.onend = () => { if (appState === 'listening') setState('idle'); recognition = null; };
  try { recognition.start(); } catch { setState('idle'); }
}

function stopListening(reset = true) {
  try { recognition?.stop(); } catch {}
  recognition = null;
  if (reset) setState('idle');
}

// ══════════════════════════════════════════════════════════════════
//  CHAT UI
// ══════════════════════════════════════════════════════════════════
function addMsg(text, role = 'jarvis') {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  chat.appendChild(el);
  el.scrollIntoView({ behavior:'smooth', block:'end' });
}

// ══════════════════════════════════════════════════════════════════
//  СОБЫТИЯ
// ══════════════════════════════════════════════════════════════════
micBtn.addEventListener('click', startListening);
orbWrapper.addEventListener('click', startListening);

settingsToggle.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  skillsPanel.hidden   = true;
});
apiKeyInput.addEventListener('change', () => {
  apiKey = apiKeyInput.value.trim();
  localStorage.setItem('jarvis_key', apiKey);
  if (!modelLoaded) statusText.textContent = apiKey ? 'Claude' : 'офлайн';
});

chooseSmall.addEventListener('click', () => {
  modelChoice = 'small';
  localStorage.setItem('jarvis_model', 'small');
  chooseSmall.classList.add('active'); chooseMain.classList.remove('active');
});
chooseMain.addEventListener('click', () => {
  modelChoice = 'main';
  localStorage.setItem('jarvis_model', 'main');
  chooseMain.classList.add('active'); chooseSmall.classList.remove('active');
});
if (modelChoice === 'main') {
  chooseMain.classList.add('active'); chooseSmall.classList.remove('active');
}

downloadBtn.addEventListener('click', downloadModel);

tabChat.addEventListener('click', () => {
  skillsPanel.hidden   = true;
  settingsPanel.hidden = true;
  tabChat.classList.add('active'); tabSkills.classList.remove('active');
});
tabSkills.addEventListener('click', () => {
  skillsPanel.hidden   = !skillsPanel.hidden;
  settingsPanel.hidden = true;
  tabSkills.classList.toggle('active', !skillsPanel.hidden);
  renderSkills();
});

addSkillBtn.addEventListener('click', () => {
  skillForm.hidden = !skillForm.hidden;
  if (!skillForm.hidden) skillName.focus();
});
cancelSkillBtn.addEventListener('click', () => {
  skillForm.hidden = true;
  skillName.value = skillTrigger.value = skillCode.value = '';
});
saveSkillBtn.addEventListener('click', () => {
  const n = skillName.value.trim();
  const t = skillTrigger.value.trim();
  const c = skillCode.value.trim();
  if (!n || !t || !c) { alert('Заполни все поля'); return; }
  SkillsManager.add(n, t, '', c);
  skillForm.hidden = true;
  skillName.value = skillTrigger.value = skillCode.value = '';
  addMsg(`✓ Скилл «${n}» добавлен!`, 'system');
});

// ══════════════════════════════════════════════════════════════════
//  ИНИЦИАЛИЗАЦИЯ
// ══════════════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', () => window.speechSynthesis.getVoices());
}

addMsg('Нажми на орб или кнопку ниже чтобы говорить', 'system');

// Авто-восстановление модели из кэша при старте
tryRestoreModel();
