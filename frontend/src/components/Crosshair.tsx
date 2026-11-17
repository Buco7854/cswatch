import { crosshairGeometry, type CrosshairStyle } from '../crosshair';
import { t } from '../i18n';
import './crosshair.css';

/** The same bounded geometry is used for the POV and editable preview. */
export default function Crosshair({
  value,
  preview = false,
  className = '',
  label,
}: {
  value?: CrosshairStyle;
  preview?: boolean;
  className?: string;
  label?: string;
}) {
  const geometry = crosshairGeometry(value);
  return (
    <svg
      className={
        'viewer-crosshair' + (preview ? ' is-preview' : '') + (className ? ' ' + className : '')
      }
      width={geometry.size}
      height={geometry.size}
      viewBox={`0 0 ${geometry.size} ${geometry.size}`}
      role={preview ? 'img' : undefined}
      aria-label={preview ? label || t('Custom crosshair preview') : undefined}
      aria-hidden={preview ? undefined : true}
      data-crosshair-preview={preview}
      focusable="false"
    >
      <g opacity={geometry.opacity} shapeRendering="crispEdges">
        <g fill="#000000" data-crosshair-layer="outline">
          {geometry.outlines.map(({ id, ...rect }) => (
            <rect key={id} data-crosshair-part={id} {...rect} />
          ))}
        </g>
        <g fill={geometry.color} data-crosshair-layer="fill">
          {geometry.fills.map(({ id, ...rect }) => (
            <rect key={id} data-crosshair-part={id} {...rect} />
          ))}
        </g>
      </g>
    </svg>
  );
}
