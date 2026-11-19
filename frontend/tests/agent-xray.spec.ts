import { expect, test } from '@playwright/test';
import {
  Bone,
  BoxGeometry,
  GreaterDepth,
  NotEqualStencilFunc,
  ReplaceStencilOp,
  Group,
  Mesh,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
  Texture,
} from 'three';
import { agentXray } from '../src/agent-xray';

test('occluded native silhouettes share the posed skeleton and geometry, retain masks and dispose only their own pass', () => {
  const root = new Group(),
    bone = new Bone(),
    texture = new Texture(),
    geometry = new BoxGeometry(),
    material = new MeshBasicMaterial({ map: texture, alphaTest: 0.5 }),
    body = new SkinnedMesh(geometry, material);
  body.name = 'original-actor';
  root.add(bone, body);
  const skeleton = new Skeleton([bone]);
  body.bind(skeleton);
  body.morphTargetInfluences = [0.4];
  const xray = agentXray(root);
  expect(root.getObjectByName('xray:original-actor')).toBeUndefined();
  const release = xray.acquire(),
    shell = root.getObjectByName('xray:original-actor') as SkinnedMesh;
  expect(shell).toBeInstanceOf(SkinnedMesh);
  expect(shell.skeleton).toBe(skeleton);
  expect(shell.geometry).toBe(geometry);
  expect(shell.visible).toBe(false);
  const pass = shell.material as MeshBasicMaterial;
  expect(pass).not.toBe(material);
  expect(pass.map).toBe(texture);
  expect(pass.alphaTest).toBe(0.5);
  expect(pass.depthFunc).toBe(GreaterDepth);
  expect(pass.depthWrite).toBe(false);
  expect(pass.stencilFunc).toBe(NotEqualStencilFunc);
  expect(pass.stencilWriteMask).toBe(0);
  expect((body.material as MeshBasicMaterial).stencilZPass).toBe(ReplaceStencilOp);
  expect(body.material as MeshBasicMaterial).not.toBe(material);
  expect(material.stencilWrite).toBe(false);
  body.position.set(3, 2, 1);
  bone.position.y = 1;
  xray.sample('#83c3e5');
  root.updateMatrixWorld(true);
  expect(shell.matrixWorld.elements).toEqual(body.matrixWorld.elements);
  expect(shell.morphTargetInfluences).toBe(body.morphTargetInfluences);
  expect(shell.skeleton.bones[0]).toBe(bone);
  expect(pass.color.getHexString()).toBe('83c3e5');
  body.visible = false;
  xray.sample('#83c3e5');
  expect(shell.visible).toBe(false);
  body.visible = true;
  xray.sample();
  expect(shell.visible).toBe(false);
  expect((body.material as MeshBasicMaterial).stencilWrite).toBe(false);
  let disposed = 0,
    sharedDisposed = 0;
  pass.addEventListener('dispose', () => disposed++);
  for (const shared of [geometry, material, texture])
    shared.addEventListener('dispose', () => sharedDisposed++);
  skeleton.dispose = () => {
    sharedDisposed++;
  };
  release();
  expect(root.getObjectByName('xray:original-actor')).toBeUndefined();
  expect(disposed).toBe(1);
  expect(sharedDisposed).toBe(0);
  expect(body.material).toBe(material);
});

test('silhouettes preserve material groups and hidden parts without modifying cached artwork', () => {
  const root = new Group(),
    visible = new MeshBasicMaterial(),
    hidden = new MeshBasicMaterial();
  hidden.visible = false;
  const mesh = new Mesh(new BoxGeometry(), [visible, hidden]);
  mesh.name = 'original-grouped-body';
  root.add(mesh);
  const xray = agentXray(root);
  const release = xray.acquire();
  xray.sample('#e7ba73');
  const shell = root.getObjectByName('xray:original-grouped-body') as Mesh;
  expect((shell.material as MeshBasicMaterial[]).map((item) => item.visible)).toEqual([
    true,
    false,
  ]);
  expect(mesh.material).not.toEqual([visible, hidden]);
  expect(root.children).toHaveLength(2);
  release();
  expect(root.children).toEqual([mesh]);
  expect(mesh.material).toEqual([visible, hidden]);
});

test('committed silhouette leases restore and reacquire masks and shells across StrictMode lifetimes', () => {
  const root = new Group(),
    geometry = new BoxGeometry(),
    material = new MeshBasicMaterial(),
    body = new Mesh(geometry, material);
  body.name = 'strict-lifetime-body';
  body.renderOrder = 2;
  root.add(body);
  const xray = agentXray(root);
  // An abandoned render leaves the live instance untouched.
  expect(body.material).toBe(material);
  expect(body.renderOrder).toBe(2);
  expect(root.children).toEqual([body]);
  const release = xray.acquire(),
    second = xray.acquire(),
    shell = root.getObjectByName('xray:strict-lifetime-body') as Mesh,
    mask = body.material as MeshBasicMaterial,
    pass = shell.material as MeshBasicMaterial;
  let disposed = 0;
  for (const owned of [mask, pass]) owned.addEventListener('dispose', () => disposed++);
  xray.sample('#83c3e5');
  release();
  release();
  expect(root.getObjectByName(shell.name)).toBe(shell);
  expect(disposed).toBe(0);
  second();
  expect(disposed).toBe(2);
  expect(root.children).toEqual([body]);
  expect(body.material).toBe(material);
  expect(body.renderOrder).toBe(2);
  const remount = xray.acquire();
  xray.sample('#e7ba73');
  expect(root.getObjectByName(shell.name)).toBe(shell);
  expect(body.material).toBe(mask);
  expect(body.renderOrder).toBe(5);
  expect(shell.visible).toBe(true);
  expect(mask.stencilWrite).toBe(true);
  expect(pass.color.getHexString()).toBe('e7ba73');
  xray.sample();
  expect(body.renderOrder).toBe(2);
  expect(mask.stencilWrite).toBe(false);
  remount();
  remount();
  expect(disposed).toBe(4);
  expect(root.children).toEqual([body]);
  expect(body.material).toBe(material);
  expect(material.stencilWrite).toBe(false);
});
