'use strict';
// Ready-made AI services for "Подключения AI": pick one, paste (or, for OpenRouter, sign in to get) a key, pick a model from the live list.
// Addresses are FIXED here (never typed by a user), so choosing a service can't aim the server anywhere else.
// "free" notes describe the providers' own free tiers as published by them in 2026; limits change — the page links to each provider.
// kind: which wire protocol services/ai.js speaks to it ('openai' = OpenAI-compatible /chat/completions).
// embed: 'local' = the provider has no embeddings API → semantic search uses the built-in on-server index (works, simpler quality).
// search: how the provider can browse the web for the competitor price check ('gemini' = Google Search grounding, 'openrouter' = :online web plugin, 'openai' = search models).
const CATALOG = [
  { id: 'gemini', name: 'Google Gemini', kind: 'gemini', base: 'https://generativelanguage.googleapis.com', keyUrl: 'https://aistudio.google.com/apikey',
    free: 'Бесплатный уровень в Google AI Studio, без карты (с лимитами в минуту и в день).', model: 'gemini-2.5-flash', embedModel: 'gemini-embedding-001', imageModel: 'gemini-2.5-flash-image', search: 'gemini', vision: true },
  { id: 'openrouter', name: 'OpenRouter (сотни моделей)', kind: 'openai', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys', oauth: true,
    free: 'Есть бесплатные модели (с пометкой «free»), без карты; лимит около 50 запросов в день, больше после пополнения на $10.', model: 'openai/gpt-4o-mini', embedModel: 'local', imageModel: '', search: 'openrouter', vision: true },
  { id: 'groq', name: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys',
    free: 'Бесплатный уровень без карты, очень быстрые открытые модели (Llama и др.).', model: 'llama-3.3-70b-versatile', embedModel: 'local', imageModel: '' },
  { id: 'cerebras', name: 'Cerebras', kind: 'openai', base: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai/',
    free: 'Бесплатный уровень без карты (около миллиона токенов в день).', model: 'llama-3.3-70b', embedModel: 'local', imageModel: '' },
  { id: 'mistral', name: 'Mistral AI', kind: 'openai', base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys',
    free: 'Бесплатный план «Experiment» (нужна проверка телефона).', model: 'mistral-small-latest', embedModel: 'mistral-embed', imageModel: '', vision: true },
  { id: 'github', name: 'GitHub Models', kind: 'openai', base: 'https://models.github.ai/inference', keyUrl: 'https://github.com/settings/personal-access-tokens',
    free: 'Бесплатно с аккаунтом GitHub (токен с правом «models»), небольшие дневные лимиты.', model: 'openai/gpt-4o-mini', embedModel: 'openai/text-embedding-3-small', imageModel: '', vision: true, noModelList: true,
    models: ['openai/gpt-4o-mini', 'openai/gpt-4.1-mini', 'openai/gpt-4o', 'meta/Llama-3.3-70B-Instruct', 'mistral-ai/mistral-small-2503', 'deepseek/DeepSeek-V3-0324'] },
  { id: 'nvidia', name: 'NVIDIA NIM', kind: 'openai', base: 'https://integrate.api.nvidia.com/v1', keyUrl: 'https://build.nvidia.com/',
    free: 'Бесплатные запросы для разработчиков после регистрации.', model: 'meta/llama-3.3-70b-instruct', embedModel: 'local', imageModel: '' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', base: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys',
    free: 'Платно (оплата по использованию).', model: 'gpt-4o-mini', embedModel: 'text-embedding-3-small', imageModel: 'gpt-image-1', search: 'openai', vision: true },
  { id: 'anthropic', name: 'Anthropic Claude', kind: 'openai', base: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys',
    free: 'Платно (оплата по использованию).', model: 'claude-sonnet-4-5', embedModel: 'local', imageModel: '', vision: true, noJsonMode: true },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', base: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys',
    free: 'Платно, но очень дёшево.', model: 'deepseek-chat', embedModel: 'local', imageModel: '' },
  { id: 'xai', name: 'xAI Grok', kind: 'openai', base: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai/',
    free: 'Платно (оплата по использованию).', model: 'grok-3-mini', embedModel: 'local', imageModel: '', vision: true },
  { id: 'together', name: 'Together AI', kind: 'openai', base: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys',
    free: 'Платно (оплата по использованию).', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', embedModel: 'local', imageModel: '' },
  { id: 'ollama', name: 'Ollama (на своём компьютере/сервере)', kind: 'ollama', base: '', keyUrl: 'https://ollama.com/download',
    free: 'Бесплатно: модели работают на вашем железе. Нужен адрес сервера Ollama.', model: 'qwen2.5:7b-instruct', embedModel: 'bge-m3', imageModel: '', needsUrl: true },
  { id: 'custom', name: 'Другой OpenAI-совместимый сервер', kind: 'openai', base: '', keyUrl: '', free: 'Свой адрес (vLLM, LM Studio, llama-server, любой совместимый сервис).', model: '', embedModel: 'local', imageModel: '', needsUrl: true },
  { id: 'mock', name: 'Демо-режим (без AI)', kind: 'mock', base: '', keyUrl: '', free: 'Без ключа: детерминированные демо-ответы для проверки интерфейса. Карточки помечаются как демо.', model: 'mock', embedModel: 'mock', imageModel: '' }
];
// tests only: point every fixed service address at a local fake provider
if (process.env.NODE_ENV === 'test' && process.env.AI_CATALOG_TEST_BASE) for (const s of CATALOG) if (s.base && s.kind === 'openai') s.base = process.env.AI_CATALOG_TEST_BASE;
const byId = id => CATALOG.find(x => x.id === id) || null;
// the service a stored config corresponds to (old configs had only provider + baseUrl)
function serviceOf(cfg) {
  if (cfg.service && byId(cfg.service)) return byId(cfg.service);
  if (cfg.provider === 'openai') { const b = (cfg.baseUrl || '').replace(/\/+$/, ''); return CATALOG.find(x => x.kind === 'openai' && x.base && x.base === b) || (b ? byId('custom') : byId('openai')); }
  return byId(cfg.provider) || byId('mock');
}
const pub = () => CATALOG.map(({ id, name, kind, keyUrl, free, model, embedModel, imageModel, oauth, needsUrl, search, vision }) => ({ id, name, kind, keyUrl, free, model, embedModel, imageModel, oauth: !!oauth, needsUrl: !!needsUrl, search: !!search, vision: !!vision }));
module.exports = { CATALOG, byId, serviceOf, pub };
