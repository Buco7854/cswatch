import { equipmentKind, equipmentName, type EquipmentKind } from '../equipment-display';
import { useEquipmentIcon } from '../equipment-icons';

/** Exact native artwork; recorded weapon text stays readable while it is preparing. */
export default function EquipmentGlyph({
  item,
  kind: requested,
  className = '',
}: {
  item?: string;
  kind?: EquipmentKind;
  className?: string;
}) {
  const kind = requested ?? equipmentKind(item || '');
  const icon = useEquipmentIcon(
    item ||
      (
        {
          bomb: 'c4',
          flash: 'flashbang',
          smoke: 'smokegrenade',
          he: 'hegrenade',
          incendiary: 'incgrenade',
        } as Record<string, string>
      )[kind] ||
      kind,
  );
  const weapon = [
    'ak',
    'rifle',
    'sniper',
    'smg',
    'pistol',
    'shotgun',
    'machinegun',
    'knife',
    'taser',
  ].includes(kind);
  if (icon)
    return (
      <span
        className={
          'equipment-glyph equipment-game-icon ' + (weapon ? 'is-weapon ' : '') + className
        }
        aria-hidden="true"
        style={{ maskImage: `url("${icon}")`, WebkitMaskImage: `url("${icon}")` }}
      />
    );
  if (item && weapon)
    return (
      <span
        className={'equipment-glyph is-weapon equipment-text-fallback ' + className}
        aria-hidden="true"
        title={equipmentName(item)}
      >
        {equipmentName(item)}
      </span>
    );
  return (
    <svg
      viewBox={weapon ? '0 0 72 24' : '0 0 24 24'}
      className={'equipment-glyph ' + (weapon ? 'is-weapon ' : '') + className}
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      {kind === 'ak' ? (
        <>
          <path d="M3 10h12l4-3h16l3 3h22v-2h3v3h6v3H37l-4 3-5-1-2-3H17l-5 7H7l4-7H3z" />
          <path d="m28 15 5 1 3 6-4 1-3-4z" />
        </>
      ) : kind === 'rifle' ? (
        <>
          <path d="M3 9h12v2h9l3-4h13l4 3h19V8h3v3h5v3H43l-4 2-5-1-3 7h-5l2-8H16l-2 4H5z" />
          <path d="M29 6V3h12v4h-3V5h-6v2z" />
        </>
      ) : kind === 'sniper' ? (
        <>
          <path d="m2 13 12-3h16l2-2h7l3 3h27v2H42l-4 3H25l-9 6H9l4-7H3z" />
          <path d="M27 5h16v4H27zM30 3h3v3h-3zm8 0h3v3h-3zm-7 12h4l1 5h-3z" />
        </>
      ) : kind === 'smg' ? (
        <>
          <path d="M7 8h15l3-3h17l3 4h14v4H44l-6 3H26l-5 6h-5l3-8H7z" />
          <path d="m28 14 5 1-1 8h-5zm18-4h18v2H46zM10 5h12v3H10z" />
        </>
      ) : kind === 'pistol' ? (
        <>
          <path d="M17 4h35l5 3v5H35l-3 4-2 7H18l5-12h-6z" />
          <path d="M35 12h10v4H33v-2h10v-1h-8zM56 6h9v4h-9z" />
        </>
      ) : kind === 'shotgun' ? (
        <>
          <path d="m3 12 11-4h18l3 3h34v3H36l-4 3H22l-8 6H6l6-8H3z" />
          <path d="M40 14h17v3H40zm-13 1h4l1 6h-4z" />
        </>
      ) : kind === 'machinegun' ? (
        <>
          <path d="M2 9h15l5-4h20l4 5h20v4H45l-6 3H24l-4 6h-6l3-10H2z" />
          <path d="M28 15h13v8H28zM25 4V2h17v3h-3V4zM48 14h3l4 9h-2z" />
        </>
      ) : kind === 'knife' ? (
        <path d="m5 13 19-2 3-5 37-3-27 14H27l-2 5h-5l1-5H6z" />
      ) : kind === 'taser' ? (
        <>
          <path d="M19 5h28l5 3v6H35l-4 9H20l4-12h-5z" />
          <path d="M51 6h6v2h-6zm0 5h6v2h-6z" />
        </>
      ) : kind === 'flash' ? (
        <>
          <path d="M8 7h8l2 14H6zM9 3h6v4H9z" />
          <path d="m16 4 4 3-1 2-4-3z" />
        </>
      ) : kind === 'smoke' ? (
        <>
          <path d="M7 7h10v15H7zM8 3h8v4H8z" />
          <path d="m16 4 4 3-1 2-4-3z" />
        </>
      ) : kind === 'he' || kind === 'decoy' ? (
        <>
          <path d="M9 7h7l4 7-2 7H6l-2-7zM9 3h7v4H9z" />
          <path d="m16 4 5 4-2 2-4-4z" />
          {kind === 'decoy' && (
            <path d="M8 10h2v8H8zm5 0h2v8h-2z" fill="var(--broadcast-plane, #17191c)" />
          )}
        </>
      ) : kind === 'molotov' ? (
        <>
          <path d="M10 7h5v5l4 9H6l4-9zM10 3h5v4h-5z" />
          <path d="m15 3 5-2 2 2-7 3z" />
        </>
      ) : kind === 'incendiary' ? (
        <>
          <path d="M7 7h10v15H7zM8 3h8v4H8z" />
          <path d="m16 4 5 3-2 3-4-4zM10 10h4v8h-4z" />
        </>
      ) : kind === 'bomb' ? (
        <>
          <path d="M4 8h16v13H4zM8 4h8v4H8z" />
          <path d="M7 11h6v4H7zm8 0h2v2h-2zm0 4h2v3h-2z" fill="var(--broadcast-plane, #17191c)" />
        </>
      ) : kind === 'armor' ? (
        <path d="m7 3 5 3 5-3 5 7-4 3v9H6v-9L2 10z" />
      ) : kind === 'helmet' ? (
        <path d="M3 14C2 7 6 2 12 2s10 5 9 12l-5 2v5h-5v-7H6l-2 5H2l1-5z" />
      ) : kind === 'defuser' ? (
        <>
          <path d="m4 2 4 1 2 5 9 11-3 3L6 10 2 7z" />
          <path d="m18 2 4 3-3 6-4-1-8 11-3-3L15 8l-1-3z" />
        </>
      ) : (
        <path d="M4 3h16v18H4zm3 3v12h10V6zM10 8h4v4h-2v2h-2zm0 8h2v1h-2z" />
      )}
    </svg>
  );
}
