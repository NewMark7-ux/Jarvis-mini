// ─── Config ──────────────────────────────────────────────────────────────────
const MODEL   = 'claude-haiku-4-5';
const SYSTEM  = `Ты голосовой ассистент Jarvis. 
Отвечай очень кратко — 1-2 предложения на русском. 
Только простой текст, без markdown и символов форматирования.`;

// ─── State ────────────────────────────────────────────────────────────────────
let state       = 'idle';   // idle | listening | thinking | speaking
let recognition = null;
let apiKey      = localStorage.getItem('jarvis_key') || '';

// ─── Elements ─────────────────────────────────────────────────────────────────
const app            = document.getElementById('app');
const chat           = document.getElementById('chat');
const micBtn         = document.getElementById('micBtn');
const micLabel       = document.getElementById('micLabel');
const stateLabel     = document.getElementById('stateLabel');
const orbWrapper     = document.getElementById('orbWrapper');
const apiKeyInput    = document.getElementById('apiKey');
const settingsPanel  = document.getElementById('settingsPanel');
const settingsToggle = document.getElementById('settingsToggle');
const statusText     = document.getElementById('statusText');

// Restore API key
if (apiKey) {
  apiKeyInput.value = apiKey;
  statusText.textContent = 'Claude';
}

// ─── Settings ─────────────────────────────────────────────────────────────────
settingsToggle.addEventListener('click', () => {
  const open = settingsPanel.hidden;
  settingsPanel.hidden = !open;
  settingsToggle.style.color = open ? 'var(--accent)' : '';
});

apiKeyInput.addEventListener('change', () => {
  apiKey = apiKeyInput.value.trim();
  localStorage.setItem('jarvis_key', apiKey);
  statusText.textContent = apiKey ? 'Claude' : 'офлайн';
});

// ─── State Machine ────────────────────────────────────────────────────────────
const LABELS = {
  idle:      'нажми чтобы говорить',
  listening: 'слушаю...',
  thinking:  'думаю...',
  speaking:  'говорю...',
};

const BTN_LABELS = {
  idle:      'Говорить',
  listening: 'Остановить',
  thinking:  '...',
  speaking:  'Прервать',
};

function setState(s) {
  state               = s;
  app.dataset.state   = s;
  stateLabel.textContent = LABELS[s]    ?? s;
  micLabel.textContent   = BTN_LABELS[s] ?? s;
}

// ─── Chat Display ─────────────────────────────────────────────────────────────
function addMsg(text, role = 'jarvis') {
  // Remove startup hint
  const hint = chat.querySelector('.msg.system');
  if (hint) hint.remove();

  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  chat.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ─── Speech Synthesis ─────────────────────────────────────────────────────────
function speak(text) {
  return new Promise(resolve => {
    if (!window.speechSynthesis) return resolve();

    window.speechSynthesis.cancel();
    const utter  = new SpeechSynthesisUtterance(text);
    utter.lang   = 'ru-RU';
    utter.rate   = 1.05;
    utter.pitch  = 0.88;
    utter.volume = 1.0;

    const voices  = window.speechSynthesis.getVoices();
    const ruVoice = voices.find(v => v.lang.startsWith('ru'));
    if (ruVoice) utter.voice = ruVoice;

    setState('speaking');
    utter.onend   = () => { setState('idle'); resolve(); };
    utter.onerror = () => { setState('idle'); resolve(); };

    window.speechSynthesis.speak(utter);
  });
}

// ─── Offline Commands ─────────────────────────────────────────────────────────
function offlineReply(text) {
  const t = text.toLowerCase().trim();

  if (/(\bвремя\b|который час|сколько время)/.test(t))
    return `Сейчас ${new Date().toLocaleTimeString('ru-RU',
      { hour: '2-digit', minute: '2-digit' })}.`;

  if (/(\bдата\b|какое число|какой день|сегодня)/.test(t))
    return `Сегодня ${new Date().toLocaleDateString('ru-RU',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`;

  if (/привет|здравствуй|хай|добр[оы]е|доброго/.test(t))
    return 'Привет! Чем могу помочь?';

  if (/как (ты|дела|жизнь)/.test(t))
    return 'Отлично, готов работать!';

  if (/(ты кто|кто ты|как тебя зовут|твоё имя)/.test(t))
    return 'Я Jarvis, твой голосовой ассистент.';

  if (/спасибо|благодарю|thanks/.test(t))
    return 'Пожалуйста!';

  if (/пока|до свидания|выключ/.test(t))
    return 'До встречи!';

  if (/помогите?|что умеешь|возможности/.test(t))
    return 'Я умею отвечать на вопросы, говорить время и дату. С API ключом — всё остальное!';

  return null;
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function askClaude(text) {
  if (!apiKey) return null;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        system: SYSTEM,
        messages: [{ role: 'user', content: text }],
      }),
    });

    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    return data.content?.[0]?.text?.trim() || null;

  } catch (e) {
    console.error('Claude API error:', e);
    return null;
  }
}

// ─── Handle Voice Input ───────────────────────────────────────────────────────
async function handleInput(text) {
  addMsg(text, 'user');
  setState('thinking');

  // 1. Offline first
  let reply = offlineReply(text);

  // 2. Claude API
  if (!reply) reply = await askClaude(text);

  // 3. Fallback
  if (!reply) {
    reply = apiKey
      ? 'Не удалось получить ответ — проверь интернет.'
      : 'Команда не распознана. Добавь Claude API ключ в настройках для умных ответов.';
  }

  addMsg(reply, 'jarvis');
  await speak(reply);
}

// ─── Speech Recognition ───────────────────────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function startListening() {
  // Toggle or interrupt
  if (state === 'listening') { stopListening(); return; }
  if (state === 'speaking')  { window.speechSynthesis?.cancel(); setState('idle'); return; }
  if (state === 'thinking')  { return; }

  if (!SR) {
    addMsg('⚠️ Распознавание речи не поддерживается. Используй Safari 14.5+ или Orion.', 'system');
    return;
  }

  recognition = new SR();
  recognition.lang            = 'ru-RU';
  recognition.interimResults  = false;
  recognition.maxAlternatives = 1;
  recognition.continuous      = false;

  recognition.onstart = () => setState('listening');

  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript;
    stopListening(false);
    handleInput(text);
  };

  recognition.onerror = (e) => {
    if      (e.error === 'not-allowed')
      addMsg('⚠️ Нет доступа к микрофону. Разреши в настройках браузера.', 'system');
    else if (e.error === 'no-speech')
      addMsg('Не услышал тебя — попробуй ещё раз.', 'system');
    else if (e.error !== 'aborted')
      addMsg(`⚠️ Ошибка: ${e.error}`, 'system');
    stopListening();
  };

  recognition.onend = () => {
    if (state === 'listening') setState('idle');
    recognition = null;
  };

  try { recognition.start(); }
  catch { setState('idle'); }
}

function stopListening(resetState = true) {
  try { recognition?.stop(); } catch {}
  recognition = null;
  if (resetState) setState('idle');
}

// ─── Events ───────────────────────────────────────────────────────────────────
micBtn.addEventListener('click', startListening);
orbWrapper.addEventListener('click', startListening);

// ─── Service Worker ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ─── Pre-load Voices (iOS loads them async) ───────────────────────────────────
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged',
    () => window.speechSynthesis.getVoices()
  );
}

// ─── Startup hint ─────────────────────────────────────────────────────────────
const hint = document.createElement('div');
hint.className   = 'msg system';
hint.textContent = 'нажми на орб или кнопку ниже чтобы говорить';
chat.appendChild(hint);
