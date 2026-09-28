const statusPill = document.querySelector("#statusPill");
const listenForm = document.querySelector("#listenForm");
const listenPort = document.querySelector("#listenPort");
const stopButton = document.querySelector("#stopButton");
const selfTestButton = document.querySelector("#selfTestButton");
const loopbackTarget = document.querySelector("#loopbackTarget");
const footerTarget = document.querySelector("#footerTarget");
const addressList = document.querySelector("#addressList");
const packetCount = document.querySelector("#packetCount");
const packetLog = document.querySelector("#packetLog");
const pauseButton = document.querySelector("#pauseButton");
const clearButton = document.querySelector("#clearButton");

let paused = false;
let visibleCount = 0;

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

function setStatus(status) {
  statusPill.className = `status-pill${status.error ? " error" : status.listening ? " listening" : ""}`;
  statusPill.querySelector("span").textContent = status.error ? status.error : status.listening ? `Listening · ${status.port}` : "Stopped";
  packetCount.textContent = String(status.count || 0);
  listenPort.value = String(status.port || listenPort.value);
  const target = `127.0.0.1:${listenPort.value}`;
  loopbackTarget.textContent = target;
  footerTarget.textContent = target;
  addressList.replaceChildren(...(status.addresses || []).map((address) => {
    const code = document.createElement("code");
    code.textContent = `${address}:${listenPort.value}`;
    return code;
  }));
  stopButton.disabled = !status.listening;
  selfTestButton.disabled = !status.listening;
  if (status.lastMessage && visibleCount === 0) addPacket(status.lastMessage);
}

function valueText(argument) {
  const value = typeof argument.value === "string" ? JSON.stringify(argument.value) : String(argument.value);
  return `${argument.type}:${value}`;
}

function addPacket(packet) {
  if (paused) return;
  if (packetLog.querySelector(".empty")) packetLog.replaceChildren();
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.dateTime = packet.timestamp;
  time.textContent = new Date(packet.timestamp).toLocaleTimeString([], { hour12: false });
  const source = document.createElement("span");
  source.className = "packet-source";
  source.textContent = packet.source;
  const address = document.createElement("span");
  address.className = "packet-address";
  address.textContent = packet.address;
  const values = document.createElement("span");
  values.className = "packet-values";
  const code = document.createElement("code");
  code.textContent = packet.args.map(valueText).join(" · ") || "no arguments";
  values.append(code);
  item.append(time, source, address, values);
  packetLog.prepend(item);
  while (packetLog.children.length > 300) packetLog.lastElementChild.remove();
  visibleCount += 1;
}

listenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try { setStatus(await post("/api/debug/listen", { port: Number(listenPort.value) })); }
  catch (error) { setStatus({ listening: false, port: Number(listenPort.value), count: visibleCount, error: error.message, addresses: [] }); }
});

listenPort.addEventListener("input", () => {
  loopbackTarget.textContent = `127.0.0.1:${listenPort.value}`;
  footerTarget.textContent = loopbackTarget.textContent;
});

stopButton.addEventListener("click", async () => setStatus(await post("/api/debug/stop")));
selfTestButton.addEventListener("click", async () => post("/api/debug/self-test"));
pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.textContent = paused ? "Resume view" : "Pause view";
});
clearButton.addEventListener("click", () => {
  visibleCount = 0;
  packetLog.innerHTML = '<li class="empty">No packets received yet.</li>';
});

const events = new EventSource("/api/debug/events");
events.addEventListener("status", (event) => setStatus(JSON.parse(event.data)));
events.addEventListener("message", (event) => addPacket(JSON.parse(event.data)));

fetch("/api/debug/status").then((response) => response.json()).then(setStatus);
