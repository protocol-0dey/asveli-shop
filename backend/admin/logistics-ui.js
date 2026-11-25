'use strict';
/* Asveli admin — «Настройка логистики»: where each country is shipped from and with whom, real carriers in one click, warehouses abroad. */
(() => {
  const { h, api, state, loading, fail } = window.Asv;
  const { can, put, err, money } = window.Asv.ui;
  const NAMES = { PL: 'Польша', DE: 'Германия', CZ: 'Чехия', SK: 'Словакия', LT: 'Литва', LV: 'Латвия', EE: 'Эстония', AT: 'Австрия', HU: 'Венгрия', RO: 'Румыния', BG: 'Болгария', FR: 'Франция', NL: 'Нидерланды', BE: 'Бельгия', LU: 'Люксембург',
    IT: 'Италия', ES: 'Испания', PT: 'Португалия', IE: 'Ирландия', DK: 'Дания', SE: 'Швеция', FI: 'Финляндия', GR: 'Греция', HR: 'Хорватия', SI: 'Словения', CY: 'Кипр', MT: 'Мальта', GB: 'Великобритания', CH: 'Швейцария', NO: 'Норвегия', UA: 'Украина', US: 'США', CA: 'Канада', INT: 'Международные' };
  const flag = cc => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map(c => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌍');
  const ST = { ok: ['st-approved', 'готово'], no_warehouse: ['st-failed', 'нет склада'], no_carrier: ['st-failed', 'нет перевозчика'], no_tariff: ['', 'нет тарифа'], zero_price: ['st-failed', 'тариф 0!'] };
  const toCents = s => { const n = Math.round(parseFloat(String(s).replace(',', '.')) * 100); return Number.isFinite(n) && n >= 0 ? n : null; };

  async function page(el) {
    loading(el);
    let v; try { v = await api('/logistics/setup'); } catch (e) { return fail(el, e); }
    const msg = h('p', { class: 'msg', role: 'status' }), root = h('div');
    const reload = async t => { try { v = await api('/logistics/setup'); draw(); if (t) { msg.className = 'msg ok'; msg.textContent = t; } } catch (e) { msg.className = 'msg err'; msg.textContent = err(e); } };
    const bad = e => { msg.className = 'msg err'; msg.textContent = err(e); };

    function coverageCard() {
      const okN = v.coverage.filter(c => c.status === 'ok').length;
      return h('div', { class: 'card' }, h('h3', null, `Куда вы можете доставлять: ${okN} из ${v.coverage.length} стран`),
        h('p', { class: 'hint' }, 'Для каждой страны: с какого склада уйдёт заказ и каким перевозчиком (самым дешёвым из включённых). Заказ идёт со склада в стране покупателя, если он есть, иначе — по приоритету.'),
        h('div', { class: 'covgrid' }, v.coverage.map(c => h('div', { class: 'cov ' + c.status, title: c.warehouse ? `${c.warehouse.name} → ${c.carrier ? c.carrier.name + ', 1 кг ' + money(c.carrier.cost_1kg) : 'нет перевозчика с тарифом'}` : 'нет склада, который отправляет сюда' },
          h('span', null, flag(c.country) + ' ' + (NAMES[c.country] || c.country)), h('small', null, c.status === 'ok' ? money(c.carrier.cost_1kg) + ' / 1 кг' : ST[c.status][1])))),
        h('details', null, h('summary', null, 'Подробно по странам'), h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Страна', 'Склад', 'Перевозчик', '1 кг', '5 кг', 'Статус'].map(t => h('th', null, t)))),
          h('tbody', null, v.coverage.map(c => h('tr', null, h('td', null, flag(c.country) + ' ' + (NAMES[c.country] || c.country)), h('td', null, c.warehouse ? `${c.warehouse.name} (${c.warehouse.country})` : '—'),
            h('td', null, c.carrier ? c.carrier.name : c.inactive ? `выключено: ${c.inactive}` : '—'), h('td', { class: 'num' }, c.carrier ? money(c.carrier.cost_1kg) : '—'), h('td', { class: 'num' }, c.carrier ? money(c.carrier.cost_5kg) : '—'),
            h('td', null, h('span', { class: 'pill ' + ST[c.status][0] }, ST[c.status][1])))))))));
    }
    function warehousesCard() {
      const name = h('input', { class: 'input', type: 'text', maxlength: 80, placeholder: 'например «Склад Берлин» или фулфилмент-партнёр', 'aria-label': 'Название склада' });
      const cc = h('select', { class: 'input', 'aria-label': 'Страна склада' }, Object.entries(NAMES).filter(([k]) => k !== 'INT').map(([k, n]) => h('option', { value: k }, flag(k) + ' ' + n)));
      const ships = h('select', { class: 'input', 'aria-label': 'Куда отправляет' }, [['', 'во все страны'], ['eu', 'по всему ЕС'], ['self', 'только по своей стране']].map(([k, t]) => h('option', { value: k }, t)));
      const prio = h('input', { class: 'input', type: 'number', min: 0, max: 1000, value: 100, 'aria-label': 'Приоритет' });
      const add = h('button', { class: 'btn primary sm', type: 'button', onclick: async () => {
        const st = ships.value === 'eu' ? v.coverage.filter(c => c.eu).map(c => c.country).join(',') : ships.value === 'self' ? cc.value : null;
        try { await api('/m/warehouses', { method: 'POST', body: { name: name.value.trim(), country: cc.value, ships_to: st, priority: Number(prio.value) } }); name.value = ''; reload('Склад добавлен. Остатки по нему задаются в «Остатки».'); } catch (e) { bad(e); }
      } }, 'Добавить склад');
      return h('div', { class: 'card form' }, h('h3', null, `Склады (${v.warehouses.length})`),
        v.warehouses.length ? h('ul', null, v.warehouses.map(w => h('li', null, `${flag(w.country)} ${w.name} — ${NAMES[w.country] || w.country}, приоритет ${w.priority}, отправляет: ${w.ships_to || 'везде'}${w.active ? '' : ' (выключен)'}`))) : h('p', { class: 'hint' }, 'Складов пока нет.'),
        h('p', { class: 'hint' }, 'Склад — это реальное место, где лежит ваш товар: свой склад, фулфилмент-оператор или склад поставщика (дропшиппинг). Добавьте его здесь, затем внесите остатки — заказы сами пойдут с ближайшего склада.'),
        can('warehouses.write') ? [h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'Название'), name), h('label', { class: 'field' }, h('span', null, 'Страна'), cc)),
          h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'Куда отправляет'), ships), h('label', { class: 'field' }, h('span', null, 'Приоритет (меньше — раньше)'), prio)), h('div', { class: 'row' }, add)] : null);
    }
    function carriersCard() {
      const mine = v.carriers.map(c => {
        const base = h('input', { class: 'input', type: 'text', inputmode: 'decimal', value: (c.base_cost / 100).toFixed(2), 'aria-label': c.name + ' базовая цена' });
        const kg = h('input', { class: 'input', type: 'text', inputmode: 'decimal', value: (c.per_kg_cost / 100).toFixed(2), 'aria-label': c.name + ' за кг' });
        const to = h('input', { class: 'input', type: 'text', value: c.countries || '', placeholder: 'все страны', 'aria-label': c.name + ' страны' });
        const save = on => async () => { try { await api('/m/carriers/' + c.id, { method: 'PATCH', body: { base_cost: toCents(base.value), per_kg_cost: toCents(kg.value), countries: to.value.trim().toUpperCase() || null, ...(on === undefined ? {} : { active: on }) } }); reload(`${c.name}: сохранено.`); } catch (e) { bad(e); } };
        return h('tr', null, h('td', null, h('b', null, c.name), h('small', { class: 'sup' }, c.code)), h('td', null, base), h('td', null, kg), h('td', null, to),
          h('td', null, h('span', { class: 'pill ' + (c.active ? 'st-approved' : '') }, c.active ? 'включён' : 'выключен')),
          h('td', null, can('carriers.write') ? h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: save() }, 'Сохранить'), h('button', { class: 'btn sm', type: 'button', onclick: save(!c.active) }, c.active ? 'Выключить' : 'Включить')) : null));
      });
      const groups = {}; for (const c of v.catalog) (groups[c.home] = groups[c.home] || []).push(c);
      return h('div', { class: 'card form' }, h('h3', null, 'Перевозчики'),
        v.carriers.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Перевозчик', 'Базовая цена', 'За кг', 'Страны назначения', 'Статус', ''].map(t => h('th', null, t)))), h('tbody', null, mine))) : h('p', { class: 'hint' }, 'Перевозчиков пока нет — добавьте из каталога ниже.'),
        h('p', { class: 'hint' }, 'Тариф = базовая цена + цена за каждый кг (вес округляется вверх). Впишите цены из вашего договора и включите перевозчика. Без тарифа включить нельзя — иначе доставка посчиталась бы бесплатной.'),
        h('h4', null, 'Каталог перевозчиков — добавить в один клик'),
        h('div', { class: 'carcat' }, Object.entries(groups).map(([home, list]) => h('div', { class: 'cargrp' }, h('b', null, flag(home) + ' ' + (NAMES[home] || home)),
          list.map(c => h('div', { class: 'carrow' }, h('span', null, c.name, c.note ? h('small', { class: 'sup' }, c.note) : null),
            c.added ? h('span', { class: 'hint' }, 'добавлен ✓') : can('carriers.write') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { try { await api('/logistics/carriers/preset', { method: 'POST', body: { id: c.id } }); reload(`${c.name} добавлен (выключен). Впишите тариф и включите.`); } catch (e) { bad(e); } } }, '+ Добавить') : null))))));
    }
    const draw = () => put(root, warehousesCard(), carriersCard(), coverageCard());
    put(el, h('div', null, h('h2', null, 'Настройка логистики'), h('p', { class: 'sub' }, 'Склады в разных странах, перевозчики с трекингом и проверка: в какие страны вы реально можете доставлять и сколько это стоит.')), msg, root);
    draw();
  }

  const prev = window.Asv.navEntries;
  window.Asv.navEntries = () => {
    const out = prev();
    if (state.gated || !can('carriers.read')) return out;
    const i = out.findIndex(e => e.group === 'Логистика');
    const entry = { id: 'p_logistics', label: 'Настройка логистики', group: 'Логистика', render: page };
    if (i < 0) out.push(entry); else out.splice(i, 0, entry);
    return out;
  };
})();
