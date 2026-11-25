'use strict';
/* Asveli admin — operator console pages: dashboard, SKU catalogue, Fast Audit, AI Studio, canvas, search, import, robots, monitor, function map.
   Same rules as the rest of the admin: no innerHTML, no inline styles in markup (positions are set through CSSOM), strict CSP. */
(() => {
  const { h, api, state, fmtDate, loading, fail, renderShell } = window.Asv;
  const { can, money, put, modal, err, meta, runAction, openDetail, resourceView, EXTRA, kpi, barList, table, refSelect } = window.Asv.ui;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v); el.append(...kids.flat().filter(Boolean)); return el; };
  const go = id => { state.tab = id; renderShell(); };
  const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  const host = u => { try { return new URL(u).host; } catch { return u; } };
  const pct = (a, b) => (b ? Math.round(a * 100 / b) : 0);
  const num = n => Number(n || 0).toLocaleString('ru-RU');
  const toast = (text, bad) => { const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, text); document.body.append(t); setTimeout(() => t.remove(), 3200); };
  const post = (path, body) => api(path, { method: 'POST', body: body || {} });
  const act = (id, k, body) => post(`/m/products/${id}/do/${k}`, body);
  const tone = c => (c == null ? 'none' : c >= 85 ? 'ok' : c >= 70 ? 'mid' : 'low');

  /* ---------- small building blocks ---------- */
  // purchase price → markup → price the buyer pays; editable right here (price follows cost + markup when "считать из наценки" is on)
  function priceBox(p) {
    const box = h('div', { class: 'pricebox' });
    const draw = () => {
      const rows = [['Поставщик', p.supplier_name ? (p.supplier_url ? h('a', { href: p.supplier_url, target: '_blank', rel: 'noopener noreferrer' }, p.supplier_name + ' ↗') : p.supplier_name) : '—'],
        ['Закупочная цена', p.cost != null ? money(p.cost) : '—'], ['Наценка', p.markup_actual_pct != null ? p.markup_actual_pct + '%' + (p.price_from_markup ? ' (цена считается из наценки ' + p.markup_pct + '%)' : '') : '—'],
        ['Итоговая цена', h('b', null, money(p.price))], ['Прибыль с единицы', p.profit != null ? money(p.profit) + (p.margin_pct != null ? ` · маржа ${p.margin_pct}%` : '') : '—']];
      const edit = can('products.write') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: form }, 'Изменить закупку / наценку') : null;
      put(box, h('h4', null, 'Цена и наценка'), h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])), edit);
    };
    const form = () => {
      const f = (label, el) => h('label', { class: 'field' }, h('span', null, label), el);
      const sup = h('input', { type: 'text', maxlength: 120, value: p.supplier_name || '' }), url = h('input', { type: 'url', maxlength: 300, value: p.supplier_url || '', placeholder: 'https://…' });
      const cost = h('input', { type: 'text', inputmode: 'decimal', value: p.cost != null ? (p.cost / 100).toFixed(2) : '', placeholder: '0.00' });
      const mk = h('input', { type: 'number', min: 0, max: 5000, value: p.markup_pct != null ? p.markup_pct : (p.markup_actual_pct != null ? Math.round(p.markup_actual_pct) : 30) });
      const auto = h('input', { type: 'checkbox', checked: p.price_from_markup || null });
      const out = h('p', { class: 'hint' }), msg = h('p', { class: 'msg', role: 'status' });
      const calc = () => { const c = Math.round(parseFloat(cost.value.replace(',', '.')) * 100); out.textContent = Number.isFinite(c) && mk.value !== '' ? `Итоговая цена будет: ${money(Math.round(c * (100 + Number(mk.value)) / 100))} (прибыль ${money(Math.round(c * Number(mk.value) / 100))})` : ''; };
      cost.addEventListener('input', calc); mk.addEventListener('input', calc); calc();
      const save = h('button', { class: 'btn primary sm', type: 'button', onclick: async () => {
        const c = cost.value.trim() === '' ? null : Math.round(parseFloat(cost.value.replace(',', '.')) * 100);
        if (c != null && !Number.isFinite(c)) { msg.className = 'msg err'; msg.textContent = 'Закупочная цена — число, например 12.50'; return; }
        try {
          const r = await api(`/m/products/${p.id}`, { method: 'PATCH', body: { supplier_name: sup.value.trim() || null, supplier_url: url.value.trim() || null, cost: c, markup_pct: mk.value === '' ? null : Number(mk.value), price_from_markup: auto.checked } });
          Object.assign(p, r); draw(); toast('Сохранено');
        } catch (e) { msg.className = 'msg err'; msg.textContent = err(e); }
      } }, 'Сохранить');
      put(box, h('h4', null, 'Цена и наценка'), f('Поставщик', sup), f('Ссылка у поставщика', url), h('div', { class: 'two' }, f('Закупочная цена', cost), f('Наценка, %', mk)),
        h('label', { class: 'field row' }, auto, h('span', null, 'Итоговую цену считать из закупки + наценки')), out, msg,
        h('div', { class: 'toolbar' }, save, h('button', { class: 'btn ghost sm', type: 'button', onclick: draw }, 'Отмена')));
    };
    draw(); return box;
  }
  // last AI analysis of a product: texts + suggested price with what it is based on; each part can be applied separately
  function analysisView(p, slot, done) {
    let a; try { a = JSON.parse(p.ai_analysis); } catch { return; }
    const pr = a.price || {}, b = pr.basis || {};
    const apply = parts => async () => { try { done(await act(p.id, 'ai_apply', { parts })); toast('Применено. Описание ушло на проверку.'); } catch (e) { toast(err(e), true); } };
    const can_ = can('ai.review');
    const FL = { raised_to_floor: 'цена поднята до минимума (закупка + 10%)', far_above_competitors: 'заметно дороже конкурентов', no_price_suggestion: 'модель не предложила цену' };
    put(slot, h('div', { class: 'anabox' },
      h('h4', null, 'AI-анализ' + (a.mock ? ' (демо)' : '') + (a.at ? ' · ' + fmtDate(a.at) : '')),
      h('div', null, h('b', null, 'Описание'), h('p', null, a.description || '—'), can_ && a.description ? h('button', { class: 'btn ghost sm', type: 'button', onclick: apply('description') }, 'Применить описание') : null),
      a.bullets && a.bullets.length ? h('ul', null, a.bullets.map(x => h('li', null, x))) : null,
      h('div', null, h('b', null, 'История товара'), h('p', null, a.story || '—'), can_ && a.story ? h('button', { class: 'btn ghost sm', type: 'button', onclick: apply('story') }, 'Применить историю') : null),
      h('div', null, h('b', null, 'Рекомендуемая цена: '), h('b', null, money(pr.suggested)), ` (сейчас ${money(pr.current)})`,
        h('p', { class: 'hint' }, [pr.reasoning, b.cost != null ? 'закупка ' + money(b.cost) : null, b.competitor_median != null ? `медиана конкурентов ${money(b.competitor_median)} (${b.offers_used} проверенных)` : 'проверенных цен конкурентов нет', ...(a.flags || []).map(f => FL[f] || f)].filter(Boolean).join(' · ')),
        can_ && pr.suggested && pr.suggested !== pr.current ? h('button', { class: 'btn ghost sm', type: 'button', onclick: apply('price') }, 'Поставить эту цену') : null),
      can_ ? h('div', { class: 'toolbar' }, h('button', { class: 'btn sm', type: 'button', onclick: apply('description,story,price') }, 'Применить всё')) : null));
  }
  function offersView(r, slot) {
    const POS = { cheaper: 'мы дешевле рынка', pricier: 'мы дороже рынка', same: 'на уровне рынка' };
    if (r.mock) return put(slot, h('p', { class: 'msg' }, 'Демо-режим: поиск в интернете не выполняется. Подключите Google Gemini, OpenRouter или OpenAI в «Подключения AI».'));
    put(slot, h('div', { class: 'anabox' },
      h('h4', null, `Конкуренты: найдено ${r.offers.length}, проверено источником ${r.offers.filter(o => o.verified).length}`),
      r.median != null ? h('p', null, `Минимум ${money(r.min)} · медиана ${money(r.median)} · наша цена ${money(r.product.price)} — ${POS[r.position]}${r.diff_pct != null ? ` (${r.diff_pct > 0 ? '+' : ''}${r.diff_pct}%)` : ''}`) : h('p', { class: 'hint' }, `Нет проверенных предложений этого же товара в ${r.currency} — сравнивать не с чем.`),
      r.offers.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'offers' }, h('thead', null, h('tr', null, ['Площадка', 'Предложение', 'Цена', 'Совпадение', 'Источник'].map(t => h('th', null, t)))),
        h('tbody', null, r.offers.map(o => h('tr', null, h('td', null, o.platform), h('td', null, o.title || '—', o.seller ? h('small', { class: 'sup' }, o.seller) : null),
          h('td', { class: 'num' }, (o.price / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ' + o.currency),
          h('td', null, o.match === 'exact' ? 'тот же товар' : 'похожий'),
          h('td', { class: 'url' }, h('a', { href: o.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, o.verified ? '✓ ' + host(o.url) : '? ' + host(o.url)))))))) : null,
      h('p', { class: 'hint' }, '✓ — сайт подтверждён самим поиском провайдера; ? — модель указала ссылку, но поиск её не подтвердил: проверьте вручную. В репрайсер попадают только ✓ и «тот же товар».')));
  }
  function thumb(p) {
    const el = h('div', { class: 'thumb', 'aria-hidden': 'true' }, (p.title || '?').trim().slice(0, 2));
    el.style.background = `linear-gradient(135deg, hsl(${(p.id * 47) % 360} 55% 24%), hsl(${(p.id * 47 + 50) % 360} 60% 38%))`; return el;
  }
  function ring(conf) {
    const r = 17, c = 2 * Math.PI * r, t = tone(conf);
    return h('span', { class: 'ring ' + t, title: conf == null ? 'Карточки ещё нет' : `Уверенность AI: ${conf}%` },
      svg('svg', { viewBox: '0 0 44 44', width: 40, height: 40, role: 'img', 'aria-label': conf == null ? 'нет карточки' : conf + ' процентов' },
        svg('circle', { cx: 22, cy: 22, r, fill: 'none', class: 'trk', 'stroke-width': 4 }),
        conf == null ? null : svg('circle', { cx: 22, cy: 22, r, fill: 'none', class: 'val', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-dasharray': `${c * conf / 100} ${c}`, transform: 'rotate(-90 22 22)' })),
      h('b', null, conf == null ? '–' : conf));
  }
  const verifiedMark = p => (p.human_verified ? h('span', { class: 'vmark yes', title: 'Проверено: ' + (p.verified_by || '') }, '✓ проверено')
    : p.ai_status === 'generated' ? h('span', { class: 'vmark wait' }, 'ждёт проверки') : h('span', { class: 'vmark none' }, 'нет карточки'));
  const SRC = { url: 'Ссылка', pdf: 'PDF', vision: 'Фото (Vision AI)', manual: 'Поле товара' };
  const FIELD = { brand: 'бренд', category: 'категория', weight_g: 'вес', hs_code: 'HS-код', origin_country: 'страна', barcode: 'штрихкод', description: 'описание' };
  function sourceRef(s) {
    if (s.source_type === 'url' && /^https:\/\//.test(s.source_ref || '')) return h('a', { href: s.source_ref, target: '_blank', rel: 'noopener noreferrer' }, host(s.source_ref));
    if (s.source_ref && s.source_ref.startsWith('field:')) return h('span', null, FIELD[s.source_ref.slice(6)] || s.source_ref.slice(6));
    return h('span', null, s.source_ref || '—');
  }
  function evidence(p) {
    const src = Array.isArray(p.data_sources) ? p.data_sources : json(p.data_sources || '[]', []);
    if (!src.length) return h('p', { class: 'sub' }, 'Источников нет: факты в описании нечем подтвердить.');
    return h('ul', { class: 'evidence' }, src.map(s => h('li', null, h('span', { class: 'fact' }, s.fact), h('span', { class: 'src ' + s.source_type }, SRC[s.source_type] || s.source_type), sourceRef(s))));
  }
  function editDialog(p, done) {
    const title = h('input', { type: 'text', maxlength: 120, value: p.title, 'aria-label': 'Название' });
    const body = h('textarea', { rows: 8, maxlength: 4000, 'aria-label': 'Описание' }); body.value = p.seo_description || '';
    const msg = h('p', { class: 'msg err' });
    const dlg = modal('Исправить карточку', h('form', { class: 'col', onsubmit: async ev => {
      ev.preventDefault(); msg.textContent = '';
      try { done(await act(p.id, 'ai_edit', { title: title.value, seo_description: body.value })); dlg.close(); } catch (e) { msg.textContent = err(e); } } },
      h('label', { class: 'field' }, 'Название', title), h('label', { class: 'field' }, 'Описание', body),
      h('p', { class: 'hint' }, 'После сохранения карточка считается проверенной вами.'), h('button', { class: 'btn', type: 'submit' }, 'Сохранить и подтвердить'), msg));
    body.focus();
  }
  function regenDialog(p, done) {
    const note = h('input', { type: 'text', maxlength: 300, placeholder: 'Например: убрать слово «лучший», добавить размеры', 'aria-label': 'Что исправить' }), msg = h('p', { class: 'msg err' });
    const dlg = modal('Перегенерировать карточку', h('form', { class: 'col', onsubmit: async ev => {
      ev.preventDefault(); msg.textContent = '';
      try { done(await act(p.id, 'ai_generate', { note: note.value })); dlg.close(); } catch (e) { msg.textContent = err(e); } } },
      h('label', { class: 'field' }, 'Что исправить (необязательно)', note), h('button', { class: 'btn', type: 'submit' }, 'Перегенерировать'), msg));
    note.focus();
  }

  /* ================================================================== DASHBOARD */
  function salesChart(days) {
    const W = 640, H = 220, P = { l: 8, r: 8, t: 14, b: 26 };
    if (!days.length) return h('p', { class: 'empty' }, 'Продаж за период нет.');
    const max = Math.max(1, ...days.map(d => d.gmv)), x = i => P.l + (days.length === 1 ? (W - P.l - P.r) / 2 : i * (W - P.l - P.r) / (days.length - 1)), y = v => P.t + (H - P.t - P.b) * (1 - v / max);
    const line = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.gmv).toFixed(1)}`).join(' ');
    const tip = h('div', { class: 'tip hidden' }), dot = svg('circle', { r: 4.5, class: 'dot hidden' });
    const box = h('div', { class: 'chart' }, tip);
    const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Выручка по дням' },
      svg('defs', {}, svg('linearGradient', { id: 'sg', x1: 0, y1: 0, x2: 0, y2: 1 }, svg('stop', { offset: 0, class: 'g0' }), svg('stop', { offset: 1, class: 'g1' }))),
      [0, .5, 1].map(f => svg('line', { x1: P.l, x2: W - P.r, y1: y(max * f), y2: y(max * f), class: 'grid' })),
      svg('path', { d: `${line} L${x(days.length - 1).toFixed(1)} ${H - P.b} L${x(0).toFixed(1)} ${H - P.b} Z`, fill: 'url(#sg)' }), svg('path', { d: line, class: 'ln', fill: 'none' }), dot,
      svg('text', { x: P.l, y: H - 6, class: 'ax' }, days[0].d.slice(5)), svg('text', { x: W - P.r, y: H - 6, class: 'ax end', 'text-anchor': 'end' }, days[days.length - 1].d.slice(5)));
    el.addEventListener('pointermove', ev => {
      const r = el.getBoundingClientRect(), px = (ev.clientX - r.left) / r.width * W;
      let best = 0; days.forEach((d, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
      const d = days[best]; dot.classList.remove('hidden'); dot.setAttribute('cx', x(best)); dot.setAttribute('cy', y(d.gmv));
      tip.classList.remove('hidden'); tip.replaceChildren(h('b', null, money(d.gmv)), h('span', null, `${d.d.slice(5)} · заказов: ${d.orders}`));
      tip.style.left = Math.min(Math.max(x(best) / W * r.width, 70), r.width - 70) + 'px'; tip.style.top = (y(d.gmv) / H * r.height - 8) + 'px';
    });
    el.addEventListener('pointerleave', () => { dot.classList.add('hidden'); tip.classList.add('hidden'); });
    box.prepend(el); return box;
  }
  async function pageDashboard(el) {
    loading(el);
    let days = 30;
    const out = h('div', { class: 'col' });
    const sel = h('select', { 'aria-label': 'Период' }, [[7, '7 дней'], [30, '30 дней'], [90, '90 дней']].map(([v, l]) => h('option', { value: v, selected: v === days }, l)));
    sel.addEventListener('change', () => { days = Number(sel.value); draw(); });
    put(el, h('div', { class: 'pagehead' }, h('div', null, h('h2', null, 'Обзор операций'), h('p', { class: 'sub' }, 'Продажи, склад и очередь проверки карточек.')), sel), out);
    async function draw() {
      const [an, ov, ord] = await Promise.all([can('analytics.read') ? api('/analytics/platform?days=' + days).catch(() => null) : null, can('ai.read') ? api('/ai/overview').catch(() => null) : null,
        meta('orders') ? api('/m/orders?limit=6').catch(() => null) : null]);
      const parts = [];
      if (an) parts.push(h('div', { class: 'grid kpis' }, kpi(money(an.gmv), 'Выручка', `за ${days} дн.`), kpi(num(an.orders), 'Заказов', an.held_orders ? `на удержании: ${an.held_orders}` : null),
        kpi(money(an.aov), 'Средний чек'), kpi(num(an.refunds), 'Возвратов', an.refunded_amount ? money(an.refunded_amount) : null)));
      if (ov) {
        const p = ov.products, vp = pct(p.verified, p.total), bar = h('i');
        requestAnimationFrame(() => { bar.style.width = vp + '%'; });
        parts.push(h('div', { class: 'grid ops' },
          h('div', { class: 'card opcard' }, h('b', null, vp + '%'), h('span', null, `SKU проверено человеком (${p.verified} из ${p.total})`), h('div', { class: 'meter' }, bar)),
          h('button', { class: 'card opcard link', type: 'button', onclick: () => go('p_review') }, h('b', null, num(p.awaiting)), h('span', null, `ждут проверки, из них ниже ${ov.threshold}%: ${p.low_confidence}`)),
          h('button', { class: 'card opcard link', type: 'button', onclick: () => go('p_studio') }, h('b', null, num(p.no_card)), h('span', null, 'товаров без AI-карточки')),
          h('button', { class: 'card opcard link', type: 'button', onclick: () => go('r_stock') }, h('b', { class: ov.stock.low ? 'warn' : null }, num(ov.stock.low)), h('span', null, 'позиций с низким остатком')),
          h('button', { class: 'card opcard link', type: 'button', onclick: () => go('p_pricing_robot') }, h('b', null, num(ov.stock.overstock)), h('span', null, 'товаров к уценке (затоваривание)'))));
      }
      if (an) parts.push(h('div', { class: 'two wide' },
        h('div', { class: 'card' }, h('h3', null, 'Заказы по странам'), an.by_country.length ? barList(an.by_country, r => r.country, 'gmv') : h('p', { class: 'empty' }, 'Нет данных.')),
        h('div', { class: 'card' }, h('h3', null, 'Выручка по дням'), salesChart(an.by_day))));
      if (ord && ord.rows.length) { const r = meta('orders'); parts.push(h('div', { class: 'card' }, h('h3', null, 'Последние заказы'), table(r, ord.rows, row => openDetail(r, row.id, draw)))); }
      if (!parts.length) parts.push(h('p', { class: 'empty' }, 'Для вашей роли здесь пока нечего показать. Выберите раздел слева.'));
      put(out, parts);
    }
    draw();
  }

  /* ================================================================== SKU CATALOGUE */
  async function pageCatalog(el) {
    const res = meta('products'); if (!res) return fail(el, new Error('forbidden'));
    const st = { page: 1, q: '', view: 'all' }, open = new Set(), counts = { awaiting: null };
    const VIEWS = { all: ['Все', {}], review: ['Ждут проверки', { ai_status: 'generated', human_verified: 'false', sort: 'ai_confidence', dir: 'asc' }], nocard: ['Без AI-карточки', { ai_status: 'none' }], verified: ['Проверено', { human_verified: 'true' }] };
    const list = h('div', { class: 'card tablewrap' }), pager = h('div', { class: 'toolbar' }), chips = h('div', { class: 'chips', role: 'tablist' });
    const q = h('input', { type: 'search', placeholder: 'SKU, штрихкод, название, ID поставщика', 'aria-label': 'Поиск' });
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { st.q = q.value.trim(); st.page = 1; load(); } });
    const drawChips = () => put(chips, Object.entries(VIEWS).map(([k, [l]]) => h('button', { type: 'button', role: 'tab', class: 'chip', 'aria-selected': k === st.view ? 'true' : 'false',
      onclick: () => { st.view = k; st.page = 1; drawChips(); load(); } }, l, k === 'review' && counts.awaiting != null ? h('em', null, counts.awaiting) : null)));
    put(el, h('div', { class: 'pagehead' }, h('div', null, h('h2', null, 'Товары и SKU'), h('p', { class: 'sub' }, 'Нажмите на строку: откроются описание, источники фактов и действия.')),
      h('div', { class: 'toolbar' }, can('products.write') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go('p_import') }, 'Импорт CSV') : null,
        res.can.create ? h('button', { class: 'btn sm', type: 'button', onclick: () => window.Asv.ui.openForm(res, null, load) }, '+ Товар' ) : null)),
      h('div', { class: 'toolbar' }, q, chips), list, pager);
    drawChips();
    if (can('ai.read')) api('/ai/overview').then(o => { counts.awaiting = o.products.awaiting; drawChips(); }).catch(() => {});

    function panel(p, redraw) {
      const done = r => { Object.assign(p, r); redraw(); };
      const has = k => res.actions.some(a => a.k === k), a = k => res.actions.find(x => x.k === k);
      const gen = p.ai_status === 'generated', st_ = p.status;
      const slot = h('div', { class: 'anaslot' });
      if (p.ai_analysis) analysisView(p, slot, done);
      const btns = [
        has('ai_analyze') ? h('button', { class: 'btn sm', type: 'button', onclick: async ev => { const b = ev.currentTarget; b.disabled = true; put(slot, h('p', { class: 'sub' }, 'AI анализирует товар…')); try { done(await act(p.id, 'ai_analyze')); } catch (e) { put(slot, h('p', { class: 'msg err' }, err(e))); } finally { b.disabled = false; } } }, 'AI-анализ: описание, цена, история') : null,
        has('competitors') ? h('button', { class: 'btn sm', type: 'button', onclick: async ev => { const b = ev.currentTarget; b.disabled = true; put(slot, h('p', { class: 'sub' }, 'Ищу этот товар на Amazon, Allegro, eBay и других площадках…')); try { offersView(await act(p.id, 'competitors'), slot); } catch (e) { put(slot, h('p', { class: 'msg err' }, err(e))); } finally { b.disabled = false; } } }, 'Цены конкурентов') : null,
        has('ai_generate') ? h('button', { class: 'btn sm', type: 'button', onclick: () => (gen ? regenDialog(p, done) : act(p.id, 'ai_generate').then(done).catch(e => toast(err(e), true))) }, gen ? 'Перегенерировать' : 'Сгенерировать карточку') : null,
        has('verify') && gen && !p.human_verified ? h('button', { class: 'btn sm ok', type: 'button', onclick: () => act(p.id, 'verify').then(done).catch(e => toast(err(e), true)) }, 'Подтвердить') : null,
        has('ai_edit') && gen ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => editDialog(p, done) }, 'Исправить') : null,
        has('ai_reject') && gen ? h('button', { class: 'btn danger sm', type: 'button', onclick: () => runAction(res, p, a('ai_reject'), done) }, 'Отклонить') : null,
        has('unverify') && p.human_verified ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => act(p.id, 'unverify').then(done).catch(e => toast(err(e), true)) }, 'Снять отметку') : null,
        ...['submit', 'approve', 'reject', 'delist'].filter(k => has(k) && ((k === 'submit' && ['draft', 'rejected'].includes(st_)) || ((k === 'approve' || k === 'reject') && st_ === 'pending_review') || (k === 'delist' && st_ === 'approved')))
          .map(k => h('button', { class: 'btn ghost sm', type: 'button', onclick: () => runAction(res, p, a(k), done) }, a(k).label)),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => openDetail(res, p.id, load) }, 'Вся запись')];
      return h('div', { class: 'panel' },
        h('div', { class: 'ptext' },
          h('h4', null, 'Описание'), p.seo_description || p.description ? h('p', { class: 'desc' }, p.seo_description || p.description) : h('p', { class: 'sub' }, 'Описания пока нет.'),
          p.ai_flags ? h('p', { class: 'flagline' }, 'Замечания AI: ' + p.ai_flags) : null,
          p.moderation_note ? h('p', { class: 'flagline' }, 'Модератор: ' + p.moderation_note) : null),
        h('div', { class: 'pev' }, priceBox(p), h('h4', null, 'Откуда взяты факты'), evidence(p),
          h('p', { class: 'idline' }, [p.barcode && 'Штрихкод ' + p.barcode, p.external_id && 'ID поставщика ' + p.external_id, p.warehouse_location && 'Ячейка ' + p.warehouse_location, `Остаток ${p.stock_qty} (в резерве ${p.stock_reserved})`].filter(Boolean).join(' · '))),
        h('div', { class: 'toolbar pbtns' }, btns), slot,
        window.Asv.shopify ? (() => { const line = h('div', { class: 'toolbar shopline' }); window.Asv.shopify.productLine(p, line); return line; })() : null);
    }
    async function load() {
      const qs = new URLSearchParams({ page: st.page, limit: 25 }); if (st.q) qs.set('q', st.q);
      for (const [k, v] of Object.entries(VIEWS[st.view][1])) qs.set(k, v);
      try {
        const d = await api('/m/products?' + qs);
        if (!d.rows.length) put(list, h('p', { class: 'empty' }, st.view === 'review' ? 'Очередь проверки пуста.' : 'Ничего не найдено.'));
        else {
          const tbody = h('tbody');
          for (const p of d.rows) {
            const row = h('tr', { class: 'click', tabindex: 0, 'aria-expanded': open.has(p.id) ? 'true' : 'false' });
            const holder = h('tr', { class: 'pdetail' }, h('td', { colspan: 10 }));
            const redraw = () => { drawRow(); if (open.has(p.id)) put(holder.firstChild, panel(p, redraw)); };
            const drawRow = () => {
              put(row, h('td', null, thumb(p)), h('td', { class: 'mono dim' }, '#' + p.id), h('td', { class: 'name' }, h('b', null, p.title), h('small', null, p.sku + (p.barcode ? ' · ' + p.barcode : ''))),
                h('td', { class: 'num dim' }, p.cost != null ? money(p.cost) : '—', p.supplier_name ? h('small', { class: 'sup' }, p.supplier_name) : null),
                h('td', { class: 'num' + (p.markup_actual_pct != null && p.markup_actual_pct < 0 ? ' warn' : '') }, p.markup_actual_pct != null ? (p.markup_actual_pct > 0 ? '+' : '') + p.markup_actual_pct + '%' : '—'),
                h('td', { class: 'num' }, h('b', null, money(p.price)), p.profit != null ? h('small', { class: 'sup' }, (p.profit >= 0 ? 'прибыль ' : 'убыток ') + money(Math.abs(p.profit))) : null), h('td', { class: 'num' + (p.stock_qty - p.stock_reserved <= 0 ? ' warn' : '') }, num(p.stock_qty)), h('td', null, ring(p.ai_status === 'generated' ? p.ai_confidence : null)),
                h('td', null, verifiedMark(p)), h('td', null, h('span', { class: 'pill st-' + p.status }, p.status)));
              row.setAttribute('aria-expanded', open.has(p.id) ? 'true' : 'false'); holder.classList.toggle('hidden', !open.has(p.id));
            };
            const toggle = () => { open.has(p.id) ? open.delete(p.id) : open.add(p.id); redraw(); };
            row.addEventListener('click', toggle); row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
            redraw(); tbody.append(row, holder);
          }
          put(list, h('table', { class: 'sku' }, h('thead', null, h('tr', null, ['', 'ID', 'Товар', 'Закупка · поставщик', 'Наценка', 'Итоговая цена', 'Остаток', 'AI, %', 'Проверка', 'Статус'].map(t => h('th', null, t)))), tbody));
        }
        const pages = Math.ceil(d.total / d.limit);
        put(pager, h('span', { class: 'sub' }, `Всего: ${d.total}`), h('span', { class: 'grow' }),
          st.page > 1 ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { st.page--; load(); } }, '← Назад') : null,
          st.page < pages ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { st.page++; load(); } }, 'Вперёд →') : null);
      } catch (e) { put(list, h('p', { class: 'msg err' }, err(e))); }
    }
    load();
  }

  /* ================================================================== FAST AUDIT */
  async function pageReview(el) {
    const canAct = can('ai.review'), canGen = can('ai.run');
    let thr = 85, queue = [], left = 0, reviewed = 0, mode = 'view'; const t0 = Date.now();
    const stage = h('div', { class: 'audit' }), stat = h('div', { class: 'auditstat' });
    const sel = h('select', { 'aria-label': 'Порог уверенности' }, [[85, 'Только где AI не уверен (ниже 85%)'], [101, 'Все непроверенные']].map(([v, l]) => h('option', { value: v }, l)));
    sel.addEventListener('change', () => { thr = Number(sel.value); load(); });
    // «Проверить все»: the server checks every card (rules + a second AI pass) and confirms those without problems; the rest stay here with the reasons
    const autoBox = h('div', { class: 'card', hidden: true });
    const autoBtn = canAct ? h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      autoBtn.disabled = true; autoBox.hidden = false;
      const bar = h('i'), log = h('div', { class: 'autolog' }), head = h('p', null, 'Проверяю…');
      put(autoBox, h('h3', null, 'Автоматическая проверка'), head, h('div', { class: 'progress' }, bar), log);
      let passed = 0, failed = 0, total = null; const seen = [];
      try {
        for (;;) {
          const r = await post('/ai/review/auto', { limit: 15, skip: seen });
          for (const it of r.items) { seen.push(it.id); it.ok ? passed++ : failed++; log.prepend(h('div', { class: it.ok ? 'ok' : 'bad' }, (it.ok ? '✓ ' : '✗ ') + `#${it.id} ${it.title}` + (it.ok ? ' — подтверждена' : ' — ' + it.issues.join('; ')))); }
          total = total ?? seen.length + r.left; bar.style.width = Math.round(seen.length * 100 / Math.max(total, 1)) + '%';
          head.textContent = `Проверено ${seen.length} из ${total}: подтверждено ${passed}, требуют внимания ${failed}.` + (r.mock ? ' Демо-режим AI: автоподтверждение выключено.' : '');
          if (r.stopped) { head.textContent += ' Остановлено: дневной лимит AI.'; break; }
          if (!r.items.length || !r.left) break;
        }
        head.textContent += ' Готово. Ниже остались только карточки с замечаниями.';
      } catch (e) { head.textContent = err(e); }
      autoBtn.disabled = false; load();
    } }, '✓ Проверить все автоматически') : null;
    put(el, h('div', { class: 'pagehead' }, h('div', null, h('h2', null, 'Быстрая проверка'), h('p', { class: 'sub' }, 'Нажмите «Проверить все» — AI сам сверит каждую карточку с фактами и подтвердит те, где нет проблем. Здесь останутся только спорные.')), h('div', { class: 'row' }, autoBtn, sel)), autoBox, stat, stage,
      h('p', { class: 'keys' }, h('kbd', null, 'Пробел'), ' подтвердить  ', h('kbd', null, 'E'), ' исправить  ', h('kbd', null, 'R'), ' перегенерировать с причиной  ', h('kbd', null, 'S'), ' пропустить'));
    const next = () => { queue.shift(); left = Math.max(0, left - 1); mode = 'view'; draw(); if (queue.length < 3 && left > queue.length) load(true); };
    const fail_ = e => toast(err(e), true);
    async function approve() { const p = queue[0]; if (!p || !canAct) return; try { await act(p.id, 'verify'); reviewed++; next(); } catch (e) { fail_(e); } }
    function startEdit() {
      const p = queue[0]; if (!p || !canAct) return; mode = 'edit';
      const title = h('input', { type: 'text', maxlength: 120, value: p.title, 'aria-label': 'Название' }), body = h('textarea', { rows: 7, maxlength: 4000, 'aria-label': 'Описание' }); body.value = p.seo_description || '';
      const save = async () => { try { await act(p.id, 'ai_edit', { title: title.value, seo_description: body.value }); reviewed++; next(); } catch (e) { fail_(e); } };
      body.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save(); });
      put(stage.querySelector('.editslot'), h('div', { class: 'editbox' }, h('label', { class: 'field' }, 'Название', title), h('label', { class: 'field' }, 'Описание', body),
        h('div', { class: 'toolbar' }, h('button', { class: 'btn sm ok', type: 'button', onclick: save }, 'Сохранить и подтвердить (Ctrl+Enter)'), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { mode = 'view'; draw(); } }, 'Отмена (Esc)'))));
      title.focus();
    }
    function startReject() {
      const p = queue[0]; if (!p || !canAct) return; mode = 'reject';
      const note = h('input', { type: 'text', maxlength: 200, placeholder: 'Что не так? Например: нет размеров, лишние обещания', 'aria-label': 'Причина' });
      const only = h('input', { type: 'checkbox', 'aria-label': 'Только отклонить' });
      const send = async () => {
        if (!note.value.trim()) return note.focus();
        try { await act(p.id, 'ai_reject', { note: note.value }); if (canGen && !only.checked) await act(p.id, 'ai_generate', { note: note.value }); reviewed++; next(); } catch (e) { fail_(e); }
      };
      note.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
      put(stage.querySelector('.editslot'), h('div', { class: 'editbox' }, h('label', { class: 'field' }, 'Причина (Enter — отправить)', note),
        canGen ? h('label', { class: 'field row' }, only, 'Только отклонить, без новой генерации') : null,
        h('div', { class: 'toolbar' }, h('button', { class: 'btn sm', type: 'button', onclick: send }, canGen ? 'Отклонить и перегенерировать' : 'Отклонить'), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { mode = 'view'; draw(); } }, 'Отмена (Esc)'))));
      note.focus();
    }
    function draw() {
      const mins = (Date.now() - t0) / 60000, rate = reviewed && mins > 0.1 ? (reviewed / mins).toFixed(1) : '—';
      put(stat, h('span', null, h('b', null, num(left)), ' осталось'), h('span', null, h('b', null, reviewed), ' проверено сейчас'), h('span', null, h('b', null, rate), ' в минуту'));
      const p = queue[0];
      if (!p) return put(stage, h('div', { class: 'card done' }, h('h3', null, 'Очередь пуста'), h('p', { class: 'sub' }, thr === 85 ? 'Карточек с низкой уверенностью не осталось. Можно проверить остальные: выберите «Все непроверенные».' : 'Все карточки проверены.'),
        canGen ? h('button', { class: 'btn', type: 'button', onclick: () => go('p_studio') }, 'Сгенерировать новые') : null));
      put(stage, h('article', { class: 'card acard' },
        h('div', { class: 'ahead' }, thumb(p), h('div', { class: 'aid' }, h('span', { class: 'mono' }, `ID ${p.id}`), h('span', { class: 'mono' }, 'SKU ' + p.sku), p.barcode ? h('span', { class: 'mono' }, 'EAN ' + p.barcode) : null,
          h('span', null, `Остаток ${num(p.stock)}`), p.warehouse_location ? h('span', null, 'Ячейка ' + p.warehouse_location) : null), ring(p.ai_confidence)),
        h('h3', { class: 'atitle' }, p.title), h('p', { class: 'ameta' }, [p.brand, p.category, money(p.price)].filter(Boolean).join(' · ')),
        p.ai_flags ? h('p', { class: 'flagline' }, 'Замечания AI: ' + p.ai_flags) : null,
        h('p', { class: 'desc' }, p.seo_description || '—'), h('h4', null, 'Откуда взяты факты'), evidence(p), h('div', { class: 'editslot' }),
        h('div', { class: 'toolbar abtns' }, canAct ? [h('button', { class: 'btn ok', type: 'button', onclick: approve }, 'Подтвердить'), h('button', { class: 'btn ghost', type: 'button', onclick: startEdit }, 'Исправить'),
          h('button', { class: 'btn ghost', type: 'button', onclick: startReject }, 'Перегенерировать')] : h('span', { class: 'sub' }, 'У вашей роли нет права подтверждать карточки.'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => { queue.push(queue.shift()); draw(); } }, 'Пропустить'))));
    }
    const onKey = e => {
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
      const tag = (e.target.tagName || '').toLowerCase(), typing = ['input', 'textarea', 'select'].includes(tag);
      if (e.key === 'Escape' && mode !== 'view') { mode = 'view'; draw(); return; }
      if (typing || mode !== 'view' || !queue.length) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'enter') { if (tag === 'button') return; e.preventDefault(); approve(); }
      else if (k === 'e' || k === 'у') { e.preventDefault(); startEdit(); }
      else if (k === 'r' || k === 'к') { e.preventDefault(); startReject(); }
      else if (k === 's' || k === 'ы') { e.preventDefault(); queue.push(queue.shift()); draw(); }
    };
    document.addEventListener('keydown', onKey); window.Asv.onLeave(() => document.removeEventListener('keydown', onKey));
    async function load(more) {
      try {
        const d = await api(`/ai/review/queue?max_conf=${thr}&limit=30`);
        if (more) { const have = new Set(queue.map(x => x.id)); queue.push(...d.rows.filter(x => !have.has(x.id))); } else queue = d.rows; left = d.left; draw();
      } catch (e) { put(stage, h('p', { class: 'msg err' }, err(e))); }
    }
    load();
  }

  /* ================================================================== AI STUDIO (batch) */
  async function pageStudio(el) {
    loading(el);
    const out = h('div', { class: 'col' }), msg = h('p', { class: 'msg' });
    async function draw() {
      try {
        const [ov, jobs, kit] = await Promise.all([api('/ai/overview'), api('/m/ai_jobs?limit=8'), meta('brand_kits') ? api('/m/brand_kits?active=true&limit=1').catch(() => ({ rows: [] })) : { rows: [] }]);
        const limit = h('input', { type: 'number', min: 1, max: 200, value: 50, 'aria-label': 'Сколько товаров' }), lang = h('select', { 'aria-label': 'Язык' }, ['en', 'pl', 'de', 'ru'].map(l => h('option', { value: l }, l.toUpperCase())));
        const run = (kind, body, btn) => async () => {
          btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Идёт обработка…';
          try { const r = await post('/ai/batch', { kind, ...body }); msg.className = 'msg ok'; msg.textContent = `Готово: ${r.done}, ошибок: ${r.failed}${r.stopped ? ' — остановлено: дневная квота AI' : ''}`; draw(); }
          catch (e) { msg.className = 'msg err'; msg.textContent = err(e); btn.disabled = false; }
        };
        const b1 = h('button', { class: 'btn', type: 'button' }, 'Сгенерировать карточки'), b2 = h('button', { class: 'btn ghost', type: 'button' }, 'Перевести проверенные'), b3 = h('button', { class: 'btn ghost', type: 'button' }, 'Обновить поисковый индекс');
        b1.addEventListener('click', () => run('card', { scope: 'unverified', limit: Number(limit.value) }, b1)());
        b2.addEventListener('click', () => run('localize', { scope: 'verified', lang: lang.value, limit: Number(limit.value) }, b2)());
        b3.addEventListener('click', async () => { b3.disabled = true; try { const r = await post('/ai/index'); toast(`Индекс: новых или изменённых ${r.indexed}, без изменений ${r.skipped}`); draw(); } catch (e) { toast(err(e), true); b3.disabled = false; } });
        put(out,
          ov.provider === 'mock' ? h('p', { class: 'banner info' }, 'Демо-режим: тексты строятся по шаблону из полей товара, переводы помечены «mock». Подключите модель через AI_PROVIDER в .env.') : null,
          h('div', { class: 'grid ops' }, kpi(num(ov.products.no_card), 'без карточки'), kpi(num(ov.products.awaiting), 'ждут проверки'), kpi(num(ov.products.verified), 'проверено'), kpi(`${ov.usage.used_24h} / ${ov.usage.limit}`, 'вызовов AI за сутки')),
          h('div', { class: 'card col' }, h('h3', null, 'Пакетная обработка'), h('p', { class: 'sub' }, 'Работает с товарами по порядку, до 200 за раз. Каждый результат попадает в очередь проверки; живые товары остаются в продаже.'),
            h('div', { class: 'toolbar' }, h('label', { class: 'field' }, 'Сколько товаров', limit), b1), h('div', { class: 'toolbar' }, h('label', { class: 'field' }, 'Язык', lang), b2, b3), msg,
            kit.rows[0] ? h('p', { class: 'hint' }, `Активный Brand Kit: ${kit.rows[0].name} (тон: ${kit.rows[0].tone}).`) : h('p', { class: 'hint' }, 'Brand Kit не задан: тексты пишутся в нейтральном тоне.')),
          h('div', { class: 'card' }, h('h3', null, 'Последние задания'), jobs.rows.length ? table(meta('ai_jobs'), jobs.rows) : h('p', { class: 'empty' }, 'Заданий ещё не было.')));
      } catch (e) { fail(out, e); }
    }
    put(el, h('div', null, h('h2', null, 'AI Studio'), h('p', { class: 'sub' }, 'Пакетная генерация, перевод и индексация.')), out); draw();
  }

  /* ================================================================== CANVAS */
  const NODE_W = 300, TYPES = { prompt: 'Промпт', style: 'Стиль', angle: 'Ракурс', crop: 'Кадрирование', text: 'Текст' };
  async function pageCanvas(el) {
    loading(el);
    const canWrite = can('ai.write') || can('ai.run');
    let canvases = [], cur = null, graph = { nodes: [], edges: [] }, results = {}, dirty = false;
    const stage = h('div', { class: 'cstage' }), bar = h('div', { class: 'toolbar' }), msg = h('p', { class: 'msg' });
    try { canvases = (await api('/m/canvases?limit=100')).rows; } catch (e) { return fail(el, e); }
    const parentOf = id => (graph.edges.find(e => e.to === id) || {}).from || '';
    const setParent = (id, from) => { graph.edges = graph.edges.filter(e => e.to !== id); if (from) graph.edges.push({ from, to: id }); dirty = true; };
    const wouldCycle = (id, from) => { let c = from, n = 0; while (c && n++ < 50) { if (c === id) return true; c = parentOf(c); } return false; };
    const uid = () => { let i = graph.nodes.length + 1; while (graph.nodes.some(n => n.id === 'n' + i)) i++; return 'n' + i; };
    function select(id) { cur = canvases.find(c => c.id === id) || null; graph = cur ? json(cur.graph, { nodes: [], edges: [] }) : { nodes: [], edges: [] }; results = cur ? json(cur.results || '{}', {}) : {}; dirty = false; msg.textContent = ''; drawBar(); drawStage(); }
    async function save() { if (!cur || !dirty) return true; try { const r = await api('/m/canvases/' + cur.id, { method: 'PATCH', body: { graph: JSON.stringify(graph) } }); Object.assign(cur, r); dirty = false; msg.className = 'msg ok'; msg.textContent = 'Сохранено'; return true; } catch (e) { msg.className = 'msg err'; msg.textContent = err(e); return false; } }
    async function generate(btn) {
      if (!cur || !(await save())) return; btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Генерация…';
      try { const r = await post(`/m/canvases/${cur.id}/do/run`); Object.assign(cur, r); results = json(r.results || '{}', {}); msg.className = 'msg ok'; msg.textContent = 'Готово'; drawStage(); } catch (e) { msg.className = 'msg err'; msg.textContent = err(e); }
      btn.disabled = false;
    }
    function drawBar() {
      const pick = h('select', { 'aria-label': 'Холст' }, h('option', { value: '' }, canvases.length ? 'Выберите холст' : 'Холстов нет'), canvases.map(c => h('option', { value: c.id, selected: cur && c.id === cur.id }, c.title)));
      pick.addEventListener('change', async () => { if (dirty && !confirm('Есть несохранённые изменения. Перейти без сохранения?')) { pick.value = cur ? cur.id : ''; return; } select(Number(pick.value)); });
      const gen = h('button', { class: 'btn', type: 'button', onclick: ev => generate(ev.currentTarget) }, 'Сгенерировать');
      put(bar, pick, canWrite ? h('button', { class: 'btn ghost sm', type: 'button', onclick: newCanvas }, '+ Холст') : null, h('span', { class: 'grow' }),
        cur && canWrite ? [['prompt', '+ Промпт'], ['style', '+ Стиль'], ['angle', '+ Ракурс']].map(([t, l]) => h('button', { class: 'btn ghost sm', type: 'button', onclick: () => addNode(t) }, l)) : null,
        cur && canWrite ? [h('button', { class: 'btn ghost sm', type: 'button', onclick: save }, 'Сохранить'), can('ai.run') ? gen : null] : null);
    }
    function newCanvas() {
      const t = h('input', { type: 'text', maxlength: 80, 'aria-label': 'Название', required: true }), m = h('p', { class: 'msg err' });
      const dlg = modal('Новый холст', h('form', { class: 'col', onsubmit: async ev => { ev.preventDefault(); try {
        const g = { nodes: [{ id: 'base', type: 'prompt', label: 'Base prompt', prompt: '', x: 40, y: 80 }], edges: [] };
        const r = await api('/m/canvases', { method: 'POST', body: { title: t.value, graph: JSON.stringify(g) } }); canvases.unshift(r); dlg.close(); select(r.id); } catch (e) { m.textContent = err(e); } } },
        h('label', { class: 'field' }, 'Название', t), h('button', { class: 'btn', type: 'submit' }, 'Создать'), m)); t.focus();
    }
    function addNode(type) {
      if (graph.nodes.length >= 30) return toast('На холсте не больше 30 узлов', true);
      const base = graph.nodes[0]; const n = { id: uid(), type, label: TYPES[type], prompt: '', x: (base ? base.x + NODE_W + 80 : 40), y: 40 + (graph.nodes.length - 1) * 430 };
      graph.nodes.push(n); if (base && type !== 'prompt') graph.edges.push({ from: base.id, to: n.id }); dirty = true; drawStage();
    }
    function drawStage() {
      if (!cur) return put(stage, h('p', { class: 'empty' }, 'Выберите холст или создайте новый.'));
      const links = svg('svg', { class: 'clinks', 'aria-hidden': 'true' }, svg('defs', {}, svg('linearGradient', { id: 'lk', x1: 0, y1: 0, x2: 1, y2: 0 }, svg('stop', { offset: 0, class: 'l0' }), svg('stop', { offset: 1, class: 'l1' }))));
      const plane = h('div', { class: 'cplane' }, links);
      const W = Math.max(1100, ...graph.nodes.map(n => n.x + NODE_W + 80)), H = Math.max(620, ...graph.nodes.map(n => n.y + 420));
      plane.style.width = W + 'px'; plane.style.height = H + 'px'; links.setAttribute('width', W); links.setAttribute('height', H);
      const cards = new Map();
      const drawLinks = () => { links.querySelectorAll('path').forEach(p => p.remove());
        for (const e of graph.edges) { const a = graph.nodes.find(n => n.id === e.from), b = graph.nodes.find(n => n.id === e.to); if (!a || !b) continue;
          const x1 = a.x + NODE_W, y1 = a.y + 26, x2 = b.x, y2 = b.y + 26, dx = Math.max(60, Math.abs(x2 - x1) / 2); links.append(svg('path', { d: `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`, class: 'lnk', fill: 'none' })); } };
      for (const n of graph.nodes) {
        const res = results[n.id], isBase = !parentOf(n.id);
        const label = h('input', { type: 'text', maxlength: 40, value: n.label, 'aria-label': 'Название узла', disabled: !canWrite }), prompt = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Опишите, что должно получиться', 'aria-label': 'Промпт', disabled: !canWrite }); prompt.value = n.prompt;
        label.addEventListener('input', () => { n.label = label.value; dirty = true; }); prompt.addEventListener('input', () => { n.prompt = prompt.value; dirty = true; });
        const par = h('select', { 'aria-label': 'Исходит из', disabled: !canWrite }, h('option', { value: '' }, 'Исходный узел'), graph.nodes.filter(m => m.id !== n.id).map(m => h('option', { value: m.id, selected: parentOf(n.id) === m.id }, m.label || m.id)));
        par.addEventListener('change', () => { if (par.value && wouldCycle(n.id, par.value)) { par.value = parentOf(n.id); return toast('Так получится цикл', true); } setParent(n.id, par.value); drawLinks(); });
        const img = res ? (res.kind === 'svg' ? h('img', { class: 'cimg', alt: 'Результат: ' + n.label, src: 'data:image/svg+xml;utf8,' + encodeURIComponent(res.data) }) : res.kind === 'file' && /^[a-f0-9]{32}$/.test(res.data) ? h('img', { class: 'cimg', alt: 'Результат: ' + n.label, src: '/api/admin/files/' + res.data + '/download' }) : h('a', { href: res.data, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть изображение')) : null;
        const head = h('div', { class: 'chead' }, h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'), label, h('span', { class: 'pill' }, TYPES[n.type] || n.type),
          canWrite && graph.nodes.length > 1 ? h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Удалить узел', onclick: () => { graph.nodes = graph.nodes.filter(m => m.id !== n.id); graph.edges = graph.edges.filter(e => e.from !== n.id && e.to !== n.id); delete results[n.id]; dirty = true; drawStage(); } }, '✕') : null);
        const card = h('div', { class: 'cnode' + (isBase ? ' base' : '') }, head, img, res && res.mock ? h('span', { class: 'hint' }, 'демо-картинка (без подключённой модели изображений)') : null, prompt, h('label', { class: 'field' }, 'Исходит из', par));
        card.style.left = n.x + 'px'; card.style.top = n.y + 'px'; card.style.width = NODE_W + 'px'; cards.set(n.id, card); plane.append(card);
        if (canWrite) head.addEventListener('pointerdown', ev => {
          if (ev.target.closest('input,button')) return; head.setPointerCapture(ev.pointerId); const sx = ev.clientX - n.x, sy = ev.clientY - n.y;
          const mv = e => { n.x = Math.max(0, Math.min(4800, Math.round(e.clientX - sx))); n.y = Math.max(0, Math.min(4800, Math.round(e.clientY - sy))); card.style.left = n.x + 'px'; card.style.top = n.y + 'px'; dirty = true; drawLinks(); };
          const up = () => { head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); }; head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up);
        });
      }
      drawLinks(); put(stage, plane);
    }
    put(el, h('div', null, h('h2', null, 'AI Canvas'), h('p', { class: 'sub' }, 'Исходный промпт и его варианты: стиль, ракурс, кадр. Каждый узел наследует описание того, из которого исходит.')), bar, msg, stage);
    drawBar(); if (canvases.length) select(canvases[0].id); else drawStage();
  }

  /* ================================================================== SEARCH */
  async function pageSearch(el) {
    const q = h('input', { type: 'search', placeholder: 'Например: что-то тёплое для бега осенью', 'aria-label': 'Запрос', maxlength: 200 }), out = h('div', { class: 'card' }, h('p', { class: 'empty' }, 'Введите запрос.'));
    const run = async () => {
      if (!q.value.trim()) return; put(out, h('p', { class: 'sub' }, 'Ищем…'));
      try { const d = await api('/ai/search?q=' + encodeURIComponent(q.value));
        put(out, d.rows.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Товар', 'Категория', 'Цена', 'Близость по смыслу', 'Совпадение'].map(t => h('th', null, t)))),
          h('tbody', null, d.rows.map(r => h('tr', null, h('td', null, h('b', null, r.title), h('div', { class: 'hint' }, r.sku)), h('td', null, r.category), h('td', { class: 'num' }, money(r.price)), h('td', { class: 'num' }, r.similarity ?? '—'),
            h('td', null, r.exact ? h('span', { class: 'pill st-approved' }, 'точный артикул') : '—')))))) : h('p', { class: 'empty' }, 'Ничего не найдено. Если каталог новый, обновите индекс в AI Studio.'),
          d.provider === 'mock' ? h('p', { class: 'hint' }, 'Демо-режим: вектор строится из слов и их частей, настоящая модель эмбеддингов не подключена.') : null);
      } catch (e) { put(out, h('p', { class: 'msg err' }, err(e))); }
    };
    q.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    put(el, h('div', null, h('h2', null, 'Поиск по смыслу'), h('p', { class: 'sub' }, 'Смысл запроса плюс точные слова. Артикул и штрихкод всегда выходят первыми.')),
      h('div', { class: 'toolbar' }, q, h('button', { class: 'btn', type: 'button', onclick: run }, 'Найти'), can('ai.run') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: async ev => { ev.currentTarget.disabled = true; try { const r = await post('/ai/index'); toast(`Индекс обновлён: ${r.indexed} новых или изменённых`); } catch (e) { toast(err(e), true); } ev.currentTarget.disabled = false; } }, 'Обновить индекс') : null), out);
  }

  /* ================================================================== IMPORT */
  async function pageImport(el) {
    const seller = refSelect({ label: 'Продавец', ref: 'sellers', req: true }, null);
    const csv = h('textarea', { rows: 10, 'aria-label': 'CSV', placeholder: 'sku,title,category,price,cost,brand,description,barcode,source_url\nWSH-BLK-42,Мужской кожаный кошелёк,Аксессуары,39.90,18.50,Nordvik,Натуральная кожа,5901234567890,https://supplier.example/item/678129' });
    const out = h('div', { class: 'col' });
    const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', 'aria-label': 'Файл CSV' });
    file.addEventListener('change', async () => { const f = file.files[0]; if (!f) return; if (f.size > 1e6) return toast('Файл больше 1 МБ', true); csv.value = await f.text(); });
    const btn = h('button', { class: 'btn', type: 'button', onclick: async () => {
      const id = seller.get(); if (!id) return toast('Выберите продавца', true); btn.disabled = true;
      try { const r = await post('/ai/import', { seller_id: id, csv: csv.value });
        put(out, h('p', { class: 'msg ' + (r.failed ? 'err' : 'ok') }, `Импортировано: ${r.imported}, с ошибками: ${r.failed}`),
          r.errors.length ? h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, [h('th', null, 'Строка'), h('th', null, 'Ошибка')])), h('tbody', null, r.errors.map(e => h('tr', null, h('td', null, e.row), h('td', null, err(new Error(e.error)))))))) : null,
          r.imported ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go('p_catalog') }, 'Открыть каталог') : null);
      } catch (e) { put(out, h('p', { class: 'msg err' }, err(e))); }
      btn.disabled = false; } }, 'Импортировать');
    put(el, h('div', null, h('h2', null, 'Импорт каталога поставщика'), h('p', { class: 'sub' }, 'До 500 строк. Товары создаются черновиками, ссылка на источник сохраняется как подтверждение фактов. Сервер сам по ссылкам не ходит.')),
      h('div', { class: 'card col' }, h('label', { class: 'field' }, 'Продавец', seller.el), h('label', { class: 'field' }, 'Файл CSV или вставьте текст', file), csv,
        h('p', { class: 'hint' }, 'Обязательные колонки: sku, title, category, price. Цена в валюте магазина, например 39.90.'), btn), out);
  }

  /* ================================================================== PRICE ROBOTS */
  async function pageRobots(el) {
    const mk = (label, v, min, max) => { const i = h('input', { type: 'number', min, max, value: v, 'aria-label': label }); return { i, node: h('label', { class: 'field' }, label, i), get: () => Number(i.value) }; };
    const step = mk('Шаг скидки, %', 5, 1, 20), every = mk('Не чаще, дней', 3, 1, 30), minStock = mk('Остаток от, шт.', 20, 1, 100000), maxUnits = mk('Продано не больше, шт.', 2, 0, 100000), win = mk('За период, дней', 30, 7, 365);
    const mOut = h('div', { class: 'col' });
    const body = dry => ({ dry, step_bps: step.get() * 100, every_days: every.get(), min_stock: minStock.get(), max_units: maxUnits.get(), days: win.get() });
    const runM = async dry => {
      if (!dry && !confirm('Применить новые цены? Изменения попадут в историю цен.')) return;
      try { const r = await post('/pricing/markdown', body(dry));
        put(mOut, h('p', { class: dry ? 'sub' : 'msg ok' }, dry ? `Предпросмотр: ${r.changes.length} товаров, цены не тронуты` : `Применено: ${r.changes.length} изменений`),
          r.changes.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['SKU', 'Было', 'Станет', 'Остаток', 'Продано', ''].map(t => h('th', null, t)))), h('tbody', null, r.changes.map(c => h('tr', null, h('td', null, c.sku), h('td', { class: 'num' }, money(c.old_price)), h('td', { class: 'num' }, money(c.new_price)), h('td', { class: 'num' }, c.stock), h('td', { class: 'num' }, c.sold), h('td', null, c.at_floor ? 'нижняя граница' : '')))))) : null);
      } catch (e) { put(mOut, h('p', { class: 'msg err' }, err(e))); }
    };
    const prod = refSelect({ label: 'Товар', ref: 'products', req: true }, null), eps = h('input', { type: 'number', min: -5, max: 0, step: 0.1, value: -1.5, 'aria-label': 'Эластичность' }), eOut = h('div', { class: 'col' });
    const runE = async () => { const id = prod.get(); if (!id) return toast('Выберите товар', true);
      try { const r = await api(`/pricing/elasticity?product_id=${id}&elasticity=${eps.value}`);
        put(eOut, h('p', { class: 'sub' }, `Продано за ${30} дней: ${r.baseline_units_30d} шт. ${r.note}`), h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Цена', 'Шаг', 'Продаж, шт.', 'Выручка', 'Маржа', ''].map(t => h('th', null, t)))),
          h('tbody', null, r.rows.map(x => h('tr', { class: x.delta_pct === 0 ? 'now' : null }, h('td', { class: 'num' }, money(x.price)), h('td', null, (x.delta_pct > 0 ? '+' : '') + x.delta_pct + '%'), h('td', { class: 'num' }, x.units), h('td', { class: 'num' }, money(x.revenue)), h('td', { class: 'num' }, money(x.margin)), h('td', null, x.below_floor ? 'ниже нижней границы' : ''))))))); }
      catch (e) { put(eOut, h('p', { class: 'msg err' }, err(e))); } };
    const dev = mk('Подозрительно, если ниже медианы на, %', 50, 5, 95), dOut = h('div', { class: 'col' });
    const runD = async () => { try { const r = await api('/compliance/price-deviation?pct=' + (100 - dev.get()));
      put(dOut, r.rows.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Товар', 'Цена', 'Медиана группы', 'От медианы'].map(t => h('th', null, t)))), h('tbody', null, r.rows.map(x => h('tr', null, h('td', null, x.title, h('div', { class: 'hint' }, x.sku)), h('td', { class: 'num' }, money(x.price)), h('td', { class: 'num' }, money(x.group_median)), h('td', { class: 'num warn' }, x.ratio_pct + '%')))))) : h('p', { class: 'empty' }, 'Подозрительно дешёвых товаров нет.')); }
      catch (e) { put(dOut, h('p', { class: 'msg err' }, err(e))); } };
    put(el, h('div', null, h('h2', null, 'Ценовые роботы и риск'), h('p', { class: 'sub' }, 'Уценка залежавшегося товара, оценка спроса при смене цены и поиск подозрительно дешёвых предложений.')),
      h('div', { class: 'card col' }, h('h3', null, 'Робот уценки'), h('p', { class: 'sub' }, 'Берёт товары с остатком, которые не продаются, и снижает цену шагами, но не ниже нижней границы и себестоимости. Товары без нижней границы не трогает.'),
        h('div', { class: 'toolbar wrapx' }, step.node, every.node, minStock.node, maxUnits.node, win.node), h('div', { class: 'toolbar' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => runM(true) }, 'Предпросмотр'), can('pricing.write') ? h('button', { class: 'btn', type: 'button', onclick: () => runM(false) }, 'Применить') : null), mOut),
      h('div', { class: 'card col' }, h('h3', null, 'Матрица эластичности'), h('p', { class: 'sub' }, 'Оценка по простой модели: при эластичности −1,5 снижение цены на 10% даёт примерно +15% продаж. Это допущение, а не прогноз.'),
        h('div', { class: 'toolbar wrapx' }, h('label', { class: 'field' }, 'Товар', prod.el), h('label', { class: 'field' }, 'Эластичность', eps), h('button', { class: 'btn ghost', type: 'button', onclick: runE }, 'Посчитать')), eOut),
      can('compliance.read') ? h('div', { class: 'card col' }, h('h3', null, 'Подозрительные цены'), h('p', { class: 'sub' }, 'Сравнивает цену с медианой той же модели или категории (нужно от трёх предложений). Низкая цена на брендовый товар чаще всего признак подделки.'),
        h('div', { class: 'toolbar wrapx' }, dev.node, h('button', { class: 'btn ghost', type: 'button', onclick: runD }, 'Проверить')), dOut) : null);
  }

  /* ================================================================== MONITOR */
  async function pageMonitor(el) {
    loading(el);
    try {
      const m = await api('/ai/monitor'), p = pct(m.used_24h, m.limit), bar = h('i'); requestAnimationFrame(() => { bar.style.width = Math.min(100, p) + '%'; });
      put(el, h('div', null, h('h2', null, 'Мониторинг AI'), h('p', { class: 'sub' }, 'Квота, ошибки и скорость ответов за последние сутки.')),
        m.provider === 'mock' ? h('p', { class: 'banner info' }, 'Сейчас включён демо-режим. Вызовов к внешним моделям нет.') : !m.configured ? h('p', { class: 'banner info' }, 'AI выбран, но не настроен: добавьте ключ в «Подключения AI».') : null,
        h('div', { class: 'grid ops' }, kpi(m.provider, 'провайдер', m.model), kpi(`${m.used_24h} / ${m.limit}`, 'вызовов за 24 часа'), kpi(num(m.by_kind.reduce((a, b) => a + (b.failed || 0), 0)), 'ошибок за 24 часа')),
        h('div', { class: 'card' }, h('strong', null, `Дневная квота: ${p}%`), h('div', { class: 'meter' }, bar), h('p', { class: 'hint' }, 'Лимит задаётся в «Подключения AI». При исчерпании пакетные задания останавливаются, а не падают.')),
        h('div', { class: 'two wide' },
          h('div', { class: 'card' }, h('h3', null, 'По типам вызовов'), m.by_kind.length ? h('table', null, h('thead', null, h('tr', null, ['Тип', 'Вызовов', 'Ошибок', 'Среднее, мс'].map(t => h('th', null, t)))), h('tbody', null, m.by_kind.map(k => h('tr', null, h('td', null, k.kind), h('td', { class: 'num' }, k.calls), h('td', { class: 'num' }, k.failed), h('td', { class: 'num' }, k.avg_ms))))) : h('p', { class: 'empty' }, 'Вызовов пока не было.')),
          h('div', { class: 'card' }, h('h3', null, 'Последние ошибки'), m.recent_errors.length ? h('table', null, h('tbody', null, m.recent_errors.map(e => h('tr', null, h('td', null, fmtDate(e.ts)), h('td', null, e.kind), h('td', { class: 'wrap' }, e.note || '—'))))) : h('p', { class: 'empty' }, 'Ошибок нет.'))),
        h('div', { class: 'card' }, h('h3', null, 'Как подключить модель'), h('p', { class: 'sub' }, 'Ключ и модели задаются в разделе «Подключения AI» (владелец). Менять код или .env не нужно.'),
          can('secrets.ai') ? h('button', { class: 'btn', type: 'button', onclick: () => go('p_ai_settings') }, 'Открыть «Подключения AI»') : h('p', { class: 'hint' }, 'Попросите владельца открыть раздел «Подключения AI».')));
    } catch (e) { fail(el, e); }
  }

  /* ================================================================== CONNECTIONS (API keys, models, limits) */
  // back from "Войти через OpenRouter": the one-time code arrives in the query string; take it out of the address bar at once
  const orBack = (() => { const q = new URLSearchParams(location.search); const st = q.get('or_state'), code = q.get('code'); if (!st) return null; history.replaceState(null, '', location.pathname + '#p_ai_settings'); return code ? { state: st, code } : { state: st, error: true }; })();

  async function pageConnections(el) {
    loading(el);
    let v; try { v = await api('/ai/settings'); } catch (e) { return fail(el, e); }
    const msg = h('p', { class: 'msg', role: 'status' }), results = h('div', { class: 'card tests', hidden: true });
    const say = (text, bad, pending) => { msg.className = 'msg ' + (pending ? '' : bad ? 'err' : 'ok'); msg.textContent = text; };
    let sel = v.service;                                                     // the service being edited (not saved until «Сохранить»)
    const svcOf = id => v.services.find(s => s.id === id);
    const grid = h('div', { class: 'svcgrid', role: 'radiogroup', 'aria-label': 'Сервис AI' }), panel = h('div', { class: 'card form' });
    const f = {};
    const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
    const inp = (key, attrs = {}) => (f[key] = h('input', { type: 'text', class: 'input', autocomplete: 'off', spellcheck: 'false', 'aria-label': key, ...attrs }));
    inp('model'); inp('embedModel'); inp('imageModel'); inp('baseUrl', { placeholder: 'https://…' });
    inp('timeoutSec', { type: 'number', min: 3, max: 180 }); inp('dailyLimit', { type: 'number', min: 1, max: 1000000 }); inp('reviewConfidence', { type: 'number', min: 1, max: 100 });
    const keyIn = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', spellcheck: 'false', 'aria-label': 'API-ключ' });
    const modelSel = h('select', { class: 'input', 'aria-label': 'Модель из списка', hidden: true }), onlyFree = h('input', { type: 'checkbox', 'aria-label': 'Только бесплатные' });
    let models = [];
    const drawModels = () => {
      const list = models.filter(m => !onlyFree.checked || m.free);
      put(modelSel, h('option', { value: '' }, `— выберите из ${list.length} моделей —`), list.map(m => h('option', { value: m.id, selected: m.id === f.model.value || null }, (m.free ? '🆓 ' : '') + m.id + (m.label ? ' — ' + m.label : '') + (m.vision ? ' · видит фото' : ''))));
      modelSel.hidden = !models.length;
    };
    modelSel.addEventListener('change', () => { if (modelSel.value) f.model.value = modelSel.value; });
    onlyFree.addEventListener('change', drawModels);
    const loadBtn = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
      loadBtn.disabled = true; say('Загружаю список моделей…', false, true);
      try { const r = await post('/ai/settings/models', { service: sel, apiKey: keyIn.value.trim() || undefined }); models = r.models; onlyFree.checked = models.some(m => m.free) && sel === 'openrouter'; drawModels(); say(`Найдено моделей: ${models.length}. Выберите и нажмите «Сохранить и проверить».`); }
      catch (e) { say(err(e) + (e.detail ? ': ' + e.detail : ''), true); } finally { loadBtn.disabled = false; }
    } }, 'Загрузить список моделей');

    const card = s => {
      const cur = s.id === v.service, on = s.id === sel, paid = /^Платно/.test(s.free);
      return h('button', { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', class: 'svc' + (on ? ' on' : '') + (cur ? ' cur' : ''), onclick: () => { sel = s.id; models = []; drawAll(true); } },
        h('b', null, s.name), h('span', { class: 'tags' }, h('i', { class: paid ? 'paid' : 'free' }, paid ? 'платно' : s.id === 'mock' ? 'демо' : 'есть бесплатно'), s.search ? h('i', null, 'поиск в интернете') : null, s.vision ? h('i', null, 'видит фото') : null, cur ? h('i', { class: 'curtag' }, 'подключено') : null),
        h('small', null, s.free));
    };
    function drawAll(switched) {
      const s = svcOf(sel), cur = sel === v.service;
      put(grid, v.services.map(card));
      if (switched) { f.model.value = cur ? v.model : s.model; f.embedModel.value = cur ? v.embedModel : s.embedModel; f.imageModel.value = cur ? v.imageModel : s.imageModel; f.baseUrl.value = cur ? (v.baseUrl || '') : ''; keyIn.value = ''; }
      f.timeoutSec.value = Math.round(v.timeoutMs / 1000); f.dailyLimit.value = v.dailyLimit; f.reviewConfidence.value = v.reviewConfidence;
      const hasKey = cur ? v.has_key : v.saved_keys.includes(sel);
      keyIn.placeholder = hasKey ? (cur ? `сохранён ${v.key_hint} — оставьте пустым, чтобы не менять` : 'ключ этого сервиса уже сохранён') : 'вставьте ключ';
      drawModels();
      const orBtn = s.oauth ? h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try { const r = await post('/ai/oauth/openrouter/start', { origin: location.origin }); location.assign(r.url); } catch (e) { say(err(e), true); }
      } }, '⚡ Войти через OpenRouter — ключ создастся сам') : null;
      put(panel, h('h3', null, s.name), h('p', { class: 'hint' }, s.free + ' Лимиты провайдеры меняют — актуальные условия на их сайте.'),
        orBtn ? h('div', { class: 'row' }, orBtn, h('span', { class: 'hint' }, 'Откроется OpenRouter: войдите (можно через Google), подтвердите — и вернётесь сюда уже подключёнными.')) : null,
        s.id === 'mock' ? null : h('div', { class: 'two' },
          field('API-ключ', keyIn, s.keyUrl ? null : 'Если сервер без ключа — оставьте пустым.'),
          s.keyUrl ? h('div', { class: 'field' }, h('span', null, 'Где взять ключ'), h('a', { class: 'btn ghost sm', href: s.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, (s.id === 'ollama' ? 'Скачать Ollama' : 'Открыть страницу ключей') + ' ↗'), h('small', { class: 'hint' }, 'Создайте ключ, скопируйте и вставьте слева.')) : null),
        s.needsUrl ? field('Адрес сервера', f.baseUrl, 'Например https://my-ollama.example.com. Внутренние адреса разрешаются только флагом AI_ALLOW_PRIVATE_HOSTS=1 на сервере.') : null,
        s.id === 'mock' ? null : h('div', { class: 'two' }, field('Модель (текст и фото → карточка)', f.model), h('div', { class: 'field' }, h('span', null, 'Выбрать из списка'), h('div', { class: 'row' }, loadBtn, models.some(m => m.free) ? h('label', { class: 'row' }, onlyFree, h('span', null, 'только бесплатные')) : null), modelSel)),
        s.id === 'mock' ? null : h('details', null, h('summary', null, 'Дополнительно: поиск, картинки, лимиты'),
          h('div', { class: 'two' }, field('Эмбеддинги (поиск по смыслу)', f.embedModel, 'local — встроенный поиск на сервере (без внешних вызовов).'), field('Картинки (AI Canvas)', f.imageModel, 'Пусто — у этого сервиса генерации картинок нет.')),
          h('div', { class: 'two' }, field('Вызовов в сутки (защита от расходов)', f.dailyLimit), field('Таймаут запроса, сек', f.timeoutSec)),
          field('Порог «Требует проверки», %', f.reviewConfidence)),
        h('div', { class: 'row actions' }, saveBtn, testBtn, cur && v.key_source === 'settings' ? delKey : null, resetBtn), msg, results);
    }
    const body = () => {
      const s = svcOf(sel), b = { service: sel, model: f.model.value.trim(), embedModel: f.embedModel.value.trim(), imageModel: f.imageModel.value.trim(),
        timeoutMs: Number(f.timeoutSec.value) * 1000, dailyLimit: Number(f.dailyLimit.value), reviewConfidence: Number(f.reviewConfidence.value) };
      if (s.needsUrl) b.baseUrl = f.baseUrl.value.trim();
      if (keyIn.value.trim()) b.apiKey = keyIn.value.trim();
      return b;
    };
    const runTest = async () => {
      const r = await post('/ai/settings/test'); results.hidden = false;
      results.replaceChildren(h('h3', null, r.ok ? '✓ Подключение работает' : '✗ Подключение не работает'),
        ...r.steps.map(s => h('div', { class: 'trow ' + (s.ok ? 'ok' : 'bad') }, h('b', null, (s.ok ? '✓ ' : '✗ ') + ({ chat: 'Текстовая модель', embeddings: 'Поиск по смыслу', config: 'Настройка' }[s.name] || s.name)), h('span', null, `${s.ms} мс`), s.ok ? null : h('span', { class: 'hint' }, [s.error, s.detail].filter(Boolean).join(': ')))));
      return r;
    };
    const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      saveBtn.disabled = true; say('Сохраняю и проверяю…', false, true);
      try { v = await api('/ai/settings', { method: 'PUT', body: body() }); sel = v.service; drawAll(true); const r = await runTest(); say(r.ok ? `Готово: ${svcOf(v.service).name} · ${v.model} работает.` : 'Сохранено, но проверка не прошла — подробности ниже.', !r.ok); toast('Подключение сохранено'); }
      catch (e) { say(err(e), true); } finally { saveBtn.disabled = false; }
    } }, 'Сохранить и проверить');
    const testBtn = h('button', { class: 'btn', type: 'button', onclick: async () => { testBtn.disabled = true; say('Проверяю…', false, true); try { const r = await runTest(); say(r.ok ? 'Работает.' : 'Есть ошибки.', !r.ok); } catch (e) { say(err(e), true); } finally { testBtn.disabled = false; } } }, 'Проверить текущее');
    const delKey = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { if (!confirm('Удалить сохранённый ключ этого сервиса?')) return; try { v = await api('/ai/settings/key', { method: 'DELETE' }); drawAll(true); say('Ключ удалён.'); } catch (e) { say(err(e), true); } } }, 'Удалить ключ');
    const resetBtn = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { if (!confirm('Сбросить подключение к настройкам из .env сервера?')) return; try { v = await post('/ai/settings/reset'); sel = v.service; drawAll(true); say('Сброшено.'); } catch (e) { say(err(e), true); } } }, 'Сбросить');

    put(el, h('div', null, h('h2', null, 'Подключения AI'), h('p', { class: 'sub' }, 'Выберите сервис, вставьте ключ (для OpenRouter — просто войдите), выберите модель — и всё заработает. Ключи хранятся зашифрованными и в браузер не возвращаются.')),
      grid, panel,
      h('div', { class: 'card' }, h('h3', null, 'Безопасность'), h('ul', { class: 'hint' },
        h('li', null, 'Ключи шифруются на сервере и никогда не показываются; у каждого сервиса свой ключ.'),
        h('li', null, 'Адреса сервисов зашиты в админку — запрос нельзя перенаправить на чужой сервер.'),
        h('li', null, 'Поставьте лимит расходов у самого провайдера; для OpenRouter его можно задать при входе.'))));
    drawAll(true);
    if (orBack) {
      if (orBack.error) say('Вход в OpenRouter отменён.', true);
      else { say('Подключаю OpenRouter…', false, true); try { v = await post('/ai/oauth/openrouter/exchange', orBack); sel = v.service; drawAll(true); say('OpenRouter подключён. Загружаю модели…', false, true); loadBtn.click(); } catch (e) { say(err(e), true); } }
    }
  }

  /* ================================================================== TRANSLATIONS */
  async function pageI18n(el) {
    loading(el);
    let v; try { v = await api('/ai/i18n'); } catch (e) { return fail(el, e); }
    const head = h('div', { class: 'card form' }), list = h('div');
    const canRun = can('ai.run');
    const draw = () => {
      const chips = Object.entries(v.langs_all).map(([k, name]) => { const on = v.langs.includes(k); return h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', disabled: !canRun || null,
        onclick: async () => { const langs = on ? v.langs.filter(x => x !== k) : [...v.langs, k]; try { v = await api('/ai/i18n', { method: 'PUT', body: { langs } }); draw(); } catch (e) { toast(err(e), true); } } }, k.toUpperCase() + ' · ' + name); });
      const src = h('select', { class: 'input', 'aria-label': 'Язык исходных карточек', disabled: !canRun || null }, Object.entries(v.langs_all).map(([k, n]) => h('option', { value: k, selected: k === v.source || null }, n)));
      src.addEventListener('change', async () => { try { v = await api('/ai/i18n', { method: 'PUT', body: { source: src.value } }); draw(); } catch (e) { toast(err(e), true); } });
      const auto = h('input', { type: 'checkbox', checked: v.auto || null, disabled: !canRun || null, 'aria-label': 'Автоперевод' });
      auto.addEventListener('change', async () => { try { v = await api('/ai/i18n', { method: 'PUT', body: { auto: auto.checked } }); draw(); } catch (e) { toast(err(e), true); } });
      const bar = h('i'), out = h('p', { class: 'hint' });
      const go = h('button', { class: 'btn primary', type: 'button', disabled: !canRun || !v.pending || null, onclick: async () => {
        go.disabled = true; const all = v.pending;
        try {
          for (;;) { const r = await post('/ai/translate/all', { limit: 15 }); v = { ...v, ...r }; bar.style.width = Math.round((all - r.left) * 100 / Math.max(all, 1)) + '%'; out.textContent = `Переведено ${all - r.left} из ${all}` + (r.failed ? `, ошибок ${r.failed}` : '');
            if (r.stopped) { out.textContent += r.stopped === 'ai_quota' ? ' — дневной лимит AI.' : ' — AI не подключён.'; break; } if (!r.left || !r.done) break; }
        } catch (e) { out.textContent = err(e); }
        draw(); renderList();
      } }, v.pending ? `Перевести всё (${v.pending})` : 'Всё переведено ✓');
      put(head, h('h3', null, 'Языки магазина'), h('div', { class: 'chips' }, chips),
        h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'На каком языке пишутся карточки'), src),
          h('label', { class: 'field row' }, auto, h('span', null, 'Переводить автоматически: новые и изменённые карточки переводятся сами каждые несколько минут'))),
        h('p', null, `Пар «товар × язык»: ${v.total}, нужно перевести: ${v.pending}, проверено человеком: ${v.verified}.` + (v.mock ? ' Сейчас демо-режим AI — переводы будут помечены как демо.' : '')),
        h('div', { class: 'row' }, go), h('div', { class: 'progress' }, bar), out);
    };
    const renderList = () => { const r = meta('translations'); resourceView(r, EXTRA.translations)(list); };
    put(el, h('div', null, h('h2', null, 'Переводы карточек'), h('p', { class: 'sub' }, 'Выберите языки — AI переведёт все карточки и будет сам переводить новые. Если исходный текст меняется, перевод обновляется.')), head, list);
    draw(); renderList();
  }

  /* ================================================================== COMPETITORS */
  async function pageCompetitors(el) {
    loading(el);
    let v; try { v = await api('/ai/competitors'); } catch (e) { return fail(el, e); }
    const msg = h('p', { class: 'msg', role: 'status' }), table_ = h('div'), bar = h('i');
    const draw = () => put(table_, v.rows.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Товар', 'Закупка', 'Наша цена', 'Мин. у конкурентов', 'Разница', 'Предложений', 'Проверено'].map(t => h('th', null, t)))),
      h('tbody', null, v.rows.map(p => h('tr', null, h('td', { class: 'name' }, h('b', null, p.title), h('small', { class: 'sup' }, p.sku)), h('td', { class: 'num' }, p.cost != null ? money(p.cost) : '—'), h('td', { class: 'num' }, money(p.price)),
        h('td', { class: 'num' }, p.competitor_price ? money(p.competitor_price) : '—'), h('td', { class: 'num' + (p.diff_pct > 3 ? ' warn' : '') }, p.diff_pct != null ? (p.diff_pct > 0 ? '+' : '') + p.diff_pct + '%' : '—'),
        h('td', null, `${p.offers} (✓ ${p.verified})`), h('td', null, p.competitor_checked_at ? fmtDate(p.competitor_checked_at) : 'не проверялся')))))) : h('p', { class: 'empty' }, 'Товаров пока нет.'));
    const run = h('button', { class: 'btn primary', type: 'button', disabled: !v.web || null, onclick: async () => {
      run.disabled = true; const total = v.rows.length; let done = 0; const seen = [];
      try {
        for (;;) {
          const r = await post('/ai/competitors/run', { limit: 3, skip: seen }); r.results.forEach(x => seen.push(x.id)); done += r.results.length;
          bar.style.width = Math.round(done * 100 / Math.max(total, 1)) + '%'; msg.className = 'msg'; msg.textContent = `Проверено ${done} из ${total}…`;
          if (r.stopped) { msg.className = 'msg err'; msg.textContent = err({ message: r.stopped }); break; }
          if (!r.left || !r.results.length) { msg.className = 'msg ok'; msg.textContent = `Готово: проверено ${done} товаров.`; break; }
        }
      } catch (e) { msg.className = 'msg err'; msg.textContent = err(e); }
      try { v = await api('/ai/competitors'); draw(); } catch { /* keep */ } run.disabled = false;
    } }, 'Сравнить цены всех товаров');
    put(el, h('div', null, h('h2', null, 'Цены конкурентов'), h('p', { class: 'sub' }, 'AI ищет каждый ваш товар на Amazon, Allegro, eBay, AliExpress, Temu, Kaufland, Empik, Ceneo, Idealo, OLX, Etsy, Zalando, MediaMarkt, Otto, Cdiscount, Bol.com, Walmart и сравнивает цены. У каждой цены есть ссылка; в расчёт идут только цены, подтверждённые поиском.')),
      !v.web ? h('p', { class: 'msg err' }, v.mock ? 'Сейчас демо-режим AI: поиск в интернете не выполняется. Подключите Google Gemini (есть бесплатно), OpenRouter или OpenAI в «Подключения AI».' : 'Подключённый сервис AI не умеет искать в интернете. Выберите Google Gemini, OpenRouter или OpenAI в «Подключения AI».') : null,
      h('div', { class: 'row' }, run), h('div', { class: 'progress' }, bar), msg, table_,
      h('p', { class: 'hint' }, 'Подробности по товару (все найденные предложения со ссылками) — в «Товары и SKU» → откройте товар → «Цены конкурентов». Каждая проверка тратит один вызов AI.'));
    draw();
  }

  /* ================================================================== FUNCTION MAP */
  async function pageFunctions(el) {
    loading(el);
    try {
      const { rows } = await api('/ai/functions'), groups = [];
      for (const r of rows) { let g = groups.find(x => x.n === r.group); if (!g) groups.push(g = { n: r.group, items: [] }); g.items.push(r); }
      const LBL = { ready: 'было', new: 'добавлено', sim: 'имитация' };
      const known = new Set(window.Asv.navEntries().map(e => e.id));
      const cnt = k => rows.filter(r => r.status === k).length;
      put(el, h('div', null, h('h2', null, 'Карта 35 функций'), h('p', { class: 'sub' }, `Добавлено ${cnt('new')}, уже работало ${cnt('ready')}, с имитацией внешних вызовов ${cnt('sim')}.`)),
        groups.map(g => h('div', { class: 'card fgroup' }, h('h3', null, g.n), h('ul', { class: 'flist' }, g.items.map(f => h('li', null, h('span', { class: 'fn' }, f.n), h('div', { class: 'ftxt' }, h('span', null, f.title), f.note ? h('small', null, f.note) : null),
          h('span', { class: 'pill fs-' + f.status }, LBL[f.status]), known.has(f.nav) ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go(f.nav) }, 'Открыть') : h('span', { class: 'hint' }, 'нет доступа')))))));
    } catch (e) { fail(el, e); }
  }

  /* ================================================================== NAVIGATION */
  const prev = window.Asv.navEntries;
  window.Asv.navEntries = () => {
    const base = prev();
    if (state.gated) return base;
    const out = [], skip = new Set(['r_products', 'r_ai_jobs']);
    const resEntry = (name, group) => { const r = meta(name); return r ? { id: 'r_' + name, label: r.label, group, render: resourceView(r, EXTRA[name]) } : null; };
    const pageE = (id, label, group, render, ok = true) => (ok ? { id, label, group, render } : null);
    const add = (...e) => out.push(...e.filter(Boolean));
    add(pageE('p_dashboard', 'Обзор операций', 'Обзор', pageDashboard, can('analytics.read') || can('ai.read')), pageE('p_functions', 'Карта 35 функций', 'Обзор', pageFunctions, can('ai.read')));
    add(pageE('p_catalog', 'Товары и SKU', 'Товары и SKU', pageCatalog, !!meta('products')), pageE('p_import', 'Импорт CSV', 'Товары и SKU', pageImport, can('products.write') && !!meta('sellers')));
    for (const e of base) {
      if (e.id === 'dash') { out.push({ ...e, label: 'Хранилище и подписчики', group: 'Система' }); continue; }
      if (e.id === 'p_analytics' || e.id === 'p_sellerdash') { out.push(e); continue; }
      if (!skip.has(e.id)) out.push(e);
    }
    const ai = [pageE('p_review', 'Быстрая проверка', 'AI Studio', pageReview, can('ai.read') && !!meta('products')), pageE('p_studio', 'Пакетная генерация', 'AI Studio', pageStudio, can('ai.run')),
      pageE('p_canvas', 'AI Canvas', 'AI Studio', pageCanvas, can('ai.read') && !!meta('canvases')), pageE('p_search', 'Поиск по смыслу', 'AI Studio', pageSearch, can('ai.read')),
      resEntry('brand_kits', 'AI Studio'), meta('translations') ? pageE('r_translations', meta('translations').label, 'AI Studio', pageI18n) : null, pageE('p_competitors', 'Цены конкурентов', 'AI Studio', pageCompetitors, can('pricing.read') && !!meta('products')), resEntry('ab_tests', 'AI Studio'), resEntry('ai_jobs', 'AI Studio')].filter(Boolean);
    const integ = [pageE('p_ai_settings', 'Подключения AI', 'Интеграции', pageConnections, can('secrets.ai')), resEntry('channels', 'Интеграции'), resEntry('channel_listings', 'Интеграции')].filter(Boolean);
    const mon = [pageE('p_pricing_robot', 'Ценовые роботы', 'Финансы и цены', pageRobots, can('pricing.read')), pageE('p_monitor', 'Мониторинг AI', 'Безопасность', pageMonitor, can('ai.read'))].filter(Boolean);
    out.push(...ai, ...integ, ...mon);
    const ORDER = ['Обзор', 'Товары и SKU', 'AI Studio', 'Интеграции', 'Заказы', 'Продавцы и каталог', 'Логистика', 'Финансы и цены', 'Маркетинг и SEO', 'Поддержка', 'Безопасность', 'Система'];
    const rank = g => { const i = ORDER.indexOf(g); return i < 0 ? 99 : i; };
    return out.map((e, i) => [e, i]).sort((a, b) => rank(a[0].group) - rank(b[0].group) || a[1] - b[1]).map(x => x[0]);
  };
})();
