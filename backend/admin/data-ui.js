'use strict';
/* Asveli admin — "Данные и бэкапы": external SQL mirror (PostgreSQL / MySQL / MariaDB) + encrypted backups (local + S3). Owner only. No innerHTML, strict CSP. */
(() => {
  const { h, api, state, loading, fail } = window.Asv;
  const { can, put, err } = window.Asv.ui;
  const CODES = {
    invalid_db_url: 'Адрес базы выглядит неверно. Пример: postgres://user:пароль@host:5432/имя_базы', mirror_connect_failed: 'Не удалось подключиться к базе',
    mirror_url_required: 'Сначала укажите адрес базы.', invalid_schema: 'Схема: только латиница, цифры и _.', invalid_prefix: 'Префикс: латиница, цифры и _, до 20 символов.',
    invalid_table_name: 'Имя таблицы в списке исключений неверно.', weak_passphrase: 'Пароль бэкапа: минимум 12 символов.', s3_incomplete: 'Заполните endpoint, bucket, Access key и Secret key.',
    invalid_s3_endpoint: 'Endpoint должен начинаться с https://', invalid_s3_bucket: 'Имя bucket неверно.', invalid_s3_region: 'Регион неверен (например eu-central-1 или auto).',
    invalid_s3_key: 'Access key неверен.', invalid_s3_secret: 'Secret key неверен.', s3_failed: 'S3 не принял файл', backup_running: 'Бэкап уже выполняется.', backup_failed: 'Бэкап не удался', mirror_off: 'Зеркало выключено.'
  };
  const e2t = e => (CODES[e.message] ? CODES[e.message] + (e.detail ? ': ' + e.detail : '') : err(e));
  const when = t => (t ? new Date(t).toLocaleString('ru-RU') : '—');
  const ago = t => { if (!t) return 'никогда'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} с назад` : s < 3600 ? `${Math.round(s / 60)} мин назад` : when(t); };
  const size = n => (n == null ? '—' : n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(1) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ');
  const say = (el, t, bad) => { el.className = 'msg ' + (bad ? 'err' : 'ok'); el.textContent = t; };
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
  const input = (attrs) => h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', ...attrs });
  const field = (label, ctl, hint) => h('label', { class: 'field' }, h('span', null, label), ctl, hint ? h('small', { class: 'hint' }, hint) : null);

  async function page(el) {
    loading(el);
    let v;
    try { v = await api('/data/settings'); } catch (e) { return fail(el, e); }
    const root = h('div', null);
    const draw = () => put(root, [header(), mirrorCard(), backupCard(), listCard(), notes()]);
    const set = x => { v = x; draw(); };

    const header = () => h('div', null, h('h2', null, 'Данные и бэкапы'),
      h('p', { class: 'sub' }, 'Все данные магазина хранятся на вашем сервере. Здесь можно подключить вашу внешнюю SQL-базу, чтобы туда постоянно копировалось всё, что записывается, и настроить зашифрованные резервные копии.'));

    /* ---------- SQL mirror ---------- */
    function mirrorCard() {
      const m = v.mirror, s = v.mirror_status, msg = h('p', { class: 'msg', role: 'status' });
      const url = input({ type: 'password', autocomplete: 'new-password', placeholder: m.configured ? 'сохранён: ' + m.hint + ' — оставьте пустым, чтобы не менять' : 'postgres://user:пароль@host:5432/база  или  mysql://user:пароль@host:3306/база', 'aria-label': 'Адрес базы' });
      const schema = input({ type: 'text', value: m.schema, 'aria-label': 'Схема PostgreSQL' });
      const prefix = input({ type: 'text', value: m.prefix, placeholder: 'например asv_', 'aria-label': 'Префикс таблиц' });
      const ssl = h('select', { class: 'input', 'aria-label': 'SSL' }, [['off', 'Без SSL (база в той же сети / на том же сервере)'], ['require', 'SSL с проверкой сертификата (рекомендуется для облака)'], ['no-verify', 'SSL без проверки сертификата']].map(([k, t]) => h('option', { value: k, selected: m.ssl === k || null }, t)));
      const exclude = input({ type: 'text', value: (m.exclude || []).join(', '), placeholder: 'например m_embeddings, m_ai_calls', 'aria-label': 'Не копировать таблицы' });
      const body = () => { const b = { schema: schema.value.trim() || 'public', prefix: prefix.value.trim(), ssl: ssl.value, exclude: exclude.value }; if (url.value.trim()) b.url = url.value.trim(); return b; };
      const testBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => busy(testBtn, async () => { say(msg, 'Проверяю…'); try { const r = await api('/data/mirror/test', { method: 'POST', body: body() }); say(msg, `Подключение работает (${r.type}, ${r.version}, ${r.ms} мс). Права на создание таблиц есть.`); } catch (e) { say(msg, e2t(e), true); } }) }, 'Проверить подключение');
      const saveBtn = h('button', { class: 'btn primary sm', type: 'button', onclick: () => busy(saveBtn, async () => { say(msg, m.enabled ? 'Сохраняю…' : 'Подключаю и начинаю копирование…'); try { set(await api('/data/settings', { method: 'PUT', body: { mirror: { ...body(), enabled: true } } })); } catch (e) { say(msg, e2t(e), true); } }) }, m.enabled ? 'Сохранить' : 'Подключить и включить');
      const offBtn = m.enabled ? h('button', { class: 'btn sm', type: 'button', onclick: () => busy(offBtn, async () => { if (!confirm('Выключить зеркало? Данные во внешней базе останутся, но перестанут обновляться.')) return; try { set(await api('/data/settings', { method: 'PUT', body: { mirror: { enabled: false } } })); } catch (e) { say(msg, e2t(e), true); } }) }, 'Выключить') : null;
      const resyncBtn = m.enabled ? h('button', { class: 'btn sm', type: 'button', onclick: () => busy(resyncBtn, async () => { if (!confirm('Скопировать все таблицы заново? Внешние таблицы будут перезаписаны текущими данными.')) return; try { set(await api('/data/mirror/resync', { method: 'POST' })); } catch (e) { say(msg, e2t(e), true); } }) }, 'Полная пересинхронизация') : null;
      const cmpOut = h('div', null);
      const cmpBtn = m.enabled ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => busy(cmpBtn, async () => {
        try {
          const r = await api('/data/mirror/compare');
          put(cmpOut, h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Таблица', 'Здесь', 'Во внешней базе', ''].map(t => h('th', null, t)))),
            h('tbody', null, r.tables.map(t => h('tr', null, h('td', { class: 'mono' }, t.table), h('td', null, String(t.local)), h('td', null, t.remote == null ? '—' : String(t.remote)),
              h('td', null, t.remote === t.local ? '✓' : t.table === 'audit' ? 'журнал пишется постоянно' : r.status.pending || r.status.copy_queue.length ? 'догоняет…' : '≠')))))));
        } catch (e) { say(msg, e2t(e), true); }
      }) }, 'Сверить таблицы') : null;
      const delUrl = m.configured ? h('button', { class: 'btn danger sm', type: 'button', onclick: () => busy(delUrl, async () => { if (!confirm('Удалить сохранённый адрес базы? Зеркало выключится.')) return; try { set(await api('/data/mirror/url', { method: 'DELETE' })); } catch (e) { say(msg, e2t(e), true); } }) }, 'Удалить адрес') : null;

      const pillOf = s => (!m.enabled ? h('span', { class: 'pill' }, 'выключено')
        : s.last_error && (!s.last_ok || s.last_error_at > s.last_ok) ? h('span', { class: 'pill st-failed' }, 'ошибка')
        : s.copy_queue.length || s.copying || !s.last_ok ? h('span', { class: 'pill' }, 'копирование…') : h('span', { class: 'pill st-approved' }, 'работает'));
      const state = h('span', null);
      const stat = h('div', { class: 'hint', 'aria-live': 'polite' });
      const drawStat = s => { put(state, pillOf(s)); put(stat, !m.enabled ? [] : [
        h('div', null, `Тип: ${m.type === 'postgres' ? 'PostgreSQL' : 'MySQL / MariaDB'} · база: ${m.hint || '—'} · таблиц: ${s.tables}`),
        h('div', null, `Последняя успешная синхронизация: ${ago(s.last_ok)} · в очереди изменений: ${s.pending} · применено всего: ${s.applied_total}`),
        s.copy_queue.length || s.copying ? h('div', null, `Начальное копирование: ${s.copying || '…'} (осталось таблиц: ${s.copy_queue.length}, скопировано строк: ${s.copied_rows})`) : null,
        s.last_error && (!s.last_ok || s.last_error_at > s.last_ok) ? h('div', { class: 'msg err' }, `Ошибка (${when(s.last_error_at)}): ${s.last_error}. Изменения не теряются — они ждут в очереди и уйдут, когда база снова станет доступна.`) : null]); };
      drawStat(s);
      // live status while the page is open
      if (m.enabled) {
        const t = setInterval(async () => { if (!stat.isConnected) return clearInterval(t); try { const x = await api('/data/settings'); drawStat(x.mirror_status); v.mirror_status = x.mirror_status; } catch { /* keep the last one */ } }, 3000);
      }
      return h('div', { class: 'card form' },
        h('div', { class: 'dhead' }, h('h3', null, 'Внешняя SQL-база (зеркало)'), state),
        h('p', { class: 'hint' }, 'Все таблицы магазина копируются в вашу базу PostgreSQL, MySQL или MariaDB, и каждая запись — новый заказ, изменение товара, удаление — доходит туда за несколько секунд. Основной остаётся база на этом сервере: во внешнюю ничего не записывайте, иначе изменения будут перезаписаны при синхронизации.'),
        stat,
        field('Адрес базы', url, 'Пароль хранится зашифрованным и обратно не показывается. Лучше создать в базе отдельного пользователя с правами только на одну базу или схему.'),
        h('div', { class: 'two' }, field('Схема (только PostgreSQL)', schema), field('Префикс таблиц', prefix, 'Пусто — имена как здесь (m_orders, m_products…).')),
        h('div', { class: 'two' }, field('Шифрование соединения', ssl), field('Не копировать таблицы', exclude, 'Через запятую. Никогда не копируются: сессии входа, одноразовые токены и учётки сотрудников админки (хэши паролей).')),
        h('div', { class: 'row actions' }, testBtn, saveBtn, resyncBtn, cmpBtn, offBtn, delUrl), msg, cmpOut);
    }

    /* ---------- backups ---------- */
    function backupCard() {
      const b = v.backup, msg = h('p', { class: 'msg', role: 'status' });
      const on = h('input', { type: 'checkbox', checked: b.enabled || null, 'aria-label': 'Автоматические бэкапы' });
      const every = h('select', { class: 'input', 'aria-label': 'Как часто' }, [[1, 'каждый час'], [6, 'каждые 6 часов'], [12, 'каждые 12 часов'], [24, 'раз в сутки'], [168, 'раз в неделю']].map(([n, t]) => h('option', { value: n, selected: b.everyHours === n || null }, t)));
      const keep = input({ type: 'number', min: 1, max: 365, value: b.keepLocal, 'aria-label': 'Сколько хранить на сервере' });
      const pass = input({ type: 'password', autocomplete: 'new-password', placeholder: b.has_passphrase ? 'задан — оставьте пустым, чтобы не менять' : 'минимум 12 символов', 'aria-label': 'Пароль бэкапа' });
      const s3 = b.s3;
      const s3on = h('input', { type: 'checkbox', checked: s3.enabled || null, 'aria-label': 'Загружать в S3' });
      const ep = input({ type: 'url', value: s3.endpoint, placeholder: 'https://s3.eu-central-1.amazonaws.com', 'aria-label': 'S3 endpoint' });
      const region = input({ type: 'text', value: s3.region, 'aria-label': 'Регион' });
      const bucket = input({ type: 'text', value: s3.bucket, 'aria-label': 'Bucket' });
      const pfx = input({ type: 'text', value: s3.prefix, 'aria-label': 'Папка в bucket' });
      const ak = input({ type: 'text', value: s3.accessKeyId, 'aria-label': 'Access key ID' });
      const sk = input({ type: 'password', autocomplete: 'new-password', placeholder: s3.secret_hint ? 'сохранён ' + s3.secret_hint + ' — оставьте пустым' : 'Secret access key', 'aria-label': 'Secret access key' });
      const body = () => {
        const x = { enabled: on.checked, everyHours: Number(every.value), keepLocal: Number(keep.value), s3: { endpoint: ep.value.trim(), region: region.value.trim() || 'auto', bucket: bucket.value.trim(), prefix: pfx.value.trim(), accessKeyId: ak.value.trim(), enabled: s3on.checked } };
        if (pass.value) x.passphrase = pass.value; if (sk.value) x.s3.secret = sk.value.trim(); return x;
      };
      const save = h('button', { class: 'btn primary sm', type: 'button', onclick: () => busy(save, async () => { try { set(await api('/data/settings', { method: 'PUT', body: { backup: body() } })); } catch (e) { say(msg, e2t(e), true); } }) }, 'Сохранить');
      const now = h('button', { class: 'btn sm', type: 'button', onclick: () => busy(now, async () => { say(msg, 'Делаю бэкап…'); try { set(await api('/data/backups/run', { method: 'POST' })); } catch (e) { say(msg, e2t(e), true); } }) }, 'Сделать бэкап сейчас');
      const s3test = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => busy(s3test, async () => { say(msg, 'Сохраняю и проверяю S3…'); try { const p = body(); p.s3.enabled = false; await api('/data/settings', { method: 'PUT', body: { backup: p } }); const r = await api('/data/backups/s3-test', { method: 'POST' }); say(msg, `S3 работает: тестовый файл записан и удалён (${r.ms} мс). Теперь можно включить загрузку.`); } catch (e) { say(msg, e2t(e), true); } }) }, 'Проверить S3');
      const clearPass = b.has_passphrase ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => busy(clearPass, async () => { if (!confirm('Убрать пароль бэкапа? Новые бэкапы будут шифроваться ключом сервера (DATA_ENCRYPTION_KEY). Старые по-прежнему открываются старым паролем.')) return; try { set(await api('/data/settings', { method: 'PUT', body: { backup: { clearPassphrase: true } } })); } catch (e) { say(msg, e2t(e), true); } }) }, 'Убрать пароль') : null;
      const l = v.last_backup;
      return h('div', { class: 'card form' },
        h('div', { class: 'dhead' }, h('h3', null, 'Резервные копии'), h('span', { class: 'pill ' + (b.enabled ? 'st-approved' : '') }, b.enabled ? 'по расписанию' : 'только вручную')),
        h('p', { class: 'hint' }, `Последний успешный бэкап: ${l ? when(l.ts) + ' · ' + size(l.size) : 'ещё не было'}. Копия делается без остановки магазина, сжимается и шифруется (AES-256-GCM).`),
        h('label', { class: 'field row' }, on, h('span', null, 'Делать бэкапы автоматически')),
        h('div', { class: 'two' }, field('Как часто', every), field('Сколько последних копий хранить на сервере', keep)),
        field('Пароль бэкапа (рекомендуется)', pass, b.has_passphrase ? 'Задан. Копию можно восстановить на любом компьютере, зная только этот пароль. Запишите его в надёжном месте: без него копию не открыть.' : 'Не задан: копии шифруются ключом сервера (DATA_ENCRYPTION_KEY из .env). Если сервер и .env пропадут, такие копии не открыть. Задайте пароль, чтобы этого не случилось.'),
        h('details', { open: s3.enabled || null }, h('summary', null, 'Загружать копии в облако (S3-совместимое хранилище)'),
          h('p', { class: 'hint' }, 'Подходит AWS S3, Cloudflare R2, Backblaze B2, Wasabi, Hetzner, MinIO и другие. Создайте отдельный bucket и ключ, которому разрешена только запись в него. Старые копии в облаке удаляйте правилом жизненного цикла (lifecycle rule) в самом bucket — так их не сможет удалить и взломщик сервера.'),
          h('div', { class: 'two' }, field('Endpoint', ep, 'R2: https://<account>.r2.cloudflarestorage.com · B2: https://s3.<region>.backblazeb2.com'), field('Регион', region, 'R2: auto')),
          h('div', { class: 'two' }, field('Bucket', bucket), field('Папка в bucket', pfx)),
          h('div', { class: 'two' }, field('Access key ID', ak), field('Secret access key', sk, s3.secret_hint ? 'Сохранён (не показывается).' : null)),
          h('label', { class: 'field row' }, s3on, h('span', null, 'Загружать каждую копию в S3')), h('div', { class: 'row actions' }, s3test)),
        h('div', { class: 'row actions' }, save, now, clearPass), msg);
    }
    function listCard() {
      const msg = h('p', { class: 'msg', role: 'status' });
      const rows = v.backups;
      if (!rows.length) return h('div', { class: 'card' }, h('h3', null, 'Копии'), h('p', { class: 'hint' }, 'Пока нет ни одной копии. Нажмите «Сделать бэкап сейчас».'));
      return h('div', { class: 'card' }, h('h3', null, 'Копии'), msg, h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Когда', 'Размер', 'Шифрование', 'S3', 'Кто', ''].map(t => h('th', null, t)))),
        h('tbody', null, rows.map(r => {
          const verify = r.local ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => busy(verify, async () => { say(msg, 'Проверяю: расшифровка + проверка целостности…'); try { const x = await api(`/data/backups/${r.name}/verify`, { method: 'POST' }); say(msg, x.ok ? `${r.name}: копия исправна (integrity ${x.integrity}, таблиц ${x.tables}, строк ${x.rows}).` : `${r.name}: не открывается — ${x.error === 'wrong_key_or_damaged' ? 'неверный ключ/пароль или файл повреждён' : x.error}.`, !x.ok); } catch (e) { say(msg, e2t(e), true); } }) }, 'Проверить') : null;
          const del = r.local ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => busy(del, async () => { if (!confirm('Удалить эту копию с сервера?' + (r.s3 === 'ok' ? ' Копия в S3 останется.' : ''))) return; try { set(await api(`/data/backups/${r.name}`, { method: 'DELETE' })); } catch (e) { say(msg, e2t(e), true); } }) }, 'Удалить') : null;
          return h('tr', null,
            h('td', null, when(r.ts), r.error && !r.size ? h('div', { class: 'msg err' }, r.error) : null),
            h('td', null, size(r.size)),
            h('td', null, r.mode === 'P' ? 'пароль бэкапа' : r.mode === 'K' ? 'ключ сервера' : '—'),
            h('td', null, r.s3 === 'ok' ? '✓' : r.s3 === 'failed' ? h('span', { class: 'pill st-failed', title: r.error || '' }, 'ошибка') : '—'),
            h('td', null, r.trigger === 'schedule' ? 'расписание' : r.by || '—'),
            h('td', null, h('div', { class: 'row' }, r.local ? h('a', { class: 'btn ghost sm', href: `/api/admin/data/backups/${encodeURIComponent(r.name)}/download`, download: r.name }, 'Скачать') : h('span', { class: 'hint' }, r.size ? 'удалена с сервера' : ''), verify, del)));
        })))));
    }
    const notes = () => h('div', { class: 'card' }, h('h3', null, 'Как восстановить'), h('ol', { class: 'hint' },
      h('li', null, 'Скачайте копию (.asvb) здесь или из S3.'),
      h('li', null, 'Расшифруйте: BACKUP_PASSPHRASE=\'ваш пароль\' node scripts/restore-backup.js копия.asvb restored.db (для копии без пароля запускайте на сервере с тем же .env).'),
      h('li', null, 'Остановите сервер, отложите data/asveli.db (и -wal, -shm), положите restored.db на место asveli.db и запустите сервер.')),
      h('p', { class: 'hint' }, 'Загруженные файлы (фото, документы) в бэкап базы не входят: они лежат в хранилище файлов (Google Drive или папка data/blobs). Если храните их локально, включите папку data/ в бэкап сервера у хостинга.'));
    put(el, root); draw();
  }

  const prev = window.Asv.navEntries;
  window.Asv.navEntries = () => {
    const out = prev();
    if (state.gated || !can('secrets.data')) return out;
    const i = out.findIndex(e => e.id === 'p_oauth');
    const entry = { id: 'p_data', label: 'Данные и бэкапы', group: 'Интеграции', render: page };
    if (i < 0) out.push(entry); else out.splice(i + 1, 0, entry);
    return out;
  };
})();
