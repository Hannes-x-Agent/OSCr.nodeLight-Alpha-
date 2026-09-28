import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import osc from "osc";
import WebSocket from "ws";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const httpPort = 43176;
const udpPortNumber = 43801;
const debugPort = 49227;
const externalUrl = process.env.OSC_SENDER_VERIFY_URL;
const baseUrl = externalUrl || `http://127.0.0.1:${httpPort}`;
const basePort = new URL(baseUrl).port;
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "oscrnode-light-verify-"));
const chromeProfile = path.join(temporaryRoot, "chrome");
const stateFile = path.join(temporaryRoot, "state.json");
const received = [];
let originalState = null;

const receiver = new osc.UDPPort({ localAddress: "127.0.0.1", localPort: udpPortNumber, metadata: true });
receiver.on("message", (message) => received.push(message));

const server = externalUrl
  ? null
  : spawn(process.execPath, ["server.mjs"], {
      cwd: new URL(".", import.meta.url),
      env: {
        ...process.env,
        OSC_SENDER_HTTP_PORT: String(httpPort),
        OSC_SENDER_TARGET_HOST: "127.0.0.1",
        OSC_SENDER_TARGET_PORT: String(udpPortNumber),
        OSCRNODE_LIGHT_STATE_FILE: stateFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--window-size=1500,1200",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${chromeProfile}`,
  baseUrl,
], { stdio: "ignore" });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function poll(action, label, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await action();
      if (result) return result;
    } catch {}
    await delay(100);
  }
  throw new Error(`${label} timed out`);
}

async function openCdp() {
  const page = await poll(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const pages = await response.json();
    return pages.find((entry) => entry.type === "page" && entry.url.includes(basePort));
  }, "Chrome page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  let commandId = 0;
  const pending = new Map();
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, call };
}

function lastMessage(address) {
  return received.filter((message) => message.address === address).at(-1);
}

function argumentValues(message) {
  return message.args.map((argument) => argument.value);
}

try {
  await new Promise((resolve, reject) => {
    receiver.once("ready", resolve);
    receiver.once("error", reject);
    receiver.open();
  });
  const status = await poll(async () => {
    const response = await fetch(`${baseUrl}/api/status`);
    return response.ok ? response.json() : null;
  }, "OSC server");
  const stateResponse = await fetch(`${baseUrl}/api/state`);
  originalState = (await stateResponse.json()).state;
  await fetch(`${baseUrl}/api/target`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: "127.0.0.1", port: udpPortNumber }),
  });
  assert.equal(status.udpReady, true);

  const { socket, call } = await openCdp();
  await call("Runtime.enable");
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await poll(async () => evaluate('document.body.dataset.connection === "connected"'), "UI connection");
  await evaluate(`(() => {
    document.querySelector('#targetHost').value = '127.0.0.1';
    document.querySelector('#targetPort').value = '${udpPortNumber}';
    document.querySelector('#targetForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  await delay(150);
  assert.equal(await evaluate(`document.fonts.ready.then(() => document.fonts.check('16px Geist'))`), true);
  assert.deepEqual(await evaluate(`(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    border: getComputedStyle(document.querySelector('.panel')).borderTopColor,
    logoLoaded: document.querySelector('.brand-logo').complete && document.querySelector('.brand-logo').naturalWidth > 0,
    logoWidth: document.querySelector('.brand-logo').getBoundingClientRect().width / document.body.getBoundingClientRect().width > 0.96,
    destinationCompact: document.querySelector('.destination').getBoundingClientRect().height < 150,
    destinationBackground: getComputedStyle(document.querySelector('.destination')).backgroundColor,
    destinationBorderWidth: getComputedStyle(document.querySelector('.destination')).borderTopWidth,
    addModuleBackground: getComputedStyle(document.querySelector('.add-module')).backgroundColor,
    addModuleBorderWidth: getComputedStyle(document.querySelector('.add-module')).borderTopWidth,
    destinationInputColor: getComputedStyle(document.querySelector('#targetHost')).color,
    logPosition: getComputedStyle(document.querySelector('.side-column')).position,
  }))()`), {
    background: "rgb(255, 255, 255)",
    border: "rgb(10, 10, 10)",
    logoLoaded: true,
    logoWidth: true,
    destinationCompact: true,
    destinationBackground: "rgb(255, 255, 255)",
    destinationBorderWidth: "2px",
    addModuleBackground: "rgb(255, 255, 255)",
    addModuleBorderWidth: "2px",
    destinationInputColor: "rgb(10, 10, 10)",
    logPosition: "sticky",
  });

  const logoSource = await (await fetch(`${baseUrl}/assets/OSCrnodeLightLogo.svg`)).text();
  assert.match(logoSource, /viewBox="0 0 1864\.55 305\.52"/);
  assert.match(logoSource, /\.cls-29 \{ fill: red; \}/);
  assert.match(logoSource, /data:font\/woff2;base64,/);
  assert.doesNotMatch(logoSource, /\.\.\/fonts\/Geist-Variable\.woff2/);

  assert.deepEqual(await evaluate(`(() => ({
    logoSource: new URL(document.querySelector('.brand-logo').src).pathname,
    connectionColor: getComputedStyle(document.querySelector('.connection')).color,
    liveColor: getComputedStyle(document.querySelector('.live-indicator')).color,
    deletionLabel: document.querySelector('#lockLabel').textContent,
    deleteDisplay: getComputedStyle(document.querySelector('[data-module-id="slider-volume"] .delete-button')).display,
    deviceCountMatches: document.querySelectorAll('#deviceList li').length === document.querySelectorAll('.module-card, .custom-card').length,
  }))()`), {
    logoSource: "/assets/OSCrnodeLightLogo.svg",
    connectionColor: "rgb(0, 168, 60)",
    liveColor: "rgb(0, 168, 60)",
    deletionLabel: "Deletion locked",
    deleteDisplay: "none",
    deviceCountMatches: true,
  });

  const lockAndCollapse = await evaluate(`(() => {
    const card = document.querySelector('[data-module-id="slider-volume"]');
    const title = card.querySelector('.module-title');
    const address = card.querySelector('.osc-address');
    const slider = card.querySelector('.osc-slider');
    const settingsLock = card.querySelector('.settings-lock-button');
    const controlLock = card.querySelector('.control-lock-button');
    const positionLock = card.querySelector('.module-lock-button');
    const collapse = card.querySelector('.collapse-button');
    document.querySelector('#titleLockButton').click();
    const deleteUnlocked = getComputedStyle(card.querySelector('.delete-button')).display;
    document.querySelector('#titleLockButton').click();
    settingsLock.click();
    const settings = {
      titleReadOnly: title.readOnly,
      addressDisabled: address.disabled,
      background: getComputedStyle(card).backgroundColor,
      sliderDisabled: slider.disabled,
      lockBorder: getComputedStyle(settingsLock).borderTopWidth,
    };
    settingsLock.click();
    controlLock.click();
    const control = {
      sliderDisabled: slider.disabled,
      background: getComputedStyle(card).backgroundColor,
      cardColor: getComputedStyle(card).color,
      lockColor: getComputedStyle(controlLock).color,
      lockBorder: getComputedStyle(controlLock).borderTopWidth,
    };
    controlLock.click();
    positionLock.click();
    const position = {
      dragDisabled: card.querySelector('.drag-handle').disabled,
      background: getComputedStyle(card).backgroundColor,
      color: getComputedStyle(card).color,
      border: getComputedStyle(card).borderTopColor,
      nextToDrag: card.querySelector('.drag-handle').nextElementSibling === positionLock,
      lockBorder: getComputedStyle(positionLock).borderTopWidth,
    };
    positionLock.click();
    settingsLock.click();
    controlLock.click();
    positionLock.click();
    const allLocked = {
      background: getComputedStyle(card).backgroundColor,
      color: getComputedStyle(card).color,
      contentOpacity: getComputedStyle(card.querySelector('.address-label')).opacity,
    };
    settingsLock.click();
    controlLock.click();
    positionLock.click();
    collapse.click();
    const collapsed = {
      addressDisplay: getComputedStyle(card.querySelector('.address-label')).display,
      sliderDisplay: getComputedStyle(slider).display,
      expanded: collapse.getAttribute('aria-expanded'),
      arrowIsLast: card.querySelector('.module-tools').lastElementChild === collapse,
    };
    collapse.click();
    return { deleteUnlocked, settings, control, position, allLocked, collapsed };
  })()`);
  assert.deepEqual(lockAndCollapse, {
    deleteUnlocked: "grid",
    settings: { titleReadOnly: true, addressDisabled: true, background: "rgb(10, 10, 10)", sliderDisabled: false, lockBorder: "0px" },
    control: { sliderDisabled: true, background: "rgb(255, 0, 0)", cardColor: "rgb(255, 255, 255)", lockColor: "rgb(255, 255, 255)", lockBorder: "0px" },
    position: { dragDisabled: true, background: "rgb(255, 255, 255)", color: "rgb(10, 10, 10)", border: "rgb(225, 6, 0)", nextToDrag: true, lockBorder: "0px" },
    allLocked: { background: "rgb(255, 0, 0)", color: "rgb(255, 255, 255)", contentOpacity: "0.62" },
    collapsed: { addressDisplay: "none", sliderDisplay: "inline-block", expanded: "false", arrowIsLast: true },
  });

  assert.equal(await evaluate(`(async () => {
    const cards = [...document.querySelectorAll('.module-card')];
    const before = new Map(cards.map((card) => [card.dataset.moduleId, card.getBoundingClientRect().top]));
    document.querySelector('[data-module-id="slider-volume"] .collapse-button').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const movedUp = cards.some((card) => card.dataset.moduleId !== 'slider-volume' && card.getBoundingClientRect().top < before.get(card.dataset.moduleId) - 20);
    document.querySelector('[data-module-id="slider-volume"] .collapse-button').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return movedUp;
  })()`), true);

  assert.equal(await evaluate(`(() => {
    const source = document.querySelector('[data-module-id="slider-volume"] .drag-handle');
    const target = document.querySelector('[data-module-id="slider-pan"]');
    const bounds = target.getBoundingClientRect();
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.right - 2, clientY: bounds.top + bounds.height / 2 }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.right - 2, clientY: bounds.top + bounds.height / 2 }));
    return [...document.querySelectorAll('.module-card')].slice(0, 2).map((card) => card.dataset.moduleId).join(',');
  })()`), "slider-pan,slider-volume");

  await call("Emulation.setDeviceMetricsOverride", { width: 640, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.modules-grid')).gridTemplateColumns.split(' ').length`), 1);
  await call("Emulation.clearDeviceMetricsOverride");

  assert.deepEqual(await evaluate(`(async () => {
    document.querySelector('#zoomOutButton').click();
    document.querySelector('#zoomOutButton').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const cards = [...document.querySelectorAll('.module-card')];
    let overlap = false;
    for (let index = 0; index < cards.length; index += 1) {
      const first = cards[index].getBoundingClientRect();
      for (let other = index + 1; other < cards.length; other += 1) {
        const second = cards[other].getBoundingClientRect();
        const horizontalIntersection = Math.min(first.right, second.right) - Math.max(first.left, second.left);
        if (horizontalIntersection > 5 && !(first.bottom + 5 <= second.top || second.bottom + 5 <= first.top)) overlap = true;
      }
    }
    const slider = document.querySelector('[data-module-id="slider-volume"] .osc-slider').getBoundingClientRect();
    const sliderCard = document.querySelector('[data-module-id="slider-volume"]').getBoundingClientRect();
    const result = {
      zoom: document.querySelector('#zoomValue').value,
      noOverlap: !overlap,
      sliderVisible: slider.width > 100 && slider.height > 0 && slider.bottom <= sliderCard.bottom,
      rowGap: getComputedStyle(document.querySelector('.modules-grid')).rowGap,
    };
    document.querySelector('#zoomInButton').click();
    document.querySelector('#zoomInButton').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return result;
  })()`), { zoom: "80%", noOverlap: true, sliderVisible: true, rowGap: "10px" });

  const initialLogVisible = await evaluate(`!document.body.classList.contains('log-hidden')`);
  await evaluate(`(() => {
    const title = document.querySelector('[data-module-id="slider-volume"] .module-title');
    if (title.readOnly) document.querySelector('[data-module-id="slider-volume"] .settings-lock-button').click();
    title.value = 'Main Level';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#zoomInButton').click();
    document.querySelector('#logToggleButton').click();
  })()`);
  assert.equal(await evaluate(`document.querySelector('[data-module-id="slider-volume"] .module-title').readOnly`), false);
  assert.equal(await evaluate(`!document.body.classList.contains('log-hidden')`), !initialLogVisible);
  await evaluate(`document.querySelector('#logToggleButton').click()`);
  const expectedZoomLabel = await evaluate(`document.querySelector('#zoomValue').value`);
  const expectedZoom = Number.parseInt(expectedZoomLabel, 10) / 100;
  const expectedLogVisible = await evaluate(`!document.body.classList.contains('log-hidden')`);
  assert.equal(expectedLogVisible, initialLogVisible);

  const sliderStart = received.length;
  await evaluate(`(() => {
    const card = document.querySelector('[data-module-id="slider-volume"]');
    const set = (selector, value) => {
      const control = card.querySelector(selector);
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('.osc-address', '/verify/slider');
    set('.range-min', '-10');
    set('.range-max', '10');
    set('.range-step', '0.5');
    set('.direct-value', '3.5');
  })()`);
  await delay(150);
  const sliderMessage = received.slice(sliderStart).find((message) => message.address === "/verify/slider");
  assert.ok(sliderMessage, "typed slider value was not sent");
  assert.equal(sliderMessage.args[0].type, "f");
  assert.ok(Math.abs(sliderMessage.args[0].value - 3.5) < 0.001);
  assert.deepEqual(await evaluate(`(() => {
    const item = document.querySelector('#deviceList [data-device-id="slider-volume"]');
    return {
      state: item.querySelector('.device-state').textContent,
      value: item.querySelector('.device-value').textContent,
      dot: getComputedStyle(item.querySelector('.device-status-dot')).backgroundColor,
      destination: document.querySelector('#destinationDevice .device-state').textContent,
    };
  })()`), { state: "Sending", value: "3.5", dot: "rgb(0, 168, 60)", destination: "Sending" });

  await evaluate(`(() => {
    const card = document.querySelector('[data-module-id="xy-double"]');
    const set = (selector, value, index = 0) => {
      const control = card.querySelectorAll(selector)[index];
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('.osc-address', '/verify/four');
    set('.osc-type', 'i');
    set('.scale-min', '-10');
    set('.scale-max', '10');
    ['left_x', 'left_y', 'right_x', 'right_y'].forEach((name, index) => set('.value-name-grid input', name, index));
    set('.pair-name-grid input', 'left', 0);
    set('.pair-name-grid input', 'right', 1);
    set('.coordinate-readout input', '-4', 0);
    set('.coordinate-readout input', '-2', 1);
    set('.coordinate-readout input', '6', 2);
    set('.coordinate-readout input', '8', 3);
  })()`);
  await delay(150);
  const together = lastMessage("/verify/four");
  assert.ok(together, "four-value together packet was not received");
  assert.deepEqual(together.args.map((argument) => argument.type), ["i", "i", "i", "i"]);
  assert.deepEqual(argumentValues(together), [-4, -2, 6, 8]);

  await evaluate(`(() => {
    const card = document.querySelector('[data-module-id="xy-double"]');
    const mode = card.querySelector('.output-mode');
    mode.value = 'paired';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    const input = card.querySelectorAll('.coordinate-readout input')[0];
    input.value = '-3';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await delay(150);
  assert.deepEqual(argumentValues(lastMessage("/verify/four/left")), [-3, -2]);
  assert.deepEqual(argumentValues(lastMessage("/verify/four/right")), [6, 8]);

  await evaluate(`(() => {
    const card = document.querySelector('[data-module-id="xy-double"]');
    const mode = card.querySelector('.output-mode');
    mode.value = 'individual';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    const input = card.querySelectorAll('.coordinate-readout input')[1];
    input.value = '-1';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await delay(150);
  for (const suffix of ["left_x", "left_y", "right_x", "right_y"]) {
    assert.ok(lastMessage(`/verify/four/${suffix}`), `individual ${suffix} packet was not received`);
  }

  const presetResult = await evaluate(`(() => {
    const card = document.querySelector('[data-module-id="xy-double"]');
    if (card.querySelector('.settings-lock-button').getAttribute('aria-pressed') === 'true') card.querySelector('.settings-lock-button').click();
    if (card.querySelector('.control-lock-button').getAttribute('aria-pressed') === 'true') card.querySelector('.control-lock-button').click();
    const store = card.querySelector('.store-button');
    store.click();
    const storeArmed = store.getAttribute('aria-pressed');
    card.querySelector('[data-preset="0"]').click();
    const input = card.querySelectorAll('.coordinate-readout input')[0];
    input.value = '5';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    card.querySelector('[data-preset="0"]').click();
    const single = document.querySelector('[data-module-id="xy-single"]');
    if (single.querySelector('.settings-lock-button').getAttribute('aria-pressed') === 'true') single.querySelector('.settings-lock-button').click();
    if (single.querySelector('.control-lock-button').getAttribute('aria-pressed') === 'true') single.querySelector('.control-lock-button').click();
    single.querySelector('.store-button').click();
    single.querySelector('[data-preset="1"]').click();
    return { storeArmed, recalled: card.querySelector('.coordinate-readout input').value };
  })()`);
  assert.deepEqual(presetResult, { storeArmed: "true", recalled: "-3" });

  const initialCustomCount = await evaluate(`document.querySelectorAll('.custom-card').length`);
  const verificationModuleTitle = `Verification slider ${Date.now()}`;
  await evaluate(`(() => {
    const form = document.querySelector('#addModuleForm');
    document.querySelector('#newModuleType').value = 'slider';
    document.querySelector('#newModuleTitle').value = ${JSON.stringify(verificationModuleTitle)};
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    document.querySelector('#addCustomButton').click();
  })()`);
  await delay(500);
  assert.equal(await evaluate(`[...document.querySelectorAll('.module-title')].some((input) => input.value === ${JSON.stringify(verificationModuleTitle)})`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.custom-card').length`), initialCustomCount + 1);

  const persisted = await poll(async () => {
    const response = await fetch(`${baseUrl}/api/state`, { cache: "no-store" });
    const result = await response.json();
    return result.state?.modules?.some((module) => module.title === verificationModuleTitle) ? result.state : null;
  }, "persistent state");
  assert.equal(persisted.zoom, expectedZoom);
  assert.equal(persisted.logVisible, expectedLogVisible);
  assert.equal(persisted.modules.find((module) => module.id === "slider-volume").title, "Main Level");
  assert.deepEqual(persisted.modules.slice(0, 2).map((module) => module.id), ["slider-pan", "slider-volume"]);
  assert.equal(persisted.modules.find((module) => module.id === "slider-volume").locked, false);
  assert.equal(persisted.modules.find((module) => module.id === "slider-volume").settingsLocked, false);
  assert.equal(persisted.modules.find((module) => module.id === "slider-volume").controlLocked, false);
  assert.equal(persisted.modules.find((module) => module.id === "slider-volume").collapsed, false);
  assert.deepEqual(persisted.modules.find((module) => module.id === "xy-double").valueNames, ["left_x", "left_y", "right_x", "right_y"]);
  assert.ok(persisted.modules.find((module) => module.id === "xy-double").presets[0]);
  assert.ok(persisted.modules.find((module) => module.id === "xy-single").presets[1]);
  assert.equal(persisted.customSends.length, initialCustomCount + 1);

  await evaluate(`window.__oscrnodeVerifyBeforeReload = true`);
  await call("Page.reload", { ignoreCache: true });
  await poll(async () => evaluate(`
    window.__oscrnodeVerifyBeforeReload !== true &&
    document.body.dataset.connection === 'connected' &&
    document.querySelector('[data-module-id="slider-volume"] .module-title')?.value === 'Main Level'
  `), "reloaded UI");
  assert.equal(await evaluate(`document.querySelector('[data-module-id="slider-volume"] .module-title').value`), "Main Level");
  assert.equal(await evaluate(`document.querySelector('#zoomValue').value`), expectedZoomLabel);
  assert.equal(await evaluate(`[...document.querySelectorAll('.module-title')].some((input) => input.value === ${JSON.stringify(verificationModuleTitle)})`), true);
  assert.equal(await evaluate(`document.querySelector('[data-module-id="xy-double"] [data-preset="0"]').classList.contains('has-value')`), true);

  socket.close();
  console.log("PASS: zoom-safe masonry, visible sliders, minimal locks, drag order, collapse, device activity, persistence, and OSC modes");
} finally {
  receiver.close();
  const waitForExit = (child) => new Promise((resolve) => {
    if (!child || child.exitCode !== null) resolve();
    else {
      child.once("exit", resolve);
      setTimeout(resolve, 2000);
    }
  });
  chrome.kill("SIGTERM");
  server?.kill("SIGTERM");

  if (externalUrl) {
    if (originalState) {
      await fetch(`${baseUrl}/api/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: originalState }),
      }).catch(() => {});
    } else {
      await fetch(`${baseUrl}/api/state`, { method: "DELETE" }).catch(() => {});
    }
  }
  await Promise.all([waitForExit(chrome), waitForExit(server)]);
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
