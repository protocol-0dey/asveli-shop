'use strict';
/* Asveli admin — "Вход покупателей": Google / GitHub / Amazon apps for buyer sign-in. Owner only. No innerHTML, strict CSP. */
(() => {
  const { h, api, state, loading, fail } = window.Asv;
  const { can, put, err } = window.Asv.ui;
  const CODES = { invalid_client_id: 'Client ID выглядит неверно.', invalid_client_secret: 'Client secret выглядит неверно.', store_url_not_allowed: 'Этот адрес магазина не входит в STORE_ORIGINS сервера.' };
  const e2t = e => CODES[e.message] || err(e);
  const toast = (t, bad) => { const x = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, t); document.body.append(x); setTimeout(() => x.remove(), 3500); };
  const HOWTO = {
    google: ['console.cloud.google.com → APIs & Services → OAuth consent screen: тип External, название Asveli, логотип, домен asveli.com → Publish app.',
      'Credentials → Create credentials → OAuth client ID → Web application.', 'Authorized redirect URIs: вставьте адрес «Адрес возврата» ниже.', 'Скопируйте Client ID и Client secret сюда.'],
    github: ['github.com → Settings → Developer settings → OAuth Apps → New OAuth App.', 'Homepage URL: адрес магазина. Authorization callback URL: «Адрес возврата» ниже.',
      'Register application → Generate a new client secret.', 'Скопируйте Client ID и Client secret сюда.'],
    amazon: ['developer.amazon.com → Login with Amazon → Create a New Security Profile (название, описание, ссылка на политику конфиденциальности).',
      'Web Settings → Edit: Allowed Origins — адрес магазина, Allowed Return URLs — «Адрес возврата» ниже (только https).', 'Скопируйте Client ID и Client Secret сюда.']
  };

  async function page(el) {
    loading(el);
    try {
      let v = await api('/oauth/settings');
      const msg = h('p', { class: 'msg', role: 'status' }), cards = h('div', { class: 'col' });
      const shopSel = h('select', { class: 'input', 'aria-label': 'Магазин' });
      const draw = () => {
        put(shopSel, v.store_origins.map(o => h('option', { value: o, selected: o === v.store_url || null }, o)));
        put(cards, v.providers.map(p => {
          const id = h('input', { type: 'text', class: 'input', autocomplete: 'off', spellcheck: 'false', value: p.clientId || '', 'aria-label': p.name + ' Client ID' });
          const sec = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', placeholder: p.has_secret ? 'оставьте пустым, чтобы не менять' : 'Client secret', 'aria-label': p.name + ' Client secret' });
          const on = h('input', { type: 'checkbox', checked: p.enabled || null, 'aria-label': 'Включить ' + p.name });
          const uri = h('input', { type: 'text', class: 'input mono', readonly: true, value: p.redirect_uri, 'aria-label': 'Адрес возврата' });
          const copy = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(p.redirect_uri); toast('Скопировано'); } catch { uri.select(); } } }, 'Копировать');
          const save = h('button', { class: 'btn primary sm', type: 'button', onclick: async () => {
            const b = { clientId: id.value.trim(), enabled: on.checked }; if (sec.value) b.clientSecret = sec.value.trim();
            try { v = await api('/oauth/settings', { method: 'PUT', body: { [p.id]: b } }); draw(); msg.className = 'msg ok'; msg.textContent = `${p.name}: сохранено. Действует сразу.`; } catch (e) { msg.className = 'msg err'; msg.textContent = e2t(e); } } }, 'Сохранить');
          const used = (v.stats.find(s => s.provider === p.id) || {}).n || 0;
          return h('div', { class: 'card form' },
            h('div', { class: 'dhead' }, h('h3', null, p.name), h('span', { class: 'pill ' + (p.enabled ? 'st-approved' : '') }, p.enabled ? 'включён' : 'выключен')),
            h('p', { class: 'hint' }, used ? `Через ${p.name} вошли ${used} покупател(ей).` : 'Пока никто не входил.'),
            h('label', { class: 'field' }, h('span', null, 'Адрес возврата (вставьте его в настройках приложения ' + p.name + ')'), h('div', { class: 'linkbox' }, uri, copy)),
            h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'Client ID'), id), h('label', { class: 'field' }, h('span', null, 'Client secret'), sec, p.secret_hint ? h('small', { class: 'hint' }, 'Сохранён: ' + p.secret_hint + ' (не показывается)') : null)),
            h('label', { class: 'field row' }, on, h('span', null, 'Показывать кнопку «Войти через ' + p.name + '» в магазине')),
            h('details', null, h('summary', null, 'Как создать приложение ' + p.name), h('ol', { class: 'hint' }, HOWTO[p.id].map(t => h('li', null, t))), h('a', { href: p.console, target: '_blank', rel: 'noopener noreferrer', class: 'hint' }, 'Открыть консоль ' + p.name + ' ↗')),
            h('div', { class: 'row actions' }, save,
              p.secret_hint && p.secret_hint.startsWith('••') ? h('button', { class: 'btn danger sm', type: 'button', onclick: async () => { if (!confirm(`Удалить секрет ${p.name}? Кнопка входа перестанет работать.`)) return; try { v = await api(`/oauth/settings/${p.id}/secret`, { method: 'DELETE' }); draw(); } catch (e) { toast(e2t(e), true); } } }, 'Удалить секрет') : null));
        }));
      };
      const saveShop = h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { v = await api('/oauth/settings', { method: 'PUT', body: { storeUrl: shopSel.value } }); draw(); msg.className = 'msg ok'; msg.textContent = 'Магазин сохранён.'; } catch (e) { msg.className = 'msg err'; msg.textContent = e2t(e); } } }, 'Сохранить');
      put(el, h('div', null, h('h2', null, 'Вход покупателей'), h('p', { class: 'sub' }, 'Кнопки «Войти через Google / GitHub / Amazon» в магазине. Аккаунт создаётся сам при первом входе; с существующим аккаунтом он связывается, только если провайдер подтвердил e-mail.')),
        h('div', { class: 'card form' }, h('h3', null, 'Куда возвращать покупателя'), h('div', { class: 'toolbar' }, shopSel, saveShop),
          h('p', { class: 'hint' }, `После входа покупатель возвращается на «адрес/login/callback». Список берётся из STORE_ORIGINS сервера. Адреса возврата для провайдеров строятся от ${v.public_base} — это должен быть публичный https-адрес API (PUBLIC_BASE_URL).`)),
        msg, cards,
        h('div', { class: 'card' }, h('h3', null, 'Безопасность'), h('ul', { class: 'hint' },
          h('li', null, 'Вход идёт по схеме OAuth 2.0 + PKCE на сервере: секреты приложений не попадают в браузер, токен покупателя не передаётся в адресной строке.'),
          h('li', null, 'Секреты хранятся зашифрованными и никогда не показываются; изменения пишутся в журнал без значений.'),
          h('li', null, 'Чужой аккаунт нельзя захватить: связь по e-mail только если провайдер подтвердил этот e-mail.'))));
      draw();
    } catch (e) { fail(el, e); }
  }

  const prev = window.Asv.navEntries;
  window.Asv.navEntries = () => {
    const out = prev();
    if (state.gated || !can('secrets.oauth')) return out;
    const i = out.findIndex(e => e.id === 'p_ai_settings');
    const entry = { id: 'p_oauth', label: 'Вход покупателей', group: 'Интеграции', render: page };
    if (i < 0) out.push(entry); else out.splice(i, 0, entry);
    return out;
  };
})();
