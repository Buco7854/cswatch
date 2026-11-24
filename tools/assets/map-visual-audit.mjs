import limits from '../../shared/map-graphics.json' with { type: 'json' };
import { worldMaterialAction } from './map-world-materials.mjs';

// Only classify families whose meaning is known. New Source shaders still get
// geometry probes and appear explicitly in the report when exported as plain PBR.
const features = new Map(
  [
    ['water', ['csgo_water', 'csgo_water_fancy', 'water', 'csgo_simple_liquid']],
    ['glass', ['csgo_glass']],
    ['foliage', ['csgo_foliage']],
    [
      'layered_surface',
      [
        'csgo_environment_blend',
        'csgo_lightmapped_4wayblend',
        'csgo_simple_2way_blend',
        'csgo_simple_3layer_parallax',
      ],
    ],
    [
      'lighting',
      [
        'csgo_complex',
        'csgo_environment',
        'csgo_lightmappedgeneric',
        'csgo_vertexlitgeneric',
        'csgo_simple',
      ],
    ],
    [
      'decal',
      ['csgo_static_overlay', 'csgo_projected_decals', 'projected_decals', 'projected_decal'],
    ],
    ['unlit', ['csgo_unlitgeneric', 'csgo_black_unlit']],
  ].flatMap(([feature, shaders]) => shaders.map((shader) => [shader + '.vfx', feature])),
);

const priority = [
  'unknown',
  'water',
  'glass',
  'foliage',
  'layered_surface',
  'lighting',
  'atmosphere',
  'decal',
  'unlit',
  'helper',
];
const maxViews = limits.views;

function describe(material) {
  const extras = material?.getExtras();
  const native = extras?.vmat;
  const shader =
    typeof native?.ShaderName === 'string' && /^[a-z0-9_]{1,100}\.vfx$/.test(native.ShaderName)
      ? native.ShaderName
      : 'gltf';
  const action = worldMaterialAction(material);
  let feature = features.get(shader) ?? 'unknown';
  let coverage = feature === 'unknown' ? 'unknown' : 'approximated';
  if (action === 'omit_helper') {
    feature = 'helper';
    coverage = 'intentionally_hidden';
  } else if (action.startsWith('omit_')) {
    if (action === 'omit_effect') feature = 'atmosphere';
    coverage = 'omitted';
  } else if (action === 'verified_atmosphere' || action === 'fog_surface') {
    feature = 'atmosphere';
    coverage = 'source_backed';
  } else if (feature === 'glass' && extras?.cswatch?.constantGlass?.schemaVersion === 1) {
    coverage = 'source_backed';
  }
  const name = native?.Name || material?.getName() || '';
  const materialName =
    typeof name === 'string' && name.length <= 256 && !/[\u0000-\u001f\u007f]/.test(name)
      ? name
      : '';
  return { shader, action, feature, coverage, materialName };
}

function point(matrix, [x, y, z]) {
  return [0, 1, 2].map(
    (i) => x * matrix[i] + y * matrix[4 + i] + z * matrix[8 + i] + matrix[12 + i],
  );
}

// Sample real triangle interiors rather than bounding-box centres, which can
// be in empty space. Per primitive cost is independent of its triangle count.
function representativeTriangle(primitive, matrix, winding) {
  if (primitive.getMode() !== 4 || primitive.listTargets().length) return;
  const pos = primitive.getAttribute('POSITION');
  if (!pos || pos.getType() !== 'VEC3') return;
  const indices = primitive.getIndices();
  const count = Math.floor((indices?.getCount() ?? pos.getCount()) / 3);
  if (!count) return;
  let best;
  for (const tri of new Set([0, Math.floor(count / 2), count - 1])) {
    const vertices = [0, 1, 2].map((corner) => {
      const index = tri * 3 + corner;
      const vertex = indices ? indices.getScalar(index) : index;
      if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= pos.getCount()) return;
      return point(matrix, pos.getElement(vertex, []));
    });
    if (
      !vertices.every((v) =>
        v?.every((n) => Number.isFinite(n) && Math.abs(n) < limits.maxAbsCoordinate),
      )
    )
      continue;
    const [a, b, c] = vertices;
    const [x, y, z] = b.map((n, i) => n - a[i]);
    const [u, v, w] = c.map((n, i) => n - a[i]);
    const normal = [y * w - z * v, z * u - x * w, x * v - y * u];
    const area2 = Math.hypot(...normal);
    if (!(area2 > 0.00001) || (best && best.area2 >= area2)) continue;
    const target = a.map((n, i) => (n + b[i] + c[i]) / 3);
    const distance = Math.min(8, Math.max(0.6, Math.sqrt(area2) * 1.5));
    const eye = target.map((n, i) => n + (winding * distance * normal[i]) / area2);
    if (eye.some((n) => Math.abs(n) > limits.maxAbsCoordinate)) continue;
    best = {
      area2,
      eye,
      target,
      orientation: Math.abs(normal[1]) / area2 > 0.75 ? 'horizontal' : 'upright',
    };
  }
  return best;
}

export function inspectMapGraphics(document) {
  const root = document.getRoot();
  const materials = new Map(),
    candidates = new Map(),
    placed = new Map();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  function place(node) {
    if (node.getExtras()?.cswatch?.kind === 'skybox') return;
    const mesh = node.getMesh();
    if (mesh && !node.getSkin() && !placed.has(mesh)) placed.set(mesh, node);
    for (const child of node.listChildren()) place(child);
  }
  for (const node of scene?.listChildren() ?? []) place(node);
  for (const mesh of root.listMeshes()) {
    const matrix = placed.get(mesh)?.getWorldMatrix();
    // glTF renderers reverse the front face for negatively scaled nodes.
    const winding =
      matrix &&
      Math.sign(
        matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9]) -
          matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9]) +
          matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]),
      );
    for (const primitive of mesh.listPrimitives()) {
      const { materialName, ...row } = describe(primitive.getMaterial());
      const key = [row.shader, row.action, row.coverage].join(':');
      const aggregate = materials.get(key);
      if (aggregate) aggregate.primitives++;
      else {
        if (materials.size >= limits.materials)
          throw Error('Map graphics audit exceeds the material family limit.');
        materials.set(key, { ...row, primitives: 1 });
      }
      if (!winding || row.feature === 'helper') continue;
      const face = representativeTriangle(primitive, matrix, winding);
      if (!face) continue;
      const angle = row.feature === 'lighting' ? ':' + face.orientation : '';
      const viewKey = key + angle;
      const previous = candidates.get(viewKey);
      if (!previous || face.area2 > previous.area2)
        candidates.set(viewKey, {
          area2: face.area2,
          view: {
            feature: row.feature,
            shader: row.shader,
            action: row.action,
            materialName,
            eye: face.eye,
            target: face.target,
          },
        });
    }
  }
  const rows = [...materials.values()].sort(
    (a, b) =>
      a.shader.localeCompare(b.shader) ||
      a.action.localeCompare(b.action) ||
      a.coverage.localeCompare(b.coverage),
  );
  // Allocate one view per feature first so a large family cannot hide a rare
  // effect. Only metadata is emitted; no camera or geometry runs in playback.
  const views = [];
  const groups = priority.map((feature) =>
    [...candidates.values()]
      .filter((v) => v.view.feature === feature)
      .sort((a, b) => b.area2 - a.area2),
  );
  for (let layer = 0; views.length < maxViews && groups.some((g) => g.length > layer); layer++) {
    for (const group of groups)
      if (group[layer] && views.length < maxViews) views.push(group[layer].view);
  }
  return { materials: rows, views };
}
