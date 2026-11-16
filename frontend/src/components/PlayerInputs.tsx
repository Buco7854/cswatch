import { ChevronDown, MoveHorizontal, MoveVertical } from 'lucide-react';
import { locale, t } from '../i18n';
import type { Position } from '../types';
import './player-inputs.css';

const actionState = (pressed: boolean | undefined) =>
  pressed === undefined ? 'unknown' : pressed ? 'pressed' : 'released';

function actionDescription(action: string, pressed: boolean | undefined) {
  return t('{{action}}: {{state}}', {
    action,
    state: t(pressed === undefined ? 'Input unavailable' : pressed ? 'Pressed' : 'Released'),
  });
}

function ActionKey({
  label,
  action,
  pressed,
  className,
}: {
  label: string;
  action: string;
  pressed: boolean | undefined;
  className: string;
}) {
  const description = actionDescription(action, pressed);
  return (
    <span
      className={'input-action-key ' + className}
      data-state={actionState(pressed)}
      title={description}
    >
      <kbd aria-hidden="true">{label}</kbd>
      <span className="visually-hidden">
        {label} · {description}
      </span>
    </span>
  );
}

function MouseButton({
  side,
  pressed,
}: {
  side: 'primary' | 'secondary';
  pressed: boolean | undefined;
}) {
  const description = actionDescription(
    t(side === 'primary' ? 'Primary attack' : 'Secondary attack'),
    pressed,
  );
  return (
    <div
      className={'input-mouse-button input-mouse-' + side}
      data-state={actionState(pressed)}
      role="img"
      aria-label={description}
      title={description}
    >
      <span aria-hidden="true">{side === 'primary' ? 'LMB' : 'RMB'}</span>
    </div>
  );
}

/** Uses only command mouse counts; a missing axis is never replaced with zero. */
function MouseMovement({ dx, dy }: { dx: number | undefined; dy: number | undefined }) {
  const complete =
    typeof dx === 'number' && Number.isFinite(dx) && typeof dy === 'number' && Number.isFinite(dy);
  const magnitude = complete ? Math.hypot(dx, dy) : 0;
  const length = Math.min(10, magnitude);
  const x = complete && magnitude > 0 ? 16 + (dx / magnitude) * length : 16;
  const y = complete && magnitude > 0 ? 16 + (dy / magnitude) * length : 16;
  return (
    <svg
      className="input-mouse-motion"
      viewBox="0 0 32 32"
      role="img"
      aria-label={t(complete ? 'Mouse movement direction' : 'Input unavailable')}
      data-recorded={complete}
    >
      <path d="M16 5v22M5 16h22" className="input-mouse-motion-axes" />
      {complete && (
        <>
          <path d={`M16 16L${x} ${y}`} className="input-mouse-motion-vector" />
          <circle cx={x} cy={y} r="2" className="input-mouse-motion-point" />
        </>
      )}
    </svg>
  );
}

export default function PlayerInputs({
  state,
  layout,
  compact = false,
  detailsExpanded,
}: {
  state: Position | undefined;
  layout: 'wasd' | 'zqsd';
  compact?: boolean;
  /** A containing edge widget can expose metadata through its own action menu. */
  detailsExpanded?: boolean;
}) {
  const input = state?.input;
  if (!input)
    return (
      <section className={'input-hud-empty' + (compact ? ' is-compact' : '')}>
        {!compact && <h3>{t('Recorded inputs')}</h3>}
        <p>{t('Input actions were not recorded for this player at this moment.')}</p>
        {(!compact || detailsExpanded) && (
          <p>{t('Unavailable values are never inferred from movement or view angles.')}</p>
        )}
      </section>
    );
  const mouse = typeof input.mouseDx === 'number' || typeof input.mouseDy === 'number';
  const number = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(locale()) : '—';
  const details = (
    <>
      <p className="input-visual-source">
        {t(input.source === 'usercmd' ? 'Recorded user commands' : 'Network button states')}
      </p>
      {mouse ? (
        <div className="input-mouse-values" role="group" aria-label={t('Recorded mouse movement')}>
          <span>
            <MoveHorizontal size={15} />
            {t('Mouse ΔX')}
            <strong className="num">{number(input.mouseDx)}</strong>
          </span>
          <span>
            <MoveVertical size={15} />
            {t('Mouse ΔY')}
            <strong className="num">{number(input.mouseDy)}</strong>
          </span>
        </div>
      ) : (
        <p className="input-recording-note">
          {t('Mouse movement is unavailable for this player at this moment.')}
        </p>
      )}
      <p className="input-recording-note">
        {t(
          'Labels use conventional key bindings. The demo records sampled game actions, not physical keys.',
        )}
      </p>
    </>
  );
  return (
    <section
      className={'player-inputs' + (compact ? ' is-compact' : '')}
      aria-label={t('Selected player input actions')}
    >
      <div className="input-device-stage">
        <div
          className="input-keyboard input-movement-keys"
          role="group"
          aria-label={t('Movement actions')}
        >
          <ActionKey
            className="input-forward"
            label={layout === 'zqsd' ? 'Z' : 'W'}
            action={t('Forward')}
            pressed={input.forward}
          />
          <ActionKey
            className="input-left"
            label={layout === 'zqsd' ? 'Q' : 'A'}
            action={t('Left')}
            pressed={input.left}
          />
          <ActionKey className="input-back" label="S" action={t('Backward')} pressed={input.back} />
          <ActionKey className="input-right" label="D" action={t('Right')} pressed={input.right} />
        </div>
        <div className="input-mouse-device" role="group" aria-label={t('Mouse action display')}>
          <div className="input-mouse-shell">
            <div className="input-mouse-buttons">
              <MouseButton side="primary" pressed={input.attack} />
              <MouseButton side="secondary" pressed={input.attack2} />
            </div>
            <span className="input-mouse-wheel" aria-hidden="true" />
            <MouseMovement dx={input.mouseDx} dy={input.mouseDy} />
          </div>
        </div>
        <div className="input-keyboard input-utility-keys">
          <ActionKey className="input-use" label="E" action={t('Use')} pressed={input.use} />
          <ActionKey
            className="input-reload"
            label="R"
            action={t('Reload')}
            pressed={input.reload}
          />
          <ActionKey className="input-walk" label="Shift" action={t('Walk')} pressed={input.walk} />
          <ActionKey
            className="input-duck"
            label="Ctrl"
            action={t('Crouch')}
            pressed={input.duck}
          />
          <ActionKey
            className="input-jump"
            label={t('Space')}
            action={t('Jump')}
            pressed={input.jump}
          />
        </div>
      </div>
      {detailsExpanded === undefined ? (
        <details className="input-visual-details">
          <summary>
            <span>{t('Input details')}</span>
            <span className="input-visual-layout">
              {layout.toUpperCase()}
              <ChevronDown size={14} />
            </span>
          </summary>
          {details}
        </details>
      ) : (
        detailsExpanded && <div className="input-visual-metadata">{details}</div>
      )}
    </section>
  );
}
