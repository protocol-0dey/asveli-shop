'use strict';
/* Asveli admin — business modules UI. Schema-driven: the server tells us (per role) which resources, fields and actions exist,
   so a role never even sees screens it cannot use. Server-side checks remain the real gate. No innerHTML anywhere. */
(() => {
  const { h, api, state, errText, fmtDate, loading, fail } = window.Asv;

  const can = p => state.me.perms.some(x => x === '*' || x === p || (x.endsWith('.*') && p.startsWith(x.slice(0, -1))));
  const money = v => (v == null ? '—' : (v / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + state.me.currency);
  const parseMoney = s => { s = String(s).trim().replace(',', '.'); const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(s); return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0) : NaN; };
  const BASE = { id: '#', created_at: 'Создано', updated_at: 'Обновлено', created_by: 'Кем' };
  const CODES = { carrier_needs_tariff: 'Без тарифа перевозчика включить нельзя: впишите базовую цену или цену за кг (или отметьте «Бесплатная доставка»).', unknown_carrier: 'Неизвестный перевозчик.', markup_needs_cost: 'Чтобы считать цену из наценки, укажите закупочную цену и наценку.', invalid_service: 'Неизвестный сервис AI.', models_failed: 'Сервис не отдал список моделей (проверьте ключ)', base_url_required: 'Сначала укажите и сохраните адрес сервера.',
    invalid_origin: 'Откройте админку по адресу localhost или https.', oauth_state_invalid: 'Вход устарел или уже использован — нажмите «Войти через OpenRouter» ещё раз.', oauth_code_invalid: 'OpenRouter вернул неверный код.', oauth_exchange_failed: 'OpenRouter не выдал ключ',
    ai_no_web_search: 'Подключённая модель не умеет искать в интернете. Для сравнения цен выберите Google Gemini, OpenRouter или OpenAI в «Подключения AI».', no_analysis: 'Сначала запустите AI-анализ.', translate_running: 'Перевод уже идёт.', invalid_langs: 'Выберите хотя бы один язык.',
    price_guard: 'Защита цен: такое изменение выглядит как ошибка (ноль или резкое падение). Подтвердите явно или исправьте.', maintenance_on: 'Магазин на техработах.', ai_not_configured: 'AI не подключён: откройте «Подключения AI» и вставьте ключ.', ai_failed: 'Провайдер AI вернул ошибку. Проверьте ключ и модель в «Подключения AI».', ai_quota: 'Дневной лимит вызовов AI исчерпан.', base_url_must_be_https: 'Адрес должен начинаться с https://', base_url_private_host: 'Адрес указывает на внутреннюю сеть — это запрещено.', base_url_unresolvable: 'Не удалось найти такой адрес.', invalid_base_url: 'Некорректный адрес (без логина, параметров и #).', invalid_api_key: 'Ключ выглядит неверно (8–400 символов, без пробелов).', invalid_provider: 'Неизвестный провайдер.', invalid_model: 'Название модели: латиница, цифры и . _ - : /', invalid_timeout: 'Таймаут: от 3 до 180 секунд.', invalid_daily_limit: 'Лимит вызовов: целое число от 1.', invalid_review_confidence: 'Порог проверки: от 1 до 100.', nothing_to_update: 'Нечего сохранять.', duplicate: 'Такая запись уже есть.', kyc_required: 'Сначала пройдите KYC.', kyc_locked: 'После KYC реквизиты заблокированы.', four_eyes_required: 'Нужен другой сотрудник: подготовивший операцию не может её одобрить.',
    insufficient_balance: 'Недостаточно средств на балансе продавца.', out_of_stock: 'Нет в наличии на одном складе.', customer_blocked: 'Покупатель заблокирован.', bad_state: 'Действие недоступно в текущем статусе.',
    password_required: 'Неверный пароль.', too_many_reveals: 'Лимит просмотров персональных данных исчерпан, попробуйте позже.', exceeds_limit: 'Сумма выше лимита.', exceeds_eligibility: 'Сумма выше лимита.',
    order_not_shippable: 'Заказ заморожен или отменён — отправка запрещена.', seller_not_active: 'Продавец не активен.', compliance_block: 'Товар нарушает комплаенс-правила.', min_below_cost: 'Мин. цена ниже себестоимости.',
    percent_too_high: 'Скидка не может быть больше 90%.', unknown_field: 'Неизвестное поле.', invalid_id: 'Некорректный номер.', coupon_exhausted: 'Купон исчерпан.', coupon_expired: 'Купон не действует.', invalid_coupon: 'Купон не найден.' };
  const err = e => CODES[e.message] || (e.message && e.message.startsWith('required_') ? 'Заполните поле: ' + e.message.slice(9) : e.message && e.message.startsWith('invalid_') ? 'Некорректное значение: ' + e.message.slice(8) : errText(e));
  const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(2).filter(n => n != null && n !== false));
  const meta = name => state.meta.find(r => r.name === name);
  const colLabel = (res, k) => BASE[k] || (res.fields.find(f => f.k === k) || {}).label || k;

  function cell(res, k, row) {
    const f = res.fields.find(x => x.k === k), v = row[k];
    if (k === 'created_at' || k === 'updated_at') return fmtDate(v);
    if (!f) return v ?? '—';
    if (v == null) return '—';
    if (f.t === 'ref') return row[k + '__label'] ?? '#' + v;
    if (f.t === 'money' || f.fmt === 'money') return h('span', { class: 'num' }, money(v));
    if (f.t === 'bps') return (v / 100) + '%';
    if (f.t === 'date') return fmtDate(v);
    if (f.t === 'bool') return v ? '✓' : '—';
    if (f.t === 'enum') return h('span', { class: 'pill st-' + v }, v);
    if (f.t === 'pii') return h('span', { class: 'mono masked' }, v);
    return String(v);
  }
  function table(res, rows, onRow) {
    if (!rows.length) return h('p', { class: 'empty' }, 'Пусто.');
    const head = h('thead', null, h('tr', null, res.list.map(k => h('th', null, colLabel(res, k)))));
    const body = h('tbody', null, rows.map(r => {
      const tr = h('tr', { class: onRow ? 'click' : null, tabindex: onRow ? 0 : null }, res.list.map(k => h('td', null, cell(res, k, r))));
      if (onRow) { tr.addEventListener('click', () => onRow(r)); tr.addEventListener('keydown', e => { if (e.key === 'Enter') onRow(r); }); }
      return tr;
    }));
    return h('div', { class: 'tablewrap' }, h('table', null, head, body));
  }

  /* ---------- dialogs ---------- */
  function modal(title, body, { wide = false, onclose } = {}) {
    const dlg = h('dialog', { class: wide ? 'wide' : null }, h('div', { class: 'col' }, h('div', { class: 'dhead' }, h('h2', null, title), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => dlg.close() }, '✕')), body));
    dlg.addEventListener('close', () => { dlg.remove(); if (onclose) onclose(); });
    document.body.append(dlg); dlg.showModal(); return dlg;
  }

  /* ---------- form inputs ---------- */
  function refSelect(f, current) {
    const sel = h('select', { 'aria-label': f.label }), q = h('input', { type: 'search', placeholder: 'поиск…', 'aria-label': 'Поиск: ' + f.label });
    const load = async () => {
      try {
        const { rows } = await api(`/m/${f.ref}/options` + (q.value ? '?q=' + encodeURIComponent(q.value) : ''));
        put(sel, h('option', { value: '' }, f.req ? '— выберите —' : '— нет —'), rows.map(r => h('option', { value: r.id, selected: String(r.id) === String(current) }, `#${r.id} ${r.label}`)));
        if (current && !rows.some(r => String(r.id) === String(current))) sel.append(h('option', { value: current, selected: true }, '#' + current));
      } catch { put(sel, h('option', { value: current || '' }, current ? '#' + current : '—')); }
    };
    let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); }); load();
    return { el: h('div', { class: 'refpick' }, q, sel), get: () => (sel.value ? Number(sel.value) : null) };
  }
  function input(f, cur, { edit = false } = {}) {
    const lab = f.label + (f.req ? ' *' : '');
    let el, get;
    const num = () => { const v = el.value.trim(); if (v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
    if (f.t === 'ref') { const r = refSelect(f, cur); return { lab, el: r.el, get: r.get, hint: f.hint }; }
    if (f.t === 'longtext') { el = h('textarea', { rows: 4, maxlength: f.max || 5000, 'aria-label': f.label }); el.value = cur ?? ''; get = () => el.value.trim() || null; }
    else if (f.t === 'bool') { el = h('input', { type: 'checkbox', checked: !!cur, 'aria-label': f.label }); get = () => el.checked; }
    else if (f.t === 'enum') { el = h('select', { 'aria-label': f.label }, f.req ? null : h('option', { value: '' }, '—'), f.vals.map(v => h('option', { value: v, selected: v === cur }, v))); get = () => el.value || null; }
    else if (f.t === 'date') { el = h('input', { type: 'date', 'aria-label': f.label, value: cur ? new Date(cur).toISOString().slice(0, 10) : '' }); get = () => el.value || null; }
    else if (f.t === 'money' || f.fmt === 'money') { el = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', 'aria-label': f.label, value: cur != null ? (cur / 100).toFixed(2) : '' }); get = () => (el.value.trim() === '' ? null : parseMoney(el.value)); }
    else if (f.t === 'int' || f.t === 'bps') { el = h('input', { type: 'number', step: 1, 'aria-label': f.label, value: cur ?? '' }); get = num; }
    else { el = h('input', { type: 'text', maxlength: f.max || 200, 'aria-label': f.label, autocomplete: 'off', placeholder: f.t === 'pii' && edit ? 'пусто = без изменений' : '' }); el.value = f.t === 'pii' ? '' : (cur ?? ''); get = () => el.value.trim() || null; }
    return { lab, el, get, hint: f.hint || (f.t === 'bps' ? 'bps: 100 = 1%' : f.t === 'money' ? `сумма в ${state.me.currency}` : '') };
  }
  function formFields(fields, values = {}, opts = {}) {
    const ins = fields.map(f => ({ f, ...input(f, values[f.k], opts) }));
    const nodes = ins.map(i => (i.f.t === 'bool'
      ? h('label', { class: 'field row' }, i.el, i.lab)
      : h('label', { class: 'field' }, i.lab, i.el, i.hint ? h('small', { class: 'hint' }, i.hint) : null)));
    // collect(): returns payload or throws a readable error. edit mode sends only fields that changed.
    const collect = ({ onlyChanged = false } = {}) => {
      const out = {};
      for (const i of ins) {
        const v = i.get();
        if (typeof v === 'number' && Number.isNaN(v)) throw new Error('invalid_' + i.f.k);
        if (onlyChanged) {
          const cur = values[i.f.k];
          if (i.f.t === 'pii') { if (v == null) continue; }
          else if ((v ?? null) === (cur ?? null) || (i.f.t === 'bool' && v === !!cur)) continue;
        } else if (v == null && !i.f.req) continue;
        out[i.f.k] = v;
      }
      return out;
    };
    return { nodes, collect };
  }

  /* ---------- action dialog ---------- */
  function runAction(res, row, a, done) {
    const go = async body => { try { const r = await api(`/m/${res.name}/${row.id}/do/${a.k}`, { method: 'POST', body }); done(r); return true; } catch (e) { return err(e); } };
    if (!a.fields.length) { if (a.confirm && !confirm(`${a.label}? Действие попадёт в журнал.`)) return; go({}).then(r => { if (typeof r === 'string') alert(r); }); return; }
    const form = formFields(a.fields), msg = h('p', { class: 'msg err' });
    const dlg = modal(a.label, h('form', { class: 'col', onsubmit: async ev => {
      ev.preventDefault(); msg.textContent = '';
      try { const r = await go(form.collect()); if (r === true) dlg.close(); else msg.textContent = r; } catch (e) { msg.textContent = err(e); } } },
      form.nodes, h('button', { class: 'btn', type: 'submit' }, 'Выполнить'), msg));
  }

  /* ---------- reveal ---------- */
  function revealDialog(res, row, f, cellEl) {
    const pw = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Ваш пароль' }), msg = h('p', { class: 'msg err' });
    const dlg = modal('Показать персональные данные', h('form', { class: 'col', onsubmit: async ev => {
      ev.preventDefault();
      try {
        const r = await api(`/m/${res.name}/${row.id}/reveal`, { method: 'POST', body: { field: f.k, password: pw.value } });
        const old = cellEl.textContent; cellEl.textContent = r.value ?? '—'; cellEl.classList.add('shown'); dlg.close();
        setTimeout(() => { cellEl.textContent = old; cellEl.classList.remove('shown'); }, 20000);     // hides itself again after 20 s
      } catch (e) { msg.textContent = err(e); pw.value = ''; } } },
      h('p', { class: 'sub' }, `Поле «${f.label}». Просмотр фиксируется в журнале, число просмотров в час ограничено. Введите свой пароль.`), pw, h('button', { class: 'btn', type: 'submit' }, 'Показать'), msg));
    pw.focus();
  }

  /* ---------- detail ---------- */
  const RELATED = { orders: [['order_items', 'order_id'], ['shipments', 'order_id'], ['fraud_flags', 'order_id']], tickets: [['ticket_notes', 'ticket_id']], products: [['price_history', 'product_id'], ['stock', 'product_id']],
    sellers: [['products', 'seller_id'], ['payouts', 'seller_id']], customers: [['orders', 'customer_id']], coupons: [['coupon_uses', 'coupon_id']] };
  async function openDetail(res, id, refresh) {
    let row; try { row = await api(`/m/${res.name}/${id}`); } catch (e) { alert(err(e)); return; }
    const body = h('div', { class: 'col' });
    const draw = () => {
      const dl = h('dl', { class: 'kv' }, [{ k: 'id', label: '#' }, ...res.fields, { k: 'created_at', label: 'Создано' }, { k: 'created_by', label: 'Кем' }].map(f => {
        const full = res.fields.find(x => x.k === f.k) || f;
        const val = h('dd', null, full.t ? cell(res, f.k, row) : (f.k === 'created_at' ? fmtDate(row[f.k]) : row[f.k] ?? '—'));
        if (full.t === 'pii' && row[f.k] != null && res.can.reveal) val.append(' ', h('button', { class: 'btn ghost sm', type: 'button', onclick: () => revealDialog(res, row, full, val.firstChild) }, 'Показать'));
        return [h('dt', null, full.label || f.k), val];
      }));
      const acts = h('div', { class: 'toolbar' }, res.actions.map(a => h('button', { class: 'btn sm' + (a.confirm ? ' ghost' : ''), type: 'button', onclick: () => runAction(res, row, a, r => { dlg.close(); refresh && refresh(); if (r && typeof r === 'object' && !r.id && Object.keys(r).length) alert(Object.entries(r).map(([k, v]) => `${k}: ${typeof v === 'number' ? money(v) : v}`).join('\n')); }) }, a.label)),
        res.can.update ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { dlg.close(); openForm(res, row, refresh); } }, 'Изменить') : null,
        res.can.remove ? h('button', { class: 'btn danger sm', type: 'button', onclick: async () => { if (!confirm('Удалить запись?')) return; try { await api(`/m/${res.name}/${row.id}`, { method: 'DELETE' }); dlg.close(); refresh && refresh(); } catch (e) { alert(err(e)); } } }, 'Удалить') : null);
      put(body, acts, dl);
      for (const [rn, fk] of RELATED[res.name] || []) {
        const rr = meta(rn); if (!rr) continue;
        const box = h('div', { class: 'card sub-card' }, h('strong', null, rr.label)); body.append(box);
        api(`/m/${rn}?${fk}=${row.id}&limit=20`).then(d => {
          box.append(table(rr, d.rows));
          if (rn === 'ticket_notes' && rr.can.create) {
            const t = h('textarea', { rows: 2, maxlength: 3000, 'aria-label': 'Заметка' });
            box.append(h('form', { class: 'col', onsubmit: async ev => { ev.preventDefault(); if (!t.value.trim()) return; try { await api('/m/ticket_notes', { method: 'POST', body: { ticket_id: row.id, body: t.value.trim() } }); draw(); } catch (e) { alert(err(e)); } } }, t, h('button', { class: 'btn sm', type: 'submit' }, 'Добавить заметку')));
          }
        }).catch(() => {});
      }
    };
    const dlg = modal(`${res.label}: ${row[res.title] != null ? (res.fields.find(f => f.k === res.title) && res.fields.find(f => f.k === res.title).t === 'ref' ? '' : row[res.title]) : '#' + row.id}`, body, { wide: true });
    draw();
  }

  /* ---------- create / edit ---------- */
  function openForm(res, row, refresh) {
    const fields = res.fields.filter(f => !f.ro), form = formFields(fields, row || {}, { edit: !!row }), msg = h('p', { class: 'msg err' });
    const dlg = modal((row ? 'Изменить: ' : 'Новая запись: ') + res.label, h('form', { class: 'col', onsubmit: async ev => {
      ev.preventDefault(); msg.textContent = '';
      try {
        const payload = form.collect({ onlyChanged: !!row });
        if (row && !Object.keys(payload).length) return dlg.close();
        await api(row ? `/m/${res.name}/${row.id}` : `/m/${res.name}`, { method: row ? 'PATCH' : 'POST', body: payload });
        dlg.close(); refresh && refresh();
      } catch (e) { msg.textContent = err(e); } } },
      form.nodes, h('button', { class: 'btn', type: 'submit' }, row ? 'Сохранить' : 'Создать'), msg), { wide: true });
  }

  /* ---------- generic resource page ---------- */
  function resourceView(res, extra) {
    return async el => {
      const state_ = { page: 1, q: '', filters: {} };
      const list = h('div', { class: 'card' }), pager = h('div', { class: 'toolbar' });
      const q = h('input', { type: 'search', placeholder: res.search ? 'Поиск (точный e-mail для персональных данных)' : 'Поиск по №', 'aria-label': 'Поиск' });
      const filt = res.filters.map(k => { const f = res.fields.find(x => x.k === k); if (!f) return null;
        const opts = f.t === 'enum' ? f.vals : f.t === 'bool' ? ['true', 'false'] : null;
        if (!opts) { const i = h('input', { type: 'text', placeholder: f.label, 'aria-label': f.label, size: 10 }); i.addEventListener('change', () => { state_.filters[k] = i.value.trim(); state_.page = 1; load(); }); return i; }
        const s = h('select', { 'aria-label': f.label }, h('option', { value: '' }, f.label + ': все'), opts.map(v => h('option', { value: v }, v)));
        s.addEventListener('change', () => { state_.filters[k] = s.value; state_.page = 1; load(); }); return s; }).filter(Boolean);
      q.addEventListener('keydown', e => { if (e.key === 'Enter') { state_.q = q.value.trim(); state_.page = 1; load(); } });
      const bar = h('div', { class: 'toolbar' }, q, filt, h('span', { class: 'grow' }), extra ? extra(load) : null,
        res.can.create ? h('button', { class: 'btn sm', type: 'button', onclick: () => openForm(res, null, load) }, '+ Создать') : null);
      put(el, h('div', null, h('h2', null, res.label), h('p', { class: 'sub' }, res.group)), bar, list, pager);
      async function load() {
        const qs = new URLSearchParams({ page: state_.page, limit: 50 }); if (state_.q) qs.set('q', state_.q);
        for (const [k, v] of Object.entries(state_.filters)) if (v) qs.set(k, v);
        try {
          const d = await api(`/m/${res.name}?${qs}`);
          put(list, table(res, d.rows, r => openDetail(res, r.id, load)));
          const pages = Math.ceil(d.total / d.limit);
          put(pager, h('span', { class: 'sub' }, `Всего: ${d.total}`), h('span', { class: 'grow' }),
            state_.page > 1 ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { state_.page--; load(); } }, '← Назад') : null,
            state_.page < pages ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { state_.page++; load(); } }, 'Вперёд →') : null);
        } catch (e) { put(list, h('p', { class: 'msg err' }, err(e))); }
      }
      load();
    };
  }
  const EXTRA = {
    alerts: load => (can('alerts.write') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: async ev => { ev.target.disabled = true; try { const r = await api('/alerts/scan', { method: 'POST', body: {} }); alert(`Проверка завершена. Новых алертов: ${r.created}`); load(); } catch (e) { alert(err(e)); } ev.target.disabled = false; } }, 'Запустить проверку аномалий') : null),
    segments: () => null
  };

  /* ---------- special pages ---------- */
  const kpi = (v, label, sub) => h('div', { class: 'card stat' }, h('b', null, v), h('span', null, label), sub ? h('div', null, h('small', null, sub)) : null);
  const barList = (rows, label, value, fmt = money) => { const max = Math.max(1, ...rows.map(r => r[value])); return h('div', { class: 'bars' }, rows.map(r => { const i = h('i'); requestAnimationFrame(() => { i.style.width = (r[value] / max * 100).toFixed(1) + '%'; });
    return h('div', { class: 'barrow' }, h('span', { class: 'bl' }, label(r)), h('div', { class: 'bt' }, i), h('span', { class: 'bv' }, fmt(r[value]))); })); };

  async function pageAnalytics(el) {
    loading(el);
    const days = h('select', { 'aria-label': 'Период' }, [7, 30, 90, 365].map(d => h('option', { value: d, selected: d === 30 }, d + ' дн.')));
    const out = h('div', { class: 'col' });
    const load = async () => {
      try {
        const a = await api('/analytics/platform?days=' + days.value);
        put(out, 
          h('div', { class: 'grid' }, kpi(money(a.gmv), 'GMV (оборот)'), kpi(a.orders, 'Заказов', `средний чек ${money(a.aov)}`), kpi(money(a.commission), 'Комиссия платформы', `take rate ${(a.take_rate_bps / 100).toFixed(1)}%`),
            kpi(a.refunds, 'Возвратов', money(a.refunded_amount)), kpi(a.new_customers, 'Новых покупателей'), kpi(a.held_orders, 'Заказов на hold (антифрод)'), kpi(a.open_alerts, 'Открытых алертов')),
          h('div', { class: 'two' },
            h('div', { class: 'card' }, h('h3', null, 'Оборот по дням'), a.by_day.length ? barList(a.by_day, r => r.d, 'gmv') : h('p', { class: 'empty' }, 'Нет данных')),
            h('div', { class: 'card' }, h('h3', null, 'По странам'), a.by_country.length ? barList(a.by_country, r => r.country, 'gmv') : h('p', { class: 'empty' }, 'Нет данных'))),
          h('div', { class: 'two' },
            h('div', { class: 'card' }, h('h3', null, 'Топ продавцов'), a.top_sellers.length ? barList(a.top_sellers, r => r.name, 'gmv') : h('p', { class: 'empty' }, 'Нет данных')),
            h('div', { class: 'card' }, h('h3', null, 'Топ товаров'), a.top_products.length ? barList(a.top_products, r => r.title, 'gmv') : h('p', { class: 'empty' }, 'Нет данных'))));
      } catch (e) { put(out, h('p', { class: 'msg err' }, err(e))); }
    };
    days.addEventListener('change', load);
    put(el, h('div', null, h('h2', null, 'Аналитика платформы'), h('p', { class: 'sub' }, 'Считается по заказам, книге проводок и событиям. Правила, не ML.')), h('div', { class: 'toolbar' }, days), out); load();
  }
  async function pageSellerDash(el) {
    const picker = refSelect({ label: 'Продавец', ref: 'sellers', req: true }, null), out = h('div', { class: 'col' });
    picker.el.querySelector('select').addEventListener('change', async () => {
      const id = picker.get(); if (!id) return put(out, );
      try {
        const a = await api(`/analytics/seller/${id}?days=30`);
        put(out, h('div', { class: 'grid' }, kpi(money(a.gross), 'Продажи за 30 дн.'), kpi(a.units, 'Единиц', `${a.orders} заказов`), kpi((a.return_rate_bps / 100).toFixed(1) + '%', 'Доля возвратов'),
          kpi(money(a.balance), 'Баланс', `к выплате в очереди: ${money(a.pending_payouts)}`), kpi(money(a.ads.spent), 'Расход на рекламу', `выручка: ${money(a.ads.revenue)}`)),
          h('div', { class: 'card' }, h('h3', null, 'Низкие остатки'), a.low_stock.length ? h('ul', null, a.low_stock.map(r => h('li', null, `${r.title} · склад #${r.warehouse_id}: ${r.free} (порог ${r.reorder_level})`))) : h('p', { class: 'empty' }, 'Всё в порядке.')));
      } catch (e) { put(out, h('p', { class: 'msg err' }, err(e))); }
    });
    put(el, h('div', null, h('h2', null, 'Кабинет продавца'), h('p', { class: 'sub' }, 'Что видит продавец о своих продажах, остатках и рекламе.')), h('div', { class: 'card' }, picker.el), out);
  }
  async function pageNewOrder(el) {
    const cust = refSelect({ label: 'Покупатель', ref: 'customers', req: true }, null), country = h('input', { type: 'text', maxlength: 2, placeholder: 'PL', 'aria-label': 'Страна', size: 3 });
    const coupon = h('input', { type: 'text', placeholder: 'купон (необязательно)', 'aria-label': 'Купон' }), lines = h('div', { class: 'col' }), msg = h('p', { class: 'msg err' }), res = h('div', { class: 'col' });
    const addLine = () => { const p = refSelect({ label: 'Товар', ref: 'products', req: true }, null), q = h('input', { type: 'number', min: 1, value: 1, 'aria-label': 'Кол-во' }); const row = h('div', { class: 'toolbar' }, p.el, q, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => row.remove() }, '✕')); row.get = () => ({ product_id: p.get(), qty: Number(q.value) }); lines.append(row); };
    addLine();
    put(el, h('div', null, h('h2', null, 'Новый заказ'), h('p', { class: 'sub' }, 'Ручной ввод через тот же сервис, что и витрина: склад, налог, комиссия, купон, антифрод.')),
      h('form', { class: 'card col', onsubmit: async ev => {
        ev.preventDefault(); msg.textContent = '';
        try {
          const o = await api('/orders/create', { method: 'POST', body: { customer_id: cust.get(), country: country.value.trim().toUpperCase(), coupon_code: coupon.value.trim() || undefined, items: [...lines.children].map(r => r.get()) } });
          put(res, h('div', { class: 'card' }, h('strong', null, `Заказ ${o.code}: ${o.status}`), h('p', null, `Итого ${money(o.total)} (товары ${money(o.subtotal)}, скидка ${money(o.discount)}, налог ${money(o.tax)}, доставка ${money(o.shipping)})`),
            o.status === 'held' ? h('p', { class: 'msg err' }, `Заморожен антифродом (score ${o.fraud_score}): ${o.hold_reason}`) : null));
        } catch (e) { msg.textContent = err(e) + (e.extra ? '' : ''); }
      } }, h('label', { class: 'field' }, 'Покупатель', cust.el), h('label', { class: 'field' }, 'Страна доставки (ISO-2)', country), h('label', { class: 'field' }, 'Купон', coupon),
        h('h3', null, 'Позиции'), lines, h('button', { class: 'btn ghost sm', type: 'button', onclick: addLine }, '+ позиция'), h('button', { class: 'btn', type: 'submit' }, 'Создать заказ'), msg), res);
  }
  async function pagePricing(el) {
    const out = h('div', { class: 'col' }), under = h('input', { type: 'number', min: 0, max: 2000, value: 100, 'aria-label': 'Занижение, bps' });
    const run = async dry => {
      try {
        const r = await api('/pricing/run', { method: 'POST', body: { dry, undercut_bps: Number(under.value) } });
        put(out, h('p', { class: dry ? 'sub' : 'msg ok' }, dry ? `Предпросмотр: ${r.changes.length} изменений (цены не тронуты)` : `Применено: ${r.changes.length} изменений`),
          r.changes.length ? h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['SKU', 'Было', 'Станет'].map(t => h('th', null, t)))), h('tbody', null, r.changes.map(c => h('tr', null, h('td', null, c.sku), h('td', null, money(c.old_price)), h('td', null, money(c.new_price))))))) : h('p', { class: 'empty' }, 'Менять нечего.'));
      } catch (e) { put(out, h('p', { class: 'msg err' }, err(e))); }
    };
    put(el, h('div', null, h('h2', null, 'Динамический репрайсер'), h('p', { class: 'sub' }, 'Цена = цена конкурента − занижение, но в пределах [макс(мин. цена, себестоимость); макс. цена] и не более ±20% за прогон. Включается флагом «Автоцена» на товаре.')),
      h('div', { class: 'card toolbar' }, h('label', { class: 'field' }, 'Занижение, bps (100 = 1%)', under), h('button', { class: 'btn ghost', type: 'button', onclick: () => run(true) }, 'Предпросмотр'),
        h('button', { class: 'btn', type: 'button', onclick: () => { if (confirm('Применить новые цены?')) run(false); } }, 'Применить')), out);
  }
  async function pageSeo(el) {
    loading(el);
    try {
      const a = await api('/seo/audit');
      put(el, h('div', null, h('h2', null, 'SEO-аудит'), h('p', { class: 'sub' }, `Страниц: ${a.pages}, замечаний: ${a.issues.length}`)),
        h('div', { class: 'card' }, a.issues.length ? h('table', null, h('thead', null, h('tr', null, [h('th', null, 'Путь'), h('th', null, 'Замечание')])), h('tbody', null, a.issues.map(i => h('tr', null, h('td', null, i.path), h('td', null, h('span', { class: 'pill' }, i.issue)))))) : h('p', { class: 'empty' }, 'Замечаний нет.')));
    } catch (e) { fail(el, e); }
  }
  async function pagePersonalization(el) {
    const picker = refSelect({ label: 'Покупатель', ref: 'customers', req: true }, null), out = h('div', { class: 'col' });
    picker.el.querySelector('select').addEventListener('change', async () => {
      const id = picker.get(); if (!id) return put(out, );
      try { const r = await api('/personalization/preview?customer_id=' + id);
        put(out, h('div', { class: 'card' }, h('strong', null, 'Сегменты: '), r.segments.length ? r.segments.map(s => h('span', { class: 'pill' }, s.name)) : 'нет'),
          h('div', { class: 'card' }, h('strong', null, 'Баннеры, которые увидит этот покупатель'), r.banners.length ? h('ul', null, r.banners.map(b => h('li', null, `[${b.placement}] ${b.title}`))) : h('p', { class: 'empty' }, 'Нет подходящих баннеров.')));
      } catch (e) { put(out, h('p', { class: 'msg err' }, err(e))); } });
    put(el, h('div', null, h('h2', null, 'Персонализация витрины'), h('p', { class: 'sub' }, 'Предпросмотр: какие сегменты и баннеры получит выбранный покупатель.')), h('div', { class: 'card' }, picker.el), out);
  }

  /* ---------- staff / IAM ---------- */
  async function pageStaff(el) {
    loading(el);
    const out = h('div', { class: 'col' });
    const manage = can('staff.manage');
    async function load() {
      try {
        const [{ rows }, { roles }, ses] = await Promise.all([api('/staff'), api('/staff/roles'), can('sessions.read') ? api('/sessions') : { rows: [] }]);
        const roleSel = (cur, onchange) => h('select', { onchange }, roles.map(r => h('option', { value: r.role, selected: r.role === cur }, r.label)));
        const showPw = (u, pw) => modal('Временный пароль', h('div', { class: 'col' }, h('p', { class: 'sub' }, `Для ${u}. Показывается один раз; при первом входе его нужно заменить.`), h('input', { type: 'text', readonly: true, value: pw, 'aria-label': 'Пароль' })));
        const create = manage ? (() => { const un = h('input', { type: 'text', placeholder: 'логин (a-z 0-9 . _ -)', maxlength: 32, 'aria-label': 'Логин' }), rs = roleSel('support_l1');
          return h('form', { class: 'toolbar', onsubmit: async ev => { ev.preventDefault(); try { const r = await api('/staff', { method: 'POST', body: { username: un.value.trim().toLowerCase(), role: rs.value } }); showPw(r.username, r.temp_password); un.value = ''; load(); } catch (e) { alert(err(e)); } } }, un, rs, h('button', { class: 'btn sm', type: 'submit' }, '+ Сотрудник')); })() : null;
        put(out, 
          h('div', { class: 'card col' }, h('h3', null, 'Сотрудники'), create, h('div', { class: 'tablewrap' }, h('table', null,
            h('thead', null, h('tr', null, ['Логин', 'Роль', '2FA', 'Последний вход', 'Статус', ''].map(t => h('th', null, t)))),
            h('tbody', null, rows.map(u => h('tr', null, h('td', null, u.username), h('td', null, manage && u.username !== state.me.username ? roleSel(u.role, async ev => { try { await api('/staff/' + u.id, { method: 'PATCH', body: { role: ev.target.value } }); load(); } catch (e) { alert(err(e)); load(); } }) : (roles.find(r => r.role === u.role) || {}).label),
              h('td', null, u.totp_enabled ? '✓' : '—'), h('td', null, u.last_login ? fmtDate(u.last_login) : '—'), h('td', null, h('span', { class: 'pill ' + (u.active ? 'st-active' : 'st-suspended') }, u.active ? 'активен' : 'отключён'), u.locked ? h('span', { class: 'pill st-held' }, 'заблокирован') : null),
              h('td', { class: 'actions' }, manage && u.username !== state.me.username ? [
                h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { try { await api('/staff/' + u.id, { method: 'PATCH', body: { active: !u.active } }); load(); } catch (e) { alert(err(e)); } } }, u.active ? 'Отключить' : 'Включить'),
                h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { if (!confirm('Сбросить пароль? Все сессии пользователя закроются.')) return; try { const r = await api(`/staff/${u.id}/reset-password`, { method: 'POST', body: {} }); showPw(u.username, r.temp_password); load(); } catch (e) { alert(err(e)); } } }, 'Сброс пароля'),
                h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { if (!confirm('Сбросить 2FA?')) return; try { await api(`/staff/${u.id}/reset-2fa`, { method: 'POST', body: {} }); load(); } catch (e) { alert(err(e)); } } }, 'Сброс 2FA'),
                u.locked ? h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { try { await api(`/staff/${u.id}/unlock`, { method: 'POST', body: {} }); load(); } catch (e) { alert(err(e)); } } }, 'Разблокировать') : null] : null))))))),
          h('div', { class: 'card col' }, h('h3', null, 'Матрица ролей'), h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, [h('th', null, 'Роль'), h('th', null, 'Права')])),
            h('tbody', null, roles.map(r => h('tr', null, h('td', null, r.label), h('td', { class: 'wrap' }, r.perms.join(', ')))))))),
          ses.rows.length ? h('div', { class: 'card col' }, h('h3', null, 'Активные сессии'), h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Пользователь', 'Роль', 'IP', 'Активность', ''].map(t => h('th', null, t)))),
            h('tbody', null, ses.rows.map(s => h('tr', null, h('td', null, s.username + (s.pending ? ' (ввод 2FA)' : '')), h('td', null, s.role), h('td', { class: 'mono' }, s.ip), h('td', null, fmtDate(s.last_seen)),
              h('td', { class: 'actions' }, manage ? h('button', { class: 'btn danger sm', type: 'button', onclick: async () => { try { await api('/sessions/' + s.ref, { method: 'DELETE' }); load(); } catch (e) { alert(err(e)); } } }, 'Завершить') : null))))))) : null);
      } catch (e) { put(out, h('p', { class: 'msg err' }, err(e))); }
    }
    put(el, h('div', null, h('h2', null, 'Сотрудники и доступ'), h('p', { class: 'sub' }, 'Роли дают минимум необходимых прав. Модератор не видит выплаты, а персональные данные — только маскированными.')), out); load();
  }

  window.Asv.ui = { can, money, put, modal, err, meta, runAction, openDetail, openForm, resourceView, EXTRA, kpi, barList, table, refSelect, formFields };

  /* ---------- navigation ---------- */
  const V = window.Asv.views;
  window.Asv.navEntries = () => {
    if (state.gated) return [{ id: 'sec', label: 'Мой аккаунт', group: 'Система', render: V.sec }];
    const e = [];
    if (can('analytics.read')) { e.push({ id: 'dash', label: 'Обзор', group: 'Обзор', render: V.dash }); e.push({ id: 'p_analytics', label: 'Аналитика платформы', group: 'Обзор', render: pageAnalytics }); }
    if (can('analytics.read') && can('sellers.read')) e.push({ id: 'p_sellerdash', label: 'Кабинет продавца', group: 'Обзор', render: pageSellerDash });
    const order = ['Заказы', 'Продавцы и каталог', 'Логистика', 'Финансы и цены', 'Маркетинг и SEO', 'Поддержка', 'Безопасность'];
    const pages = { 'Заказы': can('orders.write') ? [{ id: 'p_neworder', label: '+ Новый заказ', render: pageNewOrder }] : [], 'Финансы и цены': can('pricing.write') ? [{ id: 'p_pricing', label: 'Репрайсер', render: pagePricing }] : [],
      'Маркетинг и SEO': [...(can('seo.read') ? [{ id: 'p_seo', label: 'SEO-аудит', render: pageSeo }] : []), ...(can('segments.read') ? [{ id: 'p_pers', label: 'Персонализация', render: pagePersonalization }] : [])] };
    for (const g of order) {
      for (const r of state.meta.filter(x => x.group === g)) e.push({ id: 'r_' + r.name, label: r.label, group: g, render: resourceView(r, EXTRA[r.name]) });
      for (const p of pages[g] || []) e.push({ ...p, group: g });
    }
    if (can('subscribers.read')) e.push({ id: 'subs', label: 'Подписчики', group: 'Система', render: V.subs });
    if (can('files.read')) e.push({ id: 'files', label: 'Файлы', group: 'Система', render: V.files });
    if (can('staff.read')) e.push({ id: 'p_staff', label: 'Сотрудники и доступ', group: 'Система', render: pageStaff });
    e.push({ id: 'sec', label: 'Мой аккаунт', group: 'Система', render: V.sec });
    if (can('audit.read')) e.push({ id: 'audit', label: 'Журнал', group: 'Система', render: V.audit });
    return e;
  };
})();
