import { defineTool } from "@deepseek-ai/dsh-tools";
import { downloadBatch, LIMITS } from "./downloader.js";

export const name = "safe-download-files";
export const inject = ["tools", "systemPrompt"];

const itemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: {
      type: "string",
      required: true,
      description: "Public HTTP(S) URL of the file to download.",
    },
    file_name: {
      type: "string",
      description: "Optional basename only. The extension is normalized to the detected content type.",
    },
  },
};

const resultItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    url: { type: "string", required: true },
    finalUrl: { type: "string" },
    path: { type: "string" },
    mediaType: { type: "string" },
    bytes: { type: "integer" },
    error: { type: "string" },
    code: { type: "string" },
  },
};

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: "tool:download_files",
    order: 112,
    text: "Use web_fetch to read web pages. Use download_files only when local file artifacts are needed; do not use shell download commands. Blocked, private, oversized, or unsupported URLs must not be retried through another network tool.",
  });

  ctx.tools.register(defineTool({
    name: "download_files",
    description: `Safely download 1–${LIMITS.maxItems} public HTTP(S) files into a relative workspace subdirectory. Existing files are never overwritten.`,
    parameters: {
      directory: {
        type: "string",
        description: "Relative workspace subdirectory. Defaults to downloads. Absolute paths and parent traversal are rejected.",
      },
      items: {
        type: "array",
        required: true,
        items: itemSchema,
        description: `Files to download; accepts 1–${LIMITS.maxItems} items.`,
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          directory: { type: "string", required: true },
          succeeded: { type: "integer", required: true },
          failed: { type: "integer", required: true },
          results: {
            type: "array",
            required: true,
            items: resultItemSchema,
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: formatResult(value),
      }],
    },
    timeoutMs: LIMITS.toolTimeoutMs,
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) {
        throw new Error("download_files requires a session workspace");
      }
      return downloadBatch({
        cwd,
        directory: args.directory,
        items: args.items,
        signal: exec.signal,
      });
    },
    presentCall(args) {
      return {
        card: "generic",
        title: `Download ${args.items.length} file${args.items.length === 1 ? "" : "s"}`,
        kind: "edit",
        rawInput: { directory: args.directory ?? "downloads" },
      };
    },
    presentResult(_args, result) {
      if (result.isError) return undefined;
      return { card: "generic", title: "Downloaded files" };
    },
  }));
}

function formatResult(value) {
  const lines = [`Downloaded ${value.succeeded}/${value.results.length} files into ${value.directory}.`];
  for (const item of value.results) {
    if (item.ok) lines.push(`- ${item.path} (${item.mediaType}, ${item.bytes} bytes)`);
    else lines.push(`- Failed: ${item.url} [${item.code}] ${item.error}`);
  }
  return lines.join("\n");
}

