import * as http from "http";
import { PortHolder, OwnershipListener } from "./portBinder";
import { isEnabled, getRelayMode } from "./config";
import { debug, error, info } from "./log";
import { PROXY_ID_PATH } from "./krsServer";
import {
  fetchRelayModels,
  groupModelsByEffort,
} from "./modelStore";
import { getEffortMode } from "./effort";
import { buildCpsModels, type CpsModel } from "./cpsModelSchema";

const PROXY_ID_TOKEN = "api2kiro";

export class CpsProxyServer {
  private holder: PortHolder;
  private port: number;

  constructor(port: number, onOwnershipChange?: OwnershipListener) {
    this.port = port;
    this.holder = new PortHolder(
      port,
      "CPS",
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

  private async buildModelList(): Promise<{ models: CpsModel[]; defaultModel?: { modelId: string } }> {
    const relay = await fetchRelayModels(false);
    const groups = groupModelsByEffort(relay);
    const models: CpsModel[] = buildCpsModels(
      groups,
      getRelayMode(),
      getEffortMode(),
    );

    const result: { models: CpsModel[]; defaultModel?: { modelId: string } } = { models };
    if (models.length > 0) {
      result.defaultModel = { modelId: models[0].modelId };
    }
    return result;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || "/";
    const path = url.split("?")[0];

    if (path === PROXY_ID_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proxy: PROXY_ID_TOKEN, role: "cps" }));
      return;
    }

    if (!isEnabled()) {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    const target = (req.headers["x-amz-target"] || req.headers["x-amzn-target"] || "") as string;
    const op = target.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "";
    const pathKey = path.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const contentType = target ? "application/x-amz-json-1.0" : "application/json";

    // Profiles
    if (op === "getprofile" || op === "listavailableprofiles" || pathKey.includes("profile")) {
      req.resume();
      const isList =
        op === "listavailableprofiles" ||
        pathKey.includes("listavailableprofiles") ||
        pathKey.includes("profiles");
      const profile = {
        arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/API2KIRO",
        profileName: "API2Kiro",
        identityDetails: { region: "us-east-1" },
      };
      res.writeHead(200, { "Content-Type": contentType });
      res.end(JSON.stringify(isList ? { profiles: [profile] } : { profile }));
      return;
    }

    // Model list
    if (op === "listavailablemodels" || pathKey.includes("availablemodels")) {
      req.resume();
      this.buildModelList()
        .then((list) => {
          debug("cps models", { count: list.models.length });
          res.writeHead(200, { "Content-Type": contentType });
          res.end(JSON.stringify(list));
        })
        .catch((e) => {
          error("buildModelList failed:", (e as Error)?.message);
          res.writeHead(200, { "Content-Type": contentType });
          res.end(JSON.stringify({ models: [] }));
        });
      return;
    }

    // Usage limits: we surface usage in our own panel, so return an empty stub
    // (Kiro tolerates an empty object here).
    if (op === "getusagelimits" || pathKey.includes("usagelimit")) {
      req.resume();
      res.writeHead(200, { "Content-Type": contentType });
      res.end(JSON.stringify({}));
      return;
    }

    // Anything else: benign empty object.
    req.resume();
    info("CPS passthrough:", op || pathKey);
    res.writeHead(200, { "Content-Type": contentType });
    res.end("{}");
  }
}
