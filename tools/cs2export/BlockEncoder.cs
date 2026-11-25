// Interop with the pinned Convection Texture Tools build (MIT, see THIRD_PARTY_NOTICES.txt) that
// re-encodes lightmap mip levels in the block format Valve shipped.
using System.Runtime.InteropServices;

static partial class BlockEncoder
{
    const string Library = "cs2bcenc";

    static BlockEncoder()
    {
        NativeLibrary.SetDllImportResolver(typeof(BlockEncoder).Assembly, (name, assembly, path) =>
            name == Library
                ? NativeLibrary.Load(Environment.GetEnvironmentVariable("CS2EXPORT_BCENC") ?? "/opt/cs2bcenc/libcs2bcenc.so")
                : IntPtr.Zero);
    }

    [LibraryImport(Library, EntryPoint = "cs2bc_encode")]
    private static unsafe partial long Encode(int format, void* pixels, int width, int height, byte* output, long capacity);

    public static int BlockBytes(int format) => format is 1 or 4 ? 8 : 16;

    /// <summary>Encodes RGBA8 pixels (BC1, BC4, BC5, BC7) or RGBA half floats (BC6H).</summary>
    public static unsafe byte[] Run<T>(int format, T[] pixels, int width, int height) where T : unmanaged
    {
        var output = new byte[(long)((width + 3) / 4) * ((height + 3) / 4) * BlockBytes(format)];
        if (pixels.LongLength < (long)width * height * 4) throw new ArgumentException("Pixel buffer too small");
        // Bands of whole block rows encode in parallel on the exporter's CPUs.
        var blockRows = (height + 3) / 4;
        var bands = Math.Max(1, Math.Min(Environment.ProcessorCount * 2, blockRows / 16));
        var rowBytes = (long)((width + 3) / 4) * BlockBytes(format);
        var failed = false;
        fixed (T* input = pixels)
        fixed (byte* target = output)
        {
            var source = (IntPtr)input;
            var destination = (IntPtr)target;
            Parallel.For(0, bands, band =>
            {
                var first = blockRows * band / bands;
                var last = blockRows * (band + 1) / bands;
                var top = first * 4;
                var rows = Math.Min(height, last * 4) - top;
                var start = (T*)source + (long)top * width * 4;
                if (Encode(format, start, width, rows, (byte*)destination + first * rowBytes, (last - first) * rowBytes) != (last - first) * rowBytes)
                    failed = true;
            });
        }
        if (failed) throw new InvalidDataException($"Block encoding failed for format {format} at {width}x{height}");
        return output;
    }
}
