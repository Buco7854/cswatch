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
            Mount(Path.Combine(game, "csgo", "pak01_dir.vpk"));
            Mount(Path.Combine(game, "core", "pak01_dir.vpk"));
        }
        catch
        {
            Dispose();
            throw;
        }
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
            using var radar = Read($"panorama/images/overheadmaps/{map}_radar_psd.vtex");
            var texture = (ValveResourceFormat.ResourceTypes.Texture)radar.DataBlock!;
            if (texture.Width > 2048 || texture.Height > 2048) throw new InvalidDataException("Overview dimensions exceed limit");
            using var bitmap = texture.GenerateBitmap();
            using var encoded = bitmap.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100);
            using var output = File.Create(Path.Combine(destination, "overview.png"));
            encoded.SaveTo(output);
            return;
        }
        throw new FileNotFoundException(filename);
    }

    public void Dispose()
    {
        foreach (var (archive, _) in archives) archive.Dispose();
        archives.Clear();
    }
}
