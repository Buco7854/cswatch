using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;

if (args is ["--astc-inputs" or "--astc-group", var plan, var sourceDir, var astcDir, ..] &&
    args.Length == (args[0] == "--astc-group" ? 5 : 4))
{
    try
    {
        int? group = args[0] == "--astc-group"
            ? (System.Text.RegularExpressions.Regex.IsMatch(args[4], @"\A[0-9]{1,5}\z") ? int.Parse(args[4]) : throw new ArgumentException("Phone texture group"))
            : null;
        AstcInputs.Run(plan, sourceDir, astcDir, group);
        return 0;
    }
    catch (Exception error)
    {
        Console.Error.WriteLine(error.Message);
        return 1;
    }
}

if (args is ["--extract", "--game", var input, "--map", var map, "--manifest", var manifest, "--sha256", var hash, "--out", var output])
{
    try
    {
        Export.Extract(input, map, manifest, hash, output, overview: true);
        return 0;
    }
    catch (Exception error)
    {
        Console.Error.WriteLine(error.Message);
        return 1;
    }
}

if (args is not ["--check-model-inputs", "--game", var game, "--map", var checkedMap])
{
    Console.Error.WriteLine("Usage: cs2export --extract|--astc-inputs|--astc-group|--check-model-inputs ... (see README.md)");
    return 2;
}

try
{
    using var store = new ResourceStore(game, checkedMap);
    var models = new HashSet<string>(StringComparer.Ordinal);
    var materials = new HashSet<string>(StringComparer.Ordinal);
    var textures = new HashSet<string>(StringComparer.Ordinal);
    CheckWorld("maps/" + checkedMap);
    Console.WriteLine($"Model input check: {models.Count} models, {materials.Count} materials, {textures.Count} textures.");

    void CheckWorld(string prefix)
    {
        using var root = store.Read(prefix + "/world.vwrld");
        var world = (World)root.DataBlock!;
        foreach (var nodeName in world.GetWorldNodeNames())
        {
            using var file = store.Read(nodeName + ".vwnod");
            var node = (WorldNode)file.DataBlock!;
            foreach (var placement in node.SceneObjects.Concat(node.AggregateSceneObjects))
                CheckModel(placement.GetStringProperty("m_renderableModel"));
        }

        foreach (var lumpName in world.GetEntityLumpNames())
        {
            using var file = store.Read(lumpName);
            foreach (var entity in ((EntityLump)file.DataBlock!).GetEntities())
            {
                CheckModel(entity.GetStringProperty("model"));
                if (entity.GetStringProperty("classname") == "skybox_reference" && prefix == "maps/" + checkedMap &&
                    !entity.GetBooleanProperty("startdisabled"))
                {
                    var target = NativeScene.SkyPrefab(checkedMap, entity.GetStringProperty("targetmapname"));
                    var package = Path.Combine(game, "csgo", target + ".vpk");
                    using var prefab = File.Exists(package) ? store.MountPrefab(package) : null;
                    CheckWorld(target);
                }
            }
        }
    }

    void CheckModel(string? modelName)
    {
        if (string.IsNullOrEmpty(modelName) || !models.Add(modelName)) return;
        using var modelFile = store.Read(modelName);
        var model = (Model)modelFile.DataBlock!;
        foreach (var embedded in model.GetEmbeddedMeshesForLod(0))
            CheckMesh(embedded.Mesh, modelName);
        foreach (var reference in model.GetReferenceMeshNamesForLod(0))
        {
            using var mesh = store.Read(reference.MeshName);
            CheckMesh((Mesh)mesh.DataBlock!, modelName);
        }
    }

    void CheckMesh(Mesh mesh, string model)
    {
        foreach (var sceneObject in mesh.Data.GetArray("m_sceneObjects"))
        foreach (var draw in sceneObject.GetArray("m_drawCalls"))
        {
            var mat = Mesh.GetMaterialName(draw);
            if (mat == null || !materials.Add(mat)) continue;
            using var file = store.Read(mat);
            var material = (Material)file.DataBlock!;
            foreach (var (slot, texture) in material.TextureParams)
            {
                if (!textures.Add(texture)) continue;
                try
                {
                    using var tex = store.Read(texture);
                }
                catch (IOException e)
                {
                    throw new InvalidDataException($"{model} -> {mat} ({material.ShaderName}, {slot}) -> {texture}: {e.Message}", e);
                }
                catch (InvalidDataException e)
                {
                    throw new InvalidDataException($"{model} -> {mat} ({material.ShaderName}, {slot}) -> {texture}: {e.Message}", e);
                }
            }
        }
    }
    return 0;
}
catch (Exception e)
{
    Console.Error.WriteLine(e.Message);
    return 1;
}
