import * as http from "node:http";
import type { AddressInfo } from "node:net";

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void | Promise<void>;

export type RouteMap = Record<string, RouteHandler>;

async function routeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  routes: RouteMap,
): Promise<void> {
  const handler = routes[`${req.method} ${req.url}`];
  if (!handler) {
    res.writeHead(404).end();
    return;
  }
  try {
    await handler(req, res);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  }
}

export async function startFakeProvider(routes: RouteMap): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    void routeRequest(req, res, routes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.once("end", () => resolve(body));
    req.once("error", reject);
  });
}

export function writeSse(
  res: http.ServerResponse,
  events: Array<Record<string, unknown>>,
): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) {
    const record = `data: ${JSON.stringify(event)}\r\n\r\n`;
    const split = Math.max(1, Math.floor(record.length / 2));
    res.write(record.slice(0, split));
    res.write(record.slice(split));
  }
  res.end();
}
