'use strict';
/* Asveli admin — «Фиды для каналов»: one URL per channel (Google, Meta, Pinterest, TikTok, Ceneo, CSV). No innerHTML. */
(() => {
  const { h, api, state, loading, fail } = window.Asv;
  const { can, put, err } = window.Asv.ui;
  const CH = [
    ['Google Merchant Center (Google Покупки)', 'google.xml', 'Merchant Center → Товары → Добавить товары → «Добавить из файла» → «Ссылка на файл» → вставьте адрес, расписание — ежедневно.'],
    ['Meta (Facebook и Instagram Shop)', 'google.xml', 'Commerce Manager → Каталог → Источники данных → Фид данных → «Запланированный фид» → вставьте адрес.'],
    ['Pinterest', 'google.xml', 'Pinterest Business → Каталоги → Источник данных → вставьте адрес.'],
    ['TikTok (каталог товаров)', 'google.xml', 'TikTok Ads/Shop → Catalog Manager → Add products → Data feed → Scheduled → адрес.'],
    ['Microsoft / Bing Shopping', 'google.xml', 'Merchant Center Microsoft → Каталоги → Фиды → Запланированная загрузка.'],
    ['Ceneo.pl', 'ceneo.xml', 'Panel Ceneo → «Plik XML» / integracja → вставьте адрес.'],
    ['Idealo, Skąpiec, другие (CSV)', 'products.csv', 'Если площадка принимает CSV по ссылке — используйте этот адрес.']];
  const copy = async (t, b) => { try { await navigator.clipboard.writeText(t); b.textContent = 'Скопировано ✓'; setTimeout(() => { b.textContent = 'Копировать'; }, 1500); } catch { /* manual */ } };
  async function page(el) {
    loading(el);
    let v; try { v = await api('/feeds'); } catch (e) { return fail(el, e); }
    const msg = h('p', { class: 'msg', role: 'status' }), w = can('channels.write');
    const base = h('input', { class: 'input', type: 'url', value: v.link_base || '', placeholder: 'https://asveli.com', disabled: !w || null, 'aria-label': 'Адрес магазина для ссылок' });
    const draw = () => {
      const url = k => v.token ? `${v.public_base}/feeds/${v.token}/${k}` : null;
      put(el, h('div', null, h('h2', null, 'Фиды для каналов продаж'), h('p', { class: 'sub' }, `Один адрес — и площадка сама забирает ваши товары каждый день: цены, остатки, фото. Сейчас в фиде товаров: ${v.count} (только одобренные, с ценой > 0).`)),
        h('div', { class: 'card form' }, h('h3', null, 'Настройки'),
          h('label', { class: 'field' }, h('span', null, 'Куда ведут ссылки на товары'), base, h('small', { class: 'hint' }, 'Адрес вашего магазина, где открывается страница товара (/p/…). Пусто — первый адрес из STORE_ORIGINS.')),
          w ? h('div', { class: 'row' }, h('button', { class: 'btn primary sm', type: 'button', onclick: async () => { try { v = await api('/feeds', { method: 'PUT', body: { link_base: base.value.trim() } }); draw(); } catch (e) { msg.className = 'msg err'; msg.textContent = err(e); } } }, v.token ? 'Сохранить' : 'Создать адреса фидов'),
            v.token ? h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { if (!confirm('Сменить секретную часть адресов? Старые ссылки перестанут работать — их нужно будет заменить в каждой площадке.')) return; v = await api('/feeds/rotate', { method: 'POST' }); draw(); } }, 'Сменить секретный адрес') : null) : null, msg),
        v.token ? h('div', { class: 'card' }, h('h3', null, 'Адреса для площадок'), CH.map(([name, k, how]) => { const b = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => copy(url(k), b) }, 'Копировать');
          return h('div', { class: 'feedrow' }, h('b', null, name), h('div', { class: 'linkbox' }, h('input', { class: 'input mono', readonly: true, value: url(k), 'aria-label': name }), b), h('small', { class: 'hint' }, how)); }),
          h('p', { class: 'hint' }, 'Адрес фида должен быть доступен из интернета: публичный адрес API (PUBLIC_BASE_URL) — ' + v.public_base + '. Amazon, Allegro и eBay принимают товары только через свои API или Seller Central — фиды выше для площадок, которые принимают каталог по ссылке.')) : null);
    };
    draw();
  }
  const prev = window.Asv.navEntries;
  window.Asv.navEntries = () => {
    const out = prev();
    if (state.gated || !can('channels.read')) return out;
    const i = out.findIndex(e => e.id === 'r_channels');
    const entry = { id: 'p_feeds', label: 'Фиды для каналов', group: 'Интеграции', render: page };
    if (i < 0) out.push(entry); else out.splice(i, 0, entry);
    return out;
  };
})();
