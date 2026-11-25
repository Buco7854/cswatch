// C ABI over Convection Texture Tools (MIT, see THIRD_PARTY_NOTICES.txt) for the exporter's
// lightmap mip chains. Compile with the pinned ConvectionKernels_SingleFile.cpp.
#include <cstdint>
#include <cstring>
#include "ConvectionKernels.h"

namespace {
constexpr int kBlocks = cvtt::NumParallelBlocks;

// Copies the 4x4 texel block at (bx, by) of an RGBA image, clamping at the edges.
template <typename T>
void gather(T (*block)[4], const T *pixels, int width, int height, int bx, int by) {
  for (int i = 0; i < 16; i++) {
    int x = bx * 4 + i % 4, y = by * 4 + i / 4;
    if (x >= width) x = width - 1;
    if (y >= height) y = height - 1;
    std::memcpy(block[i], pixels + (static_cast<size_t>(y) * width + x) * 4, sizeof(T) * 4);
  }
}
}  // namespace

extern "C" {
// Formats: 1 BC1, 4 BC4 (red), 5 BC5 (red, green), 6 BC6H unsigned (RGBA half floats), 7 BC7.
// Pixels are RGBA, 8-bit per channel except BC6H's 16-bit halves. Returns bytes written or -1.
int64_t cs2bc_encode(int format, const void *pixels, int width, int height, uint8_t *out,
                     int64_t capacity) {
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384 || !pixels || !out) return -1;
  const int bw = (width + 3) / 4, bh = (height + 3) / 4;
  const int blockBytes = format == 1 || format == 4 ? 8 : 16;
  if (format != 1 && format != 4 && format != 5 && format != 6 && format != 7) return -1;
  const int64_t total = static_cast<int64_t>(bw) * bh * blockBytes;
  if (total > capacity) return -1;
  cvtt::Options options;
  // Fast index selection and one BC6H refinement round: lightmap mips are smooth, and the
  // exporter re-encodes every level below Valve's own.
  options.flags = cvtt::Flags::Fast | cvtt::Flags::BC6H_FastIndexing;
  options.refineRoundsBC6H = 1;
  cvtt::BC7EncodingPlan plan;
  if (format == 7) cvtt::Kernels::ConfigureBC7EncodingPlanFromQuality(plan, 50);
  cvtt::PixelBlockU8 u8[kBlocks];
  cvtt::PixelBlockF16 f16[kBlocks];
  uint8_t encoded[kBlocks * 16];
  const int count = bw * bh;
  for (int start = 0; start < count; start += kBlocks) {
    const int n = count - start < kBlocks ? count - start : kBlocks;
    for (int i = 0; i < kBlocks; i++) {
      const int index = start + (i < n ? i : n - 1);
      if (format == 6)
        gather(f16[i].m_pixels, static_cast<const int16_t *>(pixels), width, height, index % bw,
               index / bw);
      else
        gather(u8[i].m_pixels, static_cast<const uint8_t *>(pixels), width, height, index % bw,
               index / bw);
    }
    switch (format) {
      case 1: cvtt::Kernels::EncodeBC1(encoded, u8, options); break;
      case 4: cvtt::Kernels::EncodeBC4U(encoded, u8, options); break;
      case 5: cvtt::Kernels::EncodeBC5U(encoded, u8, options); break;
      case 6: cvtt::Kernels::EncodeBC6HU(encoded, f16, options); break;
      default: cvtt::Kernels::EncodeBC7(encoded, u8, options, plan); break;
    }
    std::memcpy(out + static_cast<int64_t>(start) * blockBytes, encoded,
                static_cast<size_t>(n) * blockBytes);
  }
  return total;
}
}
