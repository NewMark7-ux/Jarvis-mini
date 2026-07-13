// ═══════════════════════════════════════════════════════════════
//  JARVIS v2 — офлайн AI + система скиллов
//  Модули: ModelManager · SkillsManager · VoiceCore · AgentLoop
// ═══════════════════════════════════════════════════════════════

// ── Конфиг моделей ──────────────────────────────────────────────
const MODELS = {
  small: { id: 'onnx-community/Qwen2.5-0.5B-Instruct', label: 'Qwen 0.5B', dtype: 'q4' },
  main:  { id: 'onnx-community/Qwen2.5-1.5B-Instruct', label: 'Qwen 1.5B', dtype: 'q4' }
};

const SYSTEM = `Ты голосовой ассистент Jarvis. 
Отвечай кратко — 1-2 предложения на русском. Только простой текст, без markdown.
Если пользователь просит создать скилл (функцию), ответь ТОЛЬКО в формате JSON:
{"create_skill":{"name":"...","trigger":"...","description":"...","code":"function(input){ return '...'; }"}}`;

// ── Состояние ────────────────────────────────────────────────────
let appState     = 'idle';
let recognition  = null;
let generator    = null;       // Transformers.js pipeline
let modelLoaded  = false;
let modelChoice  = localStorage.getItem('jarvis_model') || 'small';
let apiKey       = localStorage.getItem('jarvis_key')   || '';

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

// Восстановить API ключ
if (apiKey) { apiKeyInput.value = apiKey; statusText.textContent = 'Claude'; }

// ══════════════════════════════════════════════════════════════════
//  SKILLS MANAGER
// ══════════════════════════════════════════════════════════════════
const SkillsManager = {
  load()       { return JSON.parse(localStorage.getItem('jarvis_skills') || '[]'); },
  save(skills) { localStorage.setItem('jarvis_skills', JSON.stringify(skills)); },

  add(name, trigger, description, code) {
    const skills = this.load();
    const idx = skills.findIndex(s => s.name === name);
    const skill = { name, trigger: trigger.toLowerCase(), description, code, created: Date.now() };
    if (idx >= 0) skills[idx] = skill; else skills.push(skill);
    this.save(skills);
    renderSkills();
    return skill;
  },

  remove(name) {
    this.save(this.load().filter(s => s.name !== name));
    renderSkills();
  },

  // Возвращает результат первого совпавшего скилла, или null
  tryRun(text) {
    const skills = this.load();
    const t = text.toLowerCase();
    for (const skill of skills) {
      if (t.includes(skill.trigger)) {
        try {
          const fn = new Function('input', skill.code);
          return fn(text);
        } catch (e) {
          return `Ошибка в скилле "${skill.name}": ${e.message}`;
        }
      }
    }
    return null;
  }
};

function renderSkills() {
  const skills = SkillsManager.load();
  if (skills.length === 0) {
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
  skillsList.querySelectorAll('.skill-del').forEach(btn =>
    btn.addEventListener('click', () => SkillsManager.remove(btn.dataset.name))
  );
}

// ══════════════════════════════════════════════════════════════════
//  MODEL MANAGER
// ══════════════════════════════════════════════════════════════════
const ModelManager = {
  async download() {
    downloadBtn.disabled = true;
    progressWrap.hidden  = false;
    modelStatus.textContent = '';

    try {
      // Динамический импорт — грузим Transformers.js только когда нужно
      const { pipeline, env } = await import(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3'
      );

      env.useBrowserCache   = true;   // Кэш в браузере → офлайн
      env.allowLocalModels  = false;

      const cfg = MODELS[modelChoice];
      modelStatus.textContent = `Загрузка ${cfg.label}...`;

      generator = await pipeline('text-generation', cfg.id, {
        dtype:  cfg.dtype,
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress') {
            const pct = Math.round(p.progress || 0);
            progressFill.style.width = pct + '%';
            progressLabel.textContent = `${pct}% · ${cfg.label}`;
          }
        }
      });

      modelLoaded = true;
      progressFill.style.width = '100%';
      progressLabel.textContent = '100% · готово';
      modelStatus.textContent  = `✓ ${cfg.label} загружена — работает офлайн`;
      statusText.textContent   = cfg.label;
      downloadBtn.textContent  = '✓ Модель загружена';

    } catch (e) {
      modelStatus.textContent = '❌ Ошибка: ' + e.message;
      downloadBtn.disabled    = false;
      downloadBtn.textContent = '⬇ Попробовать снова';
    }
  },

  async generate(text) {
    if (!generator) return null;
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user',   content: text   }
    ];
    const out = await generator(messages, {
      max_new_tokens: 180,
      do_sample: true,
      temperature: 0.7,
    });
    return out[0].generated_text.at(-1).content?.trim() || null;
  }
};

// ══════════════════════════════════════════════════════════════════
//  ОФЛАЙН КОМАНДЫ (без модели)
// ══════════════════════════════════════════════════════════════════
function offlineReply(text) {
  const t = text.toLowerCase().trim();
  if (/(\bвремя\b|который час|сколько время)/.test(t))
    return `Сейчас ${new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' })}.`;
  if (/(\bдата\b|какое число|какой день|сегодня)/.test(t))
    return `Сегодня ${new Date().toLocaleDateString('ru-RU', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}.`;
  if (/привет|здравствуй|хай/.test(t)) return 'Привет! Чем могу помочь?';
  if (/как (ты|дела|жизнь)/.test(t))   return 'Отлично, готов работать!';
  if (/(кто ты|как тебя зовут)/.test(t)) return 'Я Jarvis, твой голосовой ассистент.';
  if (/спасибо|благодарю/.test(t))      return 'Пожалуйста!';
  if (/пока|до свидания/.test(t))       return 'До встречи!';
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
//  SPEECH SYNTHESIS
// ══════════════════════════════════════════════════════════════════
function speak(text) {
  return new Promise(resolve => {
    if (!window.speechSynthesis) return resolve();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU'; u.rate = 1.05; u.pitch = 0.88; u.volume = 1;
    const ruVoice = window.speechSynthesis.getVoices().find(v => v.lang.startsWith('ru'));
    if (ruVoice) u.voice = ruVoice;
    setState('speaking');
    u.onend = u.onerror = () => { setState('idle'); resolve(); };
    window.speechSynthesis.speak(u);
  });
}

// ══════════════════════════════════════════════════════════════════
//  ОБРАБОТКА ОТВЕТА — автосоздание скиллов
// ══════════════════════════════════════════════════════════════════
async function handleReply(rawReply) {
  // Проверяем: не хочет ли модель создать скилл?
  const jsonMatch = rawReply.match(/\{"create_skill":\{.*?\}\}/s);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const cs = parsed.create_skill;
      SkillsManager.add(cs.name, cs.trigger, cs.description, cs.code);
      const msg = `✓ Скилл «${cs.name}» создан! Теперь скажи «${cs.trigger}» чтобы использовать.`;
      addMsg(msg, 'jarvis');
      await speak(msg);
      return;
    } catch { /* не JSON — отвечаем как обычно */ }
  }
  addMsg(rawReply, 'jarvis');
  await speak(rawReply);
}

// ══════════════════════════════════════════════════════════════════
//  ОСНОВНОЙ ЦИКЛ АГЕНТА
// ══════════════════════════════════════════════════════════════════
async function handleInput(text) {
  addMsg(text, 'user');
  setState('thinking');

  // 1. Скиллы (мгновенно, офлайн)
  const skillResult = SkillsManager.tryRun(text);
  if (skillResult !== null) {
    addMsg(skillResult, 'jarvis');
    await speak(skillResult);
    return;
  }

  // 2. Встроенные быстрые команды
  const quick = offlineReply(text);
  if (quick) { addMsg(quick, 'jarvis'); await speak(quick); return; }

  // 3. Локальная модель
  if (modelLoaded) {
    const local = await ModelManager.generate(text);
    if (local) { await handleReply(local); return; }
  }

  // 4. Claude API
  if (apiKey) {
    const cloud = await askClaude(text);
    if (cloud) { await handleReply(cloud); return; }
  }

  // 5. Fallback
  const fallback = modelLoaded
    ? 'Не смог ответить — попробуй ещё раз.'
    : 'Загрузи офлайн модель в настройках ⚙, или добавь Claude API ключ.';
  addMsg(fallback, 'jarvis');
  await speak(fallback);
}

// ══════════════════════════════════════════════════════════════════
//  STATE MACHINE
// ══════════════════════════════════════════════════════════════════
const STATE_LABELS = { idle:'нажми чтобы говорить', listening:'слушаю...', thinking:'думаю...', speaking:'говорю...' };
const MIC_LABELS   = { idle:'Говорить', listening:'Стоп', thinking:'...', speaking:'Прервать' };

function setState(s) {
  appState = s;
  app.dataset.state = s;
  stateLabel.textContent = STATE_LABELS[s] ?? s;
  micLabel.textContent   = MIC_LABELS[s]   ?? s;
}

// ══════════════════════════════════════════════════════════════════
//  SPEECH RECOGNITION
// ══════════════════════════════════════════════════════════════════
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function startListening() {
  if (appState === 'listening') { stopListening(); return; }
  if (appState === 'speaking')  { window.speechSynthesis?.cancel(); setState('idle'); return; }
  if (appState === 'thinking')  { return; }
  if (!SR) { addMsg('⚠️ Web Speech API не поддерживается. Используй Safari 14.5+ или Orion.', 'system'); return; }

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
    if      (e.error === 'not-allowed') addMsg('⚠️ Нет доступа к микрофону.', 'system');
    else if (e.error === 'no-speech')   addMsg('Не услышал — попробуй ещё раз.', 'system');
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
//  ПРИВЯЗКА СОБЫТИЙ
// ══════════════════════════════════════════════════════════════════

// Микрофон
micBtn.addEventListener('click', startListening);
orbWrapper.addEventListener('click', startListening);

// Настройки
settingsToggle.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  skillsPanel.hidden = true;
});
apiKeyInput.addEventListener('change', () => {
  apiKey = apiKeyInput.value.trim();
  localStorage.setItem('jarvis_key', apiKey);
  if (!modelLoaded) statusText.textContent = apiKey ? 'Claude' : 'офлайн';
});

// Выбор модели
chooseSmall.addEventListener('click', () => {
  modelChoice = 'small';
  localStorage.setItem('jarvis_model', 'small');
  chooseSmall.classList.add('active');
  chooseMain.classList.remove('active');
});
chooseMain.addEventListener('click', () => {
  modelChoice = 'main';
  localStorage.setItem('jarvis_model', 'main');
  chooseMain.classList.add('active');
  chooseSmall.classList.remove('active');
});
// Восстановить выбор
if (modelChoice === 'main') {
  chooseMain.classList.add('active');
  chooseSmall.classList.remove('active');
}

// Скачать модель
downloadBtn.addEventListener('click', () => ModelManager.download());

// Табы
tabChat.addEventListener('click', () => {
  skillsPanel.hidden   = true;
  settingsPanel.hidden = true;
  tabChat.classList.add('active');
  tabSkills.classList.remove('active');
});
tabSkills.addEventListener('click', () => {
  skillsPanel.hidden   = !skillsPanel.hidden;
  settingsPanel.hidden = true;
  tabSkills.classList.toggle('active', !skillsPanel.hidden);
  renderSkills();
});

// Скиллы — форма
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

// ── Service Worker ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── Предзагрузка голосов ────────────────────────────────────────
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', () => window.speechSynthesis.getVoices());
}

// ── Стартовое сообщение ─────────────────────────────────────────
addMsg('Нажми на орб или кнопку ниже чтобы говорить', 'system');
