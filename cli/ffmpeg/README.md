# Bundled ffmpeg (for the CLI converter)

The `tinv` converter uses these two static binaries:

```
cli/ffmpeg/ffmpeg
cli/ffmpeg/ffprobe
```

They must include **libsvtav1** (AV1 encoder) and **libopus**, and be static
(no external dylib dependencies) for the platform you run on.

Verify a binary:

```sh
./ffmpeg -hide_banner -encoders | grep -E "libsvtav1|libopus"
otool -L ./ffmpeg | grep -v "/System\|/usr/lib"   # macOS — should be empty
```

These are large (~50 MB each) and git-ignored. If they're missing, the CLI
falls back to an `ffmpeg` on your PATH (which must also have SVT-AV1).

Get a static macOS arm64 build with SVT-AV1 from osxexperts.net or build one
with `--enable-libsvtav1 --enable-libopus`.
