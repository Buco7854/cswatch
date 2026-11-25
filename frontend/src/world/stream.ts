import type { Mip } from './format';
import { allocateTexture } from './textures';

export function createTextureStream(
  gl: WebGL2RenderingContext,
  read: (file: string) => Promise<Uint8Array<ArrayBuffer>>,
  resources: { retain(release: () => void): void },
  signal?: AbortSignal,
) {
  type Upload = { target: ReturnType<typeof allocateTexture>; mip: Mip };
  type Page = { file: string; wave: number; uploads: Upload[] };
  const pages = new Map<string, Page>();
  let allocatedBytes = 0;
  function register(
    file: string,
    format: string,
    srgb: boolean,
    mips: Mip[],
    depth: number,
    flags: number,
  ) {
    const target = allocateTexture(gl, format, srgb, mips, depth, flags);
    resources.retain(() => gl.deleteTexture(target.texture));
    mips.forEach((mip, index) => {
      const name = mip.file ?? file;
      const wave =
        !mip.file || index === 0 || Math.max(mip.w, mip.h) <= 16 ? 0 : Math.max(mip.w, mip.h);
      const page = pages.get(name) ?? { file: name, wave, uploads: [] };
      pages.set(name, page);
      page.wave = Math.min(page.wave, wave);
      page.uploads.push({ target, mip });
      allocatedBytes += mip.size;
    });
    return target.texture;
  }
  async function bootstrap() {
    const initial = [...pages.values()].filter((page) => page.wave === 0);
    const payloads = await Promise.all(initial.map((page) => read(page.file)));
    signal?.throwIfAborted();
    const uploads = initial.flatMap((page, index) =>
      page.uploads.map((upload) => ({ ...upload, bytes: payloads[index] })),
    );
    // Different pages can finish in any order. Expose contiguous levels, coarse first.
    uploads.sort((a, b) => b.mip.level - a.mip.level);
    for (const { target, mip, bytes } of uploads)
      for (const slice of target.slices(mip, bytes, mip.size)) slice.write();
  }
  async function refine(invalidate: () => void) {
    const pending = [...pages.values()].filter((p) => p.wave > 0).sort((a, b) => a.wave - b.wave);
    // Fetch one page ahead. Per frame, submit at most 1 MiB of complete BC rows,
    // and yield after 2 ms of CPU submission even if some of that budget remains.
    let next = pending.length ? read(pending[0].file) : null;
    let frameBytes = 0,
      deadline = 0,
      peakFrameBytes = 0;
    for (const [index, page] of pending.entries()) {
      const bytes = await next!;
      next = index + 1 < pending.length ? read(pending[index + 1].file) : null;
      for (const { target, mip } of page.uploads)
        for (const slice of target.slices(mip, bytes, 256 * 1024)) {
          if (performance.now() >= deadline || frameBytes + slice.bytes > 1024 ** 2) {
            await new Promise<void>((resume) => requestAnimationFrame(() => resume()));
            deadline = performance.now() + 2;
            frameBytes = 0;
          }
          signal?.throwIfAborted();
          slice.write();
          frameBytes += slice.bytes;
          peakFrameBytes = Math.max(peakFrameBytes, frameBytes);
        }
      if (page.wave === 128 && next && pending[index + 1].wave !== page.wave) invalidate();
    }
    return peakFrameBytes;
  }
  return {
    register,
    bootstrap,
    refine,
    get allocatedBytes() {
      return allocatedBytes;
    },
  };
}
