import { useId } from 'react';

export function RangeSetting({
  label,
  value,
  min,
  max,
  step,
  display,
  description,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  description?: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="viewer-option-range">
      <div className="viewer-option-range-heading">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} aria-live="off">
          {display}
        </output>
      </div>
      {description && <p id={id + '-description'}>{description}</p>}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={display}
        aria-describedby={description ? id + '-description' : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
export function ToggleSetting({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="viewer-option-toggle">
      <span className="viewer-option-copy">
        {label}
        {description && <small>{description}</small>}
      </span>
      <span className="viewer-option-switch">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="viewer-option-switch-track" aria-hidden="true" />
      </span>
    </label>
  );
}
