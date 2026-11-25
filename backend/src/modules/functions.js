'use strict';
// The 35 functions of the operator console, grouped as in the brief. `status` is an honest claim, covered by a test:
//   ready = existed before this iteration, new = added now, sim = works end-to-end but external calls are simulated until an adapter is configured.
// `nav` is the admin menu id the row links to.
const F = (group, title, status, nav, note) => ({ group, title, status, nav, note: note || null });
const G1 = 'Обзор', G2 = 'Товары и SKU', G3 = 'Склады и остатки', G4 = 'AI Studio', G5 = 'Интеграции', G6 = 'Мониторинг', G7 = 'Цены и риск', G8 = 'Доступ';
const FUNCTIONS = [
  F(G1, 'Дашборд оператора: выручка, заказы, страны, продажи, последние заказы', 'new', 'p_dashboard'),
  F(G2, 'Компактная таблица SKU с поиском, фильтрами и флагом «проверено»', 'new', 'p_catalog'),
  F(G2, 'Раскрывающаяся карточка: описание, источники фактов, действия', 'new', 'p_catalog'),
  F(G2, 'Фильтр «Требуют проверки» (уверенность AI ниже порога)', 'new', 'p_catalog'),
  F(G2, 'Штрихкод, артикул, внешний ID и ячейка склада', 'new', 'p_catalog'),
  F(G2, 'Источники фактов: каждый факт со ссылкой, только https', 'new', 'p_catalog'),
  F(G2, 'Импорт каталога поставщика из CSV', 'new', 'p_import', 'Ссылки на сайты поставщиков не скачиваются сервером (защита от SSRF): они сохраняются как источник.'),
  F(G2, 'История цен', 'ready', 'r_price_history'),
  F(G3, 'Склады и локации', 'ready', 'r_warehouses'),
  F(G3, 'Остатки, резерв, корректировка ±', 'ready', 'r_stock'),
  F(G3, 'Приёмка товара (inbound)', 'ready', 'r_inbound'),
  F(G3, 'Алерты: низкий остаток и затоваривание', 'new', 'p_dashboard'),
  F(G4, 'Пакетная генерация карточек с журналом заданий', 'new', 'p_studio'),
  F(G4, 'Быстрая проверка с горячими клавишами (Space / E / R)', 'new', 'p_review'),
  F(G4, 'Перегенерация с комментарием редактора', 'new', 'p_review'),
  F(G4, 'AI Canvas: граф вариантов изображения', 'new', 'p_canvas', 'Без AI_IMAGE_URL рисует абстрактные демо-картинки.'),
  F(G4, 'Brand Kit: тон текстов и запрещённые слова', 'new', 'r_brand_kits'),
  F(G4, 'Локализация карточек PL / DE / EN / RU', 'new', 'r_translations', 'В режиме mock перевод помечен как демо и не подтверждается.'),
  F(G4, 'Эмбеддинги и гибридный поиск с дельта-индексацией', 'new', 'p_search'),
  F(G4, 'A/B-тест главной картинки со z-тестом', 'new', 'r_ab_tests'),
  F(G4, 'Защита от выдумок: факт без источника отбрасывается', 'new', 'p_review'),
  F(G5, 'Каналы продаж: Shopify, Allegro, Amazon, Etsy, WooCommerce, Wildberries', 'sim', 'r_channels', 'Shopify — настоящая двусторонняя синхронизация (Интеграции → Shopify). Остальные площадки пока имитируются; ключи хранятся зашифрованными.'),
  F(G5, 'Синхронизация только одобренных и проверенных товаров', 'sim', 'r_channel_listings'),
  F(G5, 'Единый остаток и защита от оверселла (резервы)', 'ready', 'r_stock'),
  F(G5, 'Подключения AI: Gemini / OpenAI / Ollama, ключ, модели и лимиты в админке', 'new', 'p_ai_settings', 'Ключ хранится зашифрованным, виден только владельцу, применяется без перезапуска.'),
  F(G6, 'Квота AI, ошибки и задержки', 'new', 'p_monitor'),
  F(G6, 'Аналитика продаж платформы', 'ready', 'p_analytics'),
  F(G6, 'Журнал действий сотрудников', 'ready', 'audit'),
  F(G6, 'Алерты и аномалии', 'ready', 'p_analytics'),
  F(G7, 'Репрайсер с нижней и верхней границей цены', 'ready', 'p_pricing'),
  F(G7, 'Робот уценки залежавшегося товара', 'new', 'p_pricing_robot'),
  F(G7, 'Матрица эластичности спроса (оценка по модели)', 'new', 'p_pricing_robot'),
  F(G7, 'Антифрод: правила и флаги', 'ready', 'r_fraud_flags'),
  F(G7, 'Контрафакт: отклонение цены от медианы и стоп-слова', 'new', 'p_pricing_robot'),
  F(G8, 'Роли, 2FA, вход только через SSH-туннель', 'ready', 'p_staff')
];
if (FUNCTIONS.length !== 35) throw new Error('functions map must list exactly 35 entries');
module.exports = { FUNCTIONS: FUNCTIONS.map((f, i) => ({ n: i + 1, ...f })) };
