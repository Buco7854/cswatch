// World traversal and draw bindings adapted from ValveResourceFormat 21.1 (MIT).
// Copyright (c) 2015 ValveResourceFormat Contributors. See THIRD_PARTY_NOTICES.txt.
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using ValveKeyValue;
using ValveResourceFormat;
using ValveResourceFormat.Blocks;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;

sealed class NativeScene(ResourceStore store, string game, string output, string map, string manifest)
{
    readonly Dictionary<string, object> models = [];
    readonly Dictionary<string, object> materials = [];
    readonly SortedSet<string> missing = new(StringComparer.Ordinal), missingSkies = new(StringComparer.Ordinal);
    readonly Dictionary<string, object> textures = [];
    readonly Dictionary<string, object> worlds = [];
    readonly Dictionary<string, object> post = [];
    readonly Dictionary<string, object> files = [];
    long bytesWritten;

    static object? Plain(KVObject value) => value.ValueType switch
    {
        KVValueType.Collection => value.Children.ToDictionary(p => p.Key, p => Plain(p.Value)),
        KVValueType.Array => value.Values.Select(Plain).ToArray(),
        KVValueType.BinaryBlob => value.AsBlob(),
        KVValueType.Boolean => (bool)value,
        KVValueType.String => (string)value,
        KVValueType.Null => null,
        KVValueType.Int64 => value.ToInt64(CultureInfo.InvariantCulture),
        KVValueType.UInt64 => value.ToUInt64(CultureInfo.InvariantCulture),
        _ => value.ToDouble(CultureInfo.InvariantCulture),
    };

    string Write(string category, ReadOnlySpan<byte> data)
    {
        string sha256 = Convert.ToHexStringLower(SHA256.HashData(data));
        string file = sha256 + ".bin";
        if (files.ContainsKey(file)) return file;
        bytesWritten = checked(bytesWritten + data.Length);
        if (bytesWritten > 3L * 1024 * 1024 * 1024) throw new InvalidDataException("Output exceeds 3 GiB");
        if (new DriveInfo(Path.GetPathRoot(output)!).AvailableFreeSpace - data.Length < 4L << 30)
            throw new IOException("Output would exhaust the 4 GiB disk reserve");
        using var stream = new FileStream(Path.Combine(output, file), FileMode.CreateNew);
        stream.Write(data);
        files.Add(file, new { category, size = data.Length, sha256 });
        return file;
    }

    // A 3D sky prefab is a compiled map under maps/. The installer downloads only prefab VPKs in the
    // selected map's own folder; any other reference must already be present in the read-only game root.
    public static string SkyPrefab(string map, string? reference)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(reference ?? "", @"\Amaps/(?:[a-z0-9_]{1,80}/){0,4}[a-z0-9_]{1,100}\.vmap\z"))
            throw new InvalidDataException($"Unsupported sky prefab reference for {map}: {reference}");
        return reference![..^5];
    }

    public void Extract()
    {
        World("maps/" + map);
        using var visAsset = store.ReadOptional($"maps/{map}/world_visibility.vvis");
        object? visibility = null;
        if (visAsset != null && VoxelVisibility.GetWorldVisibility(visAsset) is VoxelVisibility { HasVisibilityData: true } vis)
        {
            using var data = new MemoryStream();
            using var writer = new BinaryWriter(data);
            writer.Write(vis.BaseClusterCount);
            writer.Write(vis.PVSBytesPerCluster);
            writer.Write(vis.SkyVisibilityCluster);
            writer.Write(vis.SunVisibilityCluster);
            writer.Write(vis.GridSize);
            foreach (var v in new[] {vis.MinBounds, vis.MaxBounds})
            { writer.Write(v.X); writer.Write(v.Y); writer.Write(v.Z); }
            writer.Write(vis.Nodes.Length);
            foreach (var n in vis.Nodes)
            {
                writer.Write((n.Offset << 1) | (n.IsLeaf ? 1u : 0u));
                writer.Write((n.EnclosedListIndex << 8) | n.RegionCount);
            }
            writer.Write(vis.Regions.Length);
            foreach (var r in vis.Regions)
                writer.Write((ulong)r.ClusterId | (r.IsIntersectingGeo ? 0x8000ul : 0ul) | ((ulong)r.LeafIndex << 16) | ((ulong)r.MaskIndex << 40));
            writer.Write(vis.EnclosedClusterList.Length);
            foreach (var (offset,count) in vis.EnclosedClusterList) { writer.Write(offset); writer.Write(count); }
            writer.Write(vis.EnclosedClusters.Length);
            foreach (var c in vis.EnclosedClusters) writer.Write(c);
            writer.Write(vis.Masks.Length);
            foreach (var mask in vis.Masks) writer.Write(mask);
            writer.Write(vis.VisBlocks.Length);
            writer.Write(vis.VisBlocks);
            visibility = new { file = Write("visibility", data.GetBuffer().AsSpan(0, (int)data.Length)), clusters = vis.BaseClusterCount };
        }
        using var brdf = new Resource();
        brdf.Read(Path.Combine(Export.ToolDirectory(), ".vrf/ValveResourceFormat-21.1/Renderer/Resources/brdf_lut.vtex_c"));
        StoreTexture("vrf/brdf_lut", "lighting", (Texture)brdf.DataBlock!);
        var scene = new { map, manifest, worlds, models, materials, missingResources = missing, missingSkies, textures, post, visibility, files };
        using var stream = File.Create(Path.Combine(output, "source.json"));
        JsonSerializer.Serialize(stream, scene, new JsonSerializerOptions { Converters = { new FiniteDouble(), new FiniteSingle() } });
    }

    void World(string prefix)
    {
        using var resource = store.Read(prefix + "/world.vwrld");
        var world = (World)resource.DataBlock!;
        var lighting = world.GetWorldLightingInfo();
        foreach (var name in lighting.GetArray<string>("m_lightMaps") ?? [])
            Texture(name, "lightmaps");
        var nodes = new List<object>();
        foreach (var nodeName in world.GetWorldNodeNames())
        {
            using var nodeResource = store.Read(nodeName + ".vwnod");
            var node = (WorldNode)nodeResource.DataBlock!;
            foreach (var placement in node.SceneObjects.Concat(node.AggregateSceneObjects).Concat(node.ClutterSceneObjects))
            {
                Model(placement.GetStringProperty("m_renderableModel"));
                if (!string.IsNullOrEmpty(placement.GetStringProperty("m_renderable")))
                    throw new InvalidDataException("Standalone world mesh requires a draw binding");
            }
            foreach (var decal in node.InfoOverlays) Material(decal.GetStringProperty("m_pMaterial"));
            foreach (var replacement in node.MaterialOverrides) Material(replacement.Material);
            var extra = node.GetExtraVertexStreams();
            nodes.Add(new {
                name = nodeName, objects = node.SceneObjects.Select(Plain).ToArray(),
                aggregates = node.AggregateSceneObjects.Select(Plain).ToArray(),
                clutter = node.ClutterSceneObjects.Select(Plain).ToArray(),
                decals = node.InfoOverlays.Select(Plain).ToArray(),
                layers = node.LayerNames, layerIndices = node.SceneObjectLayerIndices,
                materialOverrides = node.MaterialOverrides.ToArray(),
                extraStreams = extra.VertexBuffers.Select(Buffer).ToArray(),
                extraBindings = node.ExtraVertexStreamOverrides.ToArray()
            });
        }
        var entities = new List<object?>();
        foreach (var lumpName in world.GetEntityLumpNames())
        {
            using var entityResource = store.Read(lumpName);
            var lump = (EntityLump)entityResource.DataBlock!;
            foreach (var entity in lump.GetEntities())
            {
                var record = (Dictionary<string,object?>)Plain(entity)!;
                entities.Add(record);
                if (entity.GetStringProperty("classname") == "prop_door_rotating" && entity.GetStringProperty("model") is { Length: > 0 } doorName)
                {
                    using var door = store.ReadOptional(doorName);
                    if (door == null)
                    {
                        missing.Add(doorName);
                        continue;
                    }
                    var defaults = ((Model)door.DataBlock!).KeyValues.GetSubCollection("door_options")?.GetSubCollection("defaults");
                    var stages = new List<string>();
                    for (int stage = 1; stage <= 4; stage++)
                    {
                        var declared = defaults?.GetStringProperty($"damage{stage}");
                        if (string.IsNullOrWhiteSpace(declared)) continue;
                        var path = "models/" + declared.Replace('\\', '/').ToLowerInvariant() + ".vmdl";
                        if (door.ExternalReferences?.ResourceRefInfoList.Any(r => r.Name == path || r.Name == path + "_c") != true)
                            throw new InvalidDataException($"Unbound damage stage {path} for {doorName}");
                        Model(path);
                        stages.Add(path);
                    }
                    record["damageStages"] = stages;
                }
                Model(entity.GetStringProperty("model"));
                var cls = entity.GetStringProperty("classname");
                if (cls == "env_sky") Material(entity.GetStringProperty("skyname"));
                foreach (var slot in new[] { "cubemaptexture", "lightprobetexture", "lightprobetexture_dlshd", "lightprobetexture_sh2_dc", "lightprobetexture_sh2_l1" })
                    if (entity.GetStringProperty(slot) is { Length: > 0 } tex)
                        Texture(tex, slot == "cubemaptexture" ? "cubemaps" : "probes");
                if (entity.GetStringProperty("postprocessing") is { Length: > 0 } pp && !post.ContainsKey(pp) && !missing.Contains(pp))
                {
                    // A volume may name settings the game files lack; the packer uses another volume's.
                    using var asset = store.ReadOptional(pp);
                    if (asset == null) missing.Add(pp);
                    else
                    {
                        var settings = (PostProcessing)asset.DataBlock!;
                        post.Add(pp, new {
                            tonemap = settings.GetTonemapParams() is { } tone ? Plain(tone) : null,
                            bloom = settings.GetBloomParams() is { } bloom ? Plain(bloom) : null,
                            dimension = settings.GetColorCorrectionLUTDimension(),
                            lut = Write("grading", settings.GetColorCorrectionLUT())
                        });
                    }
                }
                if (cls == "skybox_reference" && !entity.GetBooleanProperty("startdisabled"))
                {
                    if (prefix != "maps/" + map) throw new InvalidDataException("Nested sky prefab");
                    var sky = SkyPrefab(map, entity.GetStringProperty("targetmapname"));
                    var package = ResourceStore.PrefabPackage(game, map, sky);
                    using var prefab = File.Exists(package) ? store.MountPrefab(package) : null;
                    // A shipped map may name a 3D sky the game files lack; it is listed and skipped.
                    using (var probe = store.ReadOptional(sky + "/world.vwrld"))
                        if (probe == null) missingSkies.Add(sky);
                    if (!missingSkies.Contains(sky)) World(sky);
                }
            }
        }
        worlds.Add(prefix, new { nodes, entities, lighting = Plain(lighting), bounds = Plain(world.Data["m_worldNodes"]) });
    }

    object Buffer(VBIB.OnDiskBufferData buffer) => new {
        file = Write("geometry", buffer.Data), stride = buffer.ElementSizeInBytes, count = buffer.ElementCount,
        fields = buffer.InputLayoutFields.Select(f => new { name = f.SemanticName, index = f.SemanticIndex,
            format = f.Format.ToString(), offset = f.Offset, semantic = f.ShaderSemantic }).ToArray()
    };

    void Model(string? name)
    {
        if (string.IsNullOrEmpty(name) || models.ContainsKey(name) || missing.Contains(name)) return;
        // Like materials, a model the game files lack is listed and its placements are skipped.
        using var asset = store.ReadOptional(name);
        if (asset == null)
        {
            missing.Add(name);
            return;
        }
        var model = (Model)asset.DataBlock!;
        List<object> Level(int level)
        {
            var meshes = new List<object>();
            foreach (var embedded in model.GetEmbeddedMeshesForLod(level))
                meshes.Add(MeshRecord(embedded.Mesh, embedded.MeshIndex));
            foreach (var reference in model.GetReferenceMeshNamesForLod(level))
            {
                using var file = store.Read(reference.MeshName);
                meshes.Add(MeshRecord((Mesh)file.DataBlock!, reference.MeshIndex));
            }
            return meshes;
        }
        // The next coarser LOD lets the packer fit a map's download budget.
        var coarser = model.LodInfo.AvailableLevels.Where(level => level > 0).Order().FirstOrDefault();
        models.Add(name, new
        {
            meshes = Level(0),
            coarse = coarser > 0 ? Level(coarser) : null,
            skins = model.GetMaterialGroups().ToDictionary(p => p.Name, p => p.Materials),
        });
    }

    object MeshRecord(Mesh mesh, int index)
    {
        var vbib = mesh.VBIB;
        var draws = mesh.Data.GetArray("m_sceneObjects").SelectMany(so => so.GetArray("m_drawCalls")).ToArray();
        foreach (var draw in draws) Material(Mesh.GetMaterialName(draw));
        return new { index, vertices = vbib.VertexBuffers.Select(Buffer).ToArray(),
            indices = vbib.IndexBuffers.Select(b => new { file = Write("geometry", b.Data), stride = b.ElementSizeInBytes }).ToArray(),
            draws = draws.Select(Plain).ToArray() };
    }

    void Material(string? name)
    {
        if (string.IsNullOrEmpty(name) || materials.ContainsKey(name) || missing.Contains(name)) return;
        // Shipped maps can name a material the game files lack; its draws are skipped and listed.
        Resource asset;
        try { asset = store.Read(name); }
        catch (FileNotFoundException)
        {
            missing.Add(name);
            return;
        }
        using var _ = asset;
        var mat = (Material)asset.DataBlock!;
        foreach (var tex in mat.TextureParams.Values)
            Texture(tex, mat.ShaderName.Contains("sky", StringComparison.Ordinal) ? "sky" : "textures");
        materials.Add(name, new { shader = mat.ShaderName, ints = mat.IntParams, scalars = mat.FloatParams,
            vectors = mat.VectorParams.ToDictionary(v => v.Key, v => new[] { v.Value.X, v.Value.Y, v.Value.Z, v.Value.W }),
            slots = mat.TextureParams, attrs = mat.IntAttributes,
            signature = mat.InputSignature.Elements.Select(e => new { e.Name, e.D3DSemanticName, e.D3DSemanticIndex }).ToArray()
        });
    }

    void Texture(string name, string category)
    {
        if (textures.ContainsKey(name)) return;
        using var asset = store.Read(name);
        StoreTexture(name, category, (Texture)asset.DataBlock!);
    }

    void StoreTexture(string name, string category, Texture tex)
    {
        if (category == "lightmaps" && name.EndsWith("/direct_light_shadows.vtex", StringComparison.Ordinal) &&
            tex.NumMipLevels == 1 && tex.Depth == 1 && tex.Format is VTexFormat.BC7 or VTexFormat.ATI1N)
        {
            StoreShadowLightmap(name, tex);
            return;
        }
        int first = 0;
        if (category == "textures")
            while (first + 1 < tex.NumMipLevels && (Math.Max(tex.Width, tex.Height) >> first) > 1024) first++;
        int maxSize = tex.CalculateBufferSizeForMipLevel((uint)first);
        if (maxSize is <= 0 or > 256 * 1024 * 1024) throw new InvalidDataException($"{name} mip size {maxSize}");
        var buffer = new byte[maxSize];
        var levels = new List<object>();
        using var payload = new MemoryStream();
        foreach (var (level, w, h, d, size) in tex.GetEveryMipLevelTexture(buffer, first))
        {
            levels.Add(new { level = level - first, w, h, d, offset = payload.Position, size });
            payload.Write(buffer, 0, size);
        }
        textures.Add(name, new { file = Write(category, payload.GetBuffer().AsSpan(0, (int)payload.Length)),
            radiance = tex.RadianceCoefficients, format = tex.Format.ToString(), flags = (int)tex.Flags, depth = tex.Depth, first, levels });
    }

    // The shader reads only the sun-shadow channel, and Valve ships this lightmap without mips. Its
    // red channel becomes BC4 with a box-filtered mip chain, so the download budget can drop levels.
    void StoreShadowLightmap(string name, Texture tex)
    {
        int width = tex.Width, height = tex.Height;
        if (width % 4 != 0 || height % 4 != 0) throw new InvalidDataException($"{name} extent {width}x{height}");
        var source = new byte[tex.CalculateBufferSizeForMipLevel(0)];
        foreach (var _ in tex.GetEveryMipLevelTexture(source, 0)) { }
        var rgba = new byte[width * height * 4];
        TinyBCSharp.BlockDecoder.Create(tex.Format == VTexFormat.BC7 ? TinyBCSharp.BlockFormat.BC7 : TinyBCSharp.BlockFormat.BC4U)
            .Decode(source, width, height, rgba, width, height);
        var red = new byte[width * height];
        for (var i = 0; i < red.Length; i++) red[i] = rgba[i * 4];
        var chain = new List<(int W, int H, byte[] Data)> { (width, height, red) };
        while (chain[^1].W > 4 && chain[^1].H > 4 && chain[^1].W % 8 == 0 && chain[^1].H % 8 == 0)
        {
            var (w, h, data) = chain[^1];
            var next = new byte[w / 2 * (h / 2)];
            for (var y = 0; y < h / 2; y++)
                for (var x = 0; x < w / 2; x++)
                    next[y * (w / 2) + x] = (byte)((data[2 * y * w + 2 * x] + data[2 * y * w + 2 * x + 1] +
                        data[(2 * y + 1) * w + 2 * x] + data[(2 * y + 1) * w + 2 * x + 1] + 2) / 4);
            chain.Add((w / 2, h / 2, next));
        }
        var levels = new List<object>();
        using var payload = new MemoryStream();
        for (var index = chain.Count - 1; index >= 0; index--)
        {
            var (w, h, data) = chain[index];
            var blocks = EncodeBC4(data, w, h);
            levels.Add(new { level = index, w, h, d = 1, offset = payload.Position, size = blocks.Length });
            payload.Write(blocks);
        }
        textures.Add(name, new { file = Write("lightmaps", payload.GetBuffer().AsSpan(0, (int)payload.Length)),
            radiance = tex.RadianceCoefficients, format = "ATI1N", flags = (int)tex.Flags, depth = 1, first = 0, levels });
    }

    // BC4 unsigned: two endpoints and eight interpolated values, three index bits per texel.
    static byte[] EncodeBC4(byte[] data, int width, int height)
    {
        var output = new byte[width / 4 * (height / 4) * 8];
        var block = new byte[16];
        var o = 0;
        for (var by = 0; by < height; by += 4)
            for (var bx = 0; bx < width; bx += 4)
            {
                byte lo = 255, hi = 0;
                for (var i = 0; i < 16; i++)
                {
                    block[i] = data[(by + i / 4) * width + bx + i % 4];
                    lo = Math.Min(lo, block[i]);
                    hi = Math.Max(hi, block[i]);
                }
                output[o] = hi;
                output[o + 1] = lo;
                ulong bits = 0;
                if (hi > lo)
                    for (var i = 0; i < 16; i++)
                    {
                        // Palette order: hi, lo, then six steps from hi towards lo.
                        var step = (int)Math.Round((hi - block[i]) * 7.0 / (hi - lo));
                        ulong index = step switch { 0 => 0, 7 => 1, _ => (ulong)(step + 1) };
                        bits |= index << (3 * i);
                    }
                for (var k = 0; k < 6; k++) output[o + 2 + k] = (byte)(bits >> (8 * k));
                o += 8;
            }
        return output;
    }
}

// Some authored values are infinite or NaN; JSON has no such numbers, so they are written as null.
sealed class FiniteDouble : System.Text.Json.Serialization.JsonConverter<double>
{
    public override double Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) => reader.GetDouble();
    public override void Write(Utf8JsonWriter writer, double value, JsonSerializerOptions options)
    {
        if (double.IsFinite(value)) writer.WriteNumberValue(value);
        else writer.WriteNullValue();
    }
}

sealed class FiniteSingle : System.Text.Json.Serialization.JsonConverter<float>
{
    public override float Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) => reader.GetSingle();
    public override void Write(Utf8JsonWriter writer, float value, JsonSerializerOptions options)
    {
        if (float.IsFinite(value)) writer.WriteNumberValue(value);
        else writer.WriteNullValue();
    }
}
