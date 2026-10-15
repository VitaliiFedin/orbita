/* Тренажер «Орбітальна станція»: інтерфейс, перевірка, ігрові механіки, журнал спроб. */
(function () {
'use strict';

const LEVELS = window.LEVELS;
const CFG = window.CONFIG || {};
const params = new URLSearchParams(location.search);
const OPEN = params.get('open') === 'all' ? 99 : (parseInt(params.get('open'), 10) || 1);
const GROUPS = { basic: 'Базові', main: 'Основні', challenge: 'Виклики' };
const TYPES = { predict: 'Передбач результат', trace: 'Трасування', findbug: 'Пошук помилки', parsons: 'Складання з рядків',
                fill: 'Доповнення коду', write: 'Створення програми', mission: 'Місія' };
const TASK = {}; LEVELS.forEach(l => l.tasks.forEach(t => { t.level = l.id; TASK[t.id] = t; }));

/* ---------------------------------------------------------- helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const normOut = s => String(s).replace(/\r/g, '').split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/^\n+|\n+$/g, '');
function h(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3500); }

/* ---------------------------------------------------------- python runner (web worker + timeout) */
const Runner = {
  worker: null, ready: null, seq: 0, pending: new Map(),
  start() {
    this.ready = new Promise((res, rej) => { this._res = res; this._rej = rej; });
    this.ready.catch(() => { });
    if (location.protocol === 'file:') { this._rej(new Error('file')); return this.ready; }
    try { this.worker = new Worker('js/worker.js'); } catch (e) { this._rej(e); return this.ready; }
    this.worker.onerror = (e) => this._rej(e);
    setTimeout(() => this._rej(new Error('timeout')), 120000);
    this.worker.onmessage = (e) => {
      const d = e.data;
      if ('ready' in d) { d.ready ? this._res() : this._rej(d.error); return; }
      const p = this.pending.get(d.id); if (!p) return;
      this.pending.delete(d.id); clearTimeout(p.timer); p.resolve(d);
    };
    return this.ready;
  },
  async run(code, inputs, echo) {
    try { await this.ready; } catch (e) { return { ok: false, error: LOAD_ERR }; }
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.worker.terminate();          // зупиняємо нескінченний цикл
        setStatus('Перезапуск Python…');
        this.start().then(() => setStatus(''));
        resolve({ ok: false, timeout: true });
      }, (CFG.RUN_TIMEOUT_MS || 4000) + 400 * inputs.length);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ id, code, inputs, echo });
    });
  }
};
const LOAD_ERR = location.protocol === 'file:'
  ? 'Тренажер відкрито як файл із диска, тому браузер не дозволяє запустити Python. Відкрийте його за посиланням GitHub Pages або через локальний сервер (див. README.md).'
  : 'Не вдалося завантажити Python. Перевірте з’єднання з інтернетом і оновіть сторінку (Ctrl+F5).';
function setStatus(s) { const el = $('#pystatus'); if (el) el.textContent = s; }

/* ---------------------------------------------------------- error explanations */
function explain(err) {
  if (!err) return '';
  const ln = err.line ? ` (рядок ${err.line})` : '';
  const m = err.msg || '';
  switch (err.type) {
    case 'IndentationError': case 'TabError':
      return `Помилка відступу${ln}. Тіло if, for чи while зсувається на 4 пробіли, а всі рядки одного блоку мають однаковий відступ.`;
    case 'SyntaxError':
      if (/Maybe you meant '=='|cannot assign to/.test(m)) return `Синтаксична помилка${ln}: схоже, в умові стоїть = замість ==.`;
      if (/expected ':'/.test(m)) return `Синтаксична помилка${ln}: після if, elif, else, for чи while потрібна двокрапка.`;
      if (/unterminated string|EOL/.test(m)) return `Синтаксична помилка${ln}: не закрито лапки.`;
      if (/was never closed|unmatched/.test(m)) return `Синтаксична помилка${ln}: перевірте, чи всі дужки закриті.`;
      return `Синтаксична помилка${ln}. Перевірте двокрапки, дужки, лапки та написання команд.`;
    case 'NameError': {
      const n = (m.match(/name '(.+?)'/) || [])[1];
      return `Невідоме ім’я${n ? ' «' + n + '»' : ''}${ln}. Можливо, помилка в назві змінної або команди, або змінна ще не створена.`;
    }
    case 'TypeError':
      if (/'str' and 'int'|'int' and 'str'|can only concatenate str|not supported between instances of 'str'/.test(m))
        return `Помилка типів${ln}: число порівнюється або додається до тексту. Чи перетворили ви введення на число: int(input())?`;
      return `Помилка типів${ln}: ${m}`;
    case 'ValueError':
      if (/invalid literal for int/.test(m)) return `Помилка${ln}: int() отримав не ціле число. Перевірте, що саме вводиться.`;
      return `Помилка значення${ln}: ${m}`;
    case 'ZeroDivisionError': return `Ділення на нуль${ln}.`;
    case 'EOFError':
      return 'Програма запитує більше даних, ніж передбачено умовою. Можливо, зайвий input() або цикл не зупиняється вчасно.';
    default: return `${err.type}${ln}: ${m}`;
  }
}
const TIMEOUT_MSG = 'Програма працювала надто довго – схоже на нескінченний цикл. Чи змінюється в тілі циклу змінна з умови?';

/* ---------------------------------------------------------- state */
let S = null;   // поточний учень
const LAST = 'orbita:last';
function key(cls, code) { return 'orbita:' + cls + '|' + code; }
function load(cls, code) {
  let st = null; try { st = JSON.parse(localStorage.getItem(key(cls, code))); } catch (e) { }
  return st || { cls, code, tasks: {}, badges: {}, queue: [], created: new Date().toISOString() };
}
function save() { try { localStorage.setItem(key(S.cls, S.code), JSON.stringify(S)); localStorage.setItem(LAST, JSON.stringify({ cls: S.cls, code: S.code })); } catch (e) { } }
function ts(id) { return S.tasks[id] || (S.tasks[id] = { done: false, attempts: 0, fails: 0, hints: 0, nohint: false }); }

/* ---------------------------------------------------------- levels, unlock rule, badges */
function levelStats(l) {
  const by = g => l.tasks.filter(t => t.group === g);
  const done = t => S.tasks[t.id] && S.tasks[t.id].done;
  const basic = by('basic'), main = by('main');
  return {
    basicDone: basic.filter(done).length, basicAll: basic.length,
    mainDone: main.filter(done).length, mainAll: main.length,
    done: l.tasks.filter(done).length, all: l.tasks.length,
    passed: basic.every(done) && main.filter(done).length >= Math.ceil(main.length / 2)
  };
}
function unlocked(lid) {
  if (lid <= OPEN) return true;
  return levelStats(LEVELS[lid - 2]).passed;
}
const BADGES = [
  { id: 'nohints', name: 'Без підказок', desc: 'рівень пройдено без жодної підказки' },
  { id: 'debugger', name: 'Налагоджувач', desc: 'виправлено всі програми з помилками рівня' },
  { id: 'challenge', name: 'Виклик прийнято', desc: 'виконано завдання підвищеної складності' },
  { id: 'mission', name: 'Місію виконано', desc: 'пройдено всі шість рівнів' },
];
function awardBadges(task) {
  const got = [];
  const give = (id, sub) => { const k = sub ? id + ':' + sub : id; if (!S.badges[k]) { S.badges[k] = new Date().toISOString(); got.push(BADGES.find(b => b.id === id).name); } };
  const l = LEVELS[task.level - 1];
  const st = levelStats(l);
  if (task.group === 'challenge') give('challenge', task.id);
  const bugs = l.tasks.filter(t => t.type === 'findbug');
  if (bugs.length && bugs.every(t => S.tasks[t.id] && S.tasks[t.id].done)) give('debugger', l.id);
  if (st.passed && l.tasks.every(t => !S.tasks[t.id] || !S.tasks[t.id].hints)) give('nohints', l.id);
  if (LEVELS.every(lv => levelStats(lv).passed)) give('mission');
  return got;
}
function badgeCount(id) { return Object.keys(S.badges).filter(k => k === id || k.startsWith(id + ':')).length; }

/* ---------------------------------------------------------- report to Google Sheets */
function logEvent(task, ev) {
  const t = ts(task.id);
  S.queue.push(Object.assign({
    time: new Date().toISOString(), cls: S.cls, student: S.code, level: task.level, task: task.id,
    type: task.type, group: task.group, attempt: t.attempts, hints: t.hints,
    seconds: Math.round((Date.now() - (view.openedAt || Date.now())) / 1000)
  }, ev));
  save(); flush();
}
let flushing = false;
async function flush() {
  if (!CFG.REPORT_URL || flushing || !S || !S.queue.length) return;
  flushing = true;
  const batch = S.queue.slice(0, 50);
  try {
    await fetch(CFG.REPORT_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ events: batch }) });
    S.queue.splice(0, batch.length); save();
  } catch (e) { /* немає мережі – спробуємо пізніше */ }
  flushing = false;
}
setInterval(flush, 30000);
window.addEventListener('online', flush);

/* ---------------------------------------------------------- syntax highlight + editor */
const KW = new Set('False None True and as break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
const BI = new Set('print input int float str len range abs min max sum round bool list type'.split(' '));
function highlight(code) {
  const re = /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_Ѐ-ӿ][\wЀ-ӿ]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [tok, com, str, num, word] = m;
    if (com) out += `<span class="tk-com">${esc(com)}</span>`;
    else if (str) out += `<span class="tk-str">${esc(str)}</span>`;
    else if (num) out += `<span class="tk-num">${esc(num)}</span>`;
    else if (KW.has(word)) out += `<span class="tk-kw">${esc(word)}</span>`;
    else if (BI.has(word)) out += `<span class="tk-bi">${esc(word)}</span>`;
    else out += esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(code.slice(last)) + '\n';
}
function codeView(code) {
  const lines = code.split('\n').length;
  return `<div class="editor"><div class="gutter">${Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</div><div class="code readonly"><pre>${highlight(code)}</pre></div></div>`;
}
function makeEditor(host, value, onChange) {
  host.innerHTML = `<div class="editor"><div class="gutter"></div><div class="code"><pre></pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Редактор коду"></textarea></div></div>`;
  const ta = $('textarea', host), pre = $('pre', host), gut = $('.gutter', host);
  const insert = (text) => { if (!document.execCommand || !document.execCommand('insertText', false, text)) { ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); } };
  const sync = () => {
    pre.innerHTML = highlight(ta.value);
    const n = ta.value.split('\n').length;
    gut.textContent = Array.from({ length: Math.max(n, 6) }, (_, i) => i + 1).join('\n');
    ta.style.height = 'auto'; ta.style.height = Math.max(pre.scrollHeight, ta.scrollHeight) + 'px';
    pre.style.minHeight = ta.style.height;
    onChange && onChange(ta.value);
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', (e) => {
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (s === en && !e.shiftKey) { insert('    '); return; }
      const endLine = v.indexOf('\n', en - (en > s && v[en - 1] === '\n' ? 1 : 0)); const stop = endLine < 0 ? v.length : endLine;
      const block = v.slice(lineStart, stop);
      const nb = e.shiftKey ? block.replace(/^ {1,4}/gm, '') : block.replace(/^/gm, '    ');
      ta.setSelectionRange(lineStart, stop); insert(nb); ta.setSelectionRange(lineStart, lineStart + nb.length); sync();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const line = v.slice(lineStart, s);
      let ind = (line.match(/^ */) || [''])[0];
      if (/:\s*(#.*)?$/.test(line)) ind += '    ';
      insert('\n' + ind);
    } else if (e.key === 'Backspace' && s === en) {
      const before = v.slice(lineStart, s);
      if (before.length && /^ +$/.test(before) && before.length % 4 === 0) { e.preventDefault(); ta.setSelectionRange(s - 4, s); insert(''); }
    }
  });
  ta.value = value; sync();
  return { get: () => ta.value, set: (x) => { ta.value = x; sync(); }, focus: () => ta.focus() };
}

/* ---------------------------------------------------------- views */
const app = $('#app');
const view = { level: 1, task: null, openedAt: 0 };

function renderStart() {
  let last = null; try { last = JSON.parse(localStorage.getItem(LAST)); } catch (e) { }
  app.innerHTML = '';
  const el = h(`<div class="center"><div class="card">
    <h1>Місія «Орбітальна станція»</h1>
    <p>Тренажер для вивчення розгалужень і циклів мовою Python. Шість рівнів, у кожному – базові, основні завдання та виклики. Програми перевіряються автоматично.</p>
    <div class="field"><label for="cls">Клас</label><input id="cls" placeholder="наприклад, 7-А" value="${esc(params.get('cls') || (last && last.cls) || '')}"></div>
    <div class="field"><label for="code">Ваш код учасника</label><input id="code" placeholder="наприклад, номер у списку або псевдонім" value="${esc((last && last.code) || '')}">
      <div class="note">Не вводьте прізвище: для журналу достатньо коду, який вам дав учитель.</div></div>
    <button class="btn primary" id="go">Розпочати місію</button>
    <p class="loading" id="pystatus">Завантаження Python… (уперше це може тривати до хвилини)</p>
  </div></div>`);
  app.appendChild(el);
  Runner.ready.then(() => setStatus('Python готовий до роботи.')).catch(() => setStatus(LOAD_ERR));
  if (location.protocol === 'file:') app.querySelector('.card').insertBefore(h(`<div class="feedback fail"><h4>Тренажер треба відкривати через вебадресу</h4>Зараз файл index.html відкрито прямо з диска (адреса починається з file://). У такому режимі браузер блокує запуск Python, тому перевірка не працює. Розмістіть тренажер на GitHub Pages або запустіть локальний сервер – інструкція в README.md.</div>`), app.querySelector('.card').firstChild);
  $('#go').onclick = () => {
    const cls = $('#cls').value.trim(), code = $('#code').value.trim();
    if (!cls || !code) { toast('Заповніть клас і код учасника.'); return; }
    S = load(cls, code); save(); flush();
    const first = LEVELS.find(l => unlocked(l.id) && levelStats(l).done < l.tasks.length && levelStats(l).passed === false) || LEVELS[0];
    view.level = first.id;
    const next = first.tasks.find(t => !ts(t.id).done) || first.tasks[0];
    renderMain(); openTask(next.id);
  };
}

function renderMain() {
  app.innerHTML = '';
  app.appendChild(h(`<div><div class="topbar">
      <div class="title">Орбітальна станція<small>тренажер з Python</small></div><div class="spacer"></div>
      <span class="status" id="pystatus"></span>
      <span class="who">${esc(S.cls)} · ${esc(S.code)}</span>
      <button class="btn small" id="rep">Мій звіт</button>
      <button class="btn small ghost" id="out">Вийти</button>
    </div><div class="layout"><nav class="sidebar" id="side"></nav><main class="main" id="main"></main></div></div>`));
  $('#rep').onclick = renderReport; $('#out').onclick = () => { S = null; renderStart(); };
  renderSide();
}

function renderSide() {
  const side = $('#side'); side.innerHTML = '';
  LEVELS.forEach(l => {
    const st = levelStats(l), open = unlocked(l.id);
    const lv = h(`<div class="level ${open ? '' : 'locked'} ${st.passed ? 'done' : ''}">
      <button class="level-head" ${open ? '' : 'disabled'}><span class="level-num">${l.id}</span>
        <span><span class="level-name">${esc(l.name)}</span><br><span class="level-sub">${esc(l.topic)}</span></span>
        <span class="level-progress">${open ? st.done + '/' + st.all : 'закрито'}</span></button></div>`);
    $('.level-head', lv).onclick = () => { view.level = view.level === l.id ? 0 : l.id; renderSide(); };
    if (!open) lv.appendChild(h(`<div class="unlock-note">Відкриється, коли на рівні ${l.id - 1} виконано всі базові й не менше половини основних завдань.</div>`));
    if (open && view.level === l.id) {
      const list = h('<div class="task-list"></div>');
      ['basic', 'main', 'challenge'].forEach(g => {
        const ts_ = l.tasks.filter(t => t.group === g); if (!ts_.length) return;
        list.appendChild(h(`<div class="group-label">${GROUPS[g]}${g === 'main' ? ` (потрібно ${Math.ceil(ts_.length / 2)} з ${ts_.length})` : ''}</div>`));
        ts_.forEach(t => {
          const s = S.tasks[t.id];
          const cls = s && s.done ? 'done' : (s && s.attempts ? 'tried' : '');
          const b = h(`<button class="task-link ${view.task === t.id ? 'active' : ''}"><span class="mark ${cls}">${s && s.done ? '✓' : ''}</span>${esc(t.id)} ${esc(t.title)}</button>`);
          b.onclick = () => openTask(t.id);
          list.appendChild(b);
        });
      });
      lv.appendChild(list);
    }
    side.appendChild(lv);
  });
}

/* ---------------------------------------------------------- task screen */
let work = {};   // поточний робочий стан завдання
function openTask(id) {
  const t = TASK[id];
  view.task = id; view.level = t.level; view.openedAt = Date.now();
  renderSide();
  const l = LEVELS[t.level - 1], s = ts(id);
  const main = $('#main'); main.innerHTML = '';
  main.appendChild(h(`<div>
    <div class="crumbs">Рівень ${l.id} «${esc(l.name)}» · ${esc(l.topic)}</div>
    <h2 class="task-title">${esc(t.id)}. ${esc(t.title)}</h2>
    <div class="tags"><span class="tag ${t.group === 'challenge' ? 'challenge' : ''}">${GROUPS[t.group]}</span><span class="tag">${TYPES[t.type]}</span>${s.done ? '<span class="tag" style="color:var(--ok);border-color:#b5dcc2">виконано</span>' : ''}</div>
    ${t.id.endsWith('.1') ? `<div class="story">${esc(l.story)}</div>` : ''}
    <div class="statement">${esc(t.text)}</div>
    <div id="work"></div>
    <div class="actions" id="actions"></div>
    <div id="fb"></div>
    <div id="hintbox"></div>
  </div>`));
  work = { task: t };
  const W = $('#work');
  if (t.type === 'predict') {
    W.appendChild(h(`<div class="panel"><div class="panel-head">Програма</div>${codeView(t.code)}</div>`));
    W.appendChild(h(`<div class="panel"><div class="panel-head">Ваша відповідь: що виведе програма?</div><div class="panel-body"><textarea class="answer" id="ans" placeholder="Кожен рядок виводу – з нового рядка"></textarea></div></div>`));
    if (s.answer) $('#ans').value = s.answer;
  } else if (t.type === 'trace') {
    W.appendChild(h(`<div class="panel"><div class="panel-head">Програма</div>${codeView(t.code)}</div>`));
    const tbl = h(`<div class="panel"><div class="panel-head">Таблиця трасування (значення після кожного повторення)</div><div class="panel-body"><table class="trace"><tr><th>Повторення</th>${t.cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
      ${t.rows.map((r, i) => `<tr><td class="rowh">${i + 1}</td>${r.map((_, j) => `<td><input data-r="${i}" data-c="${j}" inputmode="numeric" value="${esc(((s.cells || [])[i] || [])[j] || '')}"></td>`).join('')}</tr>`).join('')}</table></div></div>`);
    W.appendChild(tbl);
  } else if (t.type === 'fill') {
    const parts = t.template.split('⟦⟧');
    let html = esc(parts[0]);
    for (let i = 1; i < parts.length; i++) html += `<input class="blank" data-i="${i - 1}" size="12" spellcheck="false" value="${esc((s.blanks || [])[i - 1] || '')}">` + esc(parts[i]);
    W.appendChild(h(`<div class="panel"><div class="panel-head">Допишіть пропущене</div><div class="fillcode">${html}</div></div>`));
    W.querySelectorAll('input.blank').forEach(inp => { const fit = () => { inp.size = Math.max(6, inp.value.length + 2); }; inp.addEventListener('input', fit); fit(); });
    addRunPanel(W);
  } else if (t.type === 'parsons') {
    const order = s.order || t.lines.map((_, i) => i);   // рядки в tasks.js уже записано в перемішаному порядку
    work.order = order.slice();
    const panel = h(`<div class="panel"><div class="panel-head">Перетягніть рядки або користуйтеся стрілками ↑ ↓</div><ul class="parsons" id="plist"></ul></div>`);
    W.appendChild(panel); renderParsons();
    addRunPanel(W);
  } else {
    W.appendChild(h(`<div class="panel"><div class="panel-head">Редактор коду (Tab – відступ, Shift+Tab – зменшити відступ)</div><div id="ed"></div></div>`));
    work.editor = makeEditor($('#ed'), s.code != null ? s.code : (t.code || t.starter || ''), v => { s.code = v; saveSoon(); });
    addRunPanel(W);
  }
  const A = $('#actions');
  if (['write', 'mission', 'findbug', 'fill', 'parsons'].includes(t.type)) {
    const r = h('<button class="btn">▶ Запустити</button>'); r.onclick = runOnce; A.appendChild(r);
  }
  const c = h('<button class="btn primary">Перевірити</button>'); c.onclick = check; A.appendChild(c);
  const hb = h('<button class="btn" id="hintbtn">Підказка</button>'); hb.onclick = showHint; A.appendChild(hb);
  A.appendChild(h('<span class="hint-info" id="hintinfo"></span>'));
  const nx = nextTaskId(t.id); if (nx) { const n = h('<button class="btn ghost">Наступне завдання →</button>'); n.onclick = () => openTask(nx); A.appendChild(n); }
  updateHintBtn();
  if (s.hints) renderHints();
}
let saveT; function saveSoon() { clearTimeout(saveT); saveT = setTimeout(save, 400); }
function nextTaskId(id) {
  const all = LEVELS.flatMap(l => l.tasks.map(t => t.id)); const i = all.indexOf(id);
  for (let j = i + 1; j < all.length; j++) if (unlocked(TASK[all[j]].level)) return all[j];
  return null;
}
function addRunPanel(W) {
  const t = work.task;
  const needsInput = (t.tests || []).some(x => x.in && x.in.length);
  W.appendChild(h(`<div class="panel"><div class="panel-head">Запуск програми</div><div class="panel-body io-grid">
    <div><div class="label">Вхідні дані (кожне значення з нового рядка)</div><textarea class="inputs" id="stdin" spellcheck="false">${esc(needsInput ? (t.tests[0].in || []).join('\n') : '')}</textarea></div>
    <div><div class="label">Результат</div><div class="shell" id="shell"><span class="muted">Натисніть «Запустити», щоб виконати програму, або «Перевірити», щоб пройти тести.</span></div></div>
  </div></div>`));
}
function renderParsons() {
  const t = work.task, ul = $('#plist'); ul.innerHTML = '';
  work.order.forEach((li, pos) => {
    const item = h(`<li draggable="true" data-pos="${pos}"><button class="mv" title="Вгору" aria-label="Вгору">↑</button><button class="mv" title="Вниз" aria-label="Вниз">↓</button><pre>${highlight(t.lines[li]).replace(/\n$/, '')}</pre></li>`);
    const [up, dn] = item.querySelectorAll('.mv');
    up.onclick = () => movePar(pos, pos - 1); dn.onclick = () => movePar(pos, pos + 1);
    item.addEventListener('dragstart', e => { item.classList.add('dragging'); e.dataTransfer.setData('text/plain', pos); });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('over'); });
    item.addEventListener('dragleave', () => item.classList.remove('over'));
    item.addEventListener('drop', e => { e.preventDefault(); movePar(+e.dataTransfer.getData('text/plain'), pos); });
    ul.appendChild(item);
  });
}
function movePar(from, to) {
  if (to < 0 || to >= work.order.length || from === to) { renderParsons(); return; }
  const [x] = work.order.splice(from, 1); work.order.splice(to, 0, x);
  ts(work.task.id).order = work.order.slice(); saveSoon(); renderParsons();
}
function currentCode() {
  const t = work.task;
  if (t.type === 'fill') {
    const vals = [...document.querySelectorAll('input.blank')].map(i => i.value);
    ts(t.id).blanks = vals; saveSoon();
    const parts = t.template.split('⟦⟧'); let code = parts[0];
    for (let i = 1; i < parts.length; i++) code += vals[i - 1] + parts[i];
    return code;
  }
  if (t.type === 'parsons') return work.order.map(i => t.lines[i]).join('\n');
  return work.editor.get();
}

async function runOnce() {
  const sh = $('#shell'); sh.innerHTML = '<span class="muted">Виконується…</span>';
  const inputs = $('#stdin').value.replace(/\r/g, '').split('\n'); while (inputs.length && inputs[inputs.length - 1] === '') inputs.pop();
  const r = await Runner.run(currentCode(), [inputs], true);
  if (r.timeout) { sh.innerHTML = `<span class="err">${esc(TIMEOUT_MSG)}</span>`; return; }
  if (!r.ok) { sh.innerHTML = `<span class="err">${esc(r.error)}</span>`; return; }
  const res = r.results[0];
  sh.innerHTML = esc(res.out || '') + (res.err ? `<span class="err">${res.out ? '\n' : ''}${esc(explain(res.err))}\n[${esc(res.err.type)}: ${esc(res.err.msg)}]</span>` : (res.out ? '' : '<span class="muted">(програма нічого не вивела)</span>'));
}

/* ---------------------------------------------------------- checking */
async function check() {
  const t = work.task, s = ts(t.id), fb = $('#fb');
  fb.innerHTML = '<div class="loading">Перевірка…</div>';
  let ok = false, html = '', ev = {};
  if (t.type === 'predict') {
    const ans = $('#ans').value; s.answer = ans;
    const r = await Runner.run(t.code, [[]], false);
    if (!r.ok) { fb.innerHTML = `<div class="feedback fail"><h4>Python недоступний</h4>${esc(r.timeout ? TIMEOUT_MSG : r.error)}</div>`; return; }
    const expected = normOut(r.results[0].out);
    ok = normOut(ans) === expected;
    if (!ok) {
      const nA = normOut(ans).split('\n').filter(Boolean).length, nE = expected.split('\n').length;
      html = `<h4>Ще не так</h4>Програма виведе інший результат.${nA !== nE ? ` Зверніть увагу: у правильній відповіді ${nE} ${nE === 1 ? 'рядок' : nE < 5 ? 'рядки' : 'рядків'}.` : ' Кількість рядків правильна – перевірте значення.'} Простежте виконання рядок за рядком.`;
      ev = { result: 'fail', error: 'wrong' };
    } else { html = `<h4>Правильно!</h4>Програма справді виведе:<div class="cmp"><div>${esc(expected)}</div></div>`; }
  } else if (t.type === 'trace') {
    const inputs = [...document.querySelectorAll('table.trace input')];
    s.cells = t.rows.map((r, i) => r.map((_, j) => inputs.find(x => +x.dataset.r === i && +x.dataset.c === j).value.trim()));
    let bad = 0;
    inputs.forEach(x => { const good = x.value.trim() === t.rows[+x.dataset.r][+x.dataset.c]; x.classList.toggle('bad', !good); x.classList.toggle('good', good); if (!good) bad++; });
    ok = bad === 0;
    html = ok ? '<h4>Правильно!</h4>Ви точно простежили виконання програми.' : `<h4>Є неточності</h4>Неправильних клітинок: ${bad}. Вони позначені червоним.`;
    if (!ok) ev = { result: 'fail', error: 'wrong', detail: bad + ' cells' };
  } else {
    const code = currentCode();
    const r = await Runner.run(code, t.tests.map(x => x.in || []), false);
    if (r.timeout) { html = `<h4>Перевірку зупинено</h4>${esc(TIMEOUT_MSG)}`; ev = { result: 'fail', error: 'timeout' }; }
    else if (!r.ok) { fb.innerHTML = `<div class="feedback fail"><h4>Python недоступний</h4>${esc(r.error)}</div>`; return; }
    else {
      const rows = []; let firstErr = null, failed = 0, failedHidden = [];
      t.tests.forEach((tc, i) => {
        const res = r.results[i];
        const pass = !res.err && normOut(res.out) === normOut(tc.out);
        if (!pass) { failed++; if (res.err && !firstErr) firstErr = res.err; }
        if (!pass && !tc.hidden) rows.push(`<li>Тест ${i + 1}${res.err ? ' – помилка виконання' : ''}<div class="cmp"><div class="cap">Вхідні дані</div><div class="cap">Очікувано</div><div class="cap">Отримано</div>
          <div>${esc((tc.in || []).join('\n')) || '—'}</div><div>${esc(tc.out) || '(нічого)'}</div><div>${esc(normOut(res.out)) || '(нічого)'}</div></div></li>`);
        if (!pass && tc.hidden) failedHidden.push(tc);
      });
      ok = failed === 0;
      if (ok) html = `<h4>Усі тести пройдено (${t.tests.length})</h4>Програма працює правильно, зокрема на граничних значеннях.`;
      else {
        html = `<h4>Пройдено ${t.tests.length - failed} з ${t.tests.length} тестів</h4>`;
        if (firstErr) html += `<p>${esc(explain(firstErr))}</p>`;
        if (rows.length && !(firstErr && /SyntaxError|IndentationError|TabError/.test(firstErr.type))) html += `<ul>${rows.join('')}</ul>`;
        if (failedHidden.length) html += `<p>Не пройдено прихованих тестів: ${failedHidden.length}.${failedHidden[0].why ? ' ' + esc(failedHidden[0].why) : ' Перевірте програму на інших значеннях, зокрема граничних.'}</p>`;
        ev = { result: 'fail', error: firstErr ? firstErr.type : 'wrong', detail: `${t.tests.length - failed}/${t.tests.length}` };
      }
    }
  }
  s.attempts++;
  if (ok) {
    const before = LEVELS.map(l => unlocked(l.id));
    const first = !s.done; s.done = true; if (first) s.solvedAt = new Date().toISOString();
    fb.innerHTML = `<div class="feedback ok">${html}</div>`;
    logEvent(t, { result: 'ok', error: '' });
    const got = first ? awardBadges(t) : [];
    save(); renderSide();
    const opened = LEVELS.filter((l, i) => !before[i] && unlocked(l.id)).map(l => l.id);
    const msgs = [];
    if (got.length) msgs.push('Нова відзнака: ' + got.join(', '));
    if (opened.length) msgs.push(`Рівень ${opened.join(', ')} відкрито!`);
    if (msgs.length) toast(msgs.join(' · '));
    if (badgeCount('mission') && got.includes('Місію виконано')) setTimeout(renderReport, 1500);
  } else {
    s.fails++;
    fb.innerHTML = `<div class="feedback fail">${html}</div>`;
    logEvent(t, ev);
    save(); renderSide();
  }
  updateHintBtn();
}

/* ---------------------------------------------------------- hints */
function hintsAvailable(s) { return s.fails >= 4 ? 2 : s.fails >= 2 ? 1 : 0; }
function updateHintBtn() {
  const t = work.task, s = ts(t.id), b = $('#hintbtn'), info = $('#hintinfo'); if (!b) return;
  const av = hintsAvailable(s);
  b.disabled = s.done || av <= s.hints;
  info.textContent = s.done ? '' : av <= s.hints ? (s.hints >= 2 ? '' : `Підказка стане доступною після ${s.hints === 0 ? 2 : 4} невдалих спроб.`) : '';
}
function showHint() {
  const t = work.task, s = ts(t.id);
  const av = hintsAvailable(s); if (av <= s.hints) return;
  s.hints++; save();
  logEvent(t, { result: 'hint', error: '' });
  renderHints(); updateHintBtn();
}
function renderHints() {
  const t = work.task, s = ts(t.id);
  $('#hintbox').innerHTML = `<div class="feedback hint"><h4>Підказки</h4><ul>${t.hints.slice(0, s.hints).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
}

/* ---------------------------------------------------------- report */
function renderReport() {
  const main = $('#main'); view.task = null; renderSide();
  const total = LEVELS.reduce((a, l) => a + l.tasks.length, 0);
  const done = Object.values(S.tasks).filter(x => x.done).length;
  const att = Object.values(S.tasks).reduce((a, x) => a + x.attempts, 0);
  const hints = Object.values(S.tasks).reduce((a, x) => a + x.hints, 0);
  main.innerHTML = '';
  main.appendChild(h(`<div>
    <h2 class="task-title">${badgeCount('mission') ? 'Звіт про місію: місію виконано!' : 'Мій звіт'}</h2>
    <div class="crumbs">${esc(S.cls)} · ${esc(S.code)}</div>
    <div class="statement">Виконано завдань: <b>${done}</b> з ${total}. Спроб перевірки: ${att}. Використано підказок: ${hints}.</div>
    <h3>Відзнаки</h3>
    <div class="badges">${BADGES.map(b => { const n = badgeCount(b.id); return `<div class="badge ${n ? '' : 'off'}"><b>${b.name}${n > 1 ? ' ×' + n : ''}</b><span>${b.desc}</span></div>`; }).join('')}</div>
    <h3>Рівні</h3>
    <table class="report"><tr><th>Рівень</th><th>Базові</th><th>Основні</th><th>Виклики</th><th>Стан</th></tr>
      ${LEVELS.map(l => { const st = levelStats(l); const ch = l.tasks.filter(t => t.group === 'challenge'); const chd = ch.filter(t => S.tasks[t.id] && S.tasks[t.id].done).length;
        return `<tr><td>${l.id}. ${esc(l.name)}</td><td>${st.basicDone}/${st.basicAll}</td><td>${st.mainDone}/${st.mainAll}</td><td>${chd}/${ch.length}</td><td>${st.passed ? 'пройдено' : unlocked(l.id) ? 'у процесі' : 'закрито'}</td></tr>`; }).join('')}
    </table>
    ${CFG.REPORT_URL ? `<p class="loading">${S.queue.length ? 'Очікують надсилання записів: ' + S.queue.length : 'Усі результати надіслано вчителю.'}</p>` : ''}
  </div>`));
}

/* ---------------------------------------------------------- start */
Runner.start().catch(() => { });
renderStart();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && S && S.queue.length && CFG.REPORT_URL && navigator.sendBeacon) { if (navigator.sendBeacon(CFG.REPORT_URL, new Blob([JSON.stringify({ events: S.queue })], { type: 'text/plain' }))) { S.queue = []; save(); } } });
window.__trainer = { Runner, TASK, normOut };   // для автоматичних тестів
})();
