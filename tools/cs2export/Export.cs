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

    public static void Run(string game, string destination)
    {
        var output = Path.TrimEndingDirectorySeparator(Path.GetFullPath(destination));
        var input = Path.TrimEndingDirectorySeparator(Path.GetFullPath(game));
        if (output == input || output.StartsWith(input + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new IOException("Choose an output directory outside the game root");
        if (Directory.Exists(output) || File.Exists(output))
            throw new IOException("Destination already exists: " + output);
        using (var vpk = File.OpenRead(Path.Combine(input, "csgo/maps/de_mirage.vpk")))
        {
            const string pinned = "e66cdf1ae6a976f6f6ba510a2addd04b25a4c1cfd811f51f1ef13f0954e6e350";
            if (Convert.ToHexStringLower(SHA256.HashData(vpk)) != pinned)
                throw new InvalidDataException("Mirage VPK does not match Steam manifest 8225060435969537482");
        }
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        var stage = Path.Combine(Path.GetDirectoryName(output)!, ".cs2export-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            var source = Directory.CreateDirectory(Path.Combine(stage, "source")).FullName;
            var pack = Directory.CreateDirectory(Path.Combine(stage, "pack")).FullName;
            using (var store = new ResourceStore(input, "de_mirage"))
                new NativeScene(store, input, source).Extract();
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
