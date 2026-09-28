import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
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
let debugReceiver = null;
let debugState = { listening: false, port: 9000, count: 0, error: null, lastMessage: null };
const debugEventClients = new Set();

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
  ["/app.js", [path.join(publicRoot, "app.js"), "text/javascript; charset=utf-8"]],
  ["/debug.html", [path.join(publicRoot, "debug.html"), "text/html; charset=utf-8"]],
  ["/debug.js", [path.join(publicRoot, "debug.js"), "text/javascript; charset=utf-8"]],
  [
    "/assets/OSCrnodeLightLogo.svg",
    [path.join(publicRoot, "assets", "OSCrnodeLightLogo.svg"), "image/svg+xml; charset=utf-8"],
  ],
  [
    "/fonts/Geist-Variable.woff2",
    [path.join(publicRoot, "fonts", "Geist-Variable.woff2"), "font/woff2"],
  ],
  [
    "/vendor/osc-browser.min.js",
    [path.join(root, "node_modules", "osc", "dist", "osc-browser.min.js"), "text/javascript; charset=utf-8"],
  ],
]);

const bakedStyles = new Map();

async function serveBakedStyles(response, fileName) {
  try {
    if (!bakedStyles.has(fileName)) {
      const [styles, font] = await Promise.all([
        readFile(path.join(publicRoot, fileName), "utf8"),
        readFile(path.join(publicRoot, "fonts", "Geist-Variable.woff2")),
      ]);
      const embeddedFont = `data:font/woff2;base64,${font.toString("base64")}`;
      bakedStyles.set(fileName, Buffer.from(styles.replaceAll("/fonts/Geist-Variable.woff2", embeddedFont)));
    }
    const body = bakedStyles.get(fileName);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": body.length,
      "Content-Type": "text/css; charset=utf-8",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function localAddresses() {
  const addresses = new Set(["127.0.0.1"]);
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const details of interfaces || []) {
      if (details.family === "IPv4" && !details.internal) addresses.add(details.address);
    }
  }
  return [...addresses];
}

function debugStatus() {
  return { ...debugState, addresses: localAddresses() };
}

function broadcastDebug(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of debugEventClients) client.write(payload);
}

function serializableArgument(argument) {
  const value = argument?.value;
  return {
    type: argument?.type || typeof value,
    value: Buffer.isBuffer(value) ? `<blob ${value.length} bytes>` : value,
  };
}

async function stopDebugReceiver() {
  const receiver = debugReceiver;
  debugReceiver = null;
  debugState = { ...debugState, listening: false, error: null };
  if (!receiver) return;
  await new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    receiver.once("close", finish);
    try { receiver.close(); } catch { finish(); }
    setTimeout(finish, 250);
  });
}

async function startDebugReceiver(port) {
  await stopDebugReceiver();
  const receiver = new osc.UDPPort({ localAddress: "0.0.0.0", localPort: port, metadata: true });
  debugReceiver = receiver;
  await new Promise((resolve, reject) => {
    const onReady = () => {
      receiver.off("error", onOpeningError);
      debugState = { listening: true, port, count: 0, error: null, lastMessage: null };
      broadcastDebug("status", debugStatus());
      resolve();
    };
    const onOpeningError = (error) => {
      receiver.off("ready", onReady);
      debugReceiver = null;
      debugState = { ...debugState, listening: false, port, error: error.message };
      reject(error);
    };
    receiver.once("ready", onReady);
    receiver.once("error", onOpeningError);
    receiver.open();
  });
  receiver.on("message", (message, _timeTag, info = {}) => {
    const entry = {
      timestamp: new Date().toISOString(),
      source: `${info.address || "unknown"}:${info.port || "?"}`,
      address: message.address,
      args: (message.args || []).map(serializableArgument),
    };
    debugState = { ...debugState, count: debugState.count + 1, lastMessage: entry };
    broadcastDebug("message", entry);
    broadcastDebug("status", debugStatus());
  });
  receiver.on("error", (error) => {
    debugState = { ...debugState, listening: false, error: error.message };
    broadcastDebug("status", debugStatus());
  });
  return debugStatus();
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

  if (request.method === "GET" && (url.pathname === "/styles.css" || url.pathname === "/debug.css")) {
    await serveBakedStyles(response, url.pathname.slice(1));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/debug/status") {
    sendJson(response, 200, { ok: true, ...debugStatus() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/debug/events") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    });
    response.write(`event: status\ndata: ${JSON.stringify(debugStatus())}\n\n`);
    debugEventClients.add(response);
    request.on("close", () => debugEventClients.delete(response));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/debug/listen") {
    try {
      const { port } = validateTarget({ host: "127.0.0.1", ...(await readJson(request)) });
      sendJson(response, 200, { ok: true, ...(await startDebugReceiver(port)) });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/debug/stop") {
    await stopDebugReceiver();
    broadcastDebug("status", debugStatus());
    sendJson(response, 200, { ok: true, ...debugStatus() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/debug/self-test") {
    if (!debugState.listening) {
      sendJson(response, 409, { ok: false, error: "Start the debug receiver first" });
      return;
    }
    udpPort.send({
      address: "/oscrnode/debug/test",
      args: [{ type: "s", value: "hello" }, { type: "f", value: 0.5 }, { type: "i", value: 1 }],
    }, "127.0.0.1", debugState.port);
    sendJson(response, 200, { ok: true });
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
    for (const client of debugEventClients) client.end();
    debugEventClients.clear();
    stopDebugReceiver().catch(() => {});
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
