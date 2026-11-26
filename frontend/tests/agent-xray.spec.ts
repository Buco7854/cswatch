import { expect, test } from '@playwright/test';
import {
  Bone,
  BoxGeometry,
  GreaterDepth,
  EqualStencilFunc,
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
  expect(root.getObjectByName('xray-outline:original-actor')).toBeUndefined();
  const release = xray.acquire(),
    hiddenShell = root.getObjectByName('xray-hidden:original-actor') as SkinnedMesh,
    shell = root.getObjectByName('xray-outline:original-actor') as SkinnedMesh;
  for (const each of [hiddenShell, shell]) {
    expect(each).toBeInstanceOf(SkinnedMesh);
    expect(each.skeleton).toBe(skeleton);
    expect(each.geometry).toBe(geometry);
    expect(each.visible).toBe(false);
  }
  // Every hidden-pixel mask is drawn before any outline.
  expect(hiddenShell.renderOrder).toBeLessThan(shell.renderOrder);
  const hiddenPass = hiddenShell.material as MeshBasicMaterial;
  expect(hiddenPass.colorWrite).toBe(false);
  expect(hiddenPass.depthFunc).toBe(GreaterDepth);
  expect(hiddenPass.map).toBe(texture);
  expect(hiddenPass.stencilFunc).toBe(EqualStencilFunc);
  expect(hiddenPass.stencilFuncMask).toBe(1);
  expect(hiddenPass.stencilWriteMask).toBe(2);
  expect(hiddenPass.stencilZPass).toBe(ReplaceStencilOp);
  const pass = shell.material as MeshBasicMaterial;
  expect(pass).not.toBe(material);
  expect(pass.map).toBe(texture);
  expect(pass.alphaTest).toBe(0.5);
  expect(pass.depthFunc).toBe(GreaterDepth);
  expect(pass.depthWrite).toBe(false);
  // The outline draws only off both the visible body and its hidden interior.
  expect(pass.stencilFunc).toBe(EqualStencilFunc);
  expect(pass.stencilRef).toBe(0);
  expect(pass.stencilFuncMask).toBe(3);
  expect(pass.stencilWriteMask).toBe(0);
  expect((body.material as MeshBasicMaterial).stencilZPass).toBe(ReplaceStencilOp);
  expect(body.material as MeshBasicMaterial).not.toBe(material);
  expect(material.stencilWrite).toBe(false);
  body.position.set(3, 2, 1);
  bone.position.y = 1;
  xray.sample('#83c3e5');
  root.updateMatrixWorld(true);
  expect(shell.matrixWorld.elements).toEqual(body.matrixWorld.elements);
  expect(hiddenShell.matrixWorld.elements).toEqual(body.matrixWorld.elements);
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
  for (const owned of [pass, hiddenPass]) owned.addEventListener('dispose', () => disposed++);
  for (const shared of [geometry, material, texture])
    shared.addEventListener('dispose', () => sharedDisposed++);
  skeleton.dispose = () => {
    sharedDisposed++;
  };
  release();
  expect(root.getObjectByName('xray-outline:original-actor')).toBeUndefined();
  expect(root.getObjectByName('xray-hidden:original-actor')).toBeUndefined();
  expect(disposed).toBe(2);
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
  for (const prefix of ['xray-hidden:', 'xray-outline:']) {
    const shell = root.getObjectByName(prefix + 'original-grouped-body') as Mesh;
    expect((shell.material as MeshBasicMaterial[]).map((item) => item.visible)).toEqual([
      true,
      false,
    ]);
  }
  expect(mesh.material).not.toEqual([visible, hidden]);
  expect(root.children).toHaveLength(3);
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
    shell = root.getObjectByName('xray-outline:strict-lifetime-body') as Mesh,
    hiddenShell = root.getObjectByName('xray-hidden:strict-lifetime-body') as Mesh,
    mask = body.material as MeshBasicMaterial,
    pass = shell.material as MeshBasicMaterial;
  let disposed = 0;
  for (const owned of [mask, pass, hiddenShell.material as MeshBasicMaterial])
    owned.addEventListener('dispose', () => disposed++);
  xray.sample('#83c3e5');
  release();
  release();
  expect(root.getObjectByName(shell.name)).toBe(shell);
  expect(disposed).toBe(0);
  second();
  expect(disposed).toBe(3);
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
  expect(disposed).toBe(6);
  expect(root.children).toEqual([body]);
  expect(body.material).toBe(material);
  expect(material.stencilWrite).toBe(false);
});
