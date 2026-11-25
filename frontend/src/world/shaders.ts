import header from './glsl/common.glsl?raw';
import cubeProjection from './glsl/cubemap.glsl?raw';
import worldVertex from './glsl/world.vert.glsl?raw';
import worldFragment from './glsl/world.frag.glsl?raw';
import fullscreenVertex from './glsl/fullscreen.vert.glsl?raw';
import skyFragment from './glsl/sky.frag.glsl?raw';
import postFragment from './glsl/post.frag.glsl?raw';

export const vertex = header + worldVertex;
export const worldFrag = header + cubeProjection + worldFragment;
export const screenVertex = header + fullscreenVertex;
export const skyFrag = header + cubeProjection + skyFragment;
export const postFrag = header + postFragment;
