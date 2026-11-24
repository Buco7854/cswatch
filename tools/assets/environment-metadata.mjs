/** Bounded S2V entity/material metadata, separate from game acquisition and rendering. */
import { sourceRotate, srgbToLinear } from './environment-space.mjs';
import { validPreparedFog, validPreparedGradientFog } from './prepared-environment-fog.mjs';

const keys = new Set([
  'classname',
  'origin',
  'angles',
  'scales',
  'scale',
  'worldgroupid',
  'targetmapname',
  'skyname',
  'brightnessscale',
  'tint_color',
  'startdisabled',
  'enabled',
  'parentname',
  'targetname',
  'bakedshadowindex',
  'bakelightindex',
  'baked_light_indexing',
]);
const gradeKeys = new Set([
  ...keys,
  'master',
  'postprocessing',
  'enableexposure',
  'minexposure',
  'maxexposure',
  'color',
  'brightness',
  'style',
  'directlight',
  'skycolor',
  'skyintensity',
]);
const gradientKeys = new Set([
  'classname',
  'enabled',
  'startdisabled',
  'parentname',
  'fogstart',
  'fogend',
  'fogfalloffexponent',
  'heightfog',
  'fogstartheight',
  'fogendheight',
  'fogverticalexponent',
  'fogmaxopacity',
  'fogcolor',
  'fogstrength',
  'gradientfogtexture',
]);
const limits = { bytes: 16 * 1024 ** 2, lumps: 64, entities: 20000 };

function decoded(value) {
  const text = value.replace(/^resource_name:/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function entities(input, fields = keys) {
  const texts = Array.isArray(input) ? input : [input];
  if (
    !texts.length ||
    texts.length > limits.lumps ||
    texts.some((text) => typeof text !== 'string')
  )
    throw new Error('Environment metadata requires bounded S2V entity dump text.');
  if (
    texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > limits.bytes ||
    texts.some((text) => text.includes('\0'))
  )
    throw new Error('Environment entity metadata exceeds its text limit.');
  const result = [];
  for (const text of texts) {
    if (!/^====\d+====\r?$/m.test(text)) throw new Error('Expected an S2V .vents entity dump.');
    for (const block of text.split(/^====\d+====\r?$/m).slice(1)) {
      if (result.length >= limits.entities) throw new Error('Too many environment entities.');
      const entity = Object.create(null);
      for (const line of block.split(/\r?\n/)) {
        const property = /^([a-zA-Z0-9_.]+)\s+(.+)$/.exec(line);
        if (
          !property ||
          (!fields.has(property[1]) && !/^cubemap(?:fog|heightfog)/.test(property[1]))
        )
          continue;
        if (Object.hasOwn(entity, property[1]))
          throw new Error('Duplicate environment entity property.');
        entity[property[1]] = decoded(property[2]);
      }
      result.push(entity);
    }
  }
  return result;
}

function vector(value, fallback, color = false) {
  const result =
    typeof value === 'string' ? value.trim().split(/\s+/).map(Number) : (value ?? fallback);
  if (
    !Array.isArray(result) ||
    result.length < 3 ||
    result.length > (color ? 4 : 3) ||
    result.some((v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7) ||
    (color && result.some((v) => v < 0 || v > 255))
  )
    throw new Error('Invalid authored environment vector.');
  return result.slice(0, 3);
}
function number(value, fallback, min, max) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max)
    throw new Error('Invalid authored environment scalar.');
  return result;
}
function resource(value, extension) {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !new RegExp(`^[a-zA-Z0-9_/-]+\\.${extension}$`).test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid authored environment resource path.');
  return value;
}
function active(entity) {
  return (
    ![true, 'true', '1', 1].includes(entity.startdisabled) &&
    ![false, 'false', '0', 0].includes(entity.enabled)
  );
}
function unique(values, label) {
  if (!values.length) return null;
  if (values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0])))
    throw new Error(`Ambiguous ${label} requires an explicit supported world selection.`);
  return values[0];
}
function unparented(entity) {
  if (entity.parentname)
    throw new Error('Parented environment entities require an explicit supported transform.');
  return entity;
}
function skyEnvironment(all) {
  return unique(
    all
      .filter((entity) => entity.classname === 'env_sky' && active(entity) && entity.skyname)
      .map(unparented)
      .map((entity) => ({
        skyMaterial: resource(entity.skyname, 'vmat'),
        brightnessScale: number(entity.brightnessscale, 1, 0, 16) || 1,
        tint: vector(entity.tint_color, [255, 255, 255], true),
        angles: vector(entity.angles, [0, 0, 0]),
      })),
    'enabled sky environments',
  );
}
function fog(all) {
  return all
    .filter((entity) => entity.classname === 'env_cubemap_fog' && active(entity))
    .map((entity) => ({
      ...Object.fromEntries(Object.entries(entity).filter(([key]) => /^cubemap/.test(key))),
      angles: vector(entity.angles, [0, 0, 0]),
      parented: Boolean(entity.parentname),
    }));
}
function skySources(all) {
  return all
    .filter((entity) => entity.classname === 'env_sky' && entity.skyname)
    .map((entity) => ({
      targetName: typeof entity.targetname === 'string' ? entity.targetname : null,
      skyMaterial: resource(entity.skyname, 'vmat'),
      brightnessScale: number(entity.brightnessscale, 1, 0, 16) || 1,
      angles: vector(entity.angles, [0, 0, 0]),
      parented: Boolean(entity.parentname),
    }));
}

export function inspectMapGrade(input) {
  const all = entities(input, gradeKeys);
  const masters = all.filter(
    (entity) =>
      entity.classname === 'post_processing_volume' &&
      active(entity) &&
      [true, 'true', 1, '1'].includes(entity.master),
  );
  if (masters.length !== 1 || masters[0].parentname || !masters[0].postprocessing) return null;
  const entity = masters[0];
  const exposure = [true, 'true', 1, '1'].includes(entity.enableexposure);
  const min = exposure ? number(entity.minexposure, undefined, 0.01, 16) : 1;
  return {
    resource: resource(entity.postprocessing, 'vpost') + '_c',
    min,
    max: exposure ? number(entity.maxexposure, undefined, 0.01, 16) : 1,
    ...inspectGradeLighting(all),
  };
}

function inspectGradeLighting(all) {
  const lights = all.filter((entity) => entity.classname === 'light_environment' && active(entity));
  if (lights.length !== 1) return {};
  const light = lights[0];
  if (light.parentname || Number(light.style ?? 0) !== 0 || String(light.directlight ?? 1) !== '1')
    return {};
  try {
    const energy = number(light.brightness, 1, 0, 16) * number(light.brightnessscale, 1, 0, 16);
    if (energy > 16) return {};
    const linear = (color, scale) =>
      vector(color, [255, 255, 255], true).map((x) => srgbToLinear(x / 255) * scale);
    return {
      lighting: {
        sun: linear(light.color, energy),
        sky: linear(light.skycolor, number(light.skyintensity, 1, 0, 16)),
      },
    };
  } catch {
    return {};
  }
}

export function inspectMapEnvironment(input) {
  const all = entities(input);
  const reference = unique(
    all
      .filter((entity) => entity.classname === 'skybox_reference' && active(entity))
      .map(unparented)
      .map((entity) => ({
        skyMap: resource(entity.targetmapname, 'vmap'),
        worldGroup: typeof entity.worldgroupid === 'string' ? entity.worldgroupid : null,
        origin: vector(entity.origin, [0, 0, 0]),
        angles: vector(entity.angles, [0, 0, 0]),
        scales: vector(entity.scales, [1, 1, 1]),
      })),
    '3D sky references',
  );
  return {
    ...(skyEnvironment(all) ?? {
      skyMaterial: null,
      brightnessScale: 1,
      tint: [255, 255, 255],
      angles: [0, 0, 0],
    }),
    skyMap: reference?.skyMap ?? null,
    reference,
    fog: fog(all),
    skySources: skySources(all),
  };
}

/** A static untextured gradient in the source scene's distance and height basis. */
export function inspectGradientFog(input, matrix) {
  const authored = entities(input, gradientKeys).filter(
    (entity) => entity.classname === 'env_gradient_fog' && active(entity),
  );
  if (!authored.length) return { fog: null, reason: 'no_authored_gradient_fog' };
  const entity = authored[0];
  const unsupported = { fog: null, reason: 'unsupported_gradient_fog' };
  if (authored.length !== 1 || entity.parentname || entity.gradientfogtexture) return unsupported;
  try {
    const scale = matrix ? Math.hypot(...matrix.slice(0, 3)) : 1;
    const strength = number(entity.fogstrength, undefined, 0, 16);
    const heightEnabled = [true, 'true', 1, '1'].includes(
      entity.heightfog ?? entity.fogverticalexponent !== undefined,
    );
    let height = null;
    if (heightEnabled) {
      if (matrix && (Math.abs(matrix[1]) > 1e-4 * scale || Math.abs(matrix[9]) > 1e-4 * scale))
        return { fog: null, reason: 'unsupported_gradient_fog_transform' };
      const worldHeight = (value) =>
        number(value, undefined, -1e7, 1e7) * (matrix?.[5] ?? 1) * 0.0254 + (matrix?.[13] ?? 0);
      const start = worldHeight(entity.fogstartheight),
        end = worldHeight(entity.fogendheight);
      if (start !== end)
        height = { start, end, exponent: number(entity.fogverticalexponent, undefined, 0, 16) };
    }
    const fog = {
      start: number(entity.fogstart, undefined, 0, 1e7) * scale * 0.0254,
      end: number(entity.fogend, undefined, 0, 1e7) * scale * 0.0254,
      exponent: number(entity.fogfalloffexponent, undefined, 0, 16),
      height,
      color: vector(entity.fogcolor, undefined, true).map(
        (channel) => srgbToLinear(channel / 255) * strength,
      ),
      maxOpacity: number(entity.fogmaxopacity, undefined, 0, 1),
    };
    return validPreparedGradientFog(fog) ? { fog } : unsupported;
  } catch {
    return unsupported;
  }
}

/** Source stationary shadow slots are assigned per light, not per shader or map name. */
export function inspectSunShadowChannel(input) {
  const sun = entities(input).filter(
    (entity) => entity.classname === 'light_environment' && active(entity),
  );
  if (!sun.length) return null;
  if (sun.length !== 1 || sun[0].parentname) return undefined;
  const light = sun[0];
  if ([false, 0, 'false', '0'].includes(light.baked_light_indexing)) return null;
  const authored = light.bakedshadowindex ?? light.bakelightindex ?? -1;
  if (typeof authored !== 'number' && (typeof authored !== 'string' || !/^-?\d+$/.test(authored)))
    return undefined;
  const channel = Number(authored);
  if (channel === -1) return null;
  return Number.isInteger(channel) && channel >= 0 && channel <= 3 ? channel : undefined;
}

export function inspectSkyCamera(input) {
  const all = entities(input);
  const camera = unique(
    all
      .filter((entity) => entity.classname === 'sky_camera' && active(entity))
      .map(unparented)
      .map((entity) => ({
        origin: vector(entity.origin, [0, 0, 0]),
        scale: Math.max(1, number(entity.scale, 1, -1024, 1024)),
      })),
    'sky cameras',
  );
  if (!camera) throw new Error('The selected sky world has no recorded sky_camera.');
  if (!Number.isInteger(camera.scale))
    throw new Error('The sky camera scale must be an authored integer.');
  return {
    ...camera,
    skyEnvironment: skyEnvironment(all),
    fog: fog(all),
    skySources: skySources(all),
  };
}

/** Direction matrix for sampling an already-rotated visible cube as a different
 * authored sky. Three's loaded-CubeTexture X flip is intentionally not included. */
function cubemapFogRotation(preparedAngles, fogAngles, referenceAngles = [0, 0, 0]) {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ].flatMap(([x, y, z]) => {
    const local = sourceRotate([x, -z, y], fogAngles, true);
    const prepared = sourceRotate(sourceRotate(local, preparedAngles), referenceAngles);
    return [prepared[0], prepared[2], -prepared[1]].map((value) =>
      Math.max(-1, Math.min(1, value)),
    );
  });
}

/** CS2's inspected black_unlit pixel shader multiplies its distance and height
 * fog terms. SceneCubemapFog supplies these exact authored ranges and exposure.
 * Unsupported/missing evidence omits fog while leaving genuine sky assets usable. */
export function prepareCubemapFog({ main, camera, material, effective }) {
  try {
    if (main.fog.length !== 1)
      throw new Error('A unique enabled authored cubemap fog is unavailable.');
    const entity = main.fog[0];
    if (entity.parented) throw new Error('Parented cubemap fog is unsupported.');
    if (effective.tint.some((value) => value !== 255))
      throw new Error('The prepared sky has baked tint that native cubemap fog does not use.');
    const source = number(entity.cubemapfogsource, undefined, 1, 2);
    let skyMaterial, angles, brightnessScale;
    if (source === 1) {
      const name = entity.cubemapfogskyentity;
      if (typeof name !== 'string' || !name || name.length > 512)
        throw new Error('Cubemap fog has no bounded named sky source.');
      const match = unique(
        main.skySources.filter((sky) => sky.targetName === name),
        'named fog sky sources',
      );
      if (!match || match.parented)
        throw new Error('The authored fog sky source is missing, ambiguous or parented.');
      ({ skyMaterial, angles, brightnessScale } = match);
    } else if (source === 2) {
      skyMaterial = resource(entity.cubemapfogskymaterial, 'vmat');
      angles = entity.angles;
      brightnessScale = 1;
    } else throw new Error('Unsupported cubemap fog source.');
    if (skyMaterial !== effective.skyMaterial)
      throw new Error('The authored fog needs a different sky material than the prepared cube.');
    const start = number(entity.cubemapfogstartdistance, undefined, 0, 1e7) * 0.0254;
    const end = number(entity.cubemapfogenddistance, undefined, 0, 1e7) * 0.0254;
    if (end <= start) throw new Error('Cubemap fog requires a positive authored distance range.');
    const exponent = number(entity.cubemapfogfalloffexponent, undefined, Number.MIN_VALUE, 16);
    const lodBias = number(entity.cubemapfoglodbiase, undefined, 0, 16);
    // The explicit Source default is one for opacity. Height is enabled by the
    // presence of its exponent unless cubemapheightfog explicitly overrides it.
    const maxOpacity = number(entity.cubemapfogmaxopacity, 1, 0, 1);
    const flag = entity.cubemapheightfog;
    if (flag !== undefined && ![true, false, 'true', 'false', 0, 1, '0', '1'].includes(flag))
      throw new Error('Invalid authored height fog flag.');
    const heightEnabled =
      flag === undefined
        ? Object.hasOwn(entity, 'cubemapfogheightexponent')
        : [true, 'true', 1, '1'].includes(flag);
    let height = null;
    if (heightEnabled) {
      const heightStart = number(entity.cubemapfogheightstart, undefined, -1e7, 1e7);
      const heightEnd =
        entity.cubemapfogheightend === undefined
          ? heightStart + number(entity.cubemapfogheightwidth, undefined, -1e7, 1e7)
          : number(entity.cubemapfogheightend, undefined, -1e7, 1e7);
      if (Math.abs(heightEnd) > 1e7)
        throw new Error('Authored cubemap fog height exceeds its bound.');
      if (heightEnd !== heightStart)
        height = {
          start: heightStart * 0.0254,
          end: heightEnd * 0.0254,
          exponent: number(entity.cubemapfogheightexponent, undefined, Number.MIN_VALUE, 16),
        };
    }
    const brightness = brightnessScale * 2 ** (material.exposureBias + material.renderExposureBias);
    if (!Number.isFinite(brightness) || brightness < 0 || brightness > 16)
      throw new Error('Authored cubemap fog exposure exceeds its bound.');
    const rotation = cubemapFogRotation(
      effective.angles,
      angles,
      camera?.skyEnvironment ? main.reference.angles : [0, 0, 0],
    );
    const descriptor = {
      blend: 'multiply',
      start,
      end,
      exponent,
      height,
      maxOpacity,
      lodBias,
      brightness,
      rotation,
    };
    if (!validPreparedFog(descriptor))
      throw new Error('Authored cubemap fog exceeds the bounded publication contract.');
    return { fog: descriptor, reason: null, source: { skyMaterial, angles, brightnessScale } };
  } catch (error) {
    return { fog: null, reason: error.message };
  }
}

export function inspectSkyMaterial(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || text.includes('\0'))
    throw new Error('Expected a bounded S2V material DATA dump.');
  const matches = [
    ...text.matchAll(/m_name\s*=\s*"g_tSkyTexture"\s+m_pValue\s*=\s*resource:"([^"]+)"/g),
  ];
  if (matches.length !== 1)
    throw new Error('Sky material DATA must name exactly one g_tSkyTexture.');
  const scalar = (name) => {
    const values = [
      ...text.matchAll(
        new RegExp(`m_name\\s*=\\s*"${name}"\\s+m_flValue\\s*=\\s*([+-]?[0-9.eE]+)`, 'g'),
      ),
    ];
    if (values.length > 1) throw new Error('Duplicate sky material exposure.');
    return number(values[0]?.[1], 0, -16, 16);
  };
  return {
    texture: resource(matches[0][1], 'vtex'),
    exposureBias: scalar('g_flBrightnessExposureBias'),
    renderExposureBias: scalar('g_flRenderOnlyExposureBias'),
  };
}
