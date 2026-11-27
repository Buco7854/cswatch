/** Bounded, optional authored muzzle evidence from S2V's native mesh metadata.
 * This is a bone-local attachment, not a guessed tip of the render bounds. */
export const nativeMuzzleNode = 'cswatch_native_muzzle';
export const nativeEjectNode = 'cswatch_native_eject';
const maximum = 4 * 1024 ** 2;
class UnsupportedNativeMuzzle extends Error {}
const tuple = (value, count, bound) =>
  Array.isArray(value) &&
  value.length === count &&
  value.every((part) => Number.isFinite(part) && Math.abs(part) <= bound);

/** Only the small generated attachment array grammar is accepted. No KV3 resources,
 * arbitrary tags, executable strings or unbounded recursive parser are involved. */
function attachmentArray(text, start) {
  let at = start,
    tokens = 0;
  const whitespace = () => {
    while (/\s|,/.test(text[at] ?? '') && at < text.length) at++;
  };
  const token = () => {
    whitespace();
    if (++tokens > 65536 || at - start > 1024 ** 2)
      throw RangeError('Native attachment metadata exceeds its bound.');
    const beginning = at;
    if (text[at] === '"') {
      at++;
      while (at < text.length && at - beginning <= 1024) {
        if (text[at] === '\\') at += 2;
        else if (text[at++] === '"') {
          try {
            return JSON.parse(text.slice(beginning, at));
          } catch {
            throw new UnsupportedNativeMuzzle('Invalid native attachment string.');
          }
        }
      }
      if (at - beginning > 1024) throw RangeError('Native attachment string exceeds its bound.');
      throw new UnsupportedNativeMuzzle('Invalid native attachment string.');
    }
    const match = /^[a-zA-Z_][a-zA-Z_0-9]*|^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(
      text.slice(at, at + 128),
    );
    if (!match) throw new UnsupportedNativeMuzzle('Invalid native attachment token.');
    at += match[0].length;
    if (match[0] === 'true') return true;
    if (match[0] === 'false') return false;
    if (/^[+\-.\d]/.test(match[0])) {
      const number = Number(match[0]);
      if (!Number.isFinite(number))
        throw new UnsupportedNativeMuzzle('Non-finite native attachment value.');
      return number;
    }
    return match[0];
  };
  const value = (depth = 0) => {
    whitespace();
    if (depth > 12) throw RangeError('Native attachment nesting exceeds its bound.');
    if (text[at] !== '[' && text[at] !== '{') return token();
    const array = text[at++] === '[',
      result = array ? [] : Object.create(null),
      closing = array ? ']' : '}';
    while (true) {
      whitespace();
      if (text[at] === closing) {
        at++;
        return result;
      }
      if (at >= text.length)
        throw new UnsupportedNativeMuzzle('Truncated native attachment metadata.');
      if (at - start > 1024 ** 2 || ++tokens > 65536)
        throw RangeError('Native attachment metadata exceeds its bound.');
      if (array) {
        if (result.length >= 1024) throw RangeError('Native attachment array exceeds its bound.');
        result.push(value(depth + 1));
      } else {
        const key = token();
        whitespace();
        if (typeof key !== 'string' || Object.hasOwn(result, key) || text[at++] !== '=')
          throw new UnsupportedNativeMuzzle('Invalid/duplicate native attachment field.');
        result[key] = value(depth + 1);
      }
    }
  };
  return value();
}

export function validateNativeMuzzle(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'bone,position,rotation' ||
    typeof value.bone !== 'string' ||
    !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value.bone) ||
    !tuple(value.position, 3, 128) ||
    !tuple(value.rotation, 4, 1) ||
    Math.abs(value.rotation.reduce((sum, x) => sum + x * x, 0) - 1) > 0.001
  )
    throw new UnsupportedNativeMuzzle('Invalid authored native muzzle attachment.');
  return { bone: value.bone, position: [...value.position], rotation: [...value.rotation] };
}

export const inspectNativeMuzzle = (text) => inspectNativeAttachment(text, 'muzzle_flash');
/** The authored brass ejection port (`shell_eject`), with the muzzle's evidence rules. */
export const inspectNativeEject = (text) => inspectNativeAttachment(text, 'shell_eject');

function inspectNativeAttachment(text, name) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximum || text.includes('\0'))
    throw Error('Expected bounded native mesh block MDAT.');
  if (!text.includes('--- Data for block "MDAT" ---')) return undefined;
  try {
    return inspectSupportedAttachment(text, name);
  } catch (error) {
    // Optional attachment syntax can change independently of a valid native
    // model. Only classified unsupported evidence becomes unavailable. Bounds
    // remain hard failures, and subprocess/CRC/confinement failures never enter
    // this helper or this catch.
    if (error instanceof UnsupportedNativeMuzzle) return undefined;
    throw error;
  }
}

function inspectSupportedAttachment(text, name) {
  const found = [];
  let arrays = 0;
  for (const match of text.matchAll(/^[ \t]*m_attachments[ \t]*=[ \t\r\n]*(?=\[)/gm)) {
    if (++arrays > 128) throw RangeError('Too many native mesh attachment blocks.');
    const rows = attachmentArray(text, match.index + match[0].length);
    let seen = false;
    for (const row of rows) {
      if (row?.key !== name) continue;
      if (seen) return undefined;
      seen = true;
      const attachment = row.value;
      if (
        attachment?.m_name !== name ||
        attachment.m_nInfluences !== 1 ||
        attachment.m_bIgnoreRotation !== false ||
        !Array.isArray(attachment.m_influenceNames) ||
        attachment.m_influenceNames.length !== 3 ||
        attachment.m_influenceNames.slice(1).some((name) => name !== '') ||
        JSON.stringify(attachment.m_influenceWeights) !== '[1,0,0]' ||
        JSON.stringify(attachment.m_bInfluenceRootTransform) !== '[false,false,false]' ||
        !Array.isArray(attachment.m_vInfluenceOffsets) ||
        attachment.m_vInfluenceOffsets.length !== 3 ||
        !Array.isArray(attachment.m_vInfluenceRotations) ||
        attachment.m_vInfluenceRotations.length !== 3
      )
        return undefined;
      found.push(
        validateNativeMuzzle({
          bone: attachment.m_influenceNames[0],
          position: attachment.m_vInfluenceOffsets[0],
          rotation: attachment.m_vInfluenceRotations[0],
        }),
      );
    }
    if (!seen) return undefined;
  }
  // Different mesh/body-group anchors are unsupported, rather than choosing a
  // legacy/hidden attachment and labeling it as the current weapon's muzzle.
  if (!found.length || found.some((entry) => JSON.stringify(entry) !== JSON.stringify(found[0])))
    return undefined;
  return found[0];
}

/** S2V child-bone frames retain native local axes; only lengths change to meters.
 * The existing S2V rig root and single offline +90° correction own world axes. */
export const addNativeMuzzle = (document, raw) =>
  addNativeAttachment(document, raw, nativeMuzzleNode, 'muzzle_flash');
export const addNativeEject = (document, raw) =>
  addNativeAttachment(document, raw, nativeEjectNode, 'shell_eject');

function addNativeAttachment(document, raw, nodeName, tag) {
  if (raw === undefined) return undefined;
  const attachment = validateNativeMuzzle(raw),
    nodes = document.getRoot().listNodes(),
    candidates = nodes.filter((node) => node.getName() === attachment.bone);
  if (candidates.length !== 1 || nodes.some((node) => node.getName() === nodeName))
    return undefined;
  const marker = document
    .createNode(nodeName)
    .setTranslation(attachment.position.map((value) => value * 0.0254))
    .setRotation(attachment.rotation)
    .setExtras({ cswatchNativeAttachment: tag });
  candidates[0].addChild(marker);
  return { ...attachment, units: 'source-inches', node: nodeName };
}
