import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import osc from "osc";
import { WebSocketServer } from "ws";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, "public");
const stateFile = process.env.OSCRNODE_LIGHT_STATE_FILE || path.join(root, ".oscrnode-light-state.json");

function parsePort(value, fallback, allowZero = false) {
  const port = Number(value);
  const minimum = allowZero ? 0 : 1;
  return Number.isInteger(port) && port >= minimum && port <= 65535 ? port : fallback;
}

const httpPort = parsePort(process.env.OSC_SENDER_HTTP_PORT, 4175, true);
const target = {
  host: process.env.OSC_SENDER_TARGET_HOST || "127.0.0.1",
  port: parsePort(process.env.OSC_SENDER_TARGET_PORT, 8000),
};

let udpReady = false;
let sentCount = 0;
let stopPromise = null;

let resolveServerReady;
let rejectServerReady;
export const serverReady = new Promise((resolve, reject) => {
  resolveServerReady = resolve;
  rejectServerReady = reject;
});

const udpPort = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: 0,
  metadata: true,
});

const files = new Map([
  ["/", [path.join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
  ["/index.html", [path.join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
  ["/styles.css", [path.join(publicRoot, "styles.css"), "text/css; charset=utf-8"]],
  ["/app.js", [path.join(publicRoot, "app.js"), "text/javascript; charset=utf-8"]],
  [
    "/fonts/Geist-Variable.woff2",
    [path.join(publicRoot, "fonts", "Geist-Variable.woff2"), "font/woff2"],
  ],
  [
    "/vendor/osc-browser.min.js",
    [path.join(root, "node_modules", "osc", "dist", "osc-browser.min.js"), "text/javascript; charset=utf-8"],
  ],
]);

let bakedLogo = null;

async function serveBakedLogo(response) {
  try {
    if (!bakedLogo) {
      const [svg, font] = await Promise.all([
        readFile(path.join(publicRoot, "assets", "OSCrnodeLightLogo.svg"), "utf8"),
        readFile(path.join(publicRoot, "fonts", "Geist-Variable.woff2")),
      ]);
      const embeddedFont = `data:font/woff2;base64,${font.toString("base64")}`;
      bakedLogo = Buffer.from(svg.replaceAll("../fonts/Geist-Variable.woff2", embeddedFont));
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": bakedLogo.length,
      "Content-Type": "image/svg+xml; charset=utf-8",
    });
    response.end(bakedLogo);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let length = 0;

  for await (const chunk of request) {
    length += chunk.length;
    if (length > 256 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function validateTarget(data) {
  const host = String(data.host || "").trim();
  const port = Number(data.port);

  if (!host || host.length > 253 || /[\s/]/.test(host)) {
    throw new Error("Enter a valid host name or IP address");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("UDP port must be between 1 and 65535");
  }

  return { host, port };
}

async function serveFile(response, absolutePath, contentType) {
  try {
    const details = await stat(absolutePath);
    response.writeHead(200, {
      "Cache-Control": absolutePath.includes("node_modules") ? "public, max-age=3600" : "no-store",
      "Content-Length": details.size,
      "Content-Type": contentType,
    });
    createReadStream(absolutePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/assets/OSCrnodeLightLogo.svg") {
    await serveBakedLogo(response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, { ok: true, udpReady, target, sentCount });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/target") {
    try {
      Object.assign(target, validateTarget(await readJson(request)));
      sendJson(response, 200, { ok: true, target });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      sendJson(response, 200, { ok: true, state });
    } catch (error) {
      if (error.code === "ENOENT") sendJson(response, 200, { ok: true, state: null });
      else sendJson(response, 500, { ok: false, error: "Could not read saved state" });
    }
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/state") {
    try {
      const payload = await readJson(request);
      if (!payload.state || typeof payload.state !== "object" || Array.isArray(payload.state)) {
        throw new Error("State must be an object");
      }
      await mkdir(path.dirname(stateFile), { recursive: true });
      const temporaryFile = `${stateFile}.tmp`;
      await writeFile(temporaryFile, `${JSON.stringify(payload.state, null, 2)}\n`, "utf8");
      await rename(temporaryFile, stateFile);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/api/state") {
    try {
      await unlink(stateFile);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      if (error.code === "ENOENT") sendJson(response, 200, { ok: true });
      else sendJson(response, 500, { ok: false, error: "Could not clear saved state" });
    }
    return;
  }

  if (request.method === "GET" && files.has(url.pathname)) {
    const [absolutePath, contentType] = files.get(url.pathname);
    await serveFile(response, absolutePath, contentType);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

const webSocketServer = new WebSocketServer({ noServer: true });

server.on("error", (error) => {
  rejectServerReady(error);
  console.error(`HTTP server error: ${error.message}`);
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/osc") {
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
  });
});

webSocketServer.on("connection", (socket) => {
  const browserPort = new osc.WebSocketPort({ socket, metadata: true });

  browserPort.on("message", (message) => {
    if (!udpReady) return;
    udpPort.send(message, target.host, target.port);
    sentCount += 1;
  });

  browserPort.on("error", (error) => {
    console.error(`WebSocket OSC error: ${error.message}`);
  });
});

udpPort.on("ready", () => {
  udpReady = true;
  server.listen(httpPort, "127.0.0.1", () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : httpPort;
    const url = `http://127.0.0.1:${listeningPort}`;
    console.log(`OSCrnode Light 0.1A: ${url}`);
    console.log(`UDP destination: ${target.host}:${target.port}`);
    resolveServerReady({ url, port: listeningPort, target });
  });
});

udpPort.on("error", (error) => {
  console.error(`UDP OSC error: ${error.message}`);
});

udpPort.open();

export function stopServer() {
  if (stopPromise) return stopPromise;

  stopPromise = new Promise((resolve) => {
    udpReady = false;
    for (const client of webSocketServer.clients) client.terminate();
    webSocketServer.close();
    try {
      udpPort.close();
    } catch {}

    if (server.listening) server.close(resolve);
    else resolve();
  });

  return stopPromise;
}

function stopProcess() {
  stopServer().finally(() => process.exit(0));
}

process.on("SIGINT", stopProcess);
process.on("SIGTERM", stopProcess);
