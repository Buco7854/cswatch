import type { CSSProperties } from 'react';
import type { DamageFeedbackState } from '../spectator-state';
import './spectator-hud.css';

export default function DamageFeedback({ value }: { value?: DamageFeedbackState }) {
  if (!value) return null;
  return (
    <div
      className="spectator-damage"
      aria-hidden="true"
      style={{ '--hurt-opacity': value.opacity } as CSSProperties}
    >
      <div className="spectator-damage-frame" />
      {value.direction !== undefined && (
        <svg
          className="spectator-damage-direction"
          viewBox="0 0 100 100"
          data-direction={Math.round(value.direction)}
        >
          <path
            d="M 31 16 Q 50 5 69 16 L 65 23 Q 50 15 35 23 Z"
            transform={`rotate(${value.direction} 50 50)`}
          />
        </svg>
      )}
    </div>
  );
}
