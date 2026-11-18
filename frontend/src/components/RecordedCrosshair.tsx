import { useEffect, useMemo, useState } from 'react';
import { recordedCrosshair } from '../recorded-crosshair';
import { t } from '../i18n';
import './crosshair.css';

export default function RecordedCrosshair({
  code,
  preview = false,
}: {
  code?: string;
  preview?: boolean;
}) {
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const value = useMemo(
    () => recordedCrosshair(code, preview ? 1080 : size.height),
    [code, preview, size.height],
  );
  if (!value) return null;
  const { length: l, thickness: w, gap: g, outline: o } = value;
  const arms = [
    { id: 'left', x: -g - l, y: -w / 2, width: l, height: w },
    { id: 'right', x: g, y: -w / 2, width: l, height: w },
    { id: 'bottom', x: -w / 2, y: g, width: w, height: l },
    ...(!value.tStyle ? [{ id: 'top', x: -w / 2, y: -g - l, width: w, height: l }] : []),
    ...(value.dot || value.shape === 'dot'
      ? [{ id: 'dot', x: -w / 2, y: -w / 2, width: w, height: w }]
      : []),
  ].filter((arm) => value.shape !== 'dot' || arm.id === 'dot');
  const width = preview ? 96 : size.width,
    height = preview ? 96 : size.height;
  return (
    <svg
      className={'viewer-recorded-crosshair' + (preview ? ' is-preview' : '')}
      width={width}
      height={height}
      viewBox={`${-width / 2} ${-height / 2} ${width} ${height}`}
      role={preview ? 'img' : undefined}
      aria-label={preview ? t('Recorded crosshair preview') : undefined}
      aria-hidden={preview ? undefined : true}
      data-crosshair-source="player"
      data-recorded-format={value.format}
    >
      {value.shape === 'circle' || value.shape === 'square' ? (
        <g fill="none">
          {o > 0 &&
            (value.shape === 'circle' ? (
              <circle
                r={Math.abs(g) + l}
                stroke={value.outlineColor}
                strokeWidth={w + 2 * o}
                opacity={value.outlineOpacity}
              />
            ) : (
              <rect
                x={-Math.abs(g) - l}
                y={-Math.abs(g) - l}
                width={2 * (Math.abs(g) + l)}
                height={2 * (Math.abs(g) + l)}
                stroke={value.outlineColor}
                strokeWidth={w + 2 * o}
                opacity={value.outlineOpacity}
              />
            ))}
          {value.shape === 'circle' ? (
            <circle
              r={Math.abs(g) + l}
              stroke={value.color}
              strokeWidth={w}
              opacity={value.opacity}
            />
          ) : (
            <rect
              x={-Math.abs(g) - l}
              y={-Math.abs(g) - l}
              width={2 * (Math.abs(g) + l)}
              height={2 * (Math.abs(g) + l)}
              stroke={value.color}
              strokeWidth={w}
              opacity={value.opacity}
            />
          )}
          {value.dot && (
            <rect
              x={-w / 2}
              y={-w / 2}
              width={w}
              height={w}
              fill={value.color}
              opacity={value.opacity}
            />
          )}
        </g>
      ) : (
        <>
          {o > 0 && (
            <g fill={value.outlineColor} opacity={value.outlineOpacity}>
              {arms.map(({ id, ...r }) => (
                <rect
                  key={id}
                  x={r.x - o}
                  y={r.y - o}
                  width={r.width + 2 * o}
                  height={r.height + 2 * o}
                />
              ))}
            </g>
          )}
          <g fill={value.color} opacity={value.opacity}>
            {arms.map(({ id, ...r }) => (
              <rect key={id} {...r} />
            ))}
          </g>
        </>
      )}
    </svg>
  );
}
