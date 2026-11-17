import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CROSSHAIR_LIMITS,
  crosshairGeometry,
  crosshairPresets,
  defaultCrosshairStyle,
  formatCrosshairPreset,
  normalizeCrosshairStyle,
  parseCrosshairPreset,
} from '../../frontend/src/crosshair.js';

test('crosshair preferences bound and quantize finite values while rejecting unsafe colors and coercion', () => {
  const style = normalizeCrosshairStyle({
    color: 'url(https://invalid.test/style.svg)',
    length: 100000,
    thickness: -50,
    gap: 5.26,
    opacity: Infinity,
    outlineWidth: NaN,
    outline: 'false',
    centerDot: true,
    tStyle: 1,
  });
  assert.deepEqual(style, {
    ...defaultCrosshairStyle,
    length: 24,
    thickness: 1,
    gap: 5.5,
    centerDot: true,
  });
  for (const color of ['#abc', '#00ff00;fill:red', '#ffffffff', 'red', '<svg/>', '#00ff00\n'])
    assert.equal(normalizeCrosshairStyle({ color }).color, defaultCrosshairStyle.color);
  assert.equal(normalizeCrosshairStyle({ color: '#Aa12Ff' }).color, '#aa12ff');
  assert.deepEqual(normalizeCrosshairStyle(null), defaultCrosshairStyle);
  assert.deepEqual(normalizeCrosshairStyle([]), defaultCrosshairStyle);
  assert.deepEqual(
    normalizeCrosshairStyle(Object.create({ color: '#ffffff', length: 24 })),
    defaultCrosshairStyle,
  );
  assert.equal(normalizeCrosshairStyle({ opacity: -1 }).opacity, 0);
  assert.equal(normalizeCrosshairStyle({ opacity: 5 }).opacity, 1);
  assert.equal(normalizeCrosshairStyle({ opacity: 0.726 }).opacity, 0.75);
  assert.equal(normalizeCrosshairStyle({ length: '24' }).length, 8.5);
});

test('classic geometry preserves the existing centered17px cross and T style removes only the upper arm', () => {
  const classic = crosshairGeometry(defaultCrosshairStyle);
  assert.equal(classic.size, 96);
  assert.equal(classic.color, '#c6f24e');
  assert.equal(classic.opacity, 1);
  assert.equal(classic.outlines.length, 0);
  const left = classic.fills.find((part) => part.id === 'left')!;
  const right = classic.fills.find((part) => part.id === 'right')!;
  assert.equal(left.x, 39.5);
  assert.equal(right.x + right.width, 56.5);
  assert.equal(right.x + right.width - left.x, 17);
  assert.equal(left.y + left.height / 2, 48);
  assert.equal(classic.fills.length, 4);
  const t = crosshairGeometry({ ...defaultCrosshairStyle, tStyle: true, gap: 3, centerDot: true });
  assert.deepEqual(
    t.fills.map((part) => part.id),
    ['left', 'right', 'bottom', 'dot'],
  );
  const dot = t.fills.find((part) => part.id === 'dot')!;
  assert.deepEqual(dot, { id: 'dot', x: 47, y: 47, width: 2, height: 2 });
  assert.equal(t.fills.find((part) => part.id === 'right')!.x, 51);
  assert.equal(t.fills.find((part) => part.id === 'bottom')!.y, 51);
});

test('outlines expand each drawn shape uniformly and all allowed geometry stays inside the shared viewport', () => {
  const values = crosshairGeometry({
    ...defaultCrosshairStyle,
    length: CROSSHAIR_LIMITS.length.max,
    thickness: CROSSHAIR_LIMITS.thickness.max,
    gap: CROSSHAIR_LIMITS.gap.max,
    outline: true,
    outlineWidth: CROSSHAIR_LIMITS.outlineWidth.max,
    centerDot: true,
    opacity: 0,
  });
  assert.equal(values.opacity, 0, 'zero alpha remains a deliberate preference');
  assert.equal(values.outlines.length, values.fills.length);
  for (const fill of values.fills) {
    const outline = values.outlines.find((rect) => rect.id === fill.id)!;
    assert.equal(outline.x, fill.x - 3);
    assert.equal(outline.y, fill.y - 3);
    assert.equal(outline.width, fill.width + 6);
    assert.equal(outline.height, fill.height + 6);
    assert.ok(outline.x >= 0 && outline.y >= 0);
    assert.ok(outline.x + outline.width <= values.size);
    assert.ok(outline.y + outline.height <= values.size);
  }
  for (const preset of Object.values(crosshairPresets)) {
    assert.deepEqual(normalizeCrosshairStyle(preset), preset);
    assert.deepEqual(parseCrosshairPreset(formatCrosshairPreset(preset)), preset);
  }
});

test('portable presets round-trip known fields and reject excessive, malformed, injected or incompatible imports', () => {
  const style = { ...crosshairPresets.precision, color: '#a123ef', centerDot: true };
  const text = formatCrosshairPreset(style);
  assert.equal(JSON.parse(text).format, 'cswatch-crosshair');
  assert.equal(JSON.parse(text).version, 1);
  assert.deepEqual(parseCrosshairPreset(text), style);
  assert.equal(parseCrosshairPreset(' '.repeat(2049)), null);
  assert.equal(parseCrosshairPreset('not JSON'), null);
  for (const change of [
    { version: 2 },
    { format: 'CSGO-share-code' },
    { extra: true },
    { style: { ...style, color: 'url(file:///tmp/art.svg)' } },
    { style: { ...style, length: 25 } },
    { style: { ...style, opacity: -0.1 } },
    { style: { ...style, outline: 1 } },
    { style: { ...style, remoteAsset: 'https://invalid.test/art.svg' } },
    { style: { color: '#ffffff' } },
  ])
    assert.equal(parseCrosshairPreset(JSON.stringify({ ...JSON.parse(text), ...change })), null);
});
