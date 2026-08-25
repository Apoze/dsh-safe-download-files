import { lookup } from "node:dns/promises";
import {
  link,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileTypeFromFile } from "file-type";
import {
  literalAddress,
  normalizeHost,
  UndiciSafeTransport,
  validateFetchUrl,
  validateResolvedAddresses,
} from "dsh-safe-web-fetch";

export const LIMITS = Object.freeze({
  maxItems: 100,
  maxConcurrent: 8,
  maxUrlLength: 2_048,
  maxRedirects: 5,
  maxFileBytes: 25_000_000,
  maxBatchBytes: 250_000_000,
  itemTimeoutMs: 30_000,
  toolTimeoutMs: 420_000,
});

const USER_AGENT = "dsh-safe-download-files/0.1";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BINARY_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["application/pdf", "pdf"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/ogg", "ogg"],
  ["audio/flac", "flac"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/aac", "aac"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["video/quicktime", "mov"],
  ["video/x-matroska", "mkv"],
]);
const TEXT_TYPES = new Map([
  ["text/plain", "txt"],
  ["text/markdown", "md"],
  ["text/csv", "csv"],
  ["application/json", "json"],
  ["application/xml", "xml"],
  ["text/xml", "xml"],
]);
const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const REFUSED_EXTENSIONS = new Set([
  "app", "bat", "cmd", "com", "command", "cjs", "dmg", "doc", "docx", "exe",
  "gz", "html", "htm", "jar", "js", "jsx", "mjs", "msi", "odp", "ods", "odt",
  "php", "pkg", "ppt", "pptx", "ps1", "py", "rar", "rb", "sh", "svg", "tar",
  "ts", "tsx", "vbs", "wasm", "xls", "xlsx", "xz", "zip", "zst", "7z",
]);
const COMPATIBLE_TYPES = new Set([
  "image/jpg:image/jpeg",
  "audio/x-wav:audio/wav",
  "audio/wav:audio/x-wav",
  "audio/x-m4a:audio/mp4",
]);

export async function downloadBatch({ cwd, directory = "downloads", items, signal, options = {} }) {
  if (!Array.isArray(items) || items.length < 1 || items.length > LIMITS.maxItems) {
    throw new Error(`items must contain between 1 and ${LIMITS.maxItems} files`);
  }
  const output = await resolveOutputDirectory(cwd, directory, signal);
  const shared = { transferred: 0, reserved: new Set() };
  const results = new Array(items.length);

  await mapLimit(items, LIMITS.maxConcurrent, async (item, index) => {
    results[index] = await downloadItem(item, output, shared, signal, options);
  });

  return {
    directory: output.display,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}

async function downloadItem(item, output, shared, parentSignal, options) {
  const originalUrl = typeof item?.url === "string" ? item.url : String(item?.url ?? "");
  let tempPath;
  try {
    if (originalUrl.length === 0) throw downloadError("DOWNLOAD_INVALID_URL", "URL must not be empty");
    if (item.file_name !== undefined) validateRequestedName(item.file_name);

    tempPath = join(output.real, `.dsh-download-${randomUUID()}.part`);
    const timeout = AbortSignal.timeout(options.itemTimeoutMs ?? LIMITS.itemTimeoutMs);
    const signal = AbortSignal.any([parentSignal, timeout]);
    const fetched = await fetchToFile(originalUrl, tempPath, shared, signal, options);
    const detected = await detectSafeType(tempPath, fetched.contentType);
    const suggested = item.file_name
      ?? contentDispositionName(fetched.contentDisposition)
      ?? urlName(fetched.finalUrl)
      ?? "download";
    rejectDangerousExtension(suggested);
    const finalName = normalizedName(suggested, preferredExtension(suggested, detected));
    const published = await publishWithoutOverwrite(tempPath, output.real, finalName, shared.reserved);
    tempPath = undefined;

    return {
      ok: true,
      url: originalUrl,
      finalUrl: fetched.finalUrl,
      path: join(output.display, published),
      mediaType: detected.mediaType,
      bytes: fetched.bytes,
    };
  } catch (error) {
    return {
      ok: false,
      url: originalUrl,
      error: error instanceof Error ? error.message : String(error),
      code: resultCode(error, parentSignal),
    };
  } finally {
    if (tempPath !== undefined) await unlink(tempPath).catch(() => undefined);
  }
}

async function fetchToFile(initialUrl, tempPath, shared, signal, options) {
  let current = validateFetchUrl(initialUrl, LIMITS.maxUrlLength);
  let redirects = 0;
  for (;;) {
    const { response, transport } = await requestOnce(current, signal, options);
    try {
      if (REDIRECTS.has(response.status)) {
        if (redirects >= LIMITS.maxRedirects) {
          throw downloadError("DOWNLOAD_REDIRECT_LIMIT", `exceeded ${LIMITS.maxRedirects} redirects`);
        }
        const location = response.headers.get("location");
        if (location === null) throw downloadError("DOWNLOAD_BAD_REDIRECT", "redirect has no Location header");
        current = validateFetchUrl(new URL(location, current).toString(), LIMITS.maxUrlLength);
        redirects++;
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        throw downloadError("DOWNLOAD_HTTP_ERROR", `download failed with HTTP ${response.status}`);
      }

      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > LIMITS.maxFileBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw downloadError("DOWNLOAD_TOO_LARGE", `file exceeds ${LIMITS.maxFileBytes} bytes`);
      }
      const bytes = await writeResponse(response, tempPath, shared, signal);
      return {
        finalUrl: current.toString(),
        bytes,
        contentType: mediaType(response.headers.get("content-type")),
        contentDisposition: response.headers.get("content-disposition"),
      };
    } finally {
      await transport.close().catch(() => undefined);
    }
  }
}

async function requestOnce(url, signal, options) {
  const literal = literalAddress(url.hostname);
  const resolver = options.resolver ?? systemResolver;
  const addresses = validateResolvedAddresses(literal === undefined
    ? await abortable(resolver(normalizeHost(url.hostname), signal), signal)
    : [literal]);
  const pinnedResolver = async () => addresses;
  const transport = options.transportFactory?.(pinnedResolver) ?? new UndiciSafeTransport(pinnedResolver);
  try {
    const response = await transport.request(url, signal, { "user-agent": USER_AGENT });
    return { response, transport };
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

async function writeResponse(response, path, shared, signal) {
  const handle = await open(path, "wx", 0o600);
  const reader = response.body?.getReader();
  let total = 0;
  try {
    if (reader === undefined) return 0;
    for (;;) {
      if (signal.aborted) throw signal.reason ?? downloadError("DOWNLOAD_ABORTED", "download aborted");
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      if (total + value.byteLength > LIMITS.maxFileBytes) {
        throw downloadError("DOWNLOAD_TOO_LARGE", `file exceeds ${LIMITS.maxFileBytes} bytes`);
      }
      if (shared.transferred + value.byteLength > LIMITS.maxBatchBytes) {
        throw downloadError("DOWNLOAD_BATCH_TOO_LARGE", `batch exceeds ${LIMITS.maxBatchBytes} bytes`);
      }
      shared.transferred += value.byteLength;
      total += value.byteLength;
      for (let offset = 0; offset < value.byteLength;) {
        const { bytesWritten } = await handle.write(value, offset);
        offset += bytesWritten;
      }
    }
    await handle.sync();
    return total;
  } finally {
    await reader?.cancel().catch(() => undefined);
    await handle.close();
  }
}

async function detectSafeType(path, declaredType) {
  const detected = await fileTypeFromFile(path);
  if (detected !== undefined) {
    const extension = BINARY_TYPES.get(detected.mime);
    if (extension === undefined) throw downloadError("DOWNLOAD_UNSUPPORTED_TYPE", `unsupported content type: ${detected.mime}`);
    if (!GENERIC_TYPES.has(declaredType) && !compatibleTypes(declaredType, detected.mime)) {
      throw downloadError("DOWNLOAD_TYPE_MISMATCH", `declared ${declaredType}, detected ${detected.mime}`);
    }
    return { mediaType: detected.mime, extension };
  }

  const extension = TEXT_TYPES.get(declaredType);
  if (extension === undefined) {
    throw downloadError("DOWNLOAD_UNSUPPORTED_TYPE", `unsupported or unknown content type: ${declaredType || "unknown"}`);
  }
  await validateUtf8Text(path);
  return { mediaType: declaredType, extension };
}

async function validateUtf8Text(path) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let prefix = "";
  try {
    for await (const chunk of createReadStream(path)) {
      const text = decoder.decode(chunk, { stream: true });
      if (prefix.length < 4_096) prefix += text.slice(0, 4_096 - prefix.length);
      if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
        throw downloadError("DOWNLOAD_NOT_TEXT", "text response contains binary control bytes");
      }
    }
    decoder.decode();
    const start = prefix.trimStart().toLowerCase();
    if (start.startsWith("#!")) {
      throw downloadError("DOWNLOAD_UNSUPPORTED_TYPE", "executable scripts are not allowed");
    }
    if (/^(?:<!doctype\s+html|<html\b|<svg\b)|^<\?xml[^>]*>\s*<svg\b/su.test(start)) {
      throw downloadError("DOWNLOAD_UNSUPPORTED_TYPE", "HTML and SVG downloads are not allowed");
    }
  } catch (error) {
    if (error?.code?.startsWith?.("DOWNLOAD_")) throw error;
    throw downloadError("DOWNLOAD_NOT_TEXT", "text response is not valid UTF-8");
  }
}

async function resolveOutputDirectory(cwd, requested, signal) {
  if (signal.aborted) throw signal.reason ?? new Error("download aborted");
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) {
    throw new Error("directory must be a non-empty relative subdirectory");
  }
  if (isAbsolute(requested)) throw new Error("directory must be relative to the workspace");
  const normalized = normalize(requested);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error("directory must stay inside a workspace subdirectory");
  }

  const workspace = await realpath(cwd);
  const candidate = resolve(workspace, normalized);
  assertContained(workspace, candidate);
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const actual = await realpath(candidate);
  assertContained(workspace, actual);
  return { real: actual, display: normalized };
}

function assertContained(root, target) {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("download directory escapes the workspace");
  }
}

async function publishWithoutOverwrite(tempPath, directory, fileName, reserved) {
  const parsed = parse(fileName);
  for (let suffix = 1; suffix < 10_000; suffix++) {
    const name = suffix === 1 ? fileName : `${parsed.name}-${suffix}${parsed.ext}`;
    const key = name.normalize("NFC").toLowerCase();
    if (reserved.has(key)) continue;
    reserved.add(key);
    const target = join(directory, name);
    try {
      await link(tempPath, target);
      await unlink(tempPath);
      return name;
    } catch (error) {
      reserved.delete(key);
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw downloadError("DOWNLOAD_NAME_EXHAUSTED", "could not allocate a unique filename");
}

function validateRequestedName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw downloadError("DOWNLOAD_INVALID_NAME", "file_name must contain 1–255 characters");
  }
  if (value !== basename(value) || /[\\/\u0000-\u001F]/u.test(value) || value === "." || value === ".." || value.startsWith(".")) {
    throw downloadError("DOWNLOAD_INVALID_NAME", "file_name must be a visible basename without path separators");
  }
}

function normalizedName(value, extension) {
  const clean = String(value)
    .normalize("NFC")
    .replace(/[\\/\u0000-\u001F:]/gu, "_")
    .replace(/^[.\s]+|[.\s]+$/gu, "")
    .slice(0, 180);
  const stem = (parse(clean).name || "download").replace(/^[.\s]+/u, "") || "download";
  return `${stem}.${extension}`;
}

function preferredExtension(value, detected) {
  const extension = parse(String(value)).ext.slice(1).toLowerCase();
  if (detected.mediaType === "text/plain" && ["md", "markdown", "txt"].includes(extension)) {
    return extension === "markdown" ? "md" : extension;
  }
  return detected.extension;
}

function rejectDangerousExtension(value) {
  const extension = parse(String(value)).ext.slice(1).toLowerCase();
  if (REFUSED_EXTENSIONS.has(extension)) {
    throw downloadError("DOWNLOAD_UNSUPPORTED_TYPE", `refused file extension: .${extension}`);
  }
}

function contentDispositionName(header) {
  if (!header) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { return undefined; }
  }
  return /filename="([^"]+)"/iu.exec(header)?.[1] ?? /filename=([^;]+)/iu.exec(header)?.[1]?.trim();
}

function urlName(value) {
  try {
    const name = basename(new URL(value).pathname);
    return name ? decodeURIComponent(name) : undefined;
  } catch {
    return undefined;
  }
}

function mediaType(value) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function compatibleTypes(declared, detected) {
  return declared === detected || COMPATIBLE_TYPES.has(`${declared}:${detected}`);
}

async function systemResolver(hostname) {
  return lookup(hostname, { all: true, verbatim: true });
}

async function abortable(promise, signal) {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function mapLimit(items, limit, operation) {
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function downloadError(code, message) {
  return Object.assign(new Error(message), { code });
}

function resultCode(error, parentSignal) {
  if (parentSignal.aborted) return "DOWNLOAD_ABORTED";
  if (error?.name === "TimeoutError") return "DOWNLOAD_TIMEOUT";
  return typeof error?.code === "string" ? error.code : "DOWNLOAD_FAILED";
}
