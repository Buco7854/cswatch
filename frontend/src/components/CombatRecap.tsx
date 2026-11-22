import { t } from '../i18n';
import type { CombatDamage, DamageRow } from '../combat-recap';
import type { CombatMoment } from '../review-moments';
import { equipmentName } from '../equipment-display';
import EquipmentGlyph from './EquipmentGlyph';
import ReviewEventGlyph from './ReviewEventGlyph';

function DamageColumn({
  title,
  rows,
  complete,
}: {
  title: string;
  rows: DamageRow[];
  complete: boolean;
}) {
  return (
    <section className="combat-recap-damage-column" aria-label={title}>
      <h3>{title}</h3>
      {rows.length ? (
        <ul
          tabIndex={rows.length > 2 ? 0 : undefined}
          data-keyboard-managed={rows.length > 2 || undefined}
        >
          {rows.map((row) => (
            <li key={row.playerId || 'unresolved'} data-player-id={row.playerId}>
              <strong className="num">{row.damage}</strong>
              <span data-team={row.team} title={row.name || t('Unknown player')}>
                {row.name || t('Unknown player')}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t(complete ? 'No damage' : 'Unavailable')}</p>
      )}
    </section>
  );
}

/** A small broadcast-style personal recap, independent of the round review panel. */
export default function CombatRecap({
  moment,
  selected,
  damage,
}: {
  moment: CombatMoment;
  selected: string;
  damage: CombatDamage;
}) {
  const death = moment.victimId === selected;
  if (!death) {
    const attacker = moment.attacker || t('Unknown player');
    const victim = moment.victim || t('Unknown player');
    const weapon = moment.weapon ? equipmentName(moment.weapon) : t('Unknown weapon');
    return (
      <div
        className="combat-kill-line"
        data-perspective="attacker"
        aria-label={t('{{attacker}} killed {{victim}} with {{weapon}}', {
          attacker,
          victim,
          weapon,
        })}
      >
        <strong data-team={moment.attackerTeam} title={attacker}>
          {attacker}
        </strong>
        <span role="img" aria-label={weapon} title={weapon}>
          <EquipmentGlyph item={moment.weapon} />
        </span>
        <strong data-team={moment.victimTeam} title={victim}>
          {victim}
        </strong>
      </div>
    );
  }
  const opponent = moment.attacker || t('Unknown player');
  const opponentTeam = moment.attackerTeam;
  return (
    <div className="combat-recap" data-perspective="victim" data-coverage={damage.coverage}>
      <div className="combat-recap-title">
        <span>{t('Killed by')}</span>
        <strong data-team={opponentTeam} title={opponent}>
          {opponent}
        </strong>
      </div>
      <div className="combat-recap-weapon">
        <EquipmentGlyph item={moment.weapon} />
        <span>{moment.weapon ? equipmentName(moment.weapon) : t('Unknown weapon')}</span>
        {moment.headshot && (
          <>
            <ReviewEventGlyph event={{ type: 'kill' }} detail="headshot" />
            <span>{t('Headshot')}</span>
          </>
        )}
      </div>
      <div
        className="combat-recap-damage"
        role="group"
        aria-label={t('Recorded damage this round up to this elimination.')}
      >
        <DamageColumn
          title={t('Damage taken')}
          rows={damage.taken}
          complete={damage.coverage === 'complete'}
        />
        <DamageColumn
          title={t('Damage dealt')}
          rows={damage.dealt}
          complete={damage.coverage === 'complete'}
        />
      </div>
      {damage.coverage !== 'complete' && (
        <p className="combat-recap-coverage">
          {t(
            damage.coverage === 'partial'
              ? 'Recorded damage only'
              : 'Damage was not fully recorded',
          )}
        </p>
      )}
    </div>
  );
}
