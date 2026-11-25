// Fails if a t('key')/pl('key') used in src is missing from the English dictionary, or if PL/DE/RU lack buyer keys.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk('src').filter(f => /\.tsx?$/.test(f) && !f.includes('i18n'));
const used = new Set(), prefixes = new Set();
for (const f of files) { const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\b(?:t|pl|s)\('([a-zA-Z0-9_.]+)'(\s*\+)?/g)) { const k = (f.includes('seller') && m[0].startsWith('s(') ? 'seller.' : '') + m[1]; (m[2] ? prefixes : used).add(k); } }
const load = async l => (await import(`../.build-i18n/${l}.mjs`)).default;
execFileSync('npx', ['esbuild', ...['en', 'pl', 'de', 'ru'].map(l => `src/i18n/${l}.ts`), '--bundle', '--format=esm', '--outdir=.build-i18n', '--out-extension:.js=.mjs', '--log-level=error'], { stdio: 'inherit' });
const dict = Object.fromEntries(await Promise.all(['en', 'pl', 'de', 'ru'].map(async l => [l, await load(l)])));
let bad = 0;
const plural = k => /\.(count|nOffers)$/.test(k) || k === 'search.count' || k === 'common.nOffers';
for (const k of used) if (!(k in dict.en) && !(`${k}.other` in dict.en)) { console.log('MISSING en:', k); bad++; }
for (const l of ['pl', 'de', 'ru']) for (const k of Object.keys(dict.en)) if (!k.startsWith('seller.') && !(k in dict[l])) { console.log(`MISSING ${l}:`, k); bad++; }
for (const p of prefixes) if (!Object.keys(dict.en).some(k => k.startsWith(p))) { console.log('MISSING prefix:', p); bad++; }
console.log(bad ? `${bad} problem(s)` : 'i18n OK'); process.exit(bad ? 1 : 0);
