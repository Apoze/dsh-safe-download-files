import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadBatch, LIMITS } from "../downloader.js";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

test("downloads safe files, normalizes extensions, and never overwrites", async (t) => {
  const workspace = await temporaryWorkspace(t);
  const transportFactory = fakeTransport(() => new Response(PNG, {
    headers: { "content-type": "application/octet-stream" },
  }));

  const result = await downloadBatch({
    cwd: workspace,
    directory: "assets/images",
    items: [
      { url: "https://example.com/a", file_name: "portrait.bin" },
      { url: "https://example.com/b", file_name: "portrait.bin" },
    ],
    signal: new AbortController().signal,
    options: { resolver: async () => PUBLIC, transportFactory },
  });

  assert.equal(result.succeeded, 2);
  assert.deepEqual(result.results.map((item) => item.path).sort(), [
    "assets/images/portrait.png",
    "assets/images/portrait-2.png",
  ].sort());
  assert.deepEqual(await readFile(join(workspace, result.results[0].path)), PNG);
  assert.deepEqual(await readFile(join(workspace, result.results[1].path)), PNG);
});

test("preserves safe Markdown names served as UTF-8 text/plain", async (t) => {
  const workspace = await temporaryWorkspace(t);
  const result = await downloadBatch({
    cwd: workspace,
    items: [{ url: "https://example.com/README.md" }],
    signal: new AbortController().signal,
    options: {
      resolver: async () => PUBLIC,
      transportFactory: fakeTransport(() => new Response("# Documentation\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      })),
    },
  });
  assert.equal(result.results[0].path, "downloads/README.md");
});

test("blocks private DNS answers and private redirect targets before connecting", async (t) => {
  const workspace = await temporaryWorkspace(t);
  let requests = 0;
  const blocked = await downloadBatch({
    cwd: workspace,
    items: [{ url: "https://private.example/file.txt" }],
    signal: new AbortController().signal,
    options: {
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      transportFactory: fakeTransport(() => { requests++; return new Response("never"); }),
    },
  });
  assert.equal(blocked.results[0].code, "WEB_PRIVATE_ADDRESS_BLOCKED");
  assert.equal(requests, 0);

  const mixed = await downloadBatch({
    cwd: workspace,
    items: [{ url: "https://mixed.example/file.txt" }, { url: "http://[::1]/file.txt" }],
    signal: new AbortController().signal,
    options: {
      resolver: async () => [...PUBLIC, { address: "10.0.0.1", family: 4 }],
      transportFactory: fakeTransport(() => { requests++; return new Response("never"); }),
    },
  });
  assert.deepEqual(mixed.results.map((item) => item.code), [
    "WEB_PRIVATE_ADDRESS_BLOCKED",
    "WEB_PRIVATE_ADDRESS_BLOCKED",
  ]);
  assert.equal(requests, 0);

  const redirected = await downloadBatch({
    cwd: workspace,
    items: [{ url: "https://public.example/file.txt" }],
    signal: new AbortController().signal,
    options: {
      resolver: async () => PUBLIC,
      transportFactory: fakeTransport(() => {
        requests++;
        return new Response(null, { status: 302, headers: { location: "http://192.168.1.10/private" } });
      }),
    },
  });
  assert.equal(redirected.results[0].code, "WEB_PRIVATE_ADDRESS_BLOCKED");
  assert.equal(requests, 1);
});

test("pins one validated DNS answer set for the complete request hop", async (t) => {
  const workspace = await temporaryWorkspace(t);
  let resolutions = 0;
  const result = await downloadBatch({
    cwd: workspace,
    items: [{ url: "https://stable.example/file.txt" }],
    signal: new AbortController().signal,
    options: {
      resolver: async () => { resolutions++; return PUBLIC; },
      transportFactory: (pinnedResolver) => ({
        async request(url, signal) {
          assert.deepEqual(await pinnedResolver(url.hostname, signal), PUBLIC);
          assert.deepEqual(await pinnedResolver(url.hostname, signal), PUBLIC);
          return new Response("safe", { headers: { "content-type": "text/plain" } });
        },
        async close() {},
      }),
    },
  });
  assert.equal(result.succeeded, 1);
  assert.equal(resolutions, 1);
});

test("revalidates and follows a public cross-origin redirect", async (t) => {
  const workspace = await temporaryWorkspace(t);
  const hosts = [];
  const result = await downloadBatch({
    cwd: workspace,
    items: [{ url: "https://origin.example/file", file_name: "manual" }],
    signal: new AbortController().signal,
    options: {
      resolver: async (host) => { hosts.push(host); return PUBLIC; },
      transportFactory: fakeTransport((url) => url.hostname === "origin.example"
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example/manual.pdf" } })
        : new Response("%PDF-1.7\n", { headers: { "content-type": "application/pdf" } })),
    },
  });
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].path, "downloads/manual.pdf");
  assert.deepEqual(hosts, ["origin.example", "cdn.example"]);
});

test("rejects mismatched, dangerous, and invalid text content", async (t) => {
  const workspace = await temporaryWorkspace(t);
  const bodies = new Map([
    ["mismatch.example", new Response(PNG, { headers: { "content-type": "text/html" } })],
    ["archive.example", new Response(Buffer.from("504b0304", "hex"), { headers: { "content-type": "application/zip" } })],
    ["binary.example", new Response(Buffer.from([0xff, 0xfe, 0x00]), { headers: { "content-type": "text/plain" } })],
    ["html.example", new Response("<!doctype html><html><body>unsafe</body></html>", { headers: { "content-type": "text/plain" } })],
    ["script.example", new Response("#!/bin/sh\necho unsafe\n", { headers: { "content-type": "text/plain" } })],
    ["batch.example", new Response("@echo off\necho unsafe\n", { headers: { "content-type": "text/plain" } })],
  ]);
  const result = await downloadBatch({
    cwd: workspace,
    items: [...bodies.keys()].map((host) => ({
      url: `https://${host}/${host === "batch.example" ? "run.bat" : "file"}`,
    })),
    signal: new AbortController().signal,
    options: {
      resolver: async () => PUBLIC,
      transportFactory: fakeTransport((url) => bodies.get(url.hostname)),
    },
  });
  assert.deepEqual(result.results.map((item) => item.code), [
    "DOWNLOAD_TYPE_MISMATCH",
    "DOWNLOAD_UNSUPPORTED_TYPE",
    "DOWNLOAD_NOT_TEXT",
    "DOWNLOAD_UNSUPPORTED_TYPE",
    "DOWNLOAD_UNSUPPORTED_TYPE",
    "DOWNLOAD_UNSUPPORTED_TYPE",
  ]);
});

test("rejects path traversal, symlink escapes, and model-controlled path separators", async (t) => {
  const workspace = await temporaryWorkspace(t);
  await assert.rejects(downloadBatch({
    cwd: workspace,
    directory: "../outside",
    items: [{ url: "https://example.com/file.txt" }],
    signal: new AbortController().signal,
  }), /inside a workspace subdirectory/u);

  const outside = await temporaryWorkspace(t);
  await symlink(outside, join(workspace, "escape"));
  await assert.rejects(downloadBatch({
    cwd: workspace,
    directory: "escape",
    items: [{ url: "https://example.com/file.txt" }],
    signal: new AbortController().signal,
  }), /escapes the workspace/u);

  const result = await downloadBatch({
    cwd: workspace,
    items: [{ url: "https://example.com/file.txt", file_name: "../file.txt" }],
    signal: new AbortController().signal,
  });
  assert.equal(result.results[0].code, "DOWNLOAD_INVALID_NAME");
});

test("enforces declared size and preserves partial batch success", async (t) => {
  const workspace = await temporaryWorkspace(t);
  const result = await downloadBatch({
    cwd: workspace,
    items: [
      { url: "https://large.example/file.txt" },
      { url: "https://ok.example/file.txt" },
    ],
    signal: new AbortController().signal,
    options: {
      resolver: async () => PUBLIC,
      transportFactory: fakeTransport((url) => url.hostname === "large.example"
        ? new Response(null, { headers: { "content-type": "text/plain", "content-length": String(LIMITS.maxFileBytes + 1) } })
        : new Response("safe text", { headers: { "content-type": "text/plain" } })),
    },
  });
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].code, "DOWNLOAD_TOO_LARGE");
  assert.equal(result.results[1].path, "downloads/file.txt");
});

test("honors cancellation and removes partial files", async (t) => {
  const workspace = await temporaryWorkspace(t);
  const controller = new AbortController();
  const stream = new ReadableStream({
    start(owner) {
      owner.enqueue(new Uint8Array([1, 2, 3]));
      setTimeout(() => owner.error(new DOMException("aborted", "AbortError")), 20);
    },
  });
  setTimeout(() => controller.abort(), 5);
  const result = await downloadBatch({
    cwd: workspace,
    items: [{ url: "https://example.com/file.bin" }],
    signal: controller.signal,
    options: {
      resolver: async () => PUBLIC,
      transportFactory: fakeTransport(() => new Response(stream, { headers: { "content-type": "application/octet-stream" } })),
    },
  });
  assert.equal(result.results[0].code, "DOWNLOAD_ABORTED");
  const entries = await readdir(join(workspace, "downloads"));
  assert.deepEqual(entries, []);
});

test("bounds a simulated 100-file batch to eight concurrent requests", async (t) => {
  const workspace = await temporaryWorkspace(t);
  let active = 0;
  let peak = 0;
  const result = await downloadBatch({
    cwd: workspace,
    items: Array.from({ length: 100 }, (_, index) => ({
      url: `https://example.com/${index}.txt`,
      file_name: `${index}.txt`,
    })),
    signal: new AbortController().signal,
    options: {
      resolver: async () => PUBLIC,
      transportFactory: () => ({
        async request() {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active--;
          return new Response("safe text", { headers: { "content-type": "text/plain" } });
        },
        async close() {},
      }),
    },
  });
  assert.equal(result.succeeded, 100);
  assert.ok(peak <= LIMITS.maxConcurrent);
});

function fakeTransport(handler) {
  return (resolver) => ({
    async request(url, signal) {
      await resolver(url.hostname, signal);
      return handler(url, signal);
    },
    async close() {},
  });
}

async function temporaryWorkspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-download-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  return directory;
}
