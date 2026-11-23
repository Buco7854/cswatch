import { locale } from './i18n';

const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** A readable storage size in the current language, for example 327 MB. */
export function formatBytes(bytes: number) {
  let value = Math.max(0, bytes),
    unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return new Intl.NumberFormat(locale(), {
    style: 'unit',
    unit: units[unit],
    // Plain bytes read best in words: 0 bytes, 1 byte, 0 octet.
    unitDisplay: unit ? 'short' : 'long',
    maximumFractionDigits: unit && value < 10 ? 1 : 0,
  }).format(value);
}
