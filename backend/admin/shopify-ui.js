'use strict';
/* Asveli admin — Shopify page: connection, two-way product sync, conflicts, errors, log. Plus a Shopify line in every product panel.
   Same rules as the rest of the admin: no innerHTML, no inline styles in markup, strict CSP. Secrets are typed in, never shown back. */
(() => {
  const { h, api, state, fmtDate, loading, fail, renderShell } = window.Asv;
  const { can, money, put, err, kpi } = window.Asv.ui;

  const CODES = {
    shopify_not_configured: 'Shopify не подключён: заполните магазин и ключ ниже.', invalid_shop_domain: 'Адрес магазина: только вида имя.myshopify.com.',
    shopify_auth_failed: 'Shopify не принял ключ (проверьте токен или Client ID / Secret).', shopify_token_failed: 'Не удалось получить токен у Shopify.',
    shopify_forbidden: 'У приложения нет доступа к этому магазину.', shopify_scope_missing: 'У приложения не хватает прав (scopes). Добавьте их в настройках приложения и переустановите его.',
    shopify_unreachable: 'Shopify недоступен (нет сети?).', shopify_timeout: 'Shopify не ответил вовремя.', shopify_not_found: 'Магазин или версия API не найдены.',
    shopify_rejected: 'Shopify отклонил изменение', shopify_graphql_error: 'Ошибка Shopify API', shopify_currency_rate_required: 'Валюта магазина отличается от валюты админки: укажите курс в настройках.',
    shopify_sync_running: 'Синхронизация уже идёт, подождите.', shopify_stock_changed: 'Остаток в Shopify изменился во время записи — будет сверен при следующем запуске.',
    invalid_rate: 'Курс: число больше нуля, например 4.25.', invalid_client_id: 'Client ID: 16–64 латинских букв и цифр.', invalid_token: 'Токен выглядит неверно.', invalid_client_secret: 'Client secret выглядит неверно.',
    invalid_location: 'Выберите склад Shopify из списка.', invalid_warehouse: 'Нет такого склада.', invalid_seller: 'Нет такого продавца.', confirm_required: 'Нужно подтверждение.',
    not_linked: 'Товар ещё не связан с Shopify.', compliance_block: 'Комплаенс-правила запрещают публикацию этого товара.', duplicate: 'Такой SKU уже есть.'
  };
  const e2t = e => (CODES[e.message] ? CODES[e.message] + (e.detail ? ': ' + e.detail : '') : err(e));
  const toast = (text, bad) => { const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, text); document.body.append(t); setTimeout(() => t.remove(), 4200); };
  const post = (path, body) => api(path, { method: 'POST', body: body || {} });
  const STATE = { ok: ['синхронизирован', 'st-approved'], conflict: ['конфликт', 'st-held'], error: ['ошибка', 'st-failed'], not_linked: ['ещё не в Shopify', ''] };
  const FIELD = { title: 'Название', description: 'Описание', vendor: 'Бренд', category: 'Категория', price: 'Цена', sku: 'SKU', barcode: 'Штрихкод', weight: 'Вес', status: 'Статус', images: 'Фото', seo: 'SEO-описание' };
  const pill = st => h('span', { class: 'pill ' + (STATE[st] || ['', ''])[1] }, (STATE[st] || [st])[0]);
  const adminUrl = (domain, legacy) => `https://admin.shopify.com/store/${String(domain).replace(/\.myshopify\.com$/, '')}/products/${legacy}`;
  const showVal = (k, v) => (k === 'price' && typeof v === 'number' ? money(v) : v == null || v === '' ? '—' : String(v));
  const tallyText = r => [`создано в Shopify: ${r.created}`, `импортировано: ${r.imported}`, r.linked ? `связано по SKU: ${r.linked}` : null, `отправлено: ${r.pushed}`, `получено: ${r.pulled}`,
    r.gone ? `удалено в Shopify: ${r.gone}` : null, r.conflicts ? `конфликтов: ${r.conflicts}` : null, r.errors ? `ошибок: ${r.errors}` : null, r.needs_seller ? `ждут продавца: ${r.needs_seller}` : null].filter(Boolean).join(' · ');

  // shared by the page and the product panel
  async function runOne(id, prefer, after) {
    try { const r = await post(`/shopify/product/${id}/sync`, prefer ? { prefer } : {}); toast(r.action === 'conflict' ? 'Есть конфликт — выберите версию' : r.action === 'unchanged' ? 'Изменений нет' : 'Синхронизировано'); after && after(r); }
    catch (e) { toast(e2t(e), true); after && after(null); }
  }
  async function removeIn(id, title, after) {
    const typed = prompt(`Удалить «${title}» из Shopify НАВСЕГДА? Здесь товар останется. Это нельзя отменить.\nНапишите DELETE, чтобы подтвердить.`);
    if (typed !== 'DELETE') return;
    try { await post(`/shopify/product/${id}/delete`, { confirm: 'DELETE' }); toast('Удалён из Shopify'); after && after(); } catch (e) { toast(e2t(e), true); }
  }

  /* ================================================================== PAGE */
  async function pageShopify(el) {
    loading(el);
    const canRun = can('shopify.write'), canSecrets = can('secrets.shopify'), canDel = can('shopify.delete');
    const st = { tab: 'conflict', q: '', page: 1 };
    const head = h('div'), stats = h('div', { class: 'grid kpis' }), runMsg = h('p', { class: 'msg', role: 'status' }), runBar = h('div', { class: 'toolbar' });
    const tabs = h('div', { class: 'chips', role: 'tablist' }), list = h('div', { class: 'card tablewrap' }), pager = h('div', { class: 'toolbar' }), logBox = h('div', { class: 'card tablewrap' });
    const settingsBox = h('div');
    let ov = null, domain = '';

    async function refresh() {
      ov = await api('/shopify/overview'); domain = ov.domain;
      put(head, h('div', { class: 'pagehead' }, h('div', null, h('h2', null, 'Shopify'),
        h('p', { class: 'sub' }, ov.enabled ? `Подключён магазин ${ov.domain}. ${ov.autoPush ? 'Изменения отсюда уходят в Shopify сразу.' : 'Автоотправка выключена.'} ${ov.pollMinutes ? `Изменения из Shopify забираются каждые ${ov.pollMinutes} мин.` : 'Из Shopify — только по кнопке.'}` : 'Магазин ещё не подключён — настройки внизу страницы.'))));
      put(stats, kpi(ov.products, 'товаров здесь'), kpi(ov.linked, 'связано с Shopify'), kpi(ov.not_linked, 'ещё не отправлено'), kpi(ov.conflicts, 'конфликтов', ov.conflicts ? 'нужно выбрать версию' : null), kpi(ov.errors, 'с ошибкой'));
      const btn = (label, mode, cls) => h('button', { class: 'btn ' + (cls || 'ghost') + ' sm', type: 'button', disabled: !ov.enabled || null, onclick: e => runAll(mode, e.target) }, label);
      put(runBar, canRun ? [btn('Синхронизировать сейчас', 'incremental', 'primary'), btn('Полная сверка', 'full'), btn('Только отправить в Shopify', 'push'), btn('Только забрать из Shopify', 'pull')] : null,
        ov.running ? h('span', { class: 'hint' }, 'идёт синхронизация…') : ov.state && ov.state.last_run ? h('span', { class: 'hint' }, 'последний запуск: ' + fmtDate(ov.state.last_run)) : null);
      drawTabs();
      put(logBox, ov.log.length ? h('table', null, h('thead', null, h('tr', null, ['Когда', 'Тип', 'Кто', 'Итог', 'Заметка'].map(t => h('th', null, t)))),
        h('tbody', null, ov.log.map(l => h('tr', null, h('td', { class: 'dim' }, fmtDate(l.ts)), h('td', null, { full: 'полная', incremental: 'обычная', push: 'отправка', pull: 'загрузка' }[l.kind] || l.kind), h('td', null, l.by),
          h('td', null, tallyText(l)), h('td', { class: l.ok ? 'dim' : 'warn' }, l.note || ''))))) : h('p', { class: 'empty' }, 'Синхронизаций ещё не было.'));
    }
    async function runAll(mode, b) {
      b.disabled = true; runMsg.className = 'msg'; runMsg.textContent = 'Синхронизация… Для большого каталога это может занять несколько минут.';
      try { const r = await post('/shopify/sync', { mode }); runMsg.className = 'msg ' + (r.errors ? 'err' : 'ok'); runMsg.textContent = 'Готово: ' + (tallyText(r) || 'изменений нет') + (r.errors_list && r.errors_list[0] ? ` — первая ошибка: ${e2t({ message: r.errors_list[0].error, detail: r.errors_list[0].detail })}` : ''); }
      catch (e) { runMsg.className = 'msg err'; runMsg.textContent = e2t(e); }
      finally { b.disabled = false; await refresh(); await load(); }
    }
    function drawTabs() {
      const T = { conflict: `Конфликты${ov && ov.conflicts ? ' (' + ov.conflicts + ')' : ''}`, error: `Ошибки${ov && ov.errors ? ' (' + ov.errors + ')' : ''}`, ok: 'Синхронизированы', not_linked: 'Ещё не в Shopify' };
      put(tabs, Object.entries(T).map(([k, l]) => h('button', { type: 'button', role: 'tab', class: 'chip', 'aria-selected': k === st.tab ? 'true' : 'false', onclick: () => { st.tab = k; st.page = 1; drawTabs(); load(); } }, l)));
    }
    function actions(r) {
      const after = () => { refresh(); load(); };
      const b = (label, fn, cls) => h('button', { class: 'btn ' + (cls || 'ghost') + ' sm', type: 'button', onclick: fn }, label);
      return h('div', { class: 'toolbar' },
        canRun && r.state === 'conflict' ? [b('Оставить версию админки', () => runOne(r.product_id, 'local', after), 'primary'), b('Взять из Shopify', () => runOne(r.product_id, 'shop', after))] : null,
        canRun && r.state !== 'conflict' ? b(r.state === 'not_linked' ? 'Отправить в Shopify' : 'Синхронизировать', () => runOne(r.product_id, null, after)) : null,
        r.legacy_id && domain ? h('a', { class: 'btn ghost sm', href: adminUrl(domain, r.legacy_id), target: '_blank', rel: 'noopener noreferrer' }, 'Открыть в Shopify ↗') : null,
        canRun && r.shopify_id ? b('Отвязать', async () => { if (!confirm('Отвязать товар от Shopify? Оба товара останутся, но синхронизироваться не будут. При следующем запуске он свяжется снова по SKU.')) return; try { await post(`/shopify/product/${r.product_id}/unlink`); after(); } catch (e) { toast(e2t(e), true); } }) : null,
        canDel && r.shopify_id ? b('Удалить в Shopify', () => removeIn(r.product_id, r.title, after), 'danger') : null);
    }
    async function load() {
      const qs = new URLSearchParams({ state: st.tab, page: st.page, limit: 25 }); if (st.q) qs.set('q', st.q);
      try {
        const d = await api('/shopify/links?' + qs);
        if (!d.rows.length) put(list, h('p', { class: 'empty' }, { conflict: 'Конфликтов нет.', error: 'Ошибок нет.', ok: 'Пока ничего не связано.', not_linked: 'Все товары уже в Shopify.' }[st.tab]));
        else put(list, h('table', { class: 'shoptable' }, h('thead', null, h('tr', null, ['Товар', 'Цена', 'Состояние', 'Что не так', ''].map(t => h('th', null, t)))),
          h('tbody', null, d.rows.map(r => h('tr', null,
            h('td', { class: 'name' }, h('b', null, r.title), h('small', null, `#${r.product_id} · ${r.sku}${r.multi ? ' · несколько вариантов (цены и остатки ведутся в Shopify)' : ''}`)),
            h('td', { class: 'num' }, money(r.price)), h('td', null, pill(r.state), r.synced_at ? h('small', { class: 'dim' }, ' ' + fmtDate(r.synced_at)) : null),
            h('td', { class: 'why' }, r.conflict ? h('ul', { class: 'hint' }, Object.entries(r.conflict).map(([k, v]) => h('li', null, h('b', null, (FIELD[k] || k) + ': '), 'здесь «' + showVal(k, v.here) + '», в Shopify «' + showVal(k, v.shopify) + '»'))) : r.last_error ? h('span', { class: 'warn' }, r.last_error) : ''),
            h('td', { class: 'acts' }, actions(r)))))));
        const pages = Math.ceil(d.total / 25);
        put(pager, h('span', { class: 'sub' }, `Всего: ${d.total}`), h('span', { class: 'grow' }),
          st.page > 1 ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { st.page--; load(); } }, '← Назад') : null,
          st.page < pages ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { st.page++; load(); } }, 'Вперёд →') : null);
      } catch (e) { put(list, h('p', { class: 'msg err' }, e2t(e))); }
    }

    try {
      await refresh();
      const q = h('input', { type: 'search', placeholder: 'Название или SKU', 'aria-label': 'Поиск' });
      q.addEventListener('keydown', e => { if (e.key === 'Enter') { st.q = q.value.trim(); st.page = 1; load(); } });
      if (ov.conflicts === 0) st.tab = ov.errors ? 'error' : ov.linked ? 'ok' : 'not_linked';
      drawTabs();
      put(el, head, stats, h('div', { class: 'card' }, h('h3', null, 'Синхронизация'), runBar, runMsg,
        h('p', { class: 'hint' }, 'Правило: в Shopify живыми (Active) становятся только одобренные и проверенные человеком товары. Снятые с продажи — Archived, остальные — Draft. Если одно и то же поле изменили и здесь, и в Shopify, ничего не перезаписывается — товар попадает в «Конфликты».')),
        h('div', { class: 'toolbar' }, q, tabs), list, pager,
        canSecrets ? settingsBox : null,
        h('h3', null, 'Журнал синхронизаций'), logBox);
      load();
      if (canSecrets) drawSettings(settingsBox, () => { refresh(); load(); });
    } catch (e) { fail(el, e); }
  }

  /* ---------------------------------------------------------------- settings (owner) */
  async function drawSettings(box, changed) {
    let v = await api('/shopify/settings'), shop = null;
    const inp = (type, attrs = {}) => h('input', { type, class: 'input', autocomplete: 'off', spellcheck: 'false', ...attrs });
    const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
    const domain = inp('text', { placeholder: 'asveli.myshopify.com', 'aria-label': 'Магазин' });
    const mode = h('select', { class: 'input', 'aria-label': 'Способ входа' }, h('option', { value: 'client' }, 'Приложение из Dev Dashboard (Client ID + Secret)'), h('option', { value: 'token' }, 'Токен Admin API (shpat_…)'));
    const token = inp('password', { autocomplete: 'new-password', placeholder: 'shpat_…', 'aria-label': 'Токен' });
    const cid = inp('text', { placeholder: 'Client ID', 'aria-label': 'Client ID' }), csec = inp('password', { autocomplete: 'new-password', placeholder: 'Client secret', 'aria-label': 'Client secret' });
    const ver = inp('text', { placeholder: v.default_version, 'aria-label': 'Версия API' });
    const loc = h('select', { class: 'input', 'aria-label': 'Склад Shopify' }), wh = h('select', { class: 'input', 'aria-label': 'Наш склад' }), sel = h('select', { class: 'input', 'aria-label': 'Продавец для импорта' });
    const rate = inp('text', { placeholder: 'например 4.25', 'aria-label': 'Курс' }), rateWrap = h('div');
    const auto = inp('checkbox', { 'aria-label': 'Автоотправка' }), trs = inp('checkbox', { 'aria-label': 'Переводы' }), poll = inp('number', { min: 0, max: 1440, step: 1, 'aria-label': 'Интервал' });
    const tokState = h('p', { class: 'hint' }), msg = h('p', { class: 'msg', role: 'status' }), testOut = h('div', { class: 'card', hidden: true });
    const tokRow = h('div'), cliRow = h('div');
    const say = (t, bad) => { msg.className = 'msg ' + (bad ? 'err' : 'ok'); msg.textContent = t; };
    const opts = async (path, cur, empty) => { try { const { rows } = await api(path); return [h('option', { value: '' }, empty), ...rows.map(r => h('option', { value: r.id, selected: String(r.id) === String(cur) || null }, r.label))]; } catch { return [h('option', { value: '' }, empty)]; } };
    const fill = async () => {
      domain.value = v.domain || ''; mode.value = v.authMode; ver.value = v.apiVersion === v.default_version ? '' : v.apiVersion; cid.value = v.clientId || ''; token.value = ''; csec.value = '';
      rate.value = v.rate || ''; auto.checked = v.autoPush; trs.checked = v.translations; poll.value = v.pollMinutes;
      tokRow.hidden = mode.value !== 'token'; cliRow.hidden = mode.value !== 'client';
      tokState.textContent = (mode.value === 'token' ? (v.token_hint ? `Токен сохранён: ${v.token_hint}.` : 'Токен не задан.') : (v.secret_hint ? `Secret сохранён: ${v.secret_hint}.` : 'Secret не задан.')) + ' Секреты не показываются и не отправляются обратно в браузер; оставьте поле пустым, чтобы не менять.';
      put(wh, await opts('/m/warehouses/options', v.warehouseId, 'все склады (сумма)'));
      put(sel, await opts('/m/sellers/options', v.importSellerId, '— не импортировать —'));
      put(loc, h('option', { value: '' }, v.locationId ? v.locationId : 'нажмите «Проверить подключение»'), ...(shop ? shop.locations.map(l => h('option', { value: l.id, selected: l.id === v.locationId || null }, l.name)) : []));
      if (shop) loc.value = v.locationId || '';
      rateWrap.hidden = !(shop && shop.currency !== v.platform_currency) && !v.rate;
    };
    mode.addEventListener('change', () => { tokRow.hidden = mode.value !== 'token'; cliRow.hidden = mode.value !== 'client'; });
    const body = () => {
      const b = { domain: domain.value.trim(), authMode: mode.value, apiVersion: ver.value.trim(), clientId: cid.value.trim(), warehouseId: wh.value || null, importSellerId: sel.value || null,
        rate: rate.value.trim(), autoPush: auto.checked, translations: trs.checked, pollMinutes: Number(poll.value) };
      if (loc.value && /^gid:/.test(loc.value)) b.locationId = loc.value;
      if (token.value) b.token = token.value.trim(); if (csec.value) b.clientSecret = csec.value.trim();
      return b;
    };
    const save = h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { v = await api('/shopify/settings', { method: 'PUT', body: body() }); await fill(); say('Сохранено. Действует сразу.'); changed(); } catch (e) { say(e2t(e), true); } } }, 'Сохранить');
    const test = h('button', { class: 'btn', type: 'button', onclick: async () => {
      test.disabled = true; say('Проверяю…');
      try {
        if (token.value || csec.value || domain.value.trim() !== (v.domain || '')) v = await api('/shopify/settings', { method: 'PUT', body: body() });
        const r = await post('/shopify/test'); shop = r.shop; await fill();
        testOut.hidden = false;
        put(testOut, h('h3', null, '✓ Подключение работает'), h('dl', { class: 'kv' },
          h('dt', null, 'Магазин'), h('dd', null, `${r.shop.name} (${r.shop.domain})`), h('dt', null, 'Валюта магазина'), h('dd', null, r.shop.currency + (r.currency_match ? ' — совпадает с админкой' : ` — в админке ${r.platform_currency}: нужен курс`)),
          h('dt', null, 'Склады Shopify'), h('dd', null, r.shop.locations.map(l => l.name).join(', ') || '—'), h('dt', null, 'Языки'), h('dd', null, r.shop.locales.filter(l => l.published).map(l => l.locale).join(', ')),
          h('dt', null, 'Ответ за'), h('dd', null, r.ms + ' мс')),
          !r.location_ok ? h('p', { class: 'warn' }, 'Выберите склад Shopify ниже и нажмите «Сохранить» — без него остатки не отправляются.') : null);
        say(r.rate_needed ? 'Подключено. Укажите курс валют и сохраните.' : 'Подключено.', r.rate_needed);
      } catch (e) { testOut.hidden = true; say(e2t(e), true); } finally { test.disabled = false; } } }, 'Проверить подключение');
    const del = h('button', { class: 'btn danger sm', type: 'button', onclick: async () => { if (!confirm('Удалить сохранённые ключи Shopify? Синхронизация остановится.')) return; try { v = await api('/shopify/settings/secrets', { method: 'DELETE' }); await fill(); say('Ключи удалены.'); changed(); } catch (e) { say(e2t(e), true); } } }, 'Удалить ключи');

    put(tokRow, field('Токен Admin API', token, 'Только для старых приложений, созданных в админке Shopify до 2026 года.'));
    put(cliRow, h('div', { class: 'two' }, field('Client ID', cid), field('Client secret', csec)));
    put(rateWrap, field(`Курс: 1 ${v.platform_currency} = ? в валюте магазина`, rate, 'Цены здесь в одной валюте, в Shopify — в валюте магазина. Пересчёт в обе стороны по этому курсу.'));
    put(box, h('div', { class: 'card form' }, h('h3', null, 'Подключение магазина (видно только владельцу)'),
        h('div', { class: 'two' }, field('Магазин', domain, 'Адрес вида имя.myshopify.com (в админке Shopify: Настройки → Домены).'), field('Способ входа', mode)),
        tokRow, cliRow, tokState, h('div', { class: 'row' }, del),
        h('details', null, h('summary', null, 'Как получить Client ID и Secret (5 минут)'), h('ol', { class: 'hint' },
          h('li', null, 'Откройте dev.shopify.com → Apps → Create app (тот же аккаунт, что владеет магазином).'),
          h('li', null, 'Во вкладке Versions выберите доступы (scopes): read_products, write_products, read_inventory, write_inventory, read_locations, read_translations, write_translations, read_locales. Выпустите версию (Release).'),
          h('li', null, 'Home → Install app → выберите свой магазин и подтвердите доступы.'),
          h('li', null, 'Settings → скопируйте Client ID и Client secret сюда, нажмите «Проверить подключение».'))),
        field('Версия API (необязательно)', ver, 'Пусто — ' + v.default_version + '.')),
      h('div', { class: 'card form' }, h('h3', null, 'Как синхронизировать'),
        h('div', { class: 'two' }, field('Склад Shopify для остатков', loc), field('Наш склад, чьи остатки отправлять', wh)),
        field('Продавец для товаров, созданных в Shopify', sel, 'Товары, которых здесь ещё нет, импортируются под этим продавцом. Пусто — не импортировать.'),
        rateWrap,
        h('div', { class: 'two' }, field('Забирать изменения из Shopify каждые, мин (0 — только по кнопке)', poll),
          h('div', { class: 'col' }, h('label', { class: 'field row' }, auto, h('span', null, 'Сразу отправлять изменения отсюда в Shopify')),
            h('label', { class: 'field row' }, trs, h('span', null, 'Отправлять проверенные переводы (pl, ru, de)'))))),
      h('div', { class: 'row actions' }, save, test), msg, testOut);
    await fill();
  }

  /* ---------------------------------------------------------------- Shopify line inside a product panel (catalogue page) */
  async function productLine(p, holder) {
    if (!can('shopify.read')) return;
    try {
      const s = await api('/shopify/product/' + p.id);
      const after = () => productLine(p, holder);
      const b = (label, fn, cls) => h('button', { class: 'btn ' + (cls || 'ghost') + ' sm', type: 'button', onclick: fn }, label);
      put(holder, h('span', { class: 'hint' }, 'Shopify: '), s.linked ? pill(s.state) : pill('not_linked'),
        s.state === 'error' && s.last_error ? h('span', { class: 'warn' }, ' ' + s.last_error) : null,
        s.state === 'conflict' && s.conflict ? h('span', { class: 'hint' }, ' ' + Object.keys(s.conflict).map(k => FIELD[k] || k).join(', ')) : null,
        can('shopify.write') ? (s.state === 'conflict' ? [b('Оставить версию админки', () => runOne(p.id, 'local', after), 'primary'), b('Взять из Shopify', () => runOne(p.id, 'shop', after))] : b(s.linked ? 'Синхронизировать' : 'Отправить в Shopify', () => runOne(p.id, null, after))) : null,
        s.linked && s.domain ? h('a', { class: 'btn ghost sm', href: adminUrl(s.domain, s.legacy_id), target: '_blank', rel: 'noopener noreferrer' }, 'Открыть в Shopify ↗') : null);
    } catch { holder.replaceChildren(); }
  }
  window.Asv.shopify = { productLine };

  /* ---------------------------------------------------------------- navigation: Интеграции → Shopify */
  const prev = window.Asv.navEntries;
  window.Asv.navEntries = () => {
    const out = prev();
    if (state.gated || !(can('shopify.read') || can('secrets.shopify'))) return out;
    const i = out.findIndex(e => e.group === 'Интеграции');
    const entry = { id: 'p_shopify', label: 'Shopify', group: 'Интеграции', render: pageShopify };
    if (i < 0) out.push(entry); else out.splice(i, 0, entry);
    return out;
  };
  void renderShell;
})();
