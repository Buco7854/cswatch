using System.IO.Hashing;
using ValvePak;
using ValveResourceFormat;

sealed class ResourceStore : IDisposable
{
    const int MaxEntryBytes = 256 * 1024 * 1024;
    readonly List<(Package Archive, string Path)> archives = [];

    public ResourceStore(string game, string map)
    {
        try
        {
            Mount(Path.Combine(game, "csgo", "maps", map + ".vpk"));
            // gameinfo's OfficialAddonRoot: a map shipped as an official community addon keeps its
            // materials, sky and radar there, mounted ahead of the game's own packages.
            if (File.Exists(AddonPackage(game, map))) Mount(AddonPackage(game, map));
            Mount(Path.Combine(game, "csgo", "pak01_dir.vpk"));
            Mount(Path.Combine(game, "core", "pak01_dir.vpk"));
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public static string AddonPackage(string game, string map) =>
        Path.Combine(game, "csgo_community_addons", map, map + "_dir.vpk");

    /// <summary>A sky prefab's package: under the game's maps, else extracted beside the map's addon.</summary>
    public static string PrefabPackage(string game, string map, string prefab)
    {
        var package = Path.Combine(game, "csgo", prefab + ".vpk");
        return File.Exists(package) ? package : Path.Combine(game, "csgo_community_addons", map, prefab + ".vpk");
    }

    public IDisposable MountPrefab(string path)
    {
        Mount(path, prepend: true);
        return new PrefabScope(this, archives[0]);
    }

    sealed class PrefabScope(ResourceStore store, (Package Archive, string Path) item) : IDisposable
    {
        public void Dispose()
        {
            if (store.archives.Remove(item)) item.Archive.Dispose();
        }
    }

    public Resource? ReadOptional(string name)
    {
        try { return Read(name); }
        catch (FileNotFoundException) { return null; }
    }

    void Mount(string path, bool prepend = false)
    {
        var archive = new Package();
        try
        {
            archive.Read(path);
            archives.Insert(prepend ? 0 : archives.Count, (archive, path));
        }
        catch
        {
            archive.Dispose();
            throw;
        }
    }

    public Resource Read(string name)
    {
        var compiled = name.Replace('\\', '/') + "_c";
        foreach (var (archive, path) in archives)
        {
            var entry = archive.FindEntry(compiled);
            if (entry == null) continue;
            if (entry.TotalLength > MaxEntryBytes)
                throw new InvalidDataException($"{compiled} exceeds {MaxEntryBytes} bytes");
            try
            {
                archive.ReadEntry(entry, out var bytes, false);
                var crc = Crc32.HashToUInt32(bytes);
                if (crc != entry.CRC32)
                    throw new InvalidDataException($"expected CRC {entry.CRC32:x8}, read {crc:x8}");
                var resource = new Resource { FileName = compiled };
                try
                {
                    resource.Read(new MemoryStream(bytes, writable: false));
                    return resource;
                }
                catch
                {
                    resource.Dispose();
                    throw;
                }
            }
            catch (Exception e)
            {
                throw new InvalidDataException($"{compiled} in {path}, archive {entry.ArchiveIndex}, offset {entry.Offset}, {entry.TotalLength} bytes: {e.Message}", e);
            }
        }
        throw new FileNotFoundException($"Missing compiled resource {compiled}");
    }

    // Writes the official overview text and radar image when the game files have them. The packer
    // renders missing artwork from the world geometry.
    public void WriteOverview(string map, string destination)
    {
        var filename = $"resource/overviews/{map}.txt";
        foreach (var (archive, _) in archives)
        {
            if (archive.FindEntry(filename) is not { } entry) continue;
            if (entry.TotalLength > 16384) throw new InvalidDataException("Overview metadata exceeds limit");
            archive.ReadEntry(entry, out var bytes, false);
            if (Crc32.HashToUInt32(bytes) != entry.CRC32) throw new InvalidDataException("Overview metadata CRC mismatch");
            File.WriteAllBytes(Path.Combine(destination, "overview.txt"), bytes);
            // The compiled radar keeps its source image's extension in its name.
            using var radar = ReadOptional($"panorama/images/overheadmaps/{map}_radar_psd.vtex") ??
                ReadOptional($"panorama/images/overheadmaps/{map}_radar_tga.vtex") ??
                ReadOptional($"panorama/images/overheadmaps/{map}_radar_png.vtex");
            if (radar == null) return;
            var texture = (ValveResourceFormat.ResourceTypes.Texture)radar.DataBlock!;
            if (texture.Width > 2048 || texture.Height > 2048) throw new InvalidDataException("Overview dimensions exceed limit");
            using var bitmap = texture.GenerateBitmap();
            using var encoded = bitmap.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100);
            using var output = File.Create(Path.Combine(destination, "overview.png"));
            encoded.SaveTo(output);
            return;
        }
    }

    public void Dispose()
    {
        foreach (var (archive, _) in archives) archive.Dispose();
        archives.Clear();
    }
}
