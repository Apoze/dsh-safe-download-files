# Safe File Downloads for DeepSeek Harness

A DeepSeek Harness plugin that exposes one model tool:

```text
download_files({
  directory?: string,
  items: [{ url: string, file_name?: string }]
})
```

It safely downloads public files into the current DSH workspace. This is an unofficial community plugin.

## Security

- HTTP(S) GET only, with no model-controlled headers, cookies, or credentials.
- Blocks localhost, private networks, metadata endpoints, and reserved IP ranges.
- Pins validated DNS results and revalidates every redirect.
- Detects the real file type and rejects mismatched or unknown content.
- Refuses executables, scripts, archives, Office files, HTML, SVG, and WebAssembly.
- Rejects absolute paths, parent traversal, unsafe names, and escaping symlinks.
- Writes temporary files first and publishes them atomically.
- Never overwrites an existing file.

Accepted content includes raster images, PDF, UTF-8 text/Markdown/CSV/JSON/XML, and common audio/video formats.

## Install

```sh
dsh plugin --profile web add "git+https://github.com/Apoze/dsh-safe-download-files.git#main"
```

This is a complete DSH bundle. Restart DSH after installation:

```sh
dsh --profile web --dump-config
dsh web
```

No manual Cordis entry is required.

## Limits

| Limit | Value |
| --- | ---: |
| Files per call | 100 |
| Concurrent downloads | 8 |
| File size | 25 MB |
| Total call size | 250 MB |
| Redirects | 5 |
| Timeout per file | 30 seconds |
| Tool timeout | 420 seconds |

Successful files are kept when another item in the same batch fails.

## Test

```sh
pnpm install --frozen-lockfile
pnpm test
```

The test suite covers SSRF, DNS pinning, redirect validation, MIME mismatch, path traversal, collisions, cancellation, size limits, and partial failures.

## License

[MIT](LICENSE)


## HTTP transport maintenance

Version 0.1.1 uses the compiled Apoze dsh-safe-web-fetch 0.1.0-next.1 release (source commit 736e690cccd2d74126455633cd92fd252c35de08), pinned with a lockfile integrity hash. Its Undici 8.10.2 fixes the uncaught paused-parser EOF crash described in https://github.com/nodejs/undici/issues/5360. No runtime exception suppression or node_modules patching is used. Existing DNS pinning, private-address rejection, cancellation and size limits remain in force.
