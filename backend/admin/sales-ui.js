'use strict';
/* Asveli admin — «Отдел продаж»: how the shop sells (revenue, top products, queues), card quality to fix first, stock cover,
   promotion ideas, a price plan against competitors — and the owner's switch «Передать управление ИИ-менеджеру» (owner away).
   No innerHTML. */
(() => {
  const { h, api, state, loading, fail, fmtDate } = window.Asv;
  const { can, money, put, err, kpi } = window.Asv.ui;

  const ISSUE = { title_short: 'короткое название', title_long: 'длинное название', title_spammy: 'спам в названии', description_short: 'нет описания', description_thin: 'короткое описание',
    no_photos: 'нет фото', few_photos: 'мало фото (<3)', no_category: 'нет категории', no_brand: 'нет бренда', no_barcode: 'нет штрихкода', no_manufacturer: 'нет производителя (GPSR)',
    no_safety_info: 'нет инфо о безопасности', no_price: 'нет цены', below_cost: 'цена ниже закупки', pricier_than_competitor: 'дороже конкурента >10%' };
  const STOCK = { out_selling: 'закончился, а спрос есть', low: 'скоро закончится', out: 'нет в наличии', not_selling: 'не продаётся', ok: 'в норме' };
  const msgEl = () => h('p', { class: 'msg', role: 'status' });
  const say = (m, ok, text) => { m.className = 'msg ' + (ok ? 'ok' : 'err'); m.textContent = text; };
  const tbl = (head, rows) => rows.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, head.map(x => h('th', null, x)))), h('tbody', null, rows.map(r => h('tr', null, r.map(c => h('td', null, c))))))) : h('p', { class: 'empty' }, 'Пусто.');

  function delegateCard(d, reload) {
    const m = msgEl();
    const hours = h('input', { class: 'input', type: 'number', min: 1, max: 720, value: 72, 'aria-label': 'Часов' });
    const pricePct = h('input', { class: 'input', type: 'number', min: 1, max: 50, value: d.price_pct, 'aria-label': 'Макс. изменение цены, %' });
    const discPct = h('input', { class: 'input', type: 'number', min: 0, max: 70, value: d.discount_pct, 'aria-label': 'Макс. скидка, %' });
    const note = h('input', { class: 'input', maxlength: 500, value: d.note || '', placeholder: 'Например: я в отпуске до понедельника, приоритет — упаковка', 'aria-label': 'Заметка' });
    const send = async body => { try { await api('/delegate', { method: 'PUT', body }); reload(); } catch (e) { say(m, false, err(e)); } };
    const status = d.on
      ? h('p', null, h('b', { class: 'ok' }, '● Управление передано ИИ-менеджеру'), ` до ${fmtDate(d.until)}. Лимиты: цена ±${d.price_pct}% за раз, скидки до ${d.discount_pct}%.`)
      : h('p', null, h('b', null, '○ Магазином управляете вы.'), d.ended_at ? ` Последняя передача закончилась ${fmtDate(d.ended_at)}${d.ended_by === 'expired' ? ' (по времени)' : ''}.` : '');
    return h('div', { class: 'card form' }, h('h3', null, 'Передать управление ИИ-менеджеру (когда вас нет)'), status,
      h('p', { class: 'hint' }, 'На это время ключ отдела продаж (Argon) работает как управляющий: одобряет товары, отвечает покупателям, ведёт заказы, отгрузки и возвраты товара, цены и акции. ',
        h('b', null, 'Никогда: '), 'деньги (возвраты денег, выплаты), сотрудники, ключи, настройки безопасности, KYC. Цена не ниже закупки. Всё, что он сделал, — в отчёте ниже.'),
      h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'На сколько часов'), hours), h('label', { class: 'field' }, h('span', null, 'Цена: макс. изменение за раз, %'), pricePct)),
      h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'Скидки (купоны): максимум, %'), discPct), h('label', { class: 'field' }, h('span', null, 'Заметка для ИИ-менеджера'), note)),
      h('div', { class: 'row' },
        d.on ? h('button', { class: 'btn danger sm', type: 'button', onclick: () => send({ on: false }) }, 'Я вернулся — забрать управление')
          : h('button', { class: 'btn primary sm', type: 'button', onclick: () => send({ on: true, hours: Number(hours.value), price_pct: Number(pricePct.value), discount_pct: Number(discPct.value), note: note.value }) }, 'Передать управление'),
        d.on ? h('button', { class: 'btn sm', type: 'button', onclick: () => send({ price_pct: Number(pricePct.value), discount_pct: Number(discPct.value), note: note.value }) }, 'Сохранить лимиты') : null),
      m);
  }

  async function reportCard() {
    let r; try { r = await api('/delegate/report'); } catch { return null; }
    return h('div', { class: 'card' }, h('h3', null, `Что сделал ИИ-менеджер: ${r.total} действий с ${fmtDate(r.since)}`),
      r.by_action.length ? h('p', null, r.by_action.slice(0, 12).map(x => `${x.action}: ${x.n}`).join(' · ')) : null,
      tbl(['Когда', 'Кто', 'Действие', 'Детали'], r.recent.slice(0, 50).map(x => [fmtDate(x.at), x.actor, x.action, x.detail || ''])));
  }

  async function page(el) {
    loading(el);
    let d; try { d = await api('/sales/dashboard'); } catch (e) { return fail(el, e); }
    const [cards, stock, promo] = await Promise.all([api('/sales/cards?limit=25&max_score=79').catch(() => null), api('/sales/stock?limit=25').catch(() => null), api('/sales/promo?limit=10').catch(() => null)]);
    const owner = state.me && state.me.role === 'owner';
    const q = d.queues || {};

    const planMsg = msgEl();
    const undercut = h('input', { class: 'input', type: 'number', min: 0, max: 30, value: 1, 'aria-label': 'Ниже конкурента на, %' });
    const planOut = h('div');
    const runPlan = async apply => {
      try {
        const r = await api('/sales/prices/plan', { method: 'POST', body: { rule: 'competitor', undercut_pct: Number(undercut.value), apply } });
        say(planMsg, true, apply ? `Применено: ${r.applied} из ${r.changes.length}${r.failed && r.failed.length ? `, не удалось: ${r.failed.length}` : ''}.` : `Изменений: ${r.changes.length}, пропущено: ${r.skipped_count} (нет цены конкурента, уже выгодно или упёрлись в закупку). Шаг за раз — до ${r.step_pct}%.`);
        planOut.replaceChildren(tbl(['Товар', 'Сейчас', 'Станет', '%', 'Конкурент', 'Не ниже'], r.changes.slice(0, 50).map(c => [c.title, money(c.old_price), money(c.new_price), c.change_pct + '%', money(c.outside), money(c.floor)])));
      } catch (e) { say(planMsg, false, err(e)); }
    };

    put(el, h('div', { class: 'salespage' }, h('h2', null, 'Отдел продаж'),
      h('p', { class: 'sub' }, 'Продажи, карточки, цены, остатки и акции в одном месте. То же самое ИИ-менеджер (Argon) видит через MCP-инструменты sales_*.'),
      h('div', { class: 'grid' },
        kpi(money(d.sales.d1.revenue), 'выручка сегодня', `${d.sales.d1.n} заказов`), kpi(money(d.sales.d7.revenue), 'за 7 дней', `${d.sales.d7.n} заказов`),
        kpi(money(d.sales.d30.revenue), 'за 30 дней', `${d.sales.d30.n} заказов`),
        kpi(String(q.orders_new ?? '—'), 'новых заказов'), kpi(String(q.products_pending_review ?? '—'), 'товаров ждут проверки'),
        kpi(String((q.inquiries_open ?? 0) + (q.tickets_open ?? 0)), 'вопросов покупателей')),
      owner ? delegateCard(d.delegate, () => page(el)) : (d.delegate.on ? h('div', { class: 'card' }, h('b', null, `Владелец отсутствует, управление передано ИИ-менеджеру до ${fmtDate(d.delegate.until)}.`)) : null),
      h('div', { class: 'card' }, h('h3', null, 'Топ товаров за 30 дней'), tbl(['Товар', 'Продано', 'Выручка'], d.top_30d.map(t => [t.title || '#' + t.product_id, String(t.qty), money(t.revenue)]))),
      cards ? h('div', { class: 'card' }, h('h3', null, `Карточки: плохие ${cards.buckets.bad} · средние ${cards.buckets.fair} · хорошие ${cards.buckets.good}`),
        h('p', { class: 'hint' }, 'Сначала — продающиеся и в наличии. Переписать карточку: Товары → действие «AI: сгенерировать карточку».'),
        tbl(['Товар', 'Оценка', 'Что исправить', 'Продано 30 дн.', 'Остаток'], cards.items.map(c => [c.title || c.sku, String(c.score), c.issues.map(i => ISSUE[i] || i).join(', '), String(c.sold_30d), String(c.stock)]))) : null,
      can('pricing.read') ? h('div', { class: 'card form' }, h('h3', null, 'Цены против конкурентов'),
        h('p', { class: 'hint' }, 'Чуть ниже самой низкой проверенной цены конкурента — но никогда ниже закупки и мин. цены, и не больше лимита за раз. Сначала «Показать», потом «Применить».'),
        h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', null, 'Ниже конкурента на, %'), undercut),
          h('button', { class: 'btn sm', type: 'button', onclick: () => runPlan(false) }, 'Показать план'),
          can('pricing.write') ? h('button', { class: 'btn primary sm', type: 'button', onclick: () => runPlan(true) }, 'Применить') : null), planMsg, planOut) : null,
      stock ? h('div', { class: 'card' }, h('h3', null, 'Остатки: ' + Object.entries(stock.counts).map(([k, v]) => `${STOCK[k] || k} ${v}`).join(' · ')),
        tbl(['Товар', 'Состояние', 'Доступно', 'Продажи/день', 'Хватит на, дней'], stock.items.filter(x => x.status !== 'ok').slice(0, 25).map(s => [s.title || s.sku, STOCK[s.status], String(s.available), String(s.per_day), s.days_of_cover == null ? '—' : String(s.days_of_cover)]))) : null,
      promo ? h('div', { class: 'card' }, h('h3', null, 'Идеи для маркетинга'),
        h('p', { class: 'hint' }, promo.rules.join(' ')),
        h('h4', null, 'Залежались (30 дней без продаж)'), tbl(['Товар', 'Остаток', 'Маржа', 'Идея'], promo.slow_movers.map(p => [p.title || p.sku, String(p.available), p.margin_pct == null ? '—' : p.margin_pct + '%', p.idea === 'markdown' ? 'уценка' : 'комплект / реклама'])),
        h('h4', null, 'Лидеры — усилить рекламой'), tbl(['Товар', 'Продано', 'Выручка', 'Карточка'], promo.best_sellers.map(p => [p.title || p.sku, String(p.sold_30d), money(p.revenue_30d), String(p.card_score)]))) : null,
      owner ? await reportCard() : null));
  }

  const prev = window.Asv.navEntries;
  window.Asv.navEntries = () => {
    const out = prev();
    if (state.gated || !can('sales.read')) return out;
    out.unshift({ id: 'p_sales', label: 'Отдел продаж', group: 'Продажи', render: page });
    return out;
  };
})();
