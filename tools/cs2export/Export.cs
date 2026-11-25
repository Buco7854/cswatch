// Offline Mirage export. Only the final directory is published, by same-volume rename.
using System.Diagnostics;
using System.Security.Cryptography;

static class Export
{
    public static string ToolDirectory()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "cs2export.csproj"))) return dir.FullName;
        throw new FileNotFoundException("Cannot locate cs2export source checkout");
    }

    public static void Extract(string game, string map, string manifest, string hash, string destination, bool overview)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(map, @"\A[a-z][a-z0-9_]{1,79}\z") ||
            !ulong.TryParse(manifest, out var manifestId) || manifestId == 0 || manifestId.ToString() != manifest)
            throw new InvalidDataException("Invalid map or manifest");
        using var vpk = File.OpenRead(Path.Combine(game, "csgo", "maps", map + ".vpk"));
        if (Convert.ToHexStringLower(SHA256.HashData(vpk)) != hash)
            throw new InvalidDataException("Map VPK differs from verified source hash");
        using var store = new ResourceStore(game, map);
        new NativeScene(store, game, destination, map, manifest).Extract();
        if (overview) store.WriteOverview(map, destination);
    }

    public static void Run(string game, string destination)
    {
        var output = Path.TrimEndingDirectorySeparator(Path.GetFullPath(destination));
        var input = Path.TrimEndingDirectorySeparator(Path.GetFullPath(game));
        if (output == input || output.StartsWith(input + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new IOException("Choose an output directory outside the game root");
        if (Directory.Exists(output) || File.Exists(output))
            throw new IOException("Destination already exists: " + output);
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        var stage = Path.Combine(Path.GetDirectoryName(output)!, ".cs2export-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            var source = Directory.CreateDirectory(Path.Combine(stage, "source")).FullName;
            var pack = Directory.CreateDirectory(Path.Combine(stage, "pack")).FullName;
            Extract(input, "de_mirage", "8225060435969537482", "e66cdf1ae6a976f6f6ba510a2addd04b25a4c1cfd811f51f1ef13f0954e6e350", source, overview: false);
            var args = new ProcessStartInfo("node") { UseShellExecute = false };
            args.ArgumentList.Add(Path.Combine(ToolDirectory(), "pack.mjs"));
            args.ArgumentList.Add(source);
            args.ArgumentList.Add(pack);
            using var job = Process.Start(args) ?? throw new IOException("Cannot start meshoptimizer post-step");
            if (!job.WaitForExit(300_000))
            {
                job.Kill(entireProcessTree: true);
                job.WaitForExit();
                throw new TimeoutException("Mesh packing exceeded five minutes");
            }
            if (job.ExitCode != 0) throw new InvalidDataException("Mesh packing failed");
            Directory.Move(pack, output);
        }
        finally { Directory.Delete(stage, recursive: true); }
    }
}
