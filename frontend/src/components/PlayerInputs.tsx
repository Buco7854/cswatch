import { MoveHorizontal, MoveVertical } from 'lucide-react';
import { locale, t } from '../i18n';
import type { Position } from '../types';

function ActionKey({
  label,
  action,
  pressed,
  className = '',
}: {
  label: string;
  action: string;
  pressed: boolean | undefined;
  className?: string;
}) {
  const status = pressed === undefined ? 'Input unavailable' : pressed ? 'Pressed' : 'Released';
  return (
    <span
      className={'input-action-key ' + className}
      data-state={pressed === undefined ? 'unknown' : pressed ? 'pressed' : 'released'}
      title={t('{{action}}: {{state}}', { action, state: t(status) })}
    >
      <kbd>{label}</kbd>
      <span className="visually-hidden">
        {t('{{action}}: {{state}}', { action, state: t(status) })}
      </span>
      {pressed === undefined && <small aria-hidden="true">?</small>}
    </span>
  );
}

export default function PlayerInputs({
  state,
  layout,
}: {
  state: Position | undefined;
  layout: 'wasd' | 'zqsd';
}) {
  const input = state?.input;
  if (!input)
    return (
      <section className="input-hud-empty">
        <h3>{t('Recorded inputs')}</h3>
        <p>{t('Input actions were not recorded for this player at this moment.')}</p>
        <p>{t('Unavailable values are never inferred from movement or view angles.')}</p>
      </section>
    );
  const mouse = typeof input.mouseDx === 'number' || typeof input.mouseDy === 'number';
  const number = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(locale()) : '—';
  return (
    <section className="player-inputs" aria-label={t('Selected player input actions')}>
      <div className="input-source">
        <span>
          {t(input.source === 'usercmd' ? 'Recorded user commands' : 'Network button states')}
        </span>
        <small>{layout.toUpperCase()}</small>
      </div>
      <div className="input-movement-grid" role="group" aria-label={t('Movement actions')}>
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
      <div className="input-modifiers" role="group" aria-label={t('Movement modifiers')}>
        <div>
          <ActionKey label="Shift" action={t('Walk')} pressed={input.walk} />
          <span>{t('Walk')}</span>
        </div>
        <div>
          <ActionKey label="Ctrl" action={t('Crouch')} pressed={input.duck} />
          <span>{t('Crouch')}</span>
        </div>
        <div>
          <ActionKey label={t('Space')} action={t('Jump')} pressed={input.jump} />
          <span>{t('Jump')}</span>
        </div>
      </div>
      <div
        className="input-other-actions"
        role="group"
        aria-label={t('Attack and interaction actions')}
      >
        <div>
          <span>{t('Primary attack')}</span>
          <strong data-active={input.attack === true}>
            {input.attack === undefined ? '—' : t(input.attack ? 'Active' : 'Inactive')}
          </strong>
        </div>
        <div>
          <span>{t('Secondary attack')}</span>
          <strong data-active={input.attack2 === true}>
            {input.attack2 === undefined ? '—' : t(input.attack2 ? 'Active' : 'Inactive')}
          </strong>
        </div>
        <div>
          <span>{t('Reload')}</span>
          <ActionKey label="R" action={t('Reload')} pressed={input.reload} />
        </div>
        <div>
          <span>{t('Use')}</span>
          <ActionKey label="E" action={t('Use')} pressed={input.use} />
        </div>
      </div>
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
    </section>
  );
}
