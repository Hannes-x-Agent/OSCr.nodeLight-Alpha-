const connectionButton = document.querySelector("#connectionButton");
const connectionLabel = document.querySelector("#connectionLabel");
const targetForm = document.querySelector("#targetForm");
const targetHost = document.querySelector("#targetHost");
const targetPort = document.querySelector("#targetPort");
const addModuleForm = document.querySelector("#addModuleForm");
const newModuleType = document.querySelector("#newModuleType");
const newModuleTitle = document.querySelector("#newModuleTitle");
const modulesContainer = document.querySelector("#modulesContainer");
const customContainer = document.querySelector("#customContainer");
const addCustomButton = document.querySelector("#addCustomButton");
const activityLog = document.querySelector("#activityLog");
const deviceList = document.querySelector("#deviceList");
const deviceCount = document.querySelector("#deviceCount");
const destinationDevice = document.querySelector("#destinationDevice");
const destinationEndpoint = document.querySelector("#destinationEndpoint");
const titleLockButton = document.querySelector("#titleLockButton");
const lockIcon = document.querySelector("#lockIcon");
const lockLabel = document.querySelector("#lockLabel");
const zoomValue = document.querySelector("#zoomValue");
const logToggleButton = document.querySelector("#logToggleButton");
const saveStatus = document.querySelector("#saveStatus");
const debugReceiverButton = document.querySelector("#debugReceiverButton");

let oscPort = null;
let connectionState = "disconnected";
let deletionUnlocked = false;
let saveTimer = null;
let idCounter = 0;
let state = null;
let draggedModuleId = null;
let moduleLayoutFrame = null;
let destinationPulseTimer = null;
const devicePulseTimers = new Map();

function scheduleModuleLayout() {
  cancelAnimationFrame(moduleLayoutFrame);
  moduleLayoutFrame = requestAnimationFrame(() => {
    const styles = getComputedStyle(modulesContainer);
    const rowHeight = Number.parseFloat(styles.gridAutoRows) || 4;
    const rowGap = Number.parseFloat(styles.rowGap) || 4;
    modulesContainer.querySelectorAll(".module-card").forEach((card) => {
      const height = card.offsetHeight;
      card.style.gridRowEnd = `span ${Math.max(1, Math.ceil((height + rowGap) / (rowHeight + rowGap)))}`;
    });
  });
}

const moduleResizeObserver = new ResizeObserver(scheduleModuleLayout);
window.addEventListener("resize", scheduleModuleLayout);

function makeId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

function makeSlider(title, address, min = 0, max = 1, step = 0.01, value = 0.5, id = makeId("slider")) {
  return { id, type: "slider", title, address, oscType: "f", min, max, step, value, locked: false, settingsLocked: false, controlLocked: false, collapsed: false };
}

function makeButton(type, title, address, id = makeId(type)) {
  return {
    id,
    type,
    title,
    address,
    oscType: "i",
    offValue: 0,
    onValue: 1,
    active: false,
    locked: false,
    settingsLocked: false,
    controlLocked: false,
    collapsed: false,
  };
}

function makeXY(type, title, address, id = makeId(type)) {
  const pointCount = type === "xy2" ? 2 : 1;
  return {
    id,
    type,
    title,
    address,
    oscType: "f",
    scaleMin: 0,
    scaleMax: 1,
    outputMode: "together",
    points: pointCount === 1 ? [[0.5, 0.5]] : [[0.25, 0.25], [0.75, 0.75]],
    valueNames: pointCount === 1 ? ["x", "y"] : ["x1", "y1", "x2", "y2"],
    pairNames: ["a", "b"],
    presets: [null, null, null, null],
    locked: false,
    settingsLocked: false,
    controlLocked: false,
    collapsed: false,
  };
}

function makeCustom(title = "Custom send", id = makeId("custom")) {
  return { id, title, address: "/custom/value", oscType: "f", value: "0.5" };
}

function defaultState() {
  return {
    schema: 1,
    zoom: 1,
    logVisible: true,
    target: { host: "127.0.0.1", port: 8000 },
    modules: [
      makeSlider("Volume", "/mixer/volume", 0, 1, 0.01, 0.75, "slider-volume"),
      makeSlider("Pan", "/mixer/pan", -1, 1, 0.01, 0, "slider-pan"),
      makeSlider("Effect", "/effect/amount", 0, 1, 0.01, 0.25, "slider-effect"),
      makeSlider("Speed", "/transport/speed", 0, 2, 0.01, 1, "slider-speed"),
      makeXY("xy1", "Single point", "/position/xy", "xy-single"),
      makeXY("xy2", "Two points", "/position/two-point", "xy-double"),
      makeButton("trigger", "Play", "/transport/play", "button-play"),
      makeButton("trigger", "Stop", "/transport/stop", "button-stop"),
      makeButton("toggle", "Mute", "/mixer/mute", "button-mute"),
    ],
    customSends: [makeCustom("Custom send", "custom-1")],
  };
}

function hydrateModule(module) {
  if (!module || typeof module !== "object") return null;
  if (module.type === "slider") return { ...makeSlider("Slider", "/slider"), ...module };
  if (module.type === "trigger" || module.type === "toggle") return { ...makeButton(module.type, "Button", "/button"), ...module };
  if (module.type === "xy1" || module.type === "xy2") {
    const hydrated = { ...makeXY(module.type, "XY pad", "/xy"), ...module };
    const expectedValues = module.type === "xy2" ? 4 : 2;
    const expectedPoints = module.type === "xy2" ? 2 : 1;
    hydrated.points = Array.isArray(module.points) && module.points.length === expectedPoints ? module.points : makeXY(module.type, "", "").points;
    hydrated.valueNames = Array.isArray(module.valueNames) && module.valueNames.length === expectedValues ? module.valueNames : makeXY(module.type, "", "").valueNames;
    hydrated.pairNames = Array.isArray(module.pairNames) && module.pairNames.length === 2 ? module.pairNames : ["a", "b"];
    hydrated.presets = Array.from({ length: 4 }, (_, index) => Array.isArray(module.presets?.[index]) ? module.presets[index] : null);
    return hydrated;
  }
  return null;
}

function hydrateState(saved) {
  const defaults = defaultState();
  if (!saved || typeof saved !== "object") return defaults;
  const modules = Array.isArray(saved.modules) ? saved.modules.map(hydrateModule).filter(Boolean) : defaults.modules;
  const customSends = Array.isArray(saved.customSends)
    ? saved.customSends.map((custom) => ({ ...makeCustom(), ...custom }))
    : defaults.customSends;
  return {
    ...defaults,
    ...saved,
    target: { ...defaults.target, ...(saved.target || {}) },
    modules,
    customSends,
  };
}

async function loadState() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load state");
    return hydrateState(result.state);
  } catch (error) {
    addLog("error", "State", error.message);
    return defaultState();
  }
}

async function persistState() {
  if (!state) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveStatus.textContent = "Saving…";
  saveStatus.classList.add("saving");
  try {
    const response = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (!response.ok) throw new Error("Save failed");
    saveStatus.textContent = "Saved";
    saveStatus.classList.remove("saving");
  } catch (error) {
    saveStatus.textContent = "Not saved";
    saveStatus.classList.add("saving");
    addLog("error", "State", error.message);
  }
}

function scheduleSave(delay = 180) {
  clearTimeout(saveTimer);
  saveStatus.textContent = "Unsaved";
  saveStatus.classList.add("saving");
  saveTimer = setTimeout(persistState, delay);
}

function setConnectionState(nextState, label) {
  connectionState = nextState;
  document.body.dataset.connection = nextState;
  connectionLabel.textContent = label;
  const destinationState = destinationDevice.querySelector(".device-state");
  if (nextState !== "connected") destinationState.textContent = nextState === "connecting" ? "Opening" : "Offline";
  else if (!destinationDevice.classList.contains("is-sending")) destinationState.textContent = "Ready";
}

function deviceDescriptors() {
  if (!state) return [];
  return [
    ...state.modules.map((module) => ({ id: module.id, title: module.title, address: normalizedAddress(module.address) })),
    ...state.customSends.map((custom) => ({ id: custom.id, title: custom.title, address: normalizedAddress(custom.address) })),
  ];
}

function renderDevices() {
  if (!state) return;
  devicePulseTimers.forEach(clearTimeout);
  devicePulseTimers.clear();
  const devices = deviceDescriptors();
  deviceCount.textContent = String(devices.length);
  destinationEndpoint.textContent = `${state.target.host}:${state.target.port}`;
  deviceList.replaceChildren();
  devices.forEach((device) => {
    const item = document.createElement("li");
    item.dataset.deviceId = device.id;
    item.innerHTML = '<span class="device-status-dot" aria-hidden="true"></span><div><strong></strong><code></code></div><span class="device-state">Idle</span><span class="device-value">No output yet</span>';
    item.querySelector("strong").textContent = device.title;
    item.querySelector("code").textContent = device.address;
    deviceList.append(item);
  });
}

function pulseDevice(address, value) {
  destinationDevice.classList.add("is-sending");
  destinationDevice.querySelector(".device-state").textContent = "Sending";
  clearTimeout(destinationPulseTimer);
  destinationPulseTimer = setTimeout(() => {
    destinationDevice.classList.remove("is-sending");
    destinationDevice.querySelector(".device-state").textContent = connectionState === "connected" ? "Ready" : "Offline";
  }, 1400);

  const normalized = normalizedAddress(address);
  const device = deviceDescriptors()
    .filter((candidate) => normalized === candidate.address || normalized.startsWith(`${candidate.address.replace(/\/+$/, "")}/`))
    .sort((a, b) => b.address.length - a.address.length)[0];
  if (!device) return;
  const item = [...deviceList.children].find((candidate) => candidate.dataset.deviceId === device.id);
  if (!item) return;
  item.classList.add("is-sending");
  item.querySelector(".device-state").textContent = "Sending";
  item.querySelector(".device-value").textContent = String(value);
  clearTimeout(devicePulseTimers.get(device.id));
  devicePulseTimers.set(device.id, setTimeout(() => {
    item.classList.remove("is-sending");
    item.querySelector(".device-state").textContent = "Idle";
    devicePulseTimers.delete(device.id);
  }, 1400));
}

function addLog(kind, address, value) {
  activityLog.querySelector(".empty-log")?.remove();
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString([], { hour12: false });
  item.innerHTML = `<time></time><code></code><span class="log-value"></span>`;
  item.querySelector("time").textContent = time;
  item.querySelector("code").textContent = address;
  item.querySelector(".log-value").textContent = `${kind} ${value}`;
  activityLog.prepend(item);
  while (activityLog.children.length > 120) activityLog.lastElementChild.remove();
}

function showEmptyLog() {
  activityLog.innerHTML = '<li class="empty-log">No messages sent yet.</li>';
}

function normalizedAddress(value) {
  let address = String(value || "").trim();
  if (address && !address.startsWith("/")) address = `/${address}`;
  return address;
}

function validAddress(address) {
  return Boolean(address) && !/\s/.test(address);
}

function suffixName(value, fallback) {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\s+/g, "_")
    .replace(/[#,?*\[\]{}]/g, "");
  return cleaned || fallback;
}

function addressWithSuffix(base, suffix) {
  return `${normalizedAddress(base).replace(/\/+$/, "")}/${suffixName(suffix, "value")}`;
}

function connect() {
  if (connectionState === "connected" || connectionState === "connecting") return;
  setConnectionState("connecting", "Connecting…");
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  oscPort = new osc.WebSocketPort({ url: `${protocol}://${window.location.host}/osc`, metadata: true });
  oscPort.on("ready", () => {
    setConnectionState("connected", "Connected");
    addLog("status", "WebSocket", "connected");
  });
  oscPort.on("close", () => {
    oscPort = null;
    setConnectionState("disconnected", "Connect");
  });
  oscPort.on("error", (error) => {
    setConnectionState("error", "Connection error");
    addLog("error", "WebSocket", error.message || "connection failed");
  });
  oscPort.open();
}

function disconnect() {
  oscPort?.close();
  oscPort = null;
  setConnectionState("disconnected", "Connect");
}

function sendPacket(addressValue, args, summary = args.map((argument) => argument.value).join(", ")) {
  const address = normalizedAddress(addressValue);
  if (connectionState !== "connected" || !oscPort) {
    addLog("blocked", address || "(empty address)", "connect first");
    return false;
  }
  if (!validAddress(address)) {
    addLog("error", address || "(empty address)", "invalid OSC address");
    return false;
  }
  if (args.some((argument) => argument.type !== "s" && !Number.isFinite(argument.value))) {
    addLog("error", address, "invalid value");
    return false;
  }
  oscPort.send({ address, args });
  addLog(`sent ,${args.map((argument) => argument.type).join("")}`, address, summary);
  pulseDevice(address, summary);
  return true;
}

function typedValue(type, rawValue) {
  const value = Number(rawValue);
  return type === "i" ? Math.round(value) : value;
}

function sendValue(address, type, rawValue) {
  const value = type === "s" ? String(rawValue) : typedValue(type, rawValue);
  return sendPacket(address, [{ type, value }], String(value));
}

async function applyTarget(host, port, announce = true) {
  const response = await fetch("/api/target", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host, port }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not update target");
  if (announce) addLog("target", `${result.target.host}:${result.target.port}`, "applied");
  return result.target;
}

function uniqueTitle(requested, collection) {
  const base = String(requested || "New module").trim() || "New module";
  const used = new Set(collection.map((item) => item.title.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  let index = 2;
  while (used.has(`${base} ${index}`.toLowerCase())) index += 1;
  return `${base} ${index}`;
}

function typeLabel(type) {
  return {
    slider: "Slider",
    trigger: "Trigger button",
    toggle: "Toggle button",
    xy1: "Single-point XY",
    xy2: "Two-point XY",
  }[type] || type;
}

function createBaseCard(module, extraClass = "") {
  const card = document.createElement("article");
  card.className = `module-card panel ${extraClass}`.trim();
  card.dataset.moduleId = module.id;
  card.innerHTML = `
    <div class="module-heading">
      <div class="move-tools">
        <button class="drag-handle" type="button" aria-label="Drag to move module" title="Drag to move module">
          <span aria-hidden="true">⠿</span>
        </button>
        <button class="module-lock-button" type="button" aria-label="Lock module position" title="Lock module position">
          <svg class="unlocked-icon" aria-hidden="true" viewBox="0 0 16 16"><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.17-1.3M3.5 7.25h9v6h-9z" /></svg>
          <svg class="locked-icon" aria-hidden="true" viewBox="0 0 16 16"><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7M3.5 7.25h9v6h-9z" /></svg>
        </button>
      </div>
      <div class="module-title-wrap">
        <input class="module-title" aria-label="Module title" />
        <span class="module-type"></span>
      </div>
      <div class="module-tools">
        <button class="settings-lock-button red-lock-button" type="button" aria-label="Lock module parameters" title="Lock module parameters">
          <span class="lock-letter" aria-hidden="true">P</span><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7M3.5 7.25h9v6h-9z" /></svg>
        </button>
        <button class="control-lock-button red-lock-button" type="button" aria-label="Lock live control" title="Lock live control">
          <span class="lock-letter" aria-hidden="true">C</span><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7M3.5 7.25h9v6h-9z" /></svg>
        </button>
        <button class="delete-button" type="button" aria-label="Delete module">×</button>
        <button class="collapse-button" type="button" aria-label="Collapse module" title="Collapse module">
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m3.5 10 4.5-4 4.5 4" /></svg>
        </button>
      </div>
    </div>
    <label class="address-label module-detail"><span>OSC address</span><input class="osc-address" spellcheck="false" /></label>
  `;
  const title = card.querySelector(".module-title");
  title.value = module.title;
  title.readOnly = Boolean(module.settingsLocked);
  card.querySelector(".module-type").textContent = typeLabel(module.type);
  const address = card.querySelector(".osc-address");
  const dragHandle = card.querySelector(".drag-handle");
  const collapseButton = card.querySelector(".collapse-button");
  const settingsLockButton = card.querySelector(".settings-lock-button");
  const controlLockButton = card.querySelector(".control-lock-button");
  const lockButton = card.querySelector(".module-lock-button");
  address.value = module.address;

  function applyModulePresentation() {
    card.classList.toggle("is-locked", Boolean(module.locked));
    card.classList.toggle("is-settings-locked", Boolean(module.settingsLocked));
    card.classList.toggle("is-control-locked", Boolean(module.controlLocked));
    card.classList.toggle("is-all-locked", Boolean(module.locked && module.settingsLocked && module.controlLocked));
    card.classList.toggle("is-collapsed", Boolean(module.collapsed));
    dragHandle.draggable = !module.locked;
    dragHandle.disabled = Boolean(module.locked);
    dragHandle.title = module.locked ? "Unlock this module before moving it" : "Drag to move module";
    collapseButton.setAttribute("aria-expanded", String(!module.collapsed));
    collapseButton.setAttribute("aria-label", module.collapsed ? "Expand module" : "Collapse module");
    collapseButton.title = module.collapsed ? "Expand module" : "Collapse module";
    lockButton.setAttribute("aria-pressed", String(Boolean(module.locked)));
    lockButton.setAttribute("aria-label", module.locked ? "Unlock module position" : "Lock module position");
    lockButton.title = module.locked ? "Unlock module position" : "Lock module position";
    settingsLockButton.setAttribute("aria-pressed", String(Boolean(module.settingsLocked)));
    settingsLockButton.setAttribute("aria-label", module.settingsLocked ? "Unlock module parameters" : "Lock module parameters");
    settingsLockButton.title = module.settingsLocked ? "Unlock module parameters" : "Lock module parameters";
    controlLockButton.setAttribute("aria-pressed", String(Boolean(module.controlLocked)));
    controlLockButton.setAttribute("aria-label", module.controlLocked ? "Unlock live control" : "Lock live control");
    controlLockButton.title = module.controlLocked ? "Unlock live control" : "Lock live control";

    title.readOnly = Boolean(module.settingsLocked);
    card.querySelectorAll(".address-label input, .module-settings input, .module-settings select, .value-name-grid input, .pair-name-grid input").forEach((control) => {
      control.disabled = Boolean(module.settingsLocked);
    });
    card.querySelectorAll(".osc-slider, .direct-value, .button-module-action, .coordinate-readout input").forEach((control) => {
      control.disabled = Boolean(module.controlLocked);
    });
    const pad = card.querySelector(".xy-pad");
    if (pad) {
      pad.setAttribute("aria-disabled", String(Boolean(module.controlLocked)));
      pad.tabIndex = module.controlLocked ? -1 : 0;
    }
    card.querySelectorAll(".preset-row button").forEach((control) => {
      control.disabled = Boolean(module.settingsLocked || module.controlLocked);
    });
  }
  card.applyModulePresentation = applyModulePresentation;

  title.addEventListener("input", () => {
    module.title = title.value;
    renderDevices();
    scheduleSave();
  });
  address.addEventListener("change", () => {
    module.address = normalizedAddress(address.value);
    address.value = module.address;
    address.classList.toggle("invalid", !validAddress(module.address));
    scheduleSave();
    renderDevices();
    card.dispatchEvent(new CustomEvent("addresschange"));
  });
  collapseButton.addEventListener("click", () => {
    module.collapsed = !module.collapsed;
    applyModulePresentation();
    scheduleModuleLayout();
    scheduleSave(0);
  });
  settingsLockButton.addEventListener("click", () => {
    module.settingsLocked = !module.settingsLocked;
    applyModulePresentation();
    scheduleSave(0);
  });
  controlLockButton.addEventListener("click", () => {
    module.controlLocked = !module.controlLocked;
    applyModulePresentation();
    scheduleSave(0);
  });
  lockButton.addEventListener("click", () => {
    module.locked = !module.locked;
    applyModulePresentation();
    scheduleSave(0);
  });
  dragHandle.addEventListener("dragstart", (event) => {
    if (module.locked) {
      event.preventDefault();
      return;
    }
    draggedModuleId = module.id;
    card.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", module.id);
  });
  dragHandle.addEventListener("dragend", () => {
    draggedModuleId = null;
    card.classList.remove("is-dragging");
    modulesContainer.querySelectorAll(".drop-before, .drop-after").forEach((item) => item.classList.remove("drop-before", "drop-after"));
  });
  card.querySelector(".delete-button").addEventListener("click", () => {
    if (!deletionUnlocked) return;
    if (!window.confirm(`Delete “${module.title}”?`)) return;
    state.modules = state.modules.filter((item) => item.id !== module.id);
    renderModules();
    scheduleSave(0);
  });
  applyModulePresentation();
  return card;
}

modulesContainer.addEventListener("dragover", (event) => {
  if (!draggedModuleId) return;
  const target = event.target.closest(".module-card");
  if (!target || target.dataset.moduleId === draggedModuleId) return;
  event.preventDefault();
  const bounds = target.getBoundingClientRect();
  const nearSameRow = Math.abs(event.clientY - (bounds.top + bounds.height / 2)) < bounds.height * 0.35;
  const after = nearSameRow
    ? event.clientX > bounds.left + bounds.width / 2
    : event.clientY > bounds.top + bounds.height / 2;
  modulesContainer.querySelectorAll(".drop-before, .drop-after").forEach((item) => item.classList.remove("drop-before", "drop-after"));
  target.classList.add(after ? "drop-after" : "drop-before");
  event.dataTransfer.dropEffect = "move";
});

modulesContainer.addEventListener("drop", (event) => {
  if (!draggedModuleId) return;
  const target = event.target.closest(".module-card");
  if (!target || target.dataset.moduleId === draggedModuleId) return;
  event.preventDefault();
  const sourceIndex = state.modules.findIndex((module) => module.id === draggedModuleId);
  const source = state.modules[sourceIndex];
  if (!source || source.locked) return;
  const after = target.classList.contains("drop-after");
  state.modules.splice(sourceIndex, 1);
  const targetIndex = state.modules.findIndex((module) => module.id === target.dataset.moduleId);
  state.modules.splice(targetIndex + (after ? 1 : 0), 0, source);
  draggedModuleId = null;
  renderModules();
  applyDeletionLock();
  scheduleSave(0);
});

function renderSlider(module) {
  const card = createBaseCard(module);
  card.insertAdjacentHTML("beforeend", `
    <div class="module-settings slider-settings">
      <label><span>OSC type</span><select class="osc-type"><option value="f">Float</option><option value="i">Integer</option></select></label>
      <label><span>Range min</span><input class="range-min" type="number" step="any" /></label>
      <label><span>Range max</span><input class="range-max" type="number" step="any" /></label>
      <label><span>Step</span><input class="range-step" type="number" min="0.000001" step="any" /></label>
    </div>
    <div class="slider-value"><span>Current value</span><input class="direct-value" type="number" step="any" /></div>
    <input class="osc-slider" type="range" />
    <div class="range-labels"><span class="lower-label"></span><span class="upper-label"></span></div>
  `);
  const type = card.querySelector(".osc-type");
  const minimum = card.querySelector(".range-min");
  const maximum = card.querySelector(".range-max");
  const step = card.querySelector(".range-step");
  const direct = card.querySelector(".direct-value");
  const slider = card.querySelector(".osc-slider");
  type.value = module.oscType;
  minimum.value = module.min;
  maximum.value = module.max;
  step.value = module.step;

  function displayValue() {
    const value = module.oscType === "i" ? Math.round(module.value) : Number(module.value);
    direct.value = value;
    direct.step = module.oscType === "i" ? "1" : String(module.step);
    slider.value = String(module.value);
    card.querySelector(".lower-label").textContent = module.min;
    card.querySelector(".upper-label").textContent = module.max;
  }

  function syncRange() {
    slider.min = String(module.min);
    slider.max = String(module.max);
    slider.step = String(module.oscType === "i" ? Math.max(1, Math.round(module.step)) : module.step);
    module.value = Math.max(module.min, Math.min(module.max, Number(module.value)));
    displayValue();
  }

  function updateSettings() {
    const nextMin = Number(minimum.value);
    const nextMax = Number(maximum.value);
    const nextStep = Number(step.value);
    const valid = Number.isFinite(nextMin) && Number.isFinite(nextMax) && nextMax > nextMin && Number.isFinite(nextStep) && nextStep > 0;
    [minimum, maximum, step].forEach((input) => input.classList.toggle("invalid", !valid));
    if (!valid) return;
    module.oscType = type.value;
    module.min = nextMin;
    module.max = nextMax;
    module.step = nextStep;
    syncRange();
    scheduleSave();
  }

  [type, minimum, maximum, step].forEach((control) => control.addEventListener("change", updateSettings));
  slider.addEventListener("input", () => {
    module.value = Number(slider.value);
    displayValue();
    sendValue(module.address, module.oscType, module.value);
    scheduleSave();
  });
  direct.addEventListener("change", () => {
    const next = Number(direct.value);
    if (!Number.isFinite(next)) return;
    module.value = Math.max(module.min, Math.min(module.max, next));
    displayValue();
    sendValue(module.address, module.oscType, module.value);
    scheduleSave();
  });
  syncRange();
  card.applyModulePresentation();
  return card;
}

function renderButton(module) {
  const card = createBaseCard(module);
  const valueFields = module.type === "toggle"
    ? `<label><span>Off value</span><input class="off-value" type="number" step="any" /></label><label><span>On value</span><input class="on-value" type="number" step="any" /></label>`
    : `<label><span>Send value</span><input class="on-value" type="number" step="any" /></label>`;
  card.insertAdjacentHTML("beforeend", `
    <div class="module-settings button-settings">
      <label><span>OSC type</span><select class="osc-type"><option value="f">Float</option><option value="i">Integer</option></select></label>
      ${valueFields}
    </div>
    <button class="button-module-action" type="button" aria-pressed="false"><span class="action-symbol"></span><span class="action-label"></span></button>
  `);
  const type = card.querySelector(".osc-type");
  const onValue = card.querySelector(".on-value");
  const offValue = card.querySelector(".off-value");
  const action = card.querySelector(".button-module-action");
  type.value = module.oscType;
  onValue.value = module.onValue;
  if (offValue) offValue.value = module.offValue;

  function updateButton() {
    action.setAttribute("aria-pressed", String(module.type === "toggle" && module.active));
    action.querySelector(".action-symbol").textContent = module.type === "toggle" ? (module.active ? "●" : "○") : "●";
    action.querySelector(".action-label").textContent = module.type === "toggle" ? (module.active ? `${module.title} on` : `${module.title} off`) : `Send ${module.title}`;
  }

  [type, onValue, ...(offValue ? [offValue] : [])].forEach((control) => control.addEventListener("change", () => {
    module.oscType = type.value;
    module.onValue = Number(onValue.value);
    if (offValue) module.offValue = Number(offValue.value);
    scheduleSave();
  }));
  action.addEventListener("click", () => {
    if (module.type === "toggle") module.active = !module.active;
    const value = module.type === "toggle" && !module.active ? module.offValue : module.onValue;
    sendValue(module.address, module.oscType, value);
    updateButton();
    scheduleSave();
  });
  card.querySelector(".module-title").addEventListener("input", updateButton);
  updateButton();
  card.applyModulePresentation();
  return card;
}

function renderXY(module) {
  const pointCount = module.type === "xy2" ? 2 : 1;
  const valueCount = pointCount * 2;
  const card = createBaseCard(module, "xy-module");
  card.querySelector(".address-label > span").textContent = "Base OSC address";
  const outputOptions = pointCount === 1
    ? '<option value="together">Together</option><option value="individual">Individual values</option>'
    : '<option value="together">All together</option><option value="paired">Paired points</option><option value="individual">Individual values</option>';
  card.insertAdjacentHTML("beforeend", `
    <div class="module-settings xy-settings">
      <label><span>OSC type</span><select class="osc-type"><option value="f">Float</option><option value="i">Integer</option></select></label>
      <label><span>Scale min</span><input class="scale-min" type="number" step="any" /></label>
      <label><span>Scale max</span><input class="scale-max" type="number" step="any" /></label>
      <label><span>Output</span><select class="output-mode">${outputOptions}</select></label>
    </div>
    <div class="value-name-grid ${valueCount === 2 ? "two-values" : ""}"></div>
    ${pointCount === 2 ? '<div class="pair-name-grid"></div>' : ""}
    <div class="coordinate-readout"></div>
    <div class="xy-pad" tabindex="0" aria-label="XY pad">
      <span class="axis-label axis-y">Y</span><span class="axis-label axis-x">X</span>
    </div>
    <p class="packet-preview"></p>
    <div class="preset-row">
      <span class="preset-label">Position presets</span>
      <button class="store-button" type="button" aria-pressed="false">Store</button>
      <button class="preset-button" data-preset="0" type="button">P1</button>
      <button class="preset-button" data-preset="1" type="button">P2</button>
      <button class="preset-button" data-preset="2" type="button">P3</button>
      <button class="preset-button" data-preset="3" type="button">P4</button>
    </div>
  `);

  const type = card.querySelector(".osc-type");
  const minimum = card.querySelector(".scale-min");
  const maximum = card.querySelector(".scale-max");
  const mode = card.querySelector(".output-mode");
  const pad = card.querySelector(".xy-pad");
  const readout = card.querySelector(".coordinate-readout");
  const preview = card.querySelector(".packet-preview");
  const namesGrid = card.querySelector(".value-name-grid");
  const pairGrid = card.querySelector(".pair-name-grid");
  const storeButton = card.querySelector(".store-button");
  const activePointers = new Map();
  let sendFrame = null;
  let storeArmed = false;
  type.value = module.oscType;
  minimum.value = module.scaleMin;
  maximum.value = module.scaleMax;
  mode.value = module.outputMode;

  const handles = module.points.map((_, index) => {
    const handle = document.createElement("span");
    handle.className = `pad-handle handle-${index === 0 ? "a" : "b"}`;
    handle.innerHTML = `<i>${index === 0 ? "A" : "B"}</i>`;
    pad.append(handle);
    return handle;
  });

  module.valueNames.forEach((name, index) => {
    const label = document.createElement("label");
    label.innerHTML = `<span>Value ${index + 1} name</span><input />`;
    const input = label.querySelector("input");
    input.value = name;
    input.addEventListener("change", () => {
      module.valueNames[index] = input.value.trim() || `value${index + 1}`;
      input.value = module.valueNames[index];
      renderPad();
      scheduleSave();
    });
    namesGrid.append(label);
  });

  if (pairGrid) {
    module.pairNames.forEach((name, index) => {
      const label = document.createElement("label");
      label.innerHTML = `<span>Point ${index === 0 ? "A" : "B"} pair name</span><input />`;
      const input = label.querySelector("input");
      input.value = name;
      input.addEventListener("change", () => {
        module.pairNames[index] = input.value.trim() || (index === 0 ? "a" : "b");
        input.value = module.pairNames[index];
        renderPad();
        scheduleSave();
      });
      pairGrid.append(label);
    });
  }

  const valueInputs = module.valueNames.map((name, index) => {
    const label = document.createElement("label");
    label.innerHTML = `<span></span><input type="number" step="any" />`;
    readout.append(label);
    const input = label.querySelector("input");
    input.addEventListener("change", () => {
      const outputValue = Number(input.value);
      const span = module.scaleMax - module.scaleMin;
      if (!Number.isFinite(outputValue) || span === 0) return;
      const normalized = Math.max(0, Math.min(1, (outputValue - module.scaleMin) / span));
      const pointIndex = Math.floor(index / 2);
      const axisIndex = index % 2;
      module.points[pointIndex][axisIndex] = normalized;
      renderPad();
      sendXY();
      scheduleSave();
    });
    return { label: label.querySelector("span"), input };
  });

  function scaledValue(normalized) {
    const scaled = module.scaleMin + normalized * (module.scaleMax - module.scaleMin);
    return module.oscType === "i" ? Math.round(scaled) : scaled;
  }

  function outputValues() {
    return module.points.flatMap(([x, y]) => [scaledValue(x), scaledValue(y)]);
  }

  function formatted(value) {
    return module.oscType === "i" ? String(value) : Number(value).toFixed(3);
  }

  function updatePreview() {
    const base = normalizedAddress(module.address);
    if (module.outputMode === "together") {
      preview.textContent = `${base} → [ ${module.valueNames.join(", ")} ]`;
    } else if (module.outputMode === "paired" && pointCount === 2) {
      preview.textContent = `${addressWithSuffix(base, module.pairNames[0])} + ${addressWithSuffix(base, module.pairNames[1])}`;
    } else {
      preview.textContent = module.valueNames.map((name) => addressWithSuffix(base, name)).join(" · ");
    }
  }

  function updatePresets() {
    card.querySelectorAll(".preset-button").forEach((button) => {
      const index = Number(button.dataset.preset);
      button.classList.toggle("has-value", Boolean(module.presets[index]));
      button.title = module.presets[index] ? `Recall preset ${index + 1}` : `Preset ${index + 1} is empty`;
    });
    storeButton.setAttribute("aria-pressed", String(storeArmed));
  }

  function renderPad() {
    const values = outputValues();
    module.points.forEach(([x, y], index) => {
      handles[index].style.left = `${x * 100}%`;
      handles[index].style.top = `${(1 - y) * 100}%`;
    });
    valueInputs.forEach(({ label, input }, index) => {
      label.textContent = module.valueNames[index];
      input.value = formatted(values[index]);
      input.step = module.oscType === "i" ? "1" : "any";
    });
    updatePreview();
    updatePresets();
  }

  function sendXY() {
    const values = outputValues();
    const args = values.map((value) => ({ type: module.oscType, value }));
    const summary = `[ ${values.map(formatted).join(", ")} ]`;
    if (module.outputMode === "together") {
      sendPacket(module.address, args, summary);
    } else if (module.outputMode === "paired" && pointCount === 2) {
      sendPacket(addressWithSuffix(module.address, module.pairNames[0]), args.slice(0, 2), `[ ${values.slice(0, 2).map(formatted).join(", ")} ]`);
      sendPacket(addressWithSuffix(module.address, module.pairNames[1]), args.slice(2), `[ ${values.slice(2).map(formatted).join(", ")} ]`);
    } else {
      args.forEach((argument, index) => sendPacket(addressWithSuffix(module.address, module.valueNames[index]), [argument], formatted(values[index])));
    }
  }

  function queueSend() {
    if (sendFrame) return;
    sendFrame = requestAnimationFrame(() => {
      sendXY();
      sendFrame = null;
    });
  }

  function updateFromPointer(index, event) {
    const bounds = pad.getBoundingClientRect();
    module.points[index][0] = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    module.points[index][1] = Math.max(0, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height));
    renderPad();
    queueSend();
    scheduleSave();
  }

  function choosePoint(event) {
    if (pointCount === 1) return 0;
    const bounds = pad.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = 1 - (event.clientY - bounds.top) / bounds.height;
    const occupied = [...activePointers.values()];
    const available = module.points.map((_, index) => index).filter((index) => !occupied.includes(index));
    return available.reduce((best, index) => {
      const distance = (module.points[index][0] - x) ** 2 + (module.points[index][1] - y) ** 2;
      return distance < best.distance ? { index, distance } : best;
    }, { index: available[0] ?? 0, distance: Infinity }).index;
  }

  pad.addEventListener("pointerdown", (event) => {
    if (module.controlLocked) return;
    event.preventDefault();
    const pointIndex = choosePoint(event);
    activePointers.set(event.pointerId, pointIndex);
    pad.setPointerCapture(event.pointerId);
    updateFromPointer(pointIndex, event);
  });
  pad.addEventListener("pointermove", (event) => {
    if (module.controlLocked) return;
    const pointIndex = activePointers.get(event.pointerId);
    if (pointIndex !== undefined) updateFromPointer(pointIndex, event);
  });
  function releasePointer(event) {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.delete(event.pointerId);
    if (sendFrame) cancelAnimationFrame(sendFrame);
    sendFrame = null;
    sendXY();
  }
  pad.addEventListener("pointerup", releasePointer);
  pad.addEventListener("pointercancel", releasePointer);
  pad.addEventListener("keydown", (event) => {
    if (module.controlLocked) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const index = event.shiftKey && pointCount > 1 ? 1 : 0;
    const step = event.altKey ? 0.001 : 0.01;
    if (event.key === "ArrowLeft") module.points[index][0] = Math.max(0, module.points[index][0] - step);
    if (event.key === "ArrowRight") module.points[index][0] = Math.min(1, module.points[index][0] + step);
    if (event.key === "ArrowDown") module.points[index][1] = Math.max(0, module.points[index][1] - step);
    if (event.key === "ArrowUp") module.points[index][1] = Math.min(1, module.points[index][1] + step);
    renderPad();
    sendXY();
    scheduleSave();
  });

  [type, minimum, maximum, mode].forEach((control) => control.addEventListener("change", () => {
    const nextMin = Number(minimum.value);
    const nextMax = Number(maximum.value);
    if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax) || nextMin === nextMax) {
      minimum.classList.add("invalid");
      maximum.classList.add("invalid");
      return;
    }
    minimum.classList.remove("invalid");
    maximum.classList.remove("invalid");
    module.oscType = type.value;
    module.scaleMin = nextMin;
    module.scaleMax = nextMax;
    module.outputMode = mode.value;
    renderPad();
    scheduleSave();
  }));
  card.addEventListener("addresschange", updatePreview);
  storeButton.addEventListener("click", () => {
    storeArmed = !storeArmed;
    updatePresets();
  });
  card.querySelectorAll(".preset-button").forEach((button) => button.addEventListener("click", () => {
    const index = Number(button.dataset.preset);
    if (storeArmed) {
      module.presets[index] = module.points.map((point) => [...point]);
      storeArmed = false;
      addLog("stored", module.title, `preset P${index + 1}`);
      scheduleSave(0);
      updatePresets();
      return;
    }
    if (!module.presets[index]) {
      addLog("empty", module.title, `preset P${index + 1}`);
      return;
    }
    module.points = module.presets[index].map((point) => [...point]);
    renderPad();
    sendXY();
    scheduleSave();
  }));
  renderPad();
  card.applyModulePresentation();
  return card;
}

function renderModules() {
  moduleResizeObserver.disconnect();
  modulesContainer.replaceChildren();
  if (!state.modules.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No modules yet. Add one above.";
    modulesContainer.append(empty);
    renderDevices();
    scheduleModuleLayout();
    return;
  }
  state.modules.forEach((module) => {
    const card = module.type === "slider"
      ? renderSlider(module)
      : module.type === "xy1" || module.type === "xy2"
        ? renderXY(module)
        : renderButton(module);
    modulesContainer.append(card);
    moduleResizeObserver.observe(card);
  });
  renderDevices();
  scheduleModuleLayout();
}

function renderCustomSends() {
  customContainer.replaceChildren();
  if (!state.customSends.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No custom sends. Use the plus button to add one.";
    customContainer.append(empty);
    renderDevices();
    return;
  }
  state.customSends.forEach((custom) => {
    const card = document.createElement("article");
    card.className = "custom-card panel";
    card.innerHTML = `
      <label><span>Title</span><input class="module-title" /></label>
      <label><span>OSC address</span><input class="custom-address" spellcheck="false" /></label>
      <label><span>Type</span><select class="custom-type"><option value="f">Float</option><option value="i">Integer</option><option value="s">String</option></select></label>
      <label><span>Value</span><input class="custom-value" /></label>
      <button class="primary-button custom-send-button" type="button">Send</button>
      <button class="delete-button" type="button" aria-label="Delete custom send">×</button>
    `;
    const title = card.querySelector(".module-title");
    const address = card.querySelector(".custom-address");
    const type = card.querySelector(".custom-type");
    const value = card.querySelector(".custom-value");
    title.value = custom.title;
    title.readOnly = false;
    address.value = custom.address;
    type.value = custom.oscType;
    value.value = custom.value;
    title.addEventListener("input", () => { custom.title = title.value; renderDevices(); scheduleSave(); });
    address.addEventListener("change", () => { custom.address = normalizedAddress(address.value); address.value = custom.address; renderDevices(); scheduleSave(); });
    type.addEventListener("change", () => { custom.oscType = type.value; scheduleSave(); });
    value.addEventListener("change", () => { custom.value = value.value; scheduleSave(); });
    card.querySelector(".custom-send-button").addEventListener("click", () => sendValue(custom.address, custom.oscType, custom.value));
    card.querySelector(".delete-button").addEventListener("click", () => {
      if (!deletionUnlocked || !window.confirm(`Delete “${custom.title}”?`)) return;
      state.customSends = state.customSends.filter((item) => item.id !== custom.id);
      renderCustomSends();
      scheduleSave(0);
    });
    customContainer.append(card);
  });
  renderDevices();
}

function applyDeletionLock() {
  document.body.classList.toggle("delete-unlocked", deletionUnlocked);
  titleLockButton.setAttribute("aria-pressed", String(deletionUnlocked));
  lockIcon.textContent = deletionUnlocked ? "🔓" : "🔒";
  lockLabel.textContent = deletionUnlocked ? "Deletion unlocked" : "Deletion locked";
  titleLockButton.title = deletionUnlocked ? "Lock deletion" : "Unlock deletion";
  document.querySelectorAll(".module-card").forEach((card) => card.applyModulePresentation?.());
  document.querySelectorAll(".custom-card .module-title").forEach((input) => { input.readOnly = false; });
}

function applyZoom() {
  document.documentElement.style.zoom = String(state.zoom);
  zoomValue.value = `${Math.round(state.zoom * 100)}%`;
}

function applyLogVisibility() {
  document.body.classList.toggle("log-hidden", !state.logVisible);
  logToggleButton.textContent = state.logVisible ? "Hide side" : "Show side";
  logToggleButton.setAttribute("aria-pressed", String(state.logVisible));
}

connectionButton.addEventListener("click", () => {
  if (connectionState === "connected" || connectionState === "connecting") disconnect();
  else connect();
});

debugReceiverButton.addEventListener("click", () => {
  window.open("/debug.html", "oscrnode-debug", "popup,width=900,height=760");
});

targetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const target = await applyTarget(targetHost.value.trim(), Number(targetPort.value));
    state.target = target;
    renderDevices();
    scheduleSave(0);
  } catch (error) {
    addLog("error", "Destination", error.message);
  }
});

addModuleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const type = newModuleType.value;
  const title = uniqueTitle(newModuleTitle.value, state.modules);
  const slug = suffixName(title.toLowerCase(), "control");
  const module = type === "slider"
    ? makeSlider(title, `/${slug}`)
    : type === "xy1" || type === "xy2"
      ? makeXY(type, title, `/${slug}`)
      : makeButton(type, title, `/${slug}`);
  state.modules.push(module);
  renderModules();
  applyDeletionLock();
  scheduleSave(0);
  document.querySelector(`[data-module-id="${module.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
});

addCustomButton.addEventListener("click", () => {
  const title = uniqueTitle("Custom send", state.customSends);
  state.customSends.push(makeCustom(title));
  renderCustomSends();
  applyDeletionLock();
  scheduleSave(0);
  customContainer.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" });
});

titleLockButton.addEventListener("click", () => {
  deletionUnlocked = !deletionUnlocked;
  applyDeletionLock();
});

document.querySelector("#zoomOutButton").addEventListener("click", () => {
  state.zoom = Math.max(0.7, Math.round((state.zoom - 0.1) * 10) / 10);
  applyZoom();
  scheduleSave();
});
document.querySelector("#zoomInButton").addEventListener("click", () => {
  state.zoom = Math.min(1.4, Math.round((state.zoom + 0.1) * 10) / 10);
  applyZoom();
  scheduleSave();
});
logToggleButton.addEventListener("click", () => {
  state.logVisible = !state.logVisible;
  applyLogVisibility();
  scheduleSave();
});
document.querySelector("#clearLogButton").addEventListener("click", showEmptyLog);

window.addEventListener("beforeunload", () => {
  if (!state) return;
  fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
    keepalive: true,
  }).catch(() => {});
});

async function boot() {
  showEmptyLog();
  state = await loadState();
  targetHost.value = state.target.host;
  targetPort.value = state.target.port;
  applyZoom();
  applyLogVisibility();
  renderModules();
  renderCustomSends();
  applyDeletionLock();
  try {
    await applyTarget(state.target.host, Number(state.target.port), false);
  } catch (error) {
    addLog("error", "Destination", error.message);
  }
  connect();
  scheduleSave(0);
}

boot();
