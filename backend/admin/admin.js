'use strict';
/* Asveli admin — vanilla JS. All dynamic text goes through textContent/createTextNode (no innerHTML),
   and the page runs under a strict CSP (script-src 'self', no inline styles/scripts). */

const state = { me: null, csrf: null, tab: 'dash', meta: [], gated: false };
const root = document.getElementById('app');

/* ---------- tiny DOM helper ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(2)) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return el;
}
const mount = (...nodes) => root.replaceChildren(...nodes);

const ERR = {
  invalid_credentials: 'Неверный логин, пароль или код.', invalid_code: 'Неверный код.', locked: 'Аккаунт временно заблокирован. Попробуйте через 15 минут.',
  too_many_requests: 'Слишком много попыток. Подождите немного.', weak_password: 'Пароль: минимум 12 символов.', file_too_large: 'Файл больше допустимого лимита.',
  upload_failed: 'Не удалось загрузить файл.', bad_csrf: 'Сессия устарела, обновите страницу.', bad_origin: 'Запрос отклонён (origin).', unauthorized: 'Нужно войти.',
  already_enabled: '2FA уже включена.', forbidden: 'Недостаточно прав.', password_change_required: 'Сначала смените временный пароль.', '2fa_required': 'Сначала включите 2FA.', not_in_setup: 'Сначала запустите настройку 2FA.', server_error: 'Ошибка сервера.'
};
const errText = e => ERR[e.message] || ('Ошибка: ' + (e.message || 'неизвестно'));

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf || '';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch('/api/admin' + path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* not json */ }
  if (!r.ok) {
    if (r.status === 401 && state.me && !path.startsWith('/auth/')) { state.me = null; showLogin(); }
    throw Object.assign(new Error((data && data.error) || r.statusText), { status: r.status, detail: data && typeof data.detail === 'string' ? data.detail : undefined, data });
  }
  return data;
}

/* ---------- formatting ---------- */
const fmtBytes = n => { if (n == null) return '—'; const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + ' ' + u[i]; };
const fmtDate = ts => new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

/* ---------- login ---------- */
function showLogin(step2 = false) {
  const msg = h('p', { class: 'msg err', role: 'alert' });
  const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', required: true, maxlength: 64 });
  const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: 256 });
  const code = h('input', { type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '\\d{6}', maxlength: 7, required: true });
  const btn = h('button', { class: 'btn', type: 'submit' }, step2 ? 'Подтвердить' : 'Войти');
  const form = h('form', { class: 'card login', novalidate: true, onsubmit: async ev => {
    ev.preventDefault(); btn.disabled = true; msg.textContent = '';
    try {
      const r = step2 ? await api('/auth/login2fa', { method: 'POST', body: { code: code.value } })
                      : await api('/auth/login', { method: 'POST', body: { username: user.value, password: pass.value } });
      if (r.needs2fa) return showLogin(true);
      state.csrf = r.csrf; await boot();
    } catch (e) { msg.textContent = errText(e); if (e.status === 401 && step2) code.value = ''; btn.disabled = false; }
  } },
    h('img', { src: 'logo.svg', alt: 'Asveli' }), h('h1', null, step2 ? 'Код из приложения' : 'Вход в админку'),
    step2 ? h('label', { class: 'field' }, '6-значный код (Google Authenticator, Aegis, 1Password…)', code)
          : [h('label', { class: 'field' }, 'Логин', user), h('label', { class: 'field' }, 'Пароль', pass)],
    btn, msg);
  mount(h('div', { class: 'center' }, form));
  (step2 ? code : user).focus();
}

/* ---------- app shell ---------- */
async function boot() {
  try { const me = await api('/me'); state.me = me; state.csrf = me.csrf; } catch { return showLogin(); }
  state.gated = state.me.must_change_password || (state.me.require_2fa && !state.me.totp_enabled);
  state.meta = [];
  if (!state.gated) { try { state.meta = (await api('/meta')).resources; } catch { /* nav falls back to built-ins */ } }
  if (state.gated) state.tab = 'sec';
  else { const want = decodeURIComponent(location.hash.slice(1)); if (/^[a-z0-9_]{1,40}$/.test(want)) state.tab = want; }   // reload / shared link opens the same page
  renderShell();
}
// browser Back / Forward between admin pages
window.addEventListener('hashchange', () => { const want = decodeURIComponent(location.hash.slice(1)); if (state.me && !state.gated && want && want !== state.tab && /^[a-z0-9_]{1,40}$/.test(want)) { state.tab = want; renderShell(); } });
const leaveHooks = [];
function renderShell() {
  // keep the reader where they were: the sidebar keeps its scroll; the page goes to the top of the content only when a NEW page opens
  const oldSide = document.querySelector('nav.side'), sideTop = oldSide ? oldSide.scrollTop : 0, prevTab = renderShell.last, y = window.scrollY;
  while (leaveHooks.length) { try { leaveHooks.pop()(); } catch { /* ignore */ } }      // pages that bind global handlers (hotkeys) unbind here
  const content = h('main', { id: 'content' });
  const entries = window.Asv.navEntries();
  if (!entries.some(e => e.id === state.tab)) state.tab = entries[0].id;
  const groups = []; for (const e of entries) { let g = groups.find(x => x.name === e.group); if (!g) groups.push(g = { name: e.group, items: [] }); g.items.push(e); }
  const side = h('nav', { class: 'side', 'aria-label': 'Разделы' }, groups.map(g => h('div', { class: 'grp' }, h('div', { class: 'gname' }, g.name),
    g.items.map(e => h('button', { type: 'button', 'aria-current': e.id === state.tab ? 'page' : null, onclick: () => { if (state.tab === e.id) return; state.tab = e.id; renderShell(); } }, e.label)))));
  mount(h('div', { class: 'shell' },
    h('header', { class: 'bar' }, h('img', { src: 'logo.svg', alt: 'Asveli' }), h('span', { class: 'grow' }),
      h('div', { class: 'who' }, h('span', null, state.me.username + ' · ' + state.me.role_label + (state.me.totp_enabled ? ' · 2FA ✓' : '')),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ } state.me = null; showLogin(); } }, 'Выйти'))),
    state.gated ? h('p', { class: 'msg err banner' }, state.me.must_change_password ? 'Задайте новый пароль (вы вошли с временным).' : 'Для работы с модулями включите 2FA.') : null,
    h('div', { class: 'layout' }, side, content)));
  const e = entries.find(x => x.id === state.tab);
  const nav = document.querySelector('nav.side'); if (nav) { nav.scrollTop = sideTop; if (!oldSide) { const cur = nav.querySelector('[aria-current=page]'); if (cur) cur.scrollIntoView({ block: 'nearest' }); } }
  if (!state.gated && location.hash.slice(1) !== state.tab) history.pushState(null, '', '#' + state.tab);
  renderShell.last = state.tab;
  if (prevTab === state.tab) window.scrollTo(0, y);                                   // same page redrawn (e.g. after 2FA): stay put
  else { const top = content.getBoundingClientRect().top + window.scrollY - 12; if (y > top) window.scrollTo(0, top); }
  e.render(content);
  if (nav) nav.scrollTop = sideTop;
}
const loading = el => el.replaceChildren(h('p', { class: 'sub' }, 'Загрузка…'));
const fail = (el, e) => el.replaceChildren(h('p', { class: 'msg err' }, errText(e)));

/* ---------- dashboard ---------- */
async function viewDash(el) {
  loading(el);
  try {
    const s = await api('/stats');
    const used = s.storage.used, limit = s.storage.limit, pct = used != null && limit ? Math.min(100, used / limit * 100) : null;
    const bar = h('i'); if (pct != null) requestAnimationFrame(() => { bar.style.width = pct.toFixed(1) + '%'; });
    const total = Object.values(s.subscribers).reduce((a, b) => a + b.total, 0);
    el.replaceChildren(
      h('div', null, h('h2', null, 'Обзор'), h('p', { class: 'sub' }, 'Подписчики с заглушек и состояние хранилища.')),
      h('div', { class: 'grid' },
        h('div', { class: 'card stat' }, h('b', null, total), h('span', null, 'подписчиков всего')),
        ...Object.entries(s.subscribers).map(([site, v]) => h('div', { class: 'card stat' }, h('b', null, v.total), h('span', null, site), v.week ? h('div', null, h('small', null, '+' + v.week + ' за 7 дней')) : null)),
        h('div', { class: 'card stat' }, h('b', null, s.files.count), h('span', null, 'файлов · ' + fmtBytes(s.files.bytes)))),
      h('div', { class: 'card' },
        h('strong', null, s.storage.driver === 'drive' ? 'Google Drive' : 'Локальный диск'),
        h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct != null ? Math.round(pct) : null }, bar),
        h('span', { class: 'sub' }, s.storage.error ? 'Хранилище недоступно — проверьте ключи Google.'
          : (used != null ? `${fmtBytes(used)} из ${fmtBytes(limit)}${pct != null ? ' (' + pct.toFixed(1) + '%)' : ''}` : '—') +
            (s.storage.scope === 'google-account' ? ' · учитывается весь аккаунт Google (Gmail, Фото и т.д.)' : ''))));
  } catch (e) { fail(el, e); }
}

/* ---------- subscribers ---------- */
async function viewSubs(el, page = 0, filters = { site: '', q: '' }) {
  const PAGE = 50;
  const site = h('select', { 'aria-label': 'Сайт' }, h('option', { value: '' }, 'Все сайты'), state.me.sites.map(s => h('option', { value: s, selected: s === filters.site }, s)));
  const q = h('input', { type: 'search', placeholder: 'Поиск по email', value: filters.q, 'aria-label': 'Поиск' });
  const go = () => viewSubs(el, 0, { site: site.value, q: q.value.trim() });
  site.addEventListener('change', go); q.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  const qs = new URLSearchParams({ ...(filters.site && { site: filters.site }), ...(filters.q && { q: filters.q }) });
  const head = [h('div', null, h('h2', null, 'Подписчики')),
    h('div', { class: 'toolbar' }, site, q, h('button', { class: 'btn ghost sm', type: 'button', onclick: go }, 'Найти'), h('span', { class: 'grow' }),
      h('a', { class: 'btn sm', href: '/api/admin/subscribers.csv?' + qs, style: null, download: '' }, 'Экспорт CSV'))];
  try {
    const qq = new URLSearchParams(qs); qq.set('limit', PAGE); qq.set('offset', page * PAGE);
    const { total, rows } = await api('/subscribers?' + qq);
    const table = rows.length ? h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Email', 'Сайт', 'Язык', 'Дата', ''].map(t => h('th', null, t)))),
      h('tbody', null, rows.map(r => h('tr', null, h('td', null, r.email), h('td', null, h('span', { class: 'pill' }, r.site)), h('td', null, r.lang || '—'), h('td', null, fmtDate(r.created_at)),
        h('td', { class: 'actions' }, h('button', { class: 'btn danger sm', type: 'button', onclick: async () => {
          if (!confirm('Удалить ' + r.email + '?')) return; try { await api('/subscribers/' + r.id, { method: 'DELETE' }); viewSubs(el, page, filters); } catch (e) { alert(errText(e)); } } }, 'Удалить'))))))) : h('p', { class: 'empty' }, 'Пока никого.');
    const pages = Math.ceil(total / PAGE);
    el.replaceChildren(...head, h('div', { class: 'card' }, table),
      h('div', { class: 'toolbar' }, h('span', { class: 'sub' }, `Всего: ${total}`), h('span', { class: 'grow' }),
        page > 0 ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => viewSubs(el, page - 1, filters) }, '← Назад') : null,
        page + 1 < pages ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => viewSubs(el, page + 1, filters) }, 'Вперёд →') : null));
  } catch (e) { el.replaceChildren(...head, h('p', { class: 'msg err' }, errText(e))); }
}

/* ---------- files ---------- */
function copyBtn(input) {
  return h('button', { class: 'btn sm', type: 'button', onclick: async ev => {
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    ev.target.textContent = 'Скопировано'; setTimeout(() => { ev.target.textContent = 'Копировать'; }, 1500); } }, 'Копировать');
}
function shareDialog(file) {
  const ttl = h('select', { 'aria-label': 'Срок действия' }, [['1 час', 3600], ['24 часа', 86400], ['7 дней', 604800], ['30 дней', 2592000]].map(([t, v]) => h('option', { value: v }, t)));
  const out = h('div', { class: 'col' });
  const dlg = h('dialog', null, h('div', { class: 'col' },
    h('h2', null, 'Временная ссылка'), h('p', { class: 'sub' }, file.name),
    h('label', { class: 'field' }, 'Действует', ttl),
    h('button', { class: 'btn', type: 'button', onclick: async () => {
      try {
        const r = await api(`/files/${file.id}/share`, { method: 'POST', body: { ttl: Number(ttl.value) } });
        const inp = h('input', { type: 'text', readonly: true, value: r.url, 'aria-label': 'Ссылка' });
        out.replaceChildren(h('div', { class: 'linkbox' }, inp, copyBtn(inp)), h('p', { class: 'sub' }, 'Истекает: ' + fmtDate(r.expires_at)));
        inp.select();
      } catch (e) { out.replaceChildren(h('p', { class: 'msg err' }, errText(e))); } } }, 'Создать ссылку'),
    out, h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Закрыть')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}
function uploadOne(file, row, onDone) {
  const bar = h('i'), status = h('span', { class: 'sub' }, '0%');
  row.append(h('div', { class: 'up' }, h('div', null, file.name + ' · ' + fmtBytes(file.size)), h('div', { class: 'meter' }, bar), status));
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest(), fd = new FormData();
    fd.append('file', file);
    xhr.open('POST', '/api/admin/files'); xhr.setRequestHeader('X-CSRF-Token', state.csrf);
    xhr.upload.onprogress = e => { if (e.lengthComputable) { const p = Math.round(e.loaded / e.total * 100); bar.style.width = p + '%'; status.textContent = p + '%'; } };
    xhr.onload = () => { let d = {}; try { d = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 201) { bar.style.width = '100%'; status.textContent = 'Готово'; } else { status.textContent = ERR[d.error] || 'Ошибка ' + xhr.status; status.className = 'msg err'; }
      resolve(); };
    xhr.onerror = () => { status.textContent = 'Сеть недоступна'; status.className = 'msg err'; resolve(); };
    xhr.send(fd);
  }).then(onDone);
}
async function viewFiles(el) {
  const list = h('div', { class: 'card' }), ups = h('div', { class: 'uploads' });
  const input = h('input', { type: 'file', multiple: true, class: 'hidden', 'aria-label': 'Выбрать файлы' });
  const run = async files => { for (const f of files) await uploadOne(f, ups, () => {}); refresh(); };
  const drop = h('div', { class: 'drop', role: 'button', tabindex: 0, onclick: () => input.click(),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    ondragover: e => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'),
    ondrop: e => { e.preventDefault(); drop.classList.remove('over'); run([...e.dataTransfer.files]); } }, 'Перетащите файлы сюда или нажмите, чтобы выбрать');
  input.addEventListener('change', () => { run([...input.files]); input.value = ''; });
  el.replaceChildren(h('div', null, h('h2', null, 'Файлы'), h('p', { class: 'sub' }, 'Файлы хранятся в ' + (state.me.storage === 'drive' ? 'Google Drive' : 'локальном хранилище') + ' и отдаются только через этот сервер.')),
    h('div', { class: 'card' }, drop, input, ups), list);

  async function refresh() {
    try {
      const { rows } = await api('/files');
      list.replaceChildren(rows.length ? h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Имя', 'Размер', 'Загружен', 'Публичный', ''].map(t => h('th', null, t)))),
        h('tbody', null, rows.map(f => {
          const pub = h('input', { type: 'checkbox', checked: f.is_public, 'aria-label': 'Публичный', onchange: async () => {
            try { await api('/files/' + f.id, { method: 'PATCH', body: { is_public: pub.checked } }); refresh(); } catch (e) { alert(errText(e)); pub.checked = !pub.checked; } } });
          return h('tr', null, h('td', { class: 'wrap' }, f.name, f.is_public ? h('div', { class: 'linkbox' }, (() => { const i = h('input', { type: 'text', readonly: true, value: f.public_url, 'aria-label': 'Публичная ссылка' }); return [i, copyBtn(i)]; })()) : null),
            h('td', null, fmtBytes(f.size)), h('td', null, fmtDate(f.created_at)), h('td', null, pub),
            h('td', { class: 'actions' },
              h('a', { class: 'btn ghost sm', href: `/api/admin/files/${f.id}/download`, download: '' }, 'Скачать'),
              h('button', { class: 'btn ghost sm', type: 'button', onclick: () => shareDialog(f) }, 'Ссылка'),
              h('button', { class: 'btn ghost sm', type: 'button', title: 'Аннулировать все выданные временные ссылки', onclick: async () => { if (confirm('Аннулировать все временные ссылки на этот файл?')) { try { await api(`/files/${f.id}/revoke`, { method: 'POST' }); } catch (e) { alert(errText(e)); } } } }, 'Отозвать'),
              h('button', { class: 'btn danger sm', type: 'button', onclick: async () => { if (!confirm('Удалить «' + f.name + '» навсегда?')) return; try { await api('/files/' + f.id, { method: 'DELETE' }); refresh(); } catch (e) { alert(errText(e)); } } }, 'Удалить')));
        })))) : h('p', { class: 'empty' }, 'Файлов пока нет.'));
    } catch (e) { list.replaceChildren(h('p', { class: 'msg err' }, errText(e))); }
  }
  refresh();
}

/* ---------- security ---------- */
function viewSec(el) {
  const m1 = h('p', { class: 'msg', role: 'status' });
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true }), nw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 12 });
  const pwForm = h('form', { class: 'card col', onsubmit: async ev => {
    ev.preventDefault(); m1.className = 'msg';
    try { await api('/security/password', { method: 'POST', body: { current: cur.value, next: nw.value } }); m1.className = 'msg ok'; m1.textContent = 'Пароль изменён, остальные сессии закрыты.'; pwForm.reset(); if (state.me.must_change_password) { state.me.must_change_password = false; boot(); } }
    catch (e) { m1.className = 'msg err'; m1.textContent = errText(e); } } },
    h('h2', null, 'Пароль'), h('label', { class: 'field' }, 'Текущий пароль', cur), h('label', { class: 'field' }, 'Новый пароль (≥ 12 символов)', nw),
    h('button', { class: 'btn', type: 'submit' }, 'Сменить пароль'), m1);

  const box = h('div', { class: 'card col' });
  const draw2fa = () => {
    const m = h('p', { class: 'msg', role: 'status' });
    if (state.me.totp_enabled) {
      const pw = h('input', { type: 'password', autocomplete: 'current-password' }), code = h('input', { type: 'text', inputmode: 'numeric', maxlength: 7, autocomplete: 'one-time-code' });
      box.replaceChildren(h('h2', null, 'Двухфакторная защита'), h('p', { class: 'msg ok' }, 'Включена ✓'),
        h('label', { class: 'field' }, 'Пароль', pw), h('label', { class: 'field' }, 'Код из приложения', code),
        h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          try { await api('/security/2fa/disable', { method: 'POST', body: { password: pw.value, code: code.value } }); state.me.totp_enabled = false; renderShell(); }
          catch (e) { m.className = 'msg err'; m.textContent = errText(e); } } }, 'Отключить 2FA'), m);
    } else {
      box.replaceChildren(h('h2', null, 'Двухфакторная защита'), h('p', { class: 'sub' }, 'Рекомендуется: вход потребует код из приложения-аутентификатора.'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try {
            const r = await api('/security/2fa/setup', { method: 'POST' });
            const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: 7, autocomplete: 'one-time-code', 'aria-label': 'Код' });
            box.replaceChildren(h('h2', null, 'Сканируйте QR-код'), h('img', { class: 'qr', src: r.qr, alt: 'QR-код для аутентификатора' }),
              h('p', { class: 'sub' }, 'Или введите ключ вручную:'), h('code', { class: 'mono' }, r.secret.match(/.{1,4}/g).join(' ')),
              h('label', { class: 'field' }, 'Код из приложения', code),
              h('button', { class: 'btn', type: 'button', onclick: async () => {
                try { await api('/security/2fa/enable', { method: 'POST', body: { code: code.value } }); state.me.totp_enabled = true; boot(); }
                catch (e) { m.className = 'msg err'; m.textContent = errText(e); } } }, 'Включить'), m);
          } catch (e) { m.className = 'msg err'; m.textContent = errText(e); } } }, 'Настроить 2FA'), m);
    }
  };
  draw2fa();
  el.replaceChildren(h('div', null, h('h2', null, 'Безопасность'), h('p', { class: 'sub' }, 'Пароль хранится как scrypt-хэш; секрет 2FA — зашифрован.')), h('div', { class: 'two' }, pwForm, box));
}

/* ---------- audit ---------- */
async function viewAudit(el) {
  loading(el);
  try {
    const { rows } = await api('/audit?limit=200');
    el.replaceChildren(h('div', null, h('h2', null, 'Журнал действий'), h('p', { class: 'sub' }, 'Входы, загрузки, ссылки, изменения безопасности.')),
      h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Время', 'Пользователь', 'IP', 'Действие', 'Детали'].map(t => h('th', null, t)))),
        h('tbody', null, rows.map(r => h('tr', null, h('td', null, fmtDate(r.ts)), h('td', null, r.user || '—'), h('td', { class: 'mono' }, r.ip || '—'), h('td', null, h('span', { class: 'pill' }, r.action)), h('td', { class: 'wrap' }, r.detail || '')))))));
  } catch (e) { fail(el, e); }
}

window.Asv = { onLeave: fn => leaveHooks.push(fn), h, api, state, errText, fmtDate, fmtBytes, mount, loading, fail, renderShell, views: { dash: viewDash, subs: viewSubs, files: viewFiles, sec: viewSec, audit: viewAudit } };
document.addEventListener('DOMContentLoaded', boot);
