import assert from 'node:assert/strict';
import test from 'node:test';
import { geometry } from './geometry.mjs';

// One triangle model with float positions and packed normals, and one blend material.
function scene({ paintCount = 3, entity } = {}) {
  const files = {
    vb: Buffer.alloc(3 * 16),
    ib: Buffer.from(new Uint16Array([0, 1, 2]).buffer),
    paint: Buffer.from([10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0]),
  };
  [
    [0, 0, 0],
    [64, 0, 0],
    [0, 64, 0],
  ].forEach((p, i) => p.forEach((x, c) => files.vb.writeFloatLE(x, i * 16 + c * 4)));
  const draw = {
    m_material: 'mat',
    m_vertexBuffers: [{ m_hBuffer: 0, m_nBindOffsetBytes: 0 }],
    m_indexBuffer: { m_hBuffer: 0, m_nBindOffsetBytes: 0 },
    m_nIndexCount: 3,
    m_nStartIndex: 0,
    m_nBaseVertex: 0,
    m_nVertexCount: 3,
  };
  const field = (name, index, format, offset) => ({ name, index, format, offset });
  return {
    read: (file) => files[file],
    value: {
      map: 'm',
      models: {
        mdl: {
          meshes: [
            {
              index: 0,
              vertices: [
                {
                  file: 'vb',
                  stride: 16,
                  count: 3,
                  fields: [
                    field('POSITION', 0, 'R32G32B32_FLOAT', 0),
                    field('NORMAL', 0, 'R32_UINT', 12),
                  ],
                },
              ],
              indices: [{ file: 'ib', stride: 2 }],
              draws: [draw],
            },
          ],
        },
      },
      materials: { mat: { shader: 'csgo_environment_blend.vfx', ints: {}, attrs: {}, slots: {} } },
      worlds: {
        'maps/m': {
          lighting: {},
          entities: entity ? [entity] : [],
          nodes: [
            {
              objects: [{ m_renderableModel: 'mdl', m_vTintColor: [1, 1, 1, 1] }],
              aggregates: [],
              extraStreams: [
                {
                  file: 'paint',
                  stride: 4,
                  count: paintCount,
                  fields: [field('TEXCOORD', 4, 'R8G8B8A8_UNORM', 0)],
                },
              ],
              extraBindings: [
                {
                  SceneObjectIndex: 0,
                  SubSceneObject: 0,
                  DrawCallIndex: 0,
                  BufferIndex: 0,
                  IsVertexLighting: false,
                },
              ],
            },
          ],
        },
      },
    },
  };
}
const blend = (range) => [0, 1, 2].map((i) => range.v[i * 60 + 36]);
test('a vertex paint stream replaces the layer blend of the draw it binds to', () => {
  const { value, read } = scene();
  const [range] = geometry(value, read, () => 0).ranges;
  assert.deepEqual(blend(range), [10, 20, 30]);
});
test('a paint stream whose element count differs from the draw is ignored', () => {
  const { value, read } = scene({ paintCount: 4 });
  const [range] = geometry(value, read, () => 0).ranges;
  assert.deepEqual(blend(range), [0, 0, 0]);
});
test('any entity with a model draws it, hidden when disabled or not rendered', () => {
  for (const [keys, visible] of [
    [{}, true],
    [{ startdisabled: true }, false],
    [{ rendermode: 10 }, false],
  ]) {
    const { value, read } = scene({
      entity: { classname: 'func_conveyor', model: 'mdl', origin: [0, 0, 4], ...keys },
    });
    const { ranges, entities } = geometry(value, read, () => 0);
    assert.equal(ranges.filter((range) => range.entityIndex === 0).length, 1);
    assert.equal(entities[0].initialVisibility, visible);
  }
});
