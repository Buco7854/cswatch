/** Operator toolchain pins. Changing any artifact requires a reviewed checksum update. */
export const toolchainPins = {
  s2v: {
    version: '21.1',
    url: 'https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/21.1/cli-linux-x64.zip',
    algorithm: 'sha256',
    hash: '6c76b646485977480b9f25bcf5026c30856f70e5d138a1eb127b52d768156843',
    maxBytes: 100663296,
    maxExpanded: 201326592,
    format: 'zip',
  },
  source: {
    version: 'aeaae994c92c09ef0b3d5fa2d592aa6ff6936f93',
    url: 'https://codeload.github.com/SteamTracking/SteamFileDownloader/tar.gz/aeaae994c92c09ef0b3d5fa2d592aa6ff6936f93',
    algorithm: 'sha256',
    hash: '652c6cf77a90db291b00e6d7b4ae454a19da6d397c8b0ffc8b5aa3724a38129b',
    maxBytes: 2097152,
    maxExpanded: 8388608,
    format: 'tar',
  },
  sdk: {
    version: '10.0.404',
    url: 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.404/dotnet-sdk-10.0.404-linux-x64.tar.gz',
    algorithm: 'sha512',
    hash: '577d0eb17fec33d029104c5c63a1ab0accc3e28776274abef2218dbac5af18d2109b5406d26b31d76f5c245215e3ba0926a94c20246c672c41847c9e1eb1dc50',
    maxBytes: 314572800,
    maxExpanded: 805306368,
    format: 'tar',
  },
  packages: [
    {
      name: 'blake3',
      version: '3.0.2',
      url: 'https://api.nuget.org/v3-flatcontainer/blake3/3.0.2/blake3.3.0.2.nupkg',
      algorithm: 'sha512',
      hash: 'SQq8DzbDuQWvRPLLP+f1EcPoFVMSf2ogfwJNvoF0SCVk0+u9uCCStbFXeCVTNpTPaxR5226uiRIYHYAD8iuTXw==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'THvWhdj8ErSdrGamTqjshCU1ImANfr7ieKY6eFqeMsRenvXEKut9qGm5/MA4SUk8IYvAahf67jSh0yVj9jTPzg==',
    },
    {
      name: 'microsoft.win32.systemevents',
      version: '6.0.0',
      url: 'https://api.nuget.org/v3-flatcontainer/microsoft.win32.systemevents/6.0.0/microsoft.win32.systemevents.6.0.0.nupkg',
      algorithm: 'sha512',
      hash: 'XidKzplsPrpjCZ7VEW+dw59p9oT3wediPCjDxzmIt1xn38ySmlCnYfAiLfJD3VQHIKbliOkd+nhPgb/Oeok4dQ==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'hqTM5628jSsQiv+HGpiq3WKBl2c8v1KZfby2J6Pr7pEPlK9waPdgEO6b8A/+/xn/yZ9ulv8HuqK71ONy2tg67A==',
    },
    {
      name: 'protobuf-net',
      version: '3.4.40',
      url: 'https://api.nuget.org/v3-flatcontainer/protobuf-net/3.4.40/protobuf-net.3.4.40.nupkg',
      algorithm: 'sha512',
      hash: 'OA0ernUAHSrfA11+d2yeED0/Vvzff7dnFh8bSpidJVTM8sZnHgcP7KIXzgI3f+kC2uE8ANLOvHA4zZrnWUAlpQ==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'Gds96uOs0bZlDfLIYHRMee1xmrWxUTLM9HSOlDzUmyzkTGDcMWw3Lgx9TPUxD94r+/E/Y9OEL5Cf3PiTHn9bfw==',
    },
    {
      name: 'protobuf-net.core',
      version: '3.4.40',
      url: 'https://api.nuget.org/v3-flatcontainer/protobuf-net.core/3.4.40/protobuf-net.core.3.4.40.nupkg',
      algorithm: 'sha512',
      hash: 'R3CPNSof39mTGTJYHaaMIS5S9YOSg/p+ZKzfpre8rBLdGotL+v98/4wnRz3pQ4bRBXqQsk0wrxmlyCzObdp4EQ==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'UDQ8fbEKqpQktJfFyqkZ22S7P01sJWNmqkYjzbwZdZUHFwHIDigmWIzxmExF7NjbNoTqmv2Dfsu3rOpRHXK5EA==',
    },
    {
      name: 'qrcoder',
      version: '1.8.1',
      url: 'https://api.nuget.org/v3-flatcontainer/qrcoder/1.8.1/qrcoder.1.8.1.nupkg',
      algorithm: 'sha512',
      hash: '3Mg+aSoCNKz7w3OQ6KxpiNxEu6AgOE5lqsORNNu63heRdau9wM34IUCmtvkKDCCC2oraxxlOVTKX/HsXYAxHUw==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'aGfRFpU/IPexAtEOEXCNxC3fMCAqgn6kqALRvXt6LxVAW0VolSDGHiyrY+o2CJgTITOsMpsrsDi7svMJaJ9Vfg==',
    },
    {
      name: 'steamkit2',
      version: '4.0.0-beta.1',
      url: 'https://api.nuget.org/v3-flatcontainer/steamkit2/4.0.0-beta.1/steamkit2.4.0.0-beta.1.nupkg',
      algorithm: 'sha512',
      hash: 'warYbG09jVSHHngoqtzJ2RBMDu4vVHHgi9nnn3xDt0mCSdd4RqF0/Q3mm34qUZC5WUeb5bNySL/NtyuZ2Hzp2Q==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'wreSm49ASV56Z3ljOQuzSBrUUJNuampUoVV6CH0dUNVSTFsqhUkRIXwpPuAq/Df4QB4e4MoNFy0SUGW+CPr64Q==',
    },
    {
      name: 'system.drawing.common',
      version: '6.0.0',
      url: 'https://api.nuget.org/v3-flatcontainer/system.drawing.common/6.0.0/system.drawing.common.6.0.0.nupkg',
      algorithm: 'sha512',
      hash: '1h8KPgHD6sFfE/wboEosfOTqyVZACy+qNh/sq9ODbUnVvTRPOYXuPZTNw/anK44H5CPNspZbT1yiIitd4ymI5A==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'NfuoKUiP2nUWwKZN6twGqXioIe1zVD0RIj2t976A+czLHr2nY454RwwXs6JU9Htc6mwqL6Dn/nEL3dpVf2jOhg==',
    },
    {
      name: 'system.io.hashing',
      version: '10.0.13',
      url: 'https://api.nuget.org/v3-flatcontainer/system.io.hashing/10.0.13/system.io.hashing.10.0.13.nupkg',
      algorithm: 'sha512',
      hash: '8dRuMj/OYNRciBTFXn0uDojZ3Bvz7N+TRz6KCwN8ZcsDX/9VfqcLmsjfCbO9ks0WHSSs2sirMtbWkRunhe1zOQ==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'ZlcywyQ7FJmgOV2nctdfOEPGS0kRK8T2CdOoPr6F4HPYpmjSo6GQfj3yTyOzNO6B+2U84/JKSPkJJMWqLmVsMw==',
    },
    {
      name: 'system.security.cryptography.protecteddata',
      version: '10.0.13',
      url: 'https://api.nuget.org/v3-flatcontainer/system.security.cryptography.protecteddata/10.0.13/system.security.cryptography.protecteddata.10.0.13.nupkg',
      algorithm: 'sha512',
      hash: 'FvE5JY5jBIf8v/4kwCp3wJY0bOoe/mZ8nH0Gj1I0uT7uK+WTtMSOsoJR8TM2NyJ27uTN9o0npdb5SE3TbvZ2hg==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'aUSmC6cPjFLSE0rDTsmkR3wvUOnscqewebOaaELEToh12sNmoltZqT3f0C81mJ1zhxKjWco25soHTvYwsXCsUw==',
    },
    {
      name: 'valvepak',
      version: '7.1.0.211',
      url: 'https://api.nuget.org/v3-flatcontainer/valvepak/7.1.0.211/valvepak.7.1.0.211.nupkg',
      algorithm: 'sha512',
      hash: '0dMYgUOGSjwfcKovHcPoAGs4Jka6N4lwL8kb5QgQbm+imFwup7WesW+2wC1POfsupVxqctfPpptnuAXeNhKEmw==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'LsAtI6mQPg0FzEH1t5Tgc8BUnLZ2IZm1U1Xqcpz6iEtxZKx976dkMUi66cHl8w2fPtIjsusz9dqvNqNO5nf5EQ==',
    },
    {
      name: 'zstdsharp.port',
      version: '0.8.8',
      url: 'https://api.nuget.org/v3-flatcontainer/zstdsharp.port/0.8.8/zstdsharp.port.0.8.8.nupkg',
      algorithm: 'sha512',
      hash: 'i6O1GP8E6Mh0frx9gryhb6s2sOWiOAi2h4aB4TDOof+39OE5aWTKiyU37vE6YXDvHM4MkNbIU2untq2W+g4m+w==',
      encoding: 'base64',
      maxBytes: 33554432,
      contentHash:
        'UIDFkA5DC3en3tOJ3Mof11yBx9kUQLsaeo/oFdvN6Bbkr9E9+VCqfIadHci8cu+I51K2Sl7XYWVl2R/mA75NBQ==',
    },
  ],
};

for (const value of [
  toolchainPins.s2v,
  toolchainPins.source,
  toolchainPins.sdk,
  ...toolchainPins.packages,
])
  Object.freeze(value);
Object.freeze(toolchainPins.packages);
Object.freeze(toolchainPins);
