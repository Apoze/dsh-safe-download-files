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
dsh plugin --profile web add "git+https://github.com/Apoze/dsh-safe-download-files.git#v0.1.0"
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

