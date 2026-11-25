import { Matrix4 } from 'three';

// Replay and native geometry use Source inches, +Z up. All three.js actors use metres, +Y up.
export const sourceToViewer = new Matrix4().set(
  0.0254,
  0,
  0,
  0,
  0,
  0,
  0.0254,
  0,
  0,
  -0.0254,
  0,
  0,
  0,
  0,
  0,
  1,
);
export const viewerToSource = sourceToViewer.clone().invert();
