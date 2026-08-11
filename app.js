// ═══════════════════════════════════════════════════════════════
//  JARVIS v4 — офлайн, чат + голос, история, скиллы
// ═══════════════════════════════════════════════════════════════

const SYS = `Ты офлайн голосовой ассистент Jarvis.
Отвечай кратко — 1-2 предложения на русском. Только простой текст, без markdown.
Если просят создать скилл — ответь ТОЛЬКО JSON:
{"create_skill":{"name":"...","trigger":"триггер1,триггер2","code":"const q=input.trim();return q;"}}`;

const buildPrompt = t =>
  `<|im_start|>system\n${SYS}<|im_end|>\n<|im_start|>user\n${t}<|im_end|>\n<|im_start|>assistant\n`;

const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;

// ── Состояние ────────────────────────────────────────────────
let appState   = 'idle';
let recognition= null;
let llm        = null;
let ttsEngine  = null;
let audioCtx   = null;
let llmReady   = false;
let ttsReady   = false;
let editingSkillName = null; // null = новый скилл, строка = редактирование

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

function histAdd(role, text) {
  const h = histLoad();
  h.push({role, text, time: Date.now()});
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
function addMsg(text, role='jarvis', save=true) {
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

  chat.appendChild(wrap);
  wrap.scrollIntoView({behavior:'smooth',block:'end'});

  if (save && (role==='user'||role==='jarvis'||role==='skill')) histAdd(role, text);
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
    wrap.appendChild(b); wrap.appendChild(t); chat.appendChild(wrap);
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
  'single-thread/wllama.js':  'https://cdn.jsdelivr.net/npm/@wllama/wllama/dist/single-thread/wllama.js',
  'single-thread/wllama.wasm':'https://cdn.jsdelivr.net/npm/@wllama/wllama/dist/single-thread/wllama.wasm',
};

async function loadGGUF(blob, filename) {
  modelProgressWrap.hidden=false; modelProgressFill.style.width='0%';
  modelStatus.textContent=''; pickModelBtn.disabled=true;

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
      const mod = await import('https://esm.sh/@wllama/wllama@2');
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
    step(3,'Загрузка модели в WASM...');
    const url = URL.createObjectURL(blob);
    try {
      await llm.loadModelFromUrl(url, {n_ctx:1024, n_threads:1});
    } catch(e) {
      URL.revokeObjectURL(url);
      throw new Error('Шаг 3 — модель: ' + e.message);
    }
    URL.revokeObjectURL(url);

    // Шаг 4 — сохранение
    step(4,'Сохранение в память...');
    llmReady=true;
    modelProgressFill.style.width='100%';
    modelProgressLabel.textContent='100% — готово';
    modelStatus.textContent=`✓ ${filename} — офлайн`;
    statusText.textContent=filename.replace(/\.gguf$/i,'').slice(0,18);
    pickModelBtn.textContent=`✓ ${filename}`;

    try { await dbPut('gguf',{blob,filename}); }
    catch(e) { addMsg('⚠ Не удалось сохранить в память (работает до перезагрузки): '+e.message,'system'); }

    addMsg(`✓ Модель ${filename} загружена`,'system');

  } catch(e) {
    modelStatus.textContent='❌ '+e.message;
    addMsg('❌ Ошибка: '+e.message,'system');
    pickModelBtn.disabled=false; pickModelBtn.textContent='📂 Открыть файл';
  }
}

async function tryRestoreModel() {
  const r = await dbGet('gguf');
  if(!r?.blob) return;
  modelProgressWrap.hidden=false;
  modelProgressLabel.textContent='Восстановление из памяти...';
  pickModelBtn.disabled=true;
  try {
    const mod = await import('https://esm.sh/@wllama/wllama@2');
    const WllamaClass = mod.Wllama ?? mod.default?.Wllama ?? mod.default;
    if(llm){try{await llm.exit();}catch{}}
    llm = new WllamaClass(WLLAMA_CDN);
    const url=URL.createObjectURL(r.blob);
    await llm.loadModelFromUrl(url,{n_ctx:1024,n_threads:1});
    URL.revokeObjectURL(url);
    llmReady=true;
    modelProgressFill.style.width='100%';
    modelProgressLabel.textContent='100%';
    statusText.textContent=(r.filename||'model').replace(/\.gguf$/i,'').slice(0,18);
    modelStatus.textContent=`✓ ${r.filename} — офлайн`;
    pickModelBtn.textContent=`✓ ${r.filename}`;
    addMsg(`✓ Модель восстановлена из памяти`,'system');
  } catch(e) {
    await dbDel('gguf');
    modelProgressWrap.hidden=true;
    modelStatus.textContent='⚠ Не удалось восстановить — выбери файл снова';
    pickModelBtn.disabled=false; pickModelBtn.textContent='📂 Открыть файл';
  }
}

async function generateLLM(text) {
  if(!llm||!llmReady) return null;
  try {
    return await llm.createCompletion(buildPrompt(text),{
      nPredict:200,temperature:0.7,stop:['<|im_end|>','<|endoftext|>','\n<|im_start|>']
    });
  } catch{return null;}
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

// ── iOS Web Speech фолбэк ────────────────────────────────────
let speechPrimed=false;
setInterval(()=>{if(window.speechSynthesis?.paused)window.speechSynthesis.resume();},5000);

function speakWebSpeech(text){
  return new Promise(res=>{
    if(!window.speechSynthesis){setState('idle');return res();}
    if(!speechPrimed){const u=new SpeechSynthesisUtterance('');u.volume=0;window.speechSynthesis.speak(u);speechPrimed=true;}
    window.speechSynthesis.cancel();
    const run=()=>{
      const u=new SpeechSynthesisUtterance(text);
      u.lang='ru-RU';u.rate=1.0;u.pitch=0.88;u.volume=1;
      const rv=window.speechSynthesis.getVoices().find(v=>v.lang.startsWith('ru'));
      if(rv)u.voice=rv;
      let done=false; const fin=()=>{if(!done){done=true;setState('idle');res();}};
      u.onend=fin;u.onerror=fin;
      setTimeout(fin,Math.max(4000,text.length*70+3000));
      window.speechSynthesis.speak(u);
    };
    setTimeout(run,120);
  });
}

async function speak(text) {
  setState('speaking');
  if(ttsReady&&ttsEngine){
    try{const o=await ttsEngine(text);await playFloat32(o.audio,o.sampling_rate);setState('idle');return;}
    catch(e){console.warn('TTS err:',e);}
  }
  await speakWebSpeech(text);
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
    const raw=await generateLLM(text);
    if(raw){
      // Попытка распарсить create_skill
      const m=raw.match(/\{"create_skill":\{.*?\}\}/s);
      if(m){
        try{
          const cs=JSON.parse(m[0]).create_skill;
          Skills.add(cs.name,cs.trigger,cs.code);
          const msg=`✓ Скилл «${cs.name}» создан! Скажи «${cs.trigger.split(',')[0]}».`;
          addMsg(msg,'skill'); await speak(msg); return;
        }catch{}
      }
      addMsg(raw,'jarvis'); await speak(raw); return;
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
  settingsPanel.hidden=!settingsPanel.hidden; skillsPanel.hidden=true;
  btnSettings.style.color=settingsPanel.hidden?'':'var(--accent)';
  btnSkills.style.color='';
});
btnSkills.addEventListener('click',()=>{
  skillsPanel.hidden=!skillsPanel.hidden; settingsPanel.hidden=true;
  btnSkills.style.color=skillsPanel.hidden?'':'var(--accent)';
  btnSettings.style.color='';
  renderSkills();
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
