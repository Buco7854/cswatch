# CS2 native world exporter

The offline tool reads the selected map VPK and its compiled dependencies from a local game root. Run commands from this directory so the SDK resolver uses global.json.

## Build inputs

- Microsoft .NET SDK 11.0.100, Linux x64. [Official SDK archive](https://builds.dotnet.microsoft.com/dotnet/Sdk/11.0.100/dotnet-sdk-11.0.100-linux-x64.tar.gz). SHA-512 `1bec9cca2ec689b1e80245b84f2b53c9441d1aa6daccf2ceb27490768bffa95954fa585bd275def31069d874d543d9ba9e6591fe9ade2dbd9f34ec5c0fd0050c`.
- ValveResourceFormat 21.1. [Tagged source archive](https://codeload.github.com/ValveResourceFormat/ValveResourceFormat/tar.gz/refs/tags/21.1). SHA-256 `6700eb517c5969464d7867f240ecfe6c6ba57ceecf6ba0e82779ef5dbb7a9928`.

Set DOTNET_ROOT to the extracted SDK directory, put it first on PATH and set DOTNET_CLI_TELEMETRY_OPTOUT=1. Verify the source archive before extracting it.

```sh
echo '6700eb517c5969464d7867f240ecfe6c6ba57ceecf6ba0e82779ef5dbb7a9928  vrf.tgz' | sha256sum -c - &&
  mkdir -p .vrf && tar xzf vrf.tgz -C .vrf
dotnet build
```

To verify model inputs before conversion, run `dotnet run --no-build -- --check-model-inputs --game <game-root> --map de_mirage`. This follows the main world and 3D sky model placements, entity models, LOD 0 meshes, draw materials and their texture slots. Each compiled resource is checked against the active package index CRC before VRF parses it.
