'use strict';
/* Asveli admin — «API и AI-агенты»: keys for Antigravity / Claude / Cursor / scripts + ready MCP configs. Owner only. No innerHTML. */
(() => {
  const { h, api, state, loading, fail, fmtDate } = window.Asv;
  const { can, put, err } = window.Asv.ui;
  const CODES = { invalid_key_name: 'Название: 2–60 символов (буквы, цифры, пробел, . _ -).', invalid_role: 'Выберите роль.', invalid_days: 'Срок: от 1 до 3650 дней.' };
  const e2t = e => CODES[e.message] || err(e);
  const copy = async (text, btn) => { try { await navigator.clipboard.writeText(text); const t = btn.textContent; btn.textContent = 'Скопировано ✓'; setTimeout(() => { btn.textContent = t; }, 1500); } catch { /* select manually */ } };
  const codeBox = text => { const pre = h('pre', { class: 'code' }, text); const b = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => copy(text, b) }, 'Копировать'); return h('div', { class: 'codebox' }, pre, b); };

  async function page(el) {
    loading(el);
    let v; try { v = await api('/apikeys'); } catch (e) { return fail(el, e); }
    const mcp = location.origin + '/mcp';
    const fresh = h('div');
    const name = h('input', { class: 'input', type: 'text', value: 'Antigravity', maxlength: 60, 'aria-label': 'Название ключа' });
    const role = h('select', { class: 'input', 'aria-label': 'Роль' }, v.roles.map(r => h('option', { value: r.id, selected: r.id === 'catalog_manager' || null }, r.label)));
    const days = h('select', { class: 'input', 'aria-label': 'Срок' }, [['30', '30 дней'], ['90', '90 дней'], ['365', '1 год'], ['', 'бессрочно']].map(([d, t]) => h('option', { value: d, selected: d === '90' || null }, t)));
    const msg = h('p', { class: 'msg', role: 'status' }), list = h('div');
    const configs = token => {
      const anti = JSON.stringify({ mcpServers: { asveli: { serverUrl: mcp, headers: { Authorization: 'Bearer ' + token } } } }, null, 2);
      return h('div', { class: 'col' },
        h('h4', null, 'Google Antigravity'), h('p', { class: 'hint' }, 'Панель агента → «…» → MCP Servers → Manage MCP Servers → View raw config. Вставьте (или добавьте блок «asveli» в mcpServers) и сохраните:'), codeBox(anti),
        h('h4', null, 'Claude Code'), codeBox(`claude mcp add --transport http asveli ${mcp} --header "Authorization: Bearer ${token}"`),
        h('h4', null, 'Cursor / другие (mcp.json)'), codeBox(JSON.stringify({ mcpServers: { asveli: { url: mcp, headers: { Authorization: 'Bearer ' + token } } } }, null, 2)),
        h('h4', null, 'REST API (скрипты)'), codeBox(`curl -H "Authorization: Bearer ${token}" ${location.origin}/api/admin/m/products?limit=5`));
    };
    const drawList = () => put(list, v.keys.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Название', 'Ключ', 'Роль', 'Создан', 'Последнее использование', 'Срок', ''].map(t => h('th', null, t)))),
      h('tbody', null, v.keys.map(k => h('tr', null, h('td', { class: 'wrap' }, k.parent_id ? h('span', null, '↳ ', k.name, h('br'), h('small', null, `саб-агент ключа #${k.parent_id}`), k.brief ? h('br') : null, k.brief ? h('small', { title: k.brief }, 'Задание: ' + k.brief.slice(0, 140) + (k.brief.length > 140 ? '…' : '')) : null) : k.name), h('td', { class: 'mono' }, k.prefix + '…'), h('td', null, k.role_label), h('td', null, fmtDate(k.created_at) + (k.created_by ? ' · ' + k.created_by : '')),
        h('td', null, k.last_used ? `${fmtDate(k.last_used)} · ${k.uses} запросов` : 'не использовался'), h('td', null, k.revoked ? h('span', { class: 'pill st-failed' }, 'отозван') : k.expired ? h('span', { class: 'pill st-failed' }, 'истёк') : k.expires_at ? 'до ' + fmtDate(k.expires_at) : 'бессрочно'),
        h('td', null, !k.revoked ? h('button', { class: 'btn danger sm', type: 'button', onclick: async () => { if (!confirm(`Отозвать ключ «${k.name}»? Программы с ним сразу потеряют доступ.`)) return; try { await api('/apikeys/' + k.id, { method: 'DELETE' }); v = await api('/apikeys'); drawList(); } catch (e) { msg.className = 'msg err'; msg.textContent = e2t(e); } } }, 'Отозвать') : null)))))) : h('p', { class: 'hint' }, 'Ключей пока нет.'));
    const make = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      make.disabled = true;
      try {
        const k = await api('/apikeys', { method: 'POST', body: { name: name.value.trim(), role: role.value, days: days.value } });
        put(fresh, h('div', { class: 'card form' }, h('h3', null, `Ключ «${k.name}» создан`), h('p', { class: 'msg err' }, 'Скопируйте его сейчас — второй раз он не покажется (хранится только отпечаток).'), codeBox(k.token), configs(k.token)));
        v = await api('/apikeys'); drawList(); msg.textContent = '';
      } catch (e) { msg.className = 'msg err'; msg.textContent = e2t(e); } finally { make.disabled = false; }
    } }, 'Создать ключ');
    put(el, h('div', null, h('h2', null, 'API и AI-агенты'), h('p', { class: 'sub' }, 'Подключите Antigravity, Claude или Cursor к админке: агент сможет смотреть и менять товары, цены, склады, запускать проверку карточек, переводы и сравнение цен — с правами выбранной роли.')),
      h('div', { class: 'card form' }, h('h3', null, 'Новый ключ'),
        h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'Название'), name), h('label', { class: 'field' }, h('span', null, 'Права (роль)'), role, h('small', { class: 'hint' }, 'Агенту обычно хватает «Catalog manager». Секреты, сотрудники и безопасность ключам недоступны при любой роли.'))),
        h('label', { class: 'field' }, h('span', null, 'Срок действия'), days), h('div', { class: 'row actions' }, make), msg),
      fresh,
      h('div', { class: 'card' }, h('h3', null, 'Ключи'), list),
      h('div', { class: 'card' }, h('h3', null, 'Адрес MCP'), codeBox(mcp),
        h('p', { class: 'hint' }, 'Админка доступна только с этого компьютера (или через SSH-туннель), поэтому и агент должен работать здесь же — Antigravity на вашем компьютере подходит. Каждый вызов агента записывается в журнал действий от имени ключа.'),
        h('details', null, h('summary', null, `Что умеет агент (${v.tools.length} инструментов)`), h('ul', { class: 'hint' }, v.tools.map(t => h('li', null, h('b', null, t.name), ' — ', t.description))))));
    drawList();
  }

  const prev = window.Asv.navEntries;
  window.Asv.navEntries = () => {
    const out = prev();
    if (state.gated || !can('secrets.apikeys')) return out;
    out.push({ id: 'p_apikeys', label: 'API и AI-агенты', group: 'Интеграции', render: page });
    return out;
  };
})();
