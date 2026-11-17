import type { ThrowInputSnapshot } from '../../../shared/throw-input';
import { t } from '../i18n';
import './throw-input-badges.css';

/** Small recorded game-action marks, never a claim about physical key bindings. */
export default function ThrowInputBadges({
  snapshot,
  layout = 'zqsd',
  synthetic = false,
}: {
  snapshot?: ThrowInputSnapshot;
  layout?: 'wasd' | 'zqsd';
  synthetic?: boolean;
}) {
  if (!snapshot || snapshot.provenance === 'unavailable')
    return (
      <span
        className="throw-input-unavailable"
        title={t('Throw inputs are unavailable.')}
        aria-label={t('Throw inputs are unavailable.')}
      >
        —
      </span>
    );
  const input = snapshot.input;
  const source = synthetic
    ? t('Synthetic input example for the original practice scene.')
    : snapshot.provenance === 'event-usercmd'
      ? t('Recorded command at throw. Game actions do not reveal physical key bindings.')
      : snapshot.provenance === 'event-network'
        ? t('Network snapshot at throw; this does not prove the physical launch command.')
        : t('Nearby network snapshot; this does not prove the physical launch command.');
  const keys: [boolean | undefined, string, string][] = [
    [input.forward, layout === 'zqsd' ? 'Z' : 'W', t('Forward')],
    [input.left, layout === 'zqsd' ? 'Q' : 'A', t('Left')],
    [input.back, 'S', t('Back')],
    [input.right, 'D', t('Right')],
    [input.jump, t('Jump'), t('Jump')],
    [input.duck, 'Ctrl', t('Crouch')],
    [input.walk, 'Shift', t('Walk')],
  ];
  const mouseKnown = typeof input.attack === 'boolean' || typeof input.attack2 === 'boolean';
  const mouseLabel =
    typeof input.attack !== 'boolean' || typeof input.attack2 !== 'boolean'
      ? t('Primary attack: {{primary}}; secondary attack: {{secondary}}', {
          primary: t(
            input.attack === true ? 'Held' : input.attack === false ? 'Not held' : 'Unavailable',
          ),
          secondary: t(
            input.attack2 === true ? 'Held' : input.attack2 === false ? 'Not held' : 'Unavailable',
          ),
        })
      : input.attack && input.attack2
        ? t('Primary and secondary attack')
        : input.attack
          ? t('Primary attack')
          : input.attack2
            ? t('Secondary attack')
            : t('No attack button held');
  const active = keys.filter(([value]) => value === true);
  return (
    <span className="throw-input-badges" title={source} data-input-provenance={snapshot.provenance}>
      <span className="visually-hidden">{source}</span>
      {mouseKnown && (
        <svg
          className="throw-input-mouse"
          width="18"
          height="24"
          viewBox="0 0 24 32"
          role="img"
          aria-label={mouseLabel}
        >
          <path
            d="M12 2C6.5 2 2 6.5 2 12v3h10Z"
            fill={input.attack ? 'currentColor' : 'none'}
            data-input-side="primary"
            data-state={input.attack === undefined ? 'unknown' : input.attack ? 'held' : 'not-held'}
            stroke={input.attack === undefined ? 'currentColor' : undefined}
            strokeDasharray={input.attack === undefined ? '2 2' : undefined}
          />
          <path
            d="M12 2c5.5 0 10 4.5 10 10v3H12Z"
            fill={input.attack2 ? 'currentColor' : 'none'}
            data-input-side="secondary"
            data-state={
              input.attack2 === undefined ? 'unknown' : input.attack2 ? 'held' : 'not-held'
            }
            stroke={input.attack2 === undefined ? 'currentColor' : undefined}
            strokeDasharray={input.attack2 === undefined ? '2 2' : undefined}
          />
          <rect
            x="2"
            y="2"
            width="20"
            height="28"
            rx="10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M12 2v13M2 15h20" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )}
      {active.map(([, key, label]) => (
        <kbd key={label} aria-label={label}>
          {key}
        </kbd>
      ))}
      {!mouseKnown && !active.length && (
        <span className="throw-input-unavailable" aria-label={t('Throw inputs are unavailable.')}>
          —
        </span>
      )}
    </span>
  );
}
