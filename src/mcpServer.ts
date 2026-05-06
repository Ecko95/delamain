import { killPeer, listPeers, peerStatus, readPeerLog, resumePeer, spawnPeer } from "./peerManager.js";

const TOOLS = [
  {
    name: "spawn_peer",
    description: "Spawn a supervised headless Codex peer in another repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Absolute or relative path to the repository." },
        prompt: { type: "string", description: "Task prompt for the peer." },
        name: { type: "string", description: "Optional display name for the peer." },
        model: { type: "string", description: "Optional Codex model override." },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Optional Codex sandbox mode.",
        },
        yolo: {
          type: "boolean",
          description: "Run peer with --dangerously-bypass-approvals-and-sandbox.",
        },
        dangerously_bypass_approvals_and_sandbox: {
          type: "boolean",
          description: "Alias for yolo. Run peer with --dangerously-bypass-approvals-and-sandbox.",
        },
      },
      required: ["repo", "prompt"],
    },
  },
  {
    name: "list_peers",
    description: "List all known Codex peers and their current status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "peer_status",
    description: "Get a single peer status by id or id prefix.",
    inputSchema: {
      type: "object",
      properties: { peer_id: { type: "string" } },
      required: ["peer_id"],
    },
  },
  {
    name: "read_peer_log",
    description: "Read recent log lines for a peer.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string" },
        lines: { type: "number", description: "Number of recent lines to return." },
      },
      required: ["peer_id"],
    },
  },
  {
    name: "send_peer_reply",
    description: "Resume a peer's Codex thread with a reply from the orchestrator.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string" },
        prompt: { type: "string" },
        model: { type: "string" },
        yolo: { type: "boolean" },
        dangerously_bypass_approvals_and_sandbox: {
          type: "boolean",
          description: "Alias for yolo. Run peer with --dangerously-bypass-approvals-and-sandbox.",
        },
      },
      required: ["peer_id", "prompt"],
    },
  },
  {
    name: "kill_peer",
    description: "Kill a peer runner and its Codex process.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string" },
        signal: { type: "string", description: "SIGTERM or SIGKILL. Defaults to SIGTERM." },
      },
      required: ["peer_id"],
    },
  },
];

export async function startMcpServer(): Promise<void> {
  const transport = new StdioJsonRpcTransport(async (request) => {
    try {
      const result = await handleRequest(request);
      if (request.id !== undefined && result !== undefined) {
        transport.send({ jsonrpc: "2.0", id: request.id, result });
      }
    } catch (error) {
      if (request.id !== undefined) {
        transport.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  });
  transport.start();
}

async function handleRequest(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "codex-mcp-peers-server",
          title: "Codex MCP Peers",
          version: "0.1.0",
        },
        instructions:
          "Use this MCP server to spawn and supervise headless Codex peers across repositories. Use list_peers and read_peer_log to monitor progress; use send_peer_reply when a peer reports CODEX_PEERS_STATUS: WAITING.",
      };
    case "notifications/initialized":
      return undefined;
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(request.params?.name, request.params?.arguments || {});
    default:
      if (request.id === undefined) {
        return undefined;
      }
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

function callTool(name: unknown, rawArgs: unknown): unknown {
  const args = (rawArgs || {}) as Record<string, unknown>;
  switch (name) {
    case "spawn_peer":
      return json(spawnPeer({
        repo: requiredString(args, "repo"),
        prompt: requiredString(args, "prompt"),
        name: optionalString(args, "name"),
        model: optionalString(args, "model"),
        sandbox: optionalString(args, "sandbox") as "read-only" | "workspace-write" | "danger-full-access" | undefined,
        yolo: bypassEnabled(args),
      }));
    case "list_peers":
      return json(listPeers());
    case "peer_status":
      return json(peerStatus(requiredString(args, "peer_id")));
    case "read_peer_log":
      return text(readPeerLog(requiredString(args, "peer_id"), optionalNumber(args, "lines") || 120));
    case "send_peer_reply":
      return json(resumePeer({
        peerId: requiredString(args, "peer_id"),
        prompt: requiredString(args, "prompt"),
        model: optionalString(args, "model"),
        yolo: bypassEnabled(args),
      }));
    case "kill_peer":
      return json(killPeer(requiredString(args, "peer_id"), signalValue(args.signal)));
    default:
      throw new Error(`Unknown tool: ${String(name)}`);
  }
}

function json(value: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function text(value: string): ToolResult {
  return {
    content: [{ type: "text" as const, text: value }],
  };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function signalValue(value: unknown): NodeJS.Signals {
  return value === "SIGKILL" ? "SIGKILL" : "SIGTERM";
}

function bypassEnabled(args: Record<string, unknown>): boolean {
  return Boolean(
    args.yolo ||
      args.dangerously_bypass_approvals_and_sandbox ||
      args["dangerously-bypass-approvals-and-sandbox"],
  );
}

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

class StdioJsonRpcTransport {
  private buffer = "";
  private mode: "line" | "headers" | undefined;

  constructor(private readonly onRequest: (request: JsonRpcRequest) => Promise<void>) {}

  start(): void {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      this.buffer += chunk;
      this.drain();
    });
    process.stdin.resume();
  }

  send(response: JsonRpcResponse): void {
    const body = JSON.stringify(response);
    if (this.mode === "headers") {
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    } else {
      process.stdout.write(`${body}\n`);
    }
  }

  private drain(): void {
    if (!this.mode) {
      this.mode = this.buffer.startsWith("Content-Length:") ? "headers" : "line";
    }
    if (this.mode === "headers") {
      this.drainHeaders();
    } else {
      this.drainLines();
    }
  }

  private drainLines(): void {
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.handleLine(line);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private drainHeaders(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd);
      const length = header
        .split(/\r\n/)
        .map((line) => line.match(/^Content-Length:\s*(\d+)$/i)?.[1])
        .find(Boolean);
      if (!length) {
        throw new Error("Invalid MCP message: missing Content-Length");
      }
      const bodyStart = headerEnd + 4;
      const bodyLength = Number(length);
      if (this.buffer.length < bodyStart + bodyLength) {
        return;
      }
      const body = this.buffer.slice(bodyStart, bodyStart + bodyLength);
      this.buffer = this.buffer.slice(bodyStart + bodyLength);
      this.handleLine(body);
    }
  }

  private handleLine(line: string): void {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch (error) {
      console.error(`[codex-peers] invalid JSON-RPC message: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void this.onRequest(request);
  }
}
