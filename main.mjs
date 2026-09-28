import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";

const root = path.dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let debugWindow = null;
let bridge = null;
let bridgeUrl = null;
let quitting = false;

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

function createDebugWindow() {
  if (debugWindow && !debugWindow.isDestroyed()) {
    if (debugWindow.isMinimized()) debugWindow.restore();
    debugWindow.focus();
    return;
  }
  debugWindow = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 520,
    minHeight: 520,
    show: false,
    backgroundColor: "#ffffff",
    title: "OSCrnode OSC Debug Receiver",
    icon: path.join(root, "assets", "icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  debugWindow.loadURL(new URL("/debug.html", bridgeUrl).href);
  debugWindow.once("ready-to-show", () => debugWindow.show());
  debugWindow.on("closed", () => { debugWindow = null; });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 940,
    minWidth: 760,
    minHeight: 620,
    show: false,
    backgroundColor: "#f1efe9",
    title: "OSCrnode Light 0.1A",
    icon: path.join(root, "assets", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(bridgeUrl);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === new URL("/debug.html", bridgeUrl).href) {
      createDebugWindow();
      return { action: "deny" };
    }
    if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null);
    process.env.OSC_SENDER_HTTP_PORT = "0";
    process.env.OSCRNODE_LIGHT_STATE_FILE = path.join(app.getPath("userData"), "state.json");
    bridge = await import("./server.mjs");
    ({ url: bridgeUrl } = await bridge.serverReady);
    createWindow();
  } catch (error) {
    dialog.showErrorBox("OSCrnode Light 0.1A could not start", error.message);
    app.quit();
  }
});

app.on("activate", () => {
  if (!mainWindow && bridgeUrl) createWindow();
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", (event) => {
  if (!bridge || quitting) return;
  event.preventDefault();
  quitting = true;
  bridge.stopServer().finally(() => app.quit());
});
