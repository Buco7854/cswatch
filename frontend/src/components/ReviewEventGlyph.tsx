import { useEquipmentIcon } from '../equipment-icons';
import { reviewEventArtwork, type ReviewGlyphEvent } from '../review-event-artwork';
import './review-event-glyph.css';

/** Exact operator artwork, with clearly identified original semantic fallbacks. */
export default function ReviewEventGlyph({
  event,
  size = 16,
  className = '',
  detail,
}: {
  event: ReviewGlyphEvent;
  size?: number;
  className?: string;
  detail?: 'headshot';
}) {
  const key = detail === 'headshot' ? 'headshot' : reviewEventArtwork(event);
  const artwork = useEquipmentIcon(key || '');
  const properties = {
    className: 'review-event-glyph ' + className,
    'aria-hidden': true as const,
    'data-artwork': artwork ? 'operator' : 'original-fallback',
    'data-asset-key': key,
    'data-event-type': detail || event.type,
  };
  if (artwork)
    return (
      <span
        {...properties}
        style={{
          width: size,
          height: size,
          maskImage: `url("${artwork}")`,
          WebkitMaskImage: `url("${artwork}")`,
        }}
      />
    );
  return (
    <svg
      {...properties}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      {detail === 'headshot' ? (
        <>
          <path d="M8 17v-2c-3-1-4-4-3-7a7 7 0 0 1 13 1l3 3-3 1v4h-5v4" />
          <path d="M11 5v8m-4-4h8" />
        </>
      ) : event.type === 'kill' ? (
        <>
          <circle cx="12" cy="12" r="7" />
          <path d="M12 2v6m0 8v6M2 12h6m8 0h6" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        </>
      ) : event.type === 'death' || event.type === 'elimination' ? (
        <>
          <path d="M6 15a8 8 0 1 1 12 0v5H6zM9 20v-3m3 3v-3m3 3v-3" />
          <circle cx="9" cy="11" r="1" fill="currentColor" />
          <circle cx="15" cy="11" r="1" fill="currentColor" />
          <path d="m12 13-1 2h2z" />
        </>
      ) : event.type === 'plant' ? (
        <>
          <path d="M5 7h14v14H5zM8 7V4h8v3M8 11h8v4H8zM8 18h1m3 0h1m3 0h1" />
          <path d="M12 1v3m-3-2 3 2 3-2" />
        </>
      ) : event.type === 'defuse' ? (
        <>
          <path d="M4 7h14v14H4zM7 7V4h8v3M7 11h5" />
          <path d="m10 16 3 3 8-9" strokeWidth="2.3" />
        </>
      ) : event.type === 'explosion' ? (
        <path d="m12 2 2 6 6-4-2 7 5 3-7 2 1 6-5-4-6 4 1-7-6-1 6-4-2-6 6 4z" />
      ) : event.type === 'round-end' ? (
        <>
          <path d="M6 22V3m0 1h12l-3 4 3 4H6" />
          {event.team === 2 || event.team === 3 ? <path d="M10 6v4m3-4v4" /> : null}
        </>
      ) : (
        <>
          <path d="M4 18a13 13 0 0 1 16-12m-4-3 4 3-3 4" strokeDasharray="2 3" />
          <path d="M4 16h5v6H4zM5 16v-2h3v2" />
        </>
      )}
    </svg>
  );
}
