import { Link } from 'react-router-dom';
import { t } from '../i18n';
export function BrandMark() {
  return (
    <svg viewBox="0 0 40 36" fill="none" aria-hidden="true">
      <path d="M31 3H10L3 10v23h21l7-7H12V12h12l7-9Z" fill="currentColor" />
      <path d="m23 13 13 7-13 7V13Z" fill="currentColor" />
    </svg>
  );
}
export default function Brand({ to = '/' }: { to?: string }) {
  return (
    <Link className="brand" to={to} aria-label={t('cswatch home')}>
      <BrandMark />
      <span>CSWATCH</span>
    </Link>
  );
}
