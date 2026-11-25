// Decodes Valve block payloads into stacked images for the phone ASTC tier.
// Block decoding uses TinyBCSharp through ValveResourceFormat 21.1 (MIT). See THIRD_PARTY_NOTICES.txt.
using System.Text.Json;
using System.Text.Json.Nodes;
using TinyBCSharp;

static class AstcInputs
{
    const int MaxRows = 32768;
    const long MaxPixels = 1L << 30;

    // SW x SH is the source extent. A larger source is box-reduced to W x H and a smaller one is
    // repeated, each by a whole factor.
    sealed record Slice(int Item, int Level, int Index, string File, long Offset, string Format, string Profile, int W, int H, int SW, int SH);
    sealed class Group
    {
        public required string Name;
        public required int[] Block;
        public required bool Srgb;
        public required int W;
        public int Rows;
        public readonly List<(Slice Slice, int Row)> Members = [];
    }

    static int BlockBytes(string format) => format switch
    {
        "DXT1" or "ATI1N" => 8,
        "DXT5" or "ATI2N" or "BC7" or "BC6H" => 16,
        "RGBA8888" => 4,
        "RGBA16161616F" => 8,
        _ => throw new InvalidDataException("Unsupported phone texture source " + format),
    };

    static long SliceBytes(string format, int w, int h) => format is "RGBA8888" or "RGBA16161616F"
        ? (long)w * h * BlockBytes(format)
        : (long)((w + 3) / 4) * ((h + 3) / 4) * BlockBytes(format);

    // Linear RGBA floats for HDR sources and raw 8-bit channels for LDR sources.
    static float[] DecodeFloat(byte[] source, Slice slice)
    {
        var count = slice.SW * slice.SH * 4;
        var output = new float[count];
        var span = source.AsSpan((int)slice.Offset, (int)SliceBytes(slice.Format, slice.SW, slice.SH));
        if (slice.Format == "BC6H")
        {
            var bytes = new byte[count * 4];
            BlockDecoder.Create(BlockFormat.BC6HUf32).Decode(span, slice.SW, slice.SH, bytes, slice.SW, slice.SH);
            Buffer.BlockCopy(bytes, 0, output, 0, bytes.Length);
        }
        else if (slice.Format == "RGBA16161616F")
            for (var i = 0; i < count; i++) output[i] = (float)BitConverter.ToHalf(span.Slice(i * 2, 2));
        else
        {
            var bytes = DecodeSource(source, slice);
            for (var i = 0; i < count; i++) output[i] = bytes[i] / 255f;
        }
        return Resample(output, slice);
    }

    // Box average of each whole-factor footprint, or repetition of each source texel.
    static float[] Resample(float[] values, Slice slice)
    {
        if (slice.SW == slice.W) return values;
        var output = new float[slice.W * slice.H * 4];
        if (slice.SW < slice.W)
        {
            var up = slice.W / slice.SW;
            for (var y = 0; y < slice.H; y++)
                for (var x = 0; x < slice.W; x++)
                    for (var c = 0; c < 4; c++)
                        output[(y * slice.W + x) * 4 + c] = values[((y / up) * slice.SW + x / up) * 4 + c];
            return output;
        }
        var scale = slice.SW / slice.W;
        var weight = 1f / (scale * scale);
        for (var y = 0; y < slice.SH; y++)
            for (var x = 0; x < slice.SW; x++)
                for (var c = 0; c < 4; c++)
                    output[((y / scale) * slice.W + x / scale) * 4 + c] += values[(y * slice.SW + x) * 4 + c] * weight;
        return output;
    }

    static byte[] DecodeLdr(byte[] source, Slice slice)
    {
        var bytes = DecodeSource(source, slice);
        if (slice.SW == slice.W) return bytes;
        var values = Resample(Array.ConvertAll(bytes, b => (float)b), slice);
        return Array.ConvertAll(values, v => (byte)Math.Clamp(MathF.Round(v), 0, 255));
    }

    static byte[] DecodeSource(byte[] source, Slice slice)
    {
        var span = source.AsSpan((int)slice.Offset, (int)SliceBytes(slice.Format, slice.SW, slice.SH));
        var output = new byte[slice.SW * slice.SH * 4];
        if (slice.Format == "RGBA8888")
        {
            span.CopyTo(output);
            return output;
        }
        var format = slice.Format switch
        {
            "DXT1" => BlockFormat.BC1,
            "DXT5" => BlockFormat.BC3,
            "ATI1N" => BlockFormat.BC4U,
            "ATI2N" => BlockFormat.BC5U,
            "BC7" => BlockFormat.BC7,
            _ => throw new InvalidDataException("HDR source requires the hdr profile: " + slice.Format),
        };
        BlockDecoder.Create(format).Decode(span, slice.SW, slice.SH, output, slice.SW, slice.SH);
        return output;
    }

    // Without a group, measures HDR ranges and writes layout.json. With one, writes only that
    // group's stacked image, so scratch holds one uncompressed group at a time.
    public static void Run(string planPath, string sourceDir, string outputDir, int? only = null)
    {
        using var planFile = File.OpenRead(planPath);
        var plan = JsonNode.Parse(planFile)!.AsObject();
        var items = plan["items"]!.AsArray();
        var slices = new List<Slice>();
        long pixels = 0;
        for (var item = 0; item < items.Count; item++)
        {
            var levels = items[item]!["levels"]!.AsArray();
            for (var level = 0; level < levels.Count; level++)
            {
                var entry = levels[level]!;
                int w = (int)entry["w"]!, h = (int)entry["h"]!, index = 0;
                // Baked lighting keeps its shipped extent; Valve ships lightmaps up to 8192.
                if (w is < 1 or > 8192 || h is < 1 or > 8192) throw new InvalidDataException("Phone texture extent");
                foreach (var source in entry["slices"]!.AsArray())
                {
                    var file = (string)source!["file"]!;
                    if (!System.Text.RegularExpressions.Regex.IsMatch(file, @"\A[0-9a-f]{64}\.bin\z")) throw new InvalidDataException("Phone texture source name");
                    var format = (string)source["format"]!;
                    var profile = (string)source["profile"]!;
                    if (profile is not ("srgb" or "linear" or "hdr")) throw new InvalidDataException("Phone texture profile");
                    long offset = (long)source["offset"]!;
                    var layers = (int)source["layers"]!;
                    int sw = (int?)source["w"] ?? w, sh = (int?)source["h"] ?? h;
                    bool Whole(int a, int b, int c, int d) => a >= b && a % b == 0 && c % d == 0 && a / b == c / d && a / b <= 4096;
                    if (!(Whole(sw, w, sh, h) || Whole(w, sw, h, sh))) throw new InvalidDataException("Phone texture source extent");
                    for (var layer = 0; layer < layers; layer++)
                    {
                        slices.Add(new Slice(item, level, index++, file, offset + layer * SliceBytes(format, sw, sh), format, profile, w, h, sw, sh));
                        pixels += Math.Max((long)sw * sh, (long)w * h);
                    }
                }
            }
        }
        if (pixels > MaxPixels) throw new InvalidDataException("Phone texture input exceeds its pixel budget");

        // Log encoding keeps each item's own linear range, shared across its HDR layers and levels.
        var ranges = new Dictionary<int, float>();
        var layoutPath = Path.Combine(outputDir, "layout.json");
        if (only != null)
            foreach (var (key, value) in JsonNode.Parse(File.ReadAllText(layoutPath))!["ranges"]!.AsObject())
                ranges[int.Parse(key)] = (float)value!;
        var cache = new Dictionary<string, byte[]>();
        byte[] Read(string file)
        {
            if (!cache.TryGetValue(file, out var bytes))
            {
                if (cache.Count > 8) cache.Clear();
                var path = Path.Combine(sourceDir, file);
                if (new FileInfo(path).Length > 512L * 1024 * 1024) throw new InvalidDataException("Phone texture source exceeds limit");
                cache[file] = bytes = File.ReadAllBytes(path);
            }
            return bytes;
        }
        foreach (var slice in slices.Where(s => only == null && s.Profile == "hdr"))
        {
            var values = DecodeFloat(Read(slice.File), slice);
            var peak = ranges.GetValueOrDefault(slice.Item, 1f / 64);
            for (var i = 0; i < values.Length; i += 4)
                peak = MathF.Max(peak, MathF.Max(values[i], MathF.Max(values[i + 1], values[i + 2])));
            ranges[slice.Item] = MathF.Min(peak, 64f);
        }

        var groups = new Dictionary<string, Group>();
        var ordered = new List<Group>();
        foreach (var slice in slices)
        {
            var block = items[slice.Item]!["block"]!.AsArray().Select(x => (int)x!).ToArray();
            if (block is not ([4, 4] or [5, 5] or [6, 6] or [8, 8])) throw new InvalidDataException("Phone block size");
            var srgb = slice.Profile == "srgb";
            var rows = (slice.H + block[1] - 1) / block[1] * block[1];
            var key = $"{block[0]}x{block[1]}/{srgb}/{slice.W}";
            // Each stacked image stays below the boundary's 512 MiB per-file limit.
            if (!groups.TryGetValue(key, out var group) || group.Rows + rows > MaxRows ||
                (long)(group.Rows + rows) * slice.W * 4 > 256L * 1024 * 1024)
            {
                group = new Group { Name = $"group-{ordered.Count}", Block = block, Srgb = srgb, W = slice.W };
                groups[key] = group;
                ordered.Add(group);
            }
            group.Members.Add((slice, group.Rows));
            group.Rows += rows;
        }

        Directory.CreateDirectory(outputDir);
        if (only != null && (only < 0 || only >= ordered.Count)) throw new InvalidDataException("Phone texture group");
        foreach (var group in only == null ? Array.Empty<Group>() : new[] { ordered[only.Value] })
        {
            var image = new byte[(long)group.W * group.Rows * 4];
            foreach (var (slice, row) in group.Members)
            {
                byte[] rgba;
                if (slice.Profile == "hdr")
                {
                    var range = ranges[slice.Item];
                    var values = DecodeFloat(Read(slice.File), slice);
                    rgba = new byte[values.Length];
                    // Each channel stores log2(1 + 1023 v / range) / 10, which keeps relative precision
                    // across the range and leaves alpha unused. On Vertigo's high-range lightmaps an
                    // RGBM multiplier turned small ASTC alpha errors into visible brightness blocks.
                    for (var i = 0; i < values.Length; i += 4)
                    {
                        for (var c = 0; c < 3; c++)
                            rgba[i + c] = (byte)Math.Clamp(MathF.Round(MathF.Log2(1 + 1023 * MathF.Max(0, values[i + c]) / range) / 10 * 255), 0, 255);
                        rgba[i + 3] = 255;
                    }
                }
                else rgba = DecodeLdr(Read(slice.File), slice);
                var stride = group.W * 4;
                var padded = (slice.H + group.Block[1] - 1) / group.Block[1] * group.Block[1];
                // Partial block rows repeat the last source row; GL ignores the padding.
                for (var y = 0; y < padded; y++)
                    Buffer.BlockCopy(rgba, Math.Min(y, slice.H - 1) * stride, image, (row + y) * stride, stride);
            }
            // Uncompressed 32-bit TGA, top-left origin, stored as BGRA.
            for (var i = 0; i < image.Length; i += 4) (image[i], image[i + 2]) = (image[i + 2], image[i]);
            using var output = File.Create(Path.Combine(outputDir, group.Name + ".tga"));
            var header = new byte[18];
            header[2] = 2;
            BitConverter.TryWriteBytes(header.AsSpan(12), (ushort)group.W);
            BitConverter.TryWriteBytes(header.AsSpan(14), (ushort)group.Rows);
            header[16] = 32;
            header[17] = 0x28;
            output.Write(header);
            output.Write(image);
        }

        if (only != null) return;
        var layout = new
        {
            groups = ordered.Select(g => new { name = g.Name, block = g.Block, srgb = g.Srgb, w = g.W, rows = g.Rows }),
            slices = ordered.SelectMany((g, index) => g.Members.Select(m => new { item = m.Slice.Item, level = m.Slice.Level, index = m.Slice.Index, group = index, row = m.Row, w = m.Slice.W, h = m.Slice.H })),
            ranges = ranges.ToDictionary(p => p.Key.ToString(), p => p.Value),
        };
        File.WriteAllText(layoutPath, JsonSerializer.Serialize(layout));
    }
}
