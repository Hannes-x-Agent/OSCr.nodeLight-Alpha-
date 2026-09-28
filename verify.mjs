import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import osc from "osc";

const httpPort = 43175;
const udpPortNumber = 43800;
const debugPortNumber = 43802;
const externalUrl = process.env.OSC_SENDER_VERIFY_URL;
const baseUrl = externalUrl || `http://127.0.0.1:${httpPort}`;
let originalTarget = null;
const receiver = new osc.UDPPort({
  localAddress: "127.0.0.1",
  localPort: udpPortNumber,
  metadata: true,
});

const server = externalUrl
  ? null
  : spawn(process.execPath, ["server.mjs"], {
      cwd: new URL(".", import.meta.url),
      env: {
        ...process.env,
        OSC_SENDER_HTTP_PORT: String(httpPort),
        OSC_SENDER_TARGET_HOST: "127.0.0.1",
        OSC_SENDER_TARGET_PORT: String(udpPortNumber),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

const timeout = (label, duration = 5000) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), duration));

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("Server did not start");
}

async function waitForDebugPacket() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/debug/status`);
    const status = await response.json();
    if (status.count > 0 && status.lastMessage) return status;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("Debug receiver did not receive its self-test packet");
}

try {
  await Promise.race([
    new Promise((resolve, reject) => {
      receiver.on("ready", resolve);
      receiver.on("error", reject);
      receiver.open();
    }),
    timeout("UDP receiver"),
  ]);

  const status = await waitForServer();
  originalTarget = status.target;
  assert.equal(status.udpReady, true);

  const htmlResponse = await fetch(`${baseUrl}/`);
  assert.equal(htmlResponse.status, 200);
  assert.match(await htmlResponse.text(), /OSCrnode Light 0\.1A/);

  const fontResponse = await fetch(`${baseUrl}/fonts/Geist-Variable.woff2`);
  assert.equal(fontResponse.status, 200);
  assert.equal(fontResponse.headers.get("content-type"), "font/woff2");
  assert.ok((await fontResponse.arrayBuffer()).byteLength > 60_000);

  const stylesResponse = await fetch(`${baseUrl}/styles.css`);
  assert.equal(stylesResponse.status, 200);
  const styles = await stylesResponse.text();
  assert.match(styles, /data:font\/woff2;base64,/);
  assert.doesNotMatch(styles, /url\("\/fonts\/Geist-Variable\.woff2"\)/);

  const logoResponse = await fetch(`${baseUrl}/assets/OSCrnodeLightLogo.svg`);
  assert.equal(logoResponse.status, 200);
  const logo = await logoResponse.text();
  assert.doesNotMatch(logo, /data:font\/woff2;base64,/);
  assert.match(logo, /\.\.\/fonts\/Geist-Variable\.woff2/);

  const debugHtmlResponse = await fetch(`${baseUrl}/debug.html`);
  assert.equal(debugHtmlResponse.status, 200);
  assert.match(await debugHtmlResponse.text(), /OSC Debug Receiver/);
  const debugStyles = await (await fetch(`${baseUrl}/debug.css`)).text();
  assert.match(debugStyles, /data:font\/woff2;base64,/);

  const listenResponse = await fetch(`${baseUrl}/api/debug/listen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ port: debugPortNumber }),
  });
  assert.equal(listenResponse.status, 200);
  assert.equal((await listenResponse.json()).listening, true);
  const selfTestResponse = await fetch(`${baseUrl}/api/debug/self-test`, { method: "POST" });
  assert.equal(selfTestResponse.status, 200);
  const debugStatus = await waitForDebugPacket();
  assert.equal(debugStatus.lastMessage.address, "/oscrnode/debug/test");
  assert.deepEqual(debugStatus.lastMessage.args.map((argument) => argument.type), ["s", "f", "i"]);
  const stopDebugResponse = await fetch(`${baseUrl}/api/debug/stop`, { method: "POST" });
  assert.equal(stopDebugResponse.status, 200);
  assert.equal((await stopDebugResponse.json()).listening, false);

  const targetResponse = await fetch(`${baseUrl}/api/target`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: "127.0.0.1", port: udpPortNumber }),
  });
  assert.equal(targetResponse.status, 200);
  assert.deepEqual((await targetResponse.json()).target, { host: "127.0.0.1", port: udpPortNumber });

  const received = new Promise((resolve) => receiver.once("message", resolve));
  const webSocketPort = new osc.WebSocketPort({
    url: `${baseUrl.replace(/^http/, "ws")}/osc`,
    metadata: true,
  });

  await Promise.race([
    new Promise((resolve, reject) => {
      webSocketPort.on("ready", resolve);
      webSocketPort.on("error", reject);
      webSocketPort.open();
    }),
    timeout("WebSocket connection"),
  ]);

  webSocketPort.send({
    address: "/verify/value",
    args: [{ type: "f", value: 0.75 }],
  });

  const message = await Promise.race([received, timeout("OSC relay")]);
  assert.equal(message.address, "/verify/value");
  assert.equal(message.args[0].type, "f");
  assert.ok(Math.abs(message.args[0].value - 0.75) < 0.0001);

  webSocketPort.close();
  console.log("PASS: baked Geist UI, original SVG logo, OSC debug receiver, and browser -> UDP OSC bridge");
} finally {
  receiver.close();
  await fetch(`${baseUrl}/api/debug/stop`, { method: "POST" }).catch(() => {});
  if (externalUrl && originalTarget) {
    await fetch(`${baseUrl}/api/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(originalTarget),
    }).catch(() => {});
  }
  server?.kill("SIGTERM");
}
