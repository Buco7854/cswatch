// Offline world export. Only the final directory is published, by same-volume rename.
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
}
