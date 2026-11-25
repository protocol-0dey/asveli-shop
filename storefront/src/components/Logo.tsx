import { Link } from 'react-router-dom';
// The brand mark is the customer's own logo, light variant, drawn at its native proportions (viewBox 1018×1050 for the mark).
export function Logo({ to = '/', word = true }: { to?: string; word?: boolean }) {
  return (
    <Link to={to} className="logo" aria-label="ASVELI">
      <img src="/logo-mark.svg" alt="" width={39} height={40} />
      {word && <b>ASVELI</b>}
    </Link>
  );
}
