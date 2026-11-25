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

    // A sky prefab must live under the selected map's own prefab folder, with or without its mode prefix.
    public static string SkyPrefab(string map, string? reference)
    {
        var match = System.Text.RegularExpressions.Regex.Match(reference ?? "", @"\Amaps/prefabs/([a-z0-9_]+)/[a-z0-9_]{1,100}\.vmap\z");
        if (!match.Success || (match.Groups[1].Value != map && match.Groups[1].Value != System.Text.RegularExpressions.Regex.Replace(map, @"\A(?:de|cs|ar|dz|gd|tr)_", "")))
            throw new InvalidDataException("Sky prefab outside selected map");
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
        var scene = new { map, manifest, worlds, models, materials, textures, post, visibility, files };
        using var stream = File.Create(Path.Combine(output, "source.json"));
        JsonSerializer.Serialize(stream, scene);
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
                    using var door = store.Read(doorName);
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
                if (entity.GetStringProperty("postprocessing") is { Length: > 0 } pp && !post.ContainsKey(pp))
                {
                    using var asset = store.Read(pp);
                    var settings = (PostProcessing)asset.DataBlock!;
                    post.Add(pp, new {
                        tonemap = settings.GetTonemapParams() is { } tone ? Plain(tone) : null,
                        bloom = settings.GetBloomParams() is { } bloom ? Plain(bloom) : null,
                        dimension = settings.GetColorCorrectionLUTDimension(),
                        lut = Write("grading", settings.GetColorCorrectionLUT())
                    });
                }
                if (cls == "skybox_reference" && !entity.GetBooleanProperty("startdisabled"))
                {
                    if (prefix != "maps/" + map) throw new InvalidDataException("Nested sky prefab");
                    var sky = SkyPrefab(map, entity.GetStringProperty("targetmapname"));
                    using var prefab = store.MountPrefab(Path.Combine(game, "csgo", sky + ".vpk"));
                    World(sky);
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
        if (string.IsNullOrEmpty(name) || models.ContainsKey(name)) return;
        using var asset = store.Read(name);
        var model = (Model)asset.DataBlock!;
        var meshes = new List<object>();
        foreach (var embedded in model.GetEmbeddedMeshesForLod(0))
            meshes.Add(MeshRecord(embedded.Mesh, embedded.MeshIndex));
        foreach (var reference in model.GetReferenceMeshNamesForLod(0))
        {
            using var file = store.Read(reference.MeshName);
            meshes.Add(MeshRecord((Mesh)file.DataBlock!, reference.MeshIndex));
        }
        models.Add(name, new { meshes, skins = model.GetMaterialGroups().ToDictionary(p => p.Name, p => p.Materials) });
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
        if (string.IsNullOrEmpty(name) || materials.ContainsKey(name)) return;
        using var asset = store.Read(name);
        var mat = (Material)asset.DataBlock!;
        foreach (var tex in mat.TextureParams.Values)
            Texture(tex, mat.ShaderName == "sky.vfx" ? "sky" : "textures");
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
}
