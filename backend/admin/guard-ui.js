'use strict';
/* Asveli admin — «Защита магазина»: red maintenance banner on every page + rules page. No innerHTML. */
(() => {
  const { h, api, state, loading, fail, fmtDate } = window.Asv;
  const { can, put, err } = window.Asv.ui;
  const RULES = [['price_zero', 'Цена 0 у товара в продаже'], ['price_crash', 'Резкое падение цен у нескольких товаров за 10 минут'], ['order_zero', 'Заказ на сумму 0'], ['error_spike', 'Всплеск ошибок сервера (5xx) за минуту'], ['login_attack', 'Подбор пароля в админку (только тревога)']];
  let banner = null;
  async function refreshBanner() {
    if (!state.me || state.gated) { if (banner) banner.remove(); banner = null; return; }
    let s; try { s = await api('/guard/status'); } catch { return; }
    if (!s.maintenance) { if (banner) banner.remove(); banner = null; return; }
    const lift = can('guard.write') ? h('button', { class: 'btn sm', type: 'button', onclick: async () => {
      if (!confirm('Открыть магазин снова? Убедитесь, что причина устранена (цены, ошибки).')) return;
      try { await api('/guard/maintenance', { method: 'POST', body: { on: false } }); refreshBanner(); } catch (e) { alert(err(e)); }
    } }, 'Причина устранена — открыть магазин') : null;
    const b = h('div', { class: 'guardbar', role: 'alert' }, h('b', null, '⛔ Магазин закрыт на технические работы'),
      h('span', null, `${s.by === 'auto' ? 'Автоматически' : 'Вручную (' + s.by + ')'} · ${fmtDate(s.since)} · ${s.reason || ''}`), h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { state.tab = 'p_guard'; window.Asv.renderShell(); } }, 'Подробнее'), lift);
    if (banner) banner.replaceWith(b); else document.body.prepend(b);
    banner = b;
  }
  setInterval(refreshBanner, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBanner(); });
  setTimeout(refreshBanner, 1200);

  async function page(el) {
    loading(el);
    let s; try { s = await api('/guard/status'); } catch (e) { return fail(el, e); }
    const msg = h('p', { class: 'msg', role: 'status' }), w = can('guard.write');
    const c = s.config, f = {};
    const chk = k => (f[k] = h('input', { type: 'checkbox', checked: c[k] || null, disabled: !w || null, 'aria-label': k }));
    const num = (k, min, max) => (f[k] = h('input', { class: 'input', type: 'number', min, max, value: c[k], disabled: !w || null, 'aria-label': k }));
    const save = h('button', { class: 'btn primary sm', type: 'button', onclick: async () => {
      const b = {}; for (const [k, el_] of Object.entries(f)) b[k] = el_.type === 'checkbox' ? el_.checked : Number(el_.value);
      try { s = await api('/guard/config', { method: 'PUT', body: b }); msg.className = 'msg ok'; msg.textContent = 'Сохранено.'; } catch (e) { msg.className = 'msg err'; msg.textContent = err(e); }
    } }, 'Сохранить правила');
    const toggle = h('button', { class: 'btn ' + (s.maintenance ? '' : 'danger') + ' sm', type: 'button', onclick: async () => {
      const on = !s.maintenance, reason = on ? prompt('Причина (увидят сотрудники):', 'Плановые технические работы') : null; if (on && reason === null) return;
      try { s = await api('/guard/maintenance', { method: 'POST', body: { on, reason } }); refreshBanner(); page(el); } catch (e) { msg.className = 'msg err'; msg.textContent = err(e); }
    } }, s.maintenance ? 'Открыть магазин' : 'Закрыть магазин на техработы сейчас');
    put(el, h('div', null, h('h2', null, 'Защита магазина'), h('p', { class: 'sub' }, 'Сервер каждую минуту проверяет, не случилось ли что-то опасное: цены упали до нуля, заказ на 0, всплеск ошибок. Если да — магазин сам закрывается на «технические работы», а здесь появляется тревога.')),
      h('div', { class: 'card' }, h('h3', null, s.maintenance ? '⛔ Сейчас магазин закрыт' : '✓ Магазин работает'),
        s.maintenance ? h('p', null, `${s.reason} · с ${fmtDate(s.since)} · ${s.by === 'auto' ? 'автоматически' : s.by}`) : s.last ? h('p', { class: 'hint' }, `Последнее закрытие: ${s.last.reason} (${fmtDate(s.last.since)}), открыл ${s.lifted_by} ${fmtDate(s.lifted_at)}`) : null,
        s.shopify_flag ? h('p', { class: 'hint' }, 'Сайт на Shopify: ' + (s.shopify_flag === 'ok' ? 'тема получила сигнал и показывает страницу техработ ✓' : s.shopify_flag === 'not_connected' ? 'Shopify не подключён — закройте магазин паролем в Shopify вручную при необходимости.' : 'сигнал не дошёл (' + s.shopify_flag + ').')) : null,
        h('p', { class: 'hint' }, 'Во время техработ: ваш магазин (asveli-shop) показывает страницу «технические работы», товары не отправляются в Shopify, ничего не продаётся по ошибочным ценам. Открывает магазин только человек.'),
        w ? h('div', { class: 'row' }, toggle) : null),
      h('div', { class: 'card form' }, h('h3', null, 'Правила'),
        h('label', { class: 'field row' }, chk('auto_maintenance'), h('span', null, h('b', null, 'Закрывать магазин автоматически'), ' при любом из включённых правил')),
        RULES.map(([k, t]) => h('label', { class: 'field row' }, chk(k), h('span', null, t))),
        h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'Падение цены считается резким от, %'), num('crash_pct', 10, 95)), h('label', { class: 'field' }, h('span', null, '…если товаров с таким падением не меньше'), num('crash_count', 1, 1000))),
        h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'Ошибок сервера в минуту'), num('error_count', 5, 10000)), h('label', { class: 'field' }, h('span', null, 'Неудачных входов за 10 минут'), num('login_count', 5, 10000))),
        h('label', { class: 'field' }, h('span', null, 'Ручное снижение цены больше чем на, % — требует подтверждения'), num('edit_drop_pct', 10, 99)),
        w ? h('div', { class: 'row' }, save) : null, msg),
      h('div', { class: 'card' }, h('h3', null, 'Инциденты'), s.incidents.length ? h('ul', null, s.incidents.map(i => h('li', null, `${fmtDate(i.created_at)} — ${i.title}${i.detail ? ' (' + i.detail + ')' : ''}`))) : h('p', { class: 'hint' }, 'Инцидентов не было.')));
  }

  const prev = window.Asv.navEntries;
  window.Asv.navEntries = () => {
    const out = prev();
    if (state.gated) return out;
    const i = out.findIndex(e => e.group === 'Безопасность');
    const entry = { id: 'p_guard', label: 'Защита магазина', group: 'Безопасность', render: page };
    if (i < 0) out.push(entry); else out.splice(i, 0, entry);
    return out;
  };
})();
