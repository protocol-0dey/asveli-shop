// Placeholder artwork for products without a photo: deterministic neon tile per product, glyph per category. Never used when a real image exists.
const GLYPH: Record<string, string> = {
  Innovations: 'M50 18a32 32 0 1 0 0 64 32 32 0 0 0 0-64zm0 14v18l12 8M38 10h24M38 90h24',
  Audio: 'M22 62V50a28 28 0 0 1 56 0v12M22 56h8v22h-8zM70 56h8v22h-8z',
  Wellness: 'M50 84C30 70 22 56 24 42c2-12 14-18 26-8 12-10 24-4 26 8 2 14-6 28-26 42z',
  Style: 'M50 22a6 6 0 1 1 6 6v6l30 22a5 5 0 0 1-3 9H17a5 5 0 0 1-3-9l30-22',
  Home: 'M18 52 50 24l32 28v30H62V62H38v20H18z',
  Digital: 'M30 70a16 16 0 0 1 2-32 22 22 0 0 1 42 6 13 13 0 0 1-2 26zM50 48v20m-8-8 8 8 8-8',
  default: 'M20 36 50 22l30 14v32L50 82 20 68zM20 36l30 14 30-14M50 50v32'
};
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function ProductArt({ seed, category, title }: { seed: string; category: string; title?: string }) {
  const h = hash(seed), hue = [265, 190, 220, 160, 300, 205][h % 6], hue2 = (hue + 70 + (h >> 3) % 40) % 360, id = 'a' + h.toString(36);
  const g = GLYPH[category] || GLYPH.default;
  return (
    <svg className="art" viewBox="0 0 100 100" role="img" aria-label={title || category} preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id={id + 'b'} cx="30%" cy="25%" r="90%"><stop offset="0" stopColor={`hsl(${hue} 80% 28%)`} /><stop offset="1" stopColor="#080b22" /></radialGradient>
        <linearGradient id={id + 's'} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={`hsl(${hue2} 95% 72%)`} /><stop offset="1" stopColor={`hsl(${hue} 95% 68%)`} /></linearGradient>
        <filter id={id + 'f'}><feGaussianBlur stdDeviation="2.2" /></filter>
      </defs>
      <rect width="100" height="100" fill={`url(#${id}b)`} />
      <circle cx={20 + (h % 60)} cy={78 - (h % 30)} r="26" fill={`hsl(${hue2} 90% 55%)`} opacity=".16" filter={`url(#${id}f)`} />
      <g transform="translate(14 12) scale(.72)" fill="none" stroke={`url(#${id}s)`} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
        <path d={g} filter={`url(#${id}f)`} opacity=".7" /><path d={g} />
      </g>
    </svg>
  );
}
