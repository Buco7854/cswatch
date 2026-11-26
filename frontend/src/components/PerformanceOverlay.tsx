import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useTranslation } from 'react-i18next';
import { performanceMonitor } from '../performance-monitor';
import { loadedModelBytes } from '../equipment-loader';
import './performance-overlay.css';

/** Inside the canvas: one timestamp per rendered frame, and three's own draws and triangles
 * accumulated over the frame's several render passes. */
export function PerformanceProbe() {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    performanceMonitor.enabled = true;
    performanceMonitor.reset();
    const previous = gl.info.autoReset;
    gl.info.autoReset = false;
    return () => {
      performanceMonitor.enabled = false;
      gl.info.autoReset = previous;
    };
  }, [gl]);
  useFrame(() => {
    performanceMonitor.frame(performance.now());
    gl.info.reset();
  }, -200);
  useFrame(() => {
    performanceMonitor.extra.draws = gl.info.render.calls;
    performanceMonitor.extra.triangles = gl.info.render.triangles;
  }, 10);
  return null;
}

const refreshMs = 250;

/** Outside the canvas: text rewritten four times a second, no React state per frame. */
export function PerformanceOverlay({
  resolution,
  pixelRatio,
  tier,
}: {
  resolution: number;
  pixelRatio: number;
  tier?: string;
}) {
  const { t, i18n } = useTranslation();
  const values = useRef<Record<string, HTMLElement | null>>({});
  const setup = useRef({ resolution, pixelRatio, tier });
  setup.current = { resolution, pixelRatio, tier };
  useEffect(() => {
    const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 });
    const decimal = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
    const write = (key: string, text: string) => {
      const node = values.current[key];
      if (node && node.textContent !== text) node.textContent = text;
    };
    const timer = setInterval(() => {
      const summary = performanceMonitor.summary(performance.now());
      const world = performanceMonitor.world;
      const memory = (world?.textureBytes ?? 0) + (world?.bufferBytes ?? 0) + loadedModelBytes();
      const idle = summary.frames < 2;
      write('fps', idle ? t('Idle') : decimal.format(summary.fps));
      write(
        'frame',
        idle
          ? '–'
          : `${decimal.format(summary.p50)} / ${decimal.format(summary.p95)} / ${decimal.format(summary.worst)} ms`,
      );
      write('long', number.format(summary.long));
      write('draws', number.format(summary.draws));
      write('triangles', number.format(Math.round(summary.triangles)));
      write('memory', `${number.format(memory / 1048576)} MiB`);
      const { resolution, pixelRatio, tier } = setup.current;
      write('scale', `${number.format(resolution)}% · ${decimal.format(pixelRatio)}×`);
      write('tier', tier === 'phone' ? t('Phone') : tier === 'desktop' ? t('Desktop') : '–');
    }, refreshMs);
    return () => clearInterval(timer);
  }, [t, i18n.language]);
  const row = (key: string, label: string) => (
    <div key={key}>
      <dt>{label}</dt>
      <dd ref={(node) => void (values.current[key] = node)} />
    </div>
  );
  return (
    <section className="performance-overlay" aria-label={t('Performance overlay')}>
      <dl>
        {row('fps', t('Frames per second'))}
        {row('frame', t('Frame time p50 / p95 / worst'))}
        {row('long', t('Long frames (3 s)'))}
        {row('draws', t('Draw calls per frame'))}
        {row('triangles', t('Triangles per frame'))}
        {row('memory', t('Estimated GPU memory'))}
        {row('scale', t('Render scale'))}
        {row('tier', t('Map tier'))}
      </dl>
    </section>
  );
}
