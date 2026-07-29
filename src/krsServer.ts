import * as http from "http";
import * as vscode from "vscode";
import { CwRequest } from "./cwTypes";
import { EVENT_STREAM_CONTENT_TYPE } from "./eventstream";
import { writeEvent } from "./cwEvents";
import { conversationId, latestModelId, resolveModel } from "./translate";
import { getEffortMode, getSelectedEffort, getSelectedMode } from "./effort";
import { isIntentClassifierRequest, buildIntentClassifierResponse } from "./intentClassifier";
import { requestUpstream } from "./upstream";
import { PortHolder, OwnershipListener } from "./portBinder";
import {
  getApiKey,
  isEnabled,
  getInterceptIntentClassifier,
  getBaseUrl,
  getRelayMode,
  getAutoRetry,
  getMaxRetries,
  getDefaultModel,
  getMaxTokens,
  getModelMapping,
  getThinkingBudget,
  getThinkingConfig,
} from "./config";
import { debug, error, info } from "./log";
import { runPreparedWithRetry, type ProviderSink, type ProviderTransport } from "./providerRunner";
import { providerFor } from "./providers/registry";
import type { PreparedProviderRequest, ProviderDeps } from "./providers/types";

export const PROXY_ID_PATH = "/__api2kiro_identity";
const PROXY_ID_TOKEN = "api2kiro";

export class KrsProxyServer {
  private holder: PortHolder;
  private port: number;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext, port: number, onOwnershipChange?: OwnershipListener) {
    this.context = context;
    this.port = port;
    this.holder = new PortHolder(
      port,
      "KRS",
      () => http.createServer((req, res) => this.handleRequest(req, res)),
      onOwnershipChange
    );
  }

  async start(): Promise<void> {
    await this.holder.start();
  }

  async stop(): Promise<void> {
    await this.holder.stop();
  }

  isOwner(): boolean {
    return this.holder.isOwner();
  }

  hadForeignConflict(): boolean {
    return this.holder.hadForeignConflict();
  }

  getPort(): number {
    return this.port;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || "/";
    const method = req.method || "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (url.split("?")[0] === PROXY_ID_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proxy: PROXY_ID_TOKEN, role: "krs" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        if (!isEnabled()) {
          // Proxy disabled: shouldn't normally be reachable, but be safe.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        const path = url.split("?")[0];
        const isGenerate =
          path === "/generateAssistantResponse" ||
          path === "/SendMessageStreaming" ||
          (method === "POST" && body.indexOf("conversationState") !== -1);

        if (isGenerate) {
          await this.handleGenerate(res, body);
        } else if (method === "POST" && this.looksLikeJsonRpc(body)) {
          // Kiro 的 InvokeMCPCommand（服务端 MCP 工具发现）走的是流式客户端端点，
          // 会被路由到这里。本地就地应答一个合法的 JSON-RPC 结果。
          this.handleMcpJsonRpc(res, body);
        } else {
          info("KRS unhandled:", method, path);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      } catch (e) {
        error("KRS error:", (e as Error).message);
        if (!res.headersSent) {
          res.writeHead(500, {
            "Content-Type": "application/json",
            "x-amzn-errortype": "InternalServerException",
          });
        }
        res.end(JSON.stringify({ __type: "InternalServerException", message: (e as Error).message }));
      }
    });
  }

  /** Heuristic: Kiro's InvokeMCPCommand body is JSON-RPC ({"jsonrpc","method",...}). */
  private looksLikeJsonRpc(body: string): boolean {
    return body.indexOf('"jsonrpc"') !== -1 && body.indexOf('"method"') !== -1;
  }

  /**
   * Answer Kiro's server-side MCP discovery (InvokeMCPCommand) locally.
   *
   * Kiro routes CodeWhisperer streaming-client commands (including InvokeMCPCommand)
   * to the runtime endpoint, which this proxy now owns. Against a real AWS backend
   * that call returns the backend's hosted MCP tools; against a third-party relay
   * there are none. Returning `{}` is invalid JSON-RPC and makes Kiro's
   * RemoteToolsDiscovery fail (the agent then looks like it has no tools). Kiro's
   * file/terminal capabilities are client-side (ACP) and unaffected, so we reply
   * with a *valid* JSON-RPC result advertising no remote tools — discovery then
   * succeeds cleanly and the local tools remain available.
   */
  private handleMcpJsonRpc(res: http.ServerResponse, rawBody: string): void {
    let id: unknown = null;
    let rpcMethod = "";
    try {
      const parsed = JSON.parse(rawBody);
      id = parsed?.id ?? null;
      rpcMethod = typeof parsed?.method === "string" ? parsed.method : "";
    } catch {
      /* fall through to a generic empty result */
    }

    info("KRS MCP:", rpcMethod || "(unparsed)");

    // JSON-RPC notifications carry no id and expect no response body.
    if (id === null || id === undefined) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("");
      return;
    }

    const version = this.context.extension.packageJSON.version || "0.0.0";
    let result: unknown;
    switch (rpcMethod) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "api2kiro", version },
        };
        break;
      case "tools/list":
        result = { tools: [] };
        break;
      case "prompts/list":
        result = { prompts: [] };
        break;
      case "resources/list":
        result = { resources: [] };
        break;
      case "resources/templates/list":
        result = { resourceTemplates: [] };
        break;
      default:
        result = {};
        break;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private beginEventStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": EVENT_STREAM_CONTENT_TYPE,
      "Transfer-Encoding": "chunked",
    });
    try {
      res.socket?.setNoDelay(true);
    } catch {
      /* ignore */
    }
  }

  /** Emit a friendly setup message as a normal assistant reply. */
  private writeSetupMessage(res: http.ServerResponse, convId: string, msg: string): void {
    this.beginEventStream(res);
    writeEvent(res, { messageMetadataEvent: { conversationId: convId } });
    writeEvent(res, { assistantResponseEvent: { content: msg, modelId: "api2kiro-setup" } });
    res.end();
  }

  private providerDeps(): ProviderDeps {
    return {
      version: this.context.extension.packageJSON.version || "0.0.0",
      getApiKey: (provider) => getApiKey(provider),
      getBaseUrl: (provider) => getBaseUrl(provider),
      resolveModel: (request, provider) => {
        const modelId = latestModelId(request);
        const mapping = getModelMapping(provider);
        return mapping[modelId] || getDefaultModel(provider) || modelId;
      },
      getMaxTokens,
      getEffort: getSelectedEffort,
      getReasoningMode: getSelectedMode,
      getThinkingConfig,
      getThinkingBudget,
      getEffortMode,
    };
  }

  private async handleGenerate(res: http.ServerResponse, rawBody: string): Promise<void> {
    let parsed: CwRequest;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    const convId = conversationId(parsed);
    const kiroModel = latestModelId(parsed);

    const providerId = getRelayMode();
    const baseUrl = getBaseUrl(providerId);
    const apiKey = getApiKey(providerId);
    if (!baseUrl || !apiKey) {
      this.writeSetupMessage(
        res,
        convId,
        "⚠️ API2Kiro 尚未配置完成。\n\n请在左侧 “API2Kiro” 控制面板中填写中转站地址与 API Key 后再试。\n\n" +
          (baseUrl ? "" : "· 缺少中转站地址\n") +
          (apiKey ? "" : "· 缺少 API Key\n")
      );
      return;
    }

    // Intercept Kiro's intent classifier locally to save an upstream call.
    if (getInterceptIntentClassifier() && isIntentClassifierRequest(parsed)) {
      debug("intent classifier intercepted", { conversationId: convId });
      this.beginEventStream(res);
      for (const ev of buildIntentClassifierResponse(parsed, convId, kiroModel)) {
        writeEvent(res, ev);
      }
      res.end();
      return;
    }

    const provider = providerFor(providerId, this.providerDeps());
    const prepared = await provider.prepare(parsed);
    info(
      `→ [${providerId}] model=${prepared.modelId} (kiro=${kiroModel}) conv=${convId}`
    );
    debug("upstream request", { url: prepared.url, body: prepared.body });

    await this.streamWithRetry(res, prepared, convId);
  }

  /**
   * 发起上游请求并流式转换回 Kiro；在「尚未向客户端吐出任何内容」时对连接失败 /
   * 可重试状态码(5xx/429) / 流中途中断透明重试。一旦已开始向客户端输出正文/思考/工具
   * (committed)，则不再重试(避免重复内容)，尽力收尾。
   */
  private async streamWithRetry(
    res: http.ServerResponse,
    prepared: PreparedProviderRequest,
    convId: string,
  ): Promise<void> {
    const transport: ProviderTransport = {
      request: (item) => requestUpstream("POST", item.url, item.headers, item.body),
    };
    let metadataWritten = false;
    const sink: ProviderSink = {
      begin: () => this.beginEventStream(res),
      write: (event) => {
        metadataWritten ||= event.messageMetadataEvent !== undefined;
        writeEvent(res, event);
      },
      fail: (message) => {
        if (!metadataWritten) {
          writeEvent(res, { messageMetadataEvent: { conversationId: convId } });
          metadataWritten = true;
        }
        writeEvent(res, {
          assistantResponseEvent: {
            content: `上游错误：${message}`,
            modelId: prepared.modelId,
          },
        });
      },
      end: () => {
        if (!res.writableEnded) {
          res.end();
        }
      },
    };
    await runPreparedWithRetry(prepared, transport, sink, {
      maxRetries: getAutoRetry() ? getMaxRetries() : 0,
      conversationId: convId,
    });
  }
}

// Re-export for the CPS server / others that resolve upstream model ids.
export { resolveModel };
