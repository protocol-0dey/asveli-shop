'use strict';
/* Asveli admin — «Доверие и безопасность»: which regions are open for sale, whether the house catalogue is gated too,
   re-certification terms, and a manual run of the yearly re-certification check. No innerHTML. */
(() => {
  const { h, api, state, loading, fail } = window.Asv;
  const { can, put, err } = window.Asv.ui;

  async function page(el) {
    loading(el);
    let c; try { c = await api('/trust/config'); } catch (e) { return fail(el, e); }
    const w = can('sellers.kyc'), msg = h('p', { class: 'msg', role: 'status' });
    const regionBoxes = Object.entries(c.regions).map(([k, r]) => {
      const box = h('input', { type: 'checkbox', checked: c.open_regions.includes(k) || null, disabled: !w || null, 'aria-label': r.label });
      box.dataset.region = k;
      return { box, row: h('label', { class: 'field row' }, box, h('span', null, h('b', null, `${k} — ${r.label}`), ` · ${r.rule === 'local' ? 'местные правила: проверить у юриста до открытия' : r.rule}`)) };
    });
    const all = h('input', { type: 'checkbox', checked: c.enforce_all || null, disabled: !w || null, 'aria-label': 'enforce_all' });
    const days = h('input', { class: 'input', type: 'number', min: 30, max: 730, value: c.recert_days, disabled: !w || null, 'aria-label': 'recert_days' });
    const grace = h('input', { class: 'input', type: 'number', min: 1, max: 60, value: c.grace_days, disabled: !w || null, 'aria-label': 'grace_days' });
    const save = h('button', { class: 'btn primary sm', type: 'button', onclick: async () => {
      const open_regions = regionBoxes.filter(x => x.box.checked).map(x => x.box.dataset.region);
      try { c = { ...c, ...(await api('/trust/config', { method: 'PUT', body: { open_regions, enforce_all: all.checked, recert_days: Number(days.value), grace_days: Number(grace.value) } })) }; msg.className = 'msg ok'; msg.textContent = 'Сохранено.'; }
      catch (e) { msg.className = 'msg err'; msg.textContent = err(e); }
    } }, 'Сохранить');
    const scan = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
      try { const r = await api('/trust/recert-scan', { method: 'POST', body: {} }); msg.className = 'msg ok'; msg.textContent = `Проверено: предупреждений ${r.warned}, приостановлено ${r.suspended}.`; }
      catch (e) { msg.className = 'msg err'; msg.textContent = err(e); }
    } }, 'Проверить подтверждения сейчас');
    put(el, h('div', null, h('h2', null, 'Доверие и безопасность'),
      h('p', { class: 'sub' }, 'Продавать могут только проверенные компании, и только в тех регионах, для которых у товара есть всё нужное: производитель, ответственное лицо, свои фото, подтверждение бренда. Покупатель из закрытого региона товар не видит в корзине.')),
      h('div', { class: 'card form' }, h('h3', null, 'Открытые регионы продаж'), regionBoxes.map(x => x.row),
        h('p', { class: 'hint' }, 'Открывайте регион только после того, как юрист подтвердил местные требования к маркетплейсам.')),
      h('div', { class: 'card form' }, h('h3', null, 'Правила для продавцов'),
        h('label', { class: 'field row' }, all, h('span', null, h('b', null, 'Проверять и собственный каталог'), ' (продавцы, заведённые в админке). Продавцы из кабинета продавца проверяются всегда.')),
        h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'Подтверждение данных раз в, дней'), days), h('label', { class: 'field' }, h('span', null, 'Дней на подтверждение после срока'), grace)),
        w ? h('div', { class: 'row' }, save, scan) : null, msg),
      h('div', { class: 'card' }, h('h3', null, 'Где что смотреть'), h('ul', null,
        h('li', null, 'Продавцы → действие «Нарушение (санкция)»: 1 предупреждение · 2 запрет новых карточек на 30 дней · 3 стоп продаж в регионе · 4 блокировка и удержание выплат.'),
        h('li', null, 'Товары → «Где можно продавать»: что не хватает по каждому региону; «Бренд: документ подтверждён / отклонён».'),
        h('li', null, 'Жалобы на товары: сообщения покупателей, владельцев брендов и органов надзора.'))));
  }

  const prev = window.Asv.navEntries;
  window.Asv.navEntries = () => {
    const out = prev();
    if (state.gated || !can('sellers.read')) return out;
    const i = out.findIndex(e => e.group === 'Продавцы и каталог');
    const entry = { id: 'p_trust', label: 'Доверие и безопасность', group: 'Продавцы и каталог', render: page };
    if (i < 0) out.push(entry); else out.splice(i, 0, entry);
    return out;
  };
})();
