'use strict';
/* MCP endpoint for AI agents (Google Antigravity, Claude, Cursor…): Model Context Protocol over Streamable HTTP, stateless JSON responses.
   POST /mcp with a JSON-RPC message; auth = an admin API key (Authorization: Bearer asv_…), created in «Система → API и AI-агенты».
   Every tool is a thin wrapper over the admin REST API, called back into this same server with the same key: the agent can do exactly
   what the key's role may do in the admin — same validation, same price guard, same audit log — and never touch secrets. */
const express = require('express');
const cfg = require('../config');
const { audit } = require('../db');

const router = express.Router();
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = d => ({ type: 'string', description: d }), int = d => ({ type: 'integer', description: d }), obj = d => ({ type: 'object', description: d, additionalProperties: true });

const TOOLS = [
  { name: 'shop_overview', description: 'Сводка магазина: товары (всего, проверено, ждут проверки), склад, AI-подключение, защита/техработы. Start here.', inputSchema: S({}),
    run: async c => ({ ai: await c.get('/ai/overview'), guard: await c.get('/guard/status').catch(() => null) }) },
  { name: 'list_resources', description: 'Какие разделы (ресурсы) доступны этому ключу и их поля: products, orders, warehouses, carriers, stock, customers, shipments, coupons…', inputSchema: S({}),
    run: c => c.get('/meta') },
  { name: 'list_records', description: 'Список записей раздела с поиском и фильтрами. resource — имя из list_resources.', inputSchema: S({ resource: str('например products, orders, warehouses'), q: str('поиск'), page: int('страница, с 1'), limit: int('до 100'), filters: obj('фильтры поле→значение, например {"status":"approved"}') }, ['resource']),
    run: (c, a) => { const q = new URLSearchParams({ page: a.page || 1, limit: Math.min(a.limit || 25, 100) }); if (a.q) q.set('q', a.q); for (const [k, v] of Object.entries(a.filters || {})) q.set(k, String(v)); return c.get(`/m/${seg(a.resource)}?${q}`); } },
  { name: 'get_record', description: 'Одна запись целиком (например товар со всеми полями, ценой, закупкой, наценкой).', inputSchema: S({ resource: str('имя раздела'), id: int('id записи') }, ['resource', 'id']),
    run: (c, a) => c.get(`/m/${seg(a.resource)}/${num(a.id)}`) },
  { name: 'create_record', description: 'Создать запись (товар, склад, перевозчик, купон…). Поля — как в list_resources. Деньги — в центах (минимальных единицах).', inputSchema: S({ resource: str('имя раздела'), fields: obj('значения полей') }, ['resource', 'fields']),
    run: (c, a) => c.send('POST', `/m/${seg(a.resource)}`, a.fields) },
  { name: 'update_record', description: 'Изменить поля записи. Для товара: title, price, cost (закупка), markup_pct, price_from_markup, supplier_name, seo_description, story… Деньги — в центах.', inputSchema: S({ resource: str('имя раздела'), id: int('id'), fields: obj('что изменить') }, ['resource', 'id', 'fields']),
    run: (c, a) => c.send('PATCH', `/m/${seg(a.resource)}/${num(a.id)}`, a.fields) },
  { name: 'record_action', description: 'Действие над записью. Товары: ai_generate (карточка), ai_analyze (описание+цена+история), ai_apply {parts:"description,story,price"}, competitors (цены конкурентов), verify, submit, approve, delist. Отправления: ship {tracking_no}.', inputSchema: S({ resource: str('имя раздела'), id: int('id'), action: str('имя действия'), params: obj('параметры действия') }, ['resource', 'id', 'action']),
    run: (c, a) => c.send('POST', `/m/${seg(a.resource)}/${num(a.id)}/do/${seg(a.action)}`, a.params || {}) },
  { name: 'check_all_cards', description: '«Проверить все»: автоматически проверяет карточки, ожидающие проверки (правила + вторая проверка AI), подтверждает те, где нет проблем.', inputSchema: S({ limit: int('сколько карточек за вызов, до 100') }),
    run: (c, a) => c.send('POST', '/ai/review/auto', { limit: a.limit || 30 }) },
  { name: 'translate_all', description: 'Перевести карточки на все языки магазина (те, что ещё не переведены или изменились).', inputSchema: S({ limit: int('сколько переводов за вызов, до 100') }),
    run: (c, a) => c.send('POST', '/ai/translate/all', { limit: a.limit || 30 }) },
  { name: 'compare_competitor_prices', description: 'Найти цены этих товаров у конкурентов (Amazon, Allegro, eBay…) с ссылками. Без ids — товары, которые давно не проверялись.', inputSchema: S({ ids: { type: 'array', items: { type: 'integer' }, description: 'id товаров' }, limit: int('до 30') }),
    run: (c, a) => c.send('POST', '/ai/competitors/run', { ids: a.ids, limit: a.limit || 5 }) },
  /* ---------- sales & marketing department (role sales_manager; store_manager while the owner is away) ---------- */
  { name: 'sales_whoami', description: 'Отдел продаж: кто я, в каком режиме (обычный / владелец отсутствует — управление магазином передано мне), до какого времени, мои лимиты (макс. изменение цены за раз, макс. скидка). Вызывай в начале работы.', inputSchema: S({}),
    run: c => c.get('/sales/me') },
  { name: 'sales_dashboard', description: 'Сводка продаж: выручка и заказы за 1/7/30 дней, топ товаров, качество карточек, остатки, очереди (товары на проверке, вопросы покупателей, тикеты, новые заказы).', inputSchema: S({}),
    run: c => c.get('/sales/dashboard') },
  { name: 'sales_cards_to_fix', description: 'Карточки, которые надо улучшить в первую очередь: оценка 0–100 и список проблем (короткое название, мало фото, нет описания, нет категории, дороже конкурента, ниже закупки…). Сначала — продающиеся и в наличии. Исправляй через update_record (поля title, description, seo_description, images, category_id) или переписывай через record_action ai_generate.', inputSchema: S({ limit: int('сколько, по умолчанию 30'), max_score: int('только с оценкой не выше, напр. 60') }),
    run: (c, a) => c.get(`/sales/cards?limit=${Math.min(a.limit || 30, 200)}&max_score=${a.max_score ?? 100}`) },
  { name: 'sales_price_plan', description: 'План цен. rule=competitor — чуть ниже самой низкой проверенной цены конкурента (undercut_pct, по умолчанию 1%); rule=percent — изменить на pct %. Никогда не ниже закупки/мин. цены и не больше лимита за раз. По умолчанию только показывает (apply=false); apply=true — применяет и пишет историю цен. Скидки показывай только от реальной прежней цены (Omnibus).', inputSchema: S({ rule: str('competitor | percent'), ids: { type: 'array', items: { type: 'integer' }, description: 'id товаров' }, category_id: int('или вся категория'), pct: { type: 'number', description: 'для percent: напр. -5 или 3' }, undercut_pct: int('для competitor'), apply: { type: 'boolean' } }, ['rule']),
    run: (c, a) => c.send('POST', '/sales/prices/plan', a) },
  { name: 'sales_stock', description: 'Остатки и запас в днях продаж: что закончилось и продаётся, что скоро закончится, что не продаётся.', inputSchema: S({ days: int('период продаж, по умолчанию 30'), cover_days: int('порог «скоро закончится», по умолчанию 14') }),
    run: (c, a) => c.get(`/sales/stock?days=${a.days || 30}&cover_days=${a.cover_days || 14}`) },
  { name: 'sales_promo_ideas', description: 'Идеи для маркетинга: залежавшиеся товары (уценка, комплект, реклама) и лидеры продаж (усилить рекламой). Ничего не применяет само. Купоны — create_record coupons (percent в базисных пунктах: 1000 = 10%).', inputSchema: S({ limit: int('по умолчанию 20') }),
    run: (c, a) => c.get(`/sales/promo?limit=${a.limit || 20}`) },
  /* ---------- sub-agents ---------- */
  { name: 'agent_brief', description: 'Кто я: имя ключа, роль, права и моё задание (brief) от создателя. Саб-агенту — вызвать первым делом и работать строго в рамках задания.', inputSchema: S({}),
    run: c => c.get('/agents/me') },
  { name: 'agents_list', description: 'Мои саб-агенты и роли, которые я могу им дать (не шире моих прав). Максимум 10 активных.', inputSchema: S({}),
    run: c => c.get('/agents') },
  { name: 'agents_create', description: 'Создать саб-агента: отдельный ключ с узкой ролью и письменным заданием. Роли: copywriter (карточки, SEO), pricing_analyst (анализ цен, без изменений), content_checker (проверка карточек), ads_manager (кампании, купоны, баннеры), stock_keeper (остатки), marketing, analyst, catalog_manager, support_l1. Ключ возвращается один раз: передай его саб-агенту в его MCP-настройки, нигде больше не сохраняй и не пиши в чат. Саб-агент не может создавать своих агентов; при отзыве твоего ключа отключаются все.', inputSchema: S({ name: str('имя, напр. Argon-Copywriter'), role: str('роль из agents_list'), brief: str('задание: что делать, чего не делать, критерии качества (от 20 знаков)'), days: int('срок, 1–90, по умолчанию 30') }, ['name', 'role', 'brief']),
    run: (c, a) => c.send('POST', '/agents', a) },
  { name: 'agents_revoke', description: 'Отключить своего саб-агента по id (из agents_list).', inputSchema: S({ id: int('id саб-агента') }, ['id']),
    run: (c, a) => c.send('DELETE', `/agents/${num(a.id)}`, {}) },
  { name: 'admin_api', description: 'Любой другой вызов REST API админки (как в браузере): method + path после /api/admin, например GET /ai/competitors или POST /shopify/sync. Права — те же, что у ключа.', inputSchema: S({ method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: str('например /m/orders?status=paid'), body: obj('тело запроса') }, ['method', 'path']),
    run: (c, a) => (a.method === 'GET' ? c.get(path(a.path)) : c.send(a.method, path(a.path), a.body || {})) }
];
const seg = v => { const s = String(v || ''); if (!/^[a-z_]{1,40}$/.test(s)) throw rpcErr(-32602, 'invalid name: ' + s.slice(0, 40)); return s; };
const num = v => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) throw rpcErr(-32602, 'invalid id'); return n; };
const path = p => { const s = String(p || ''); if (!/^\/[A-Za-z0-9_\-/.?=&%,:+]*$/.test(s) || s.includes('..') || /^\/(auth|security|staff|me)\b/.test(s)) throw rpcErr(-32602, 'path not allowed'); return s; };
const rpcErr = (code, message) => Object.assign(new Error(message), { rpc: code });

// calls back into this server's REST API with the caller's own key: one set of rules for people, scripts and agents
function client(req) {
  const base = `http://127.0.0.1:${cfg.adminPort}/api/admin`, auth = req.headers.authorization;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { Authorization: auth, Host: '127.0.0.1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(170000) });
    let j = null; try { j = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw Object.assign(new Error(`${r.status} ${(j && j.error) || r.statusText}${j && j.detail ? ': ' + j.detail : ''}`), { tool: true });
    return j;
  };
  return { get: p => call('GET', p), send: (m, p, b) => call(m, p, b) };
}

router.all('/', express.json({ limit: '256kb' }), async (req, res) => {
  if (!req.apiKey) return res.status(401).set('WWW-Authenticate', 'Bearer realm="asveli-admin"').json({ error: 'api_key_required' });
  if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' });   // stateless server: no SSE stream
  const m = req.body;
  if (Array.isArray(m)) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch not supported' } });
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
  if (m.id === undefined) return res.status(202).end();                                   // notifications (initialized, cancelled…)
  const ok = result => res.json({ jsonrpc: '2.0', id: m.id, result }), fail = (code, message) => res.json({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  try {
    if (m.method === 'initialize') {
      const want = m.params && m.params.protocolVersion;
      return ok({ protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'asveli-admin', title: 'Asveli admin', version: '1.0.0' },
        instructions: 'Управление магазином Asveli. Начните с shop_overview и list_resources. Деньги — целые числа в минимальных единицах (центы/гроши). Изменения цен проходят защиту цен; запись в журнал действий — от имени API-ключа.' });
    }
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (m.method === 'tools/call') {
      const t = TOOLS.find(x => x.name === (m.params && m.params.name)); if (!t) return fail(-32602, 'unknown tool');
      const args = (m.params && m.params.arguments) || {};
      audit(req, 'mcp.tool', t.name, req.user.username);
      try {
        const out = await t.run(client(req), args);
        const text = JSON.stringify(out, null, 1);
        return ok({ content: [{ type: 'text', text: text.length > 200000 ? text.slice(0, 200000) + '\n…(обрезано)' : text }], isError: false });
      } catch (e) {
        if (e.rpc) return fail(e.rpc, e.message);
        return ok({ content: [{ type: 'text', text: 'Ошибка: ' + e.message }], isError: true });   // tool-level error: the agent sees it and can retry differently
      }
    }
    return fail(-32601, 'method not found');
  } catch (e) { return fail(-32603, 'internal error'); }
});
module.exports = router;
module.exports.TOOLS = TOOLS;
