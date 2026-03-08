const convoyIdEl = document.getElementById("convoyId");
const carIdEl = document.getElementById("carId");
const positionEl = document.getElementById("position");
const speedKmhEl = document.getElementById("speedKmh");
const gapToFrontMEl = document.getElementById("gapToFrontM");

const joinBtn = document.getElementById("joinBtn");
const updateBtn = document.getElementById("updateBtn");
const brakeBtn = document.getElementById("brakeBtn");
const releaseBtn = document.getElementById("releaseBtn");

const connBadge = document.getElementById("connBadge");
const carsList = document.getElementById("carsList");
const alertBox = document.getElementById("alertBox");
const alertTitle = document.getElementById("alertTitle");
const alertText = document.getElementById("alertText");
const logs = document.getElementById("logs");

const meLabel = document.getElementById("meLabel");
const meStatus = document.getElementById("meStatus");
const frontCar = document.getElementById("frontCar");
const ttc = document.getElementById("ttc");
const danger = document.getElementById("danger");

let ws = null;
let joined = false;
let lastRoomState = null;

function log(line) {
  const t = new Date().toLocaleTimeString();
  logs.value = `[${t}] ${line}\n` + logs.value;
}

function setConn(isOnline) {
  connBadge.textContent = isOnline ? "Online" : "Offline";
  connBadge.className = `badge ${isOnline ? "online" : "offline"}`;
}

function getStateFromForm() {
  return {
    convoyId: convoyIdEl.value.trim(),
    carId: carIdEl.value.trim(),
    position: Number(positionEl.value),
    speedKmh: Number(speedKmhEl.value),
    gapToFrontM: Number(gapToFrontMEl.value)
  };
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("Cannot send: socket not open");
    return;
  }
  ws.send(JSON.stringify(obj));
}

function ensureSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}`);

  ws.addEventListener("open", () => {
    setConn(true);
    log("WebSocket connected");
  });

  ws.addEventListener("close", () => {
    setConn(false);
    log("WebSocket disconnected");
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "system") {
      log(`SYSTEM: ${msg.message}`);
      return;
    }

    if (msg.type === "hard_brake_event") {
      log(`EVENT: ${msg.message}`);
      handleBrakeEvent(msg);
      return;
    }

    if (msg.type === "room_state") {
      lastRoomState = msg;
      renderRoom(msg);
    }
  });
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.08;

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  } catch (err) {
    log(`Beep failed: ${err.message}`);
  }
}

function handleBrakeEvent(msg) {
  const myPos = Number(positionEl.value);
  if (!joined) return;

  if (msg.sourcePosition < myPos) {
    alertTitle.textContent = "Brake alert ahead";
    alertText.textContent = `${msg.sourceCarId} in front triggered HARD BRAKE. Check following distance now.`;
    alertBox.className = "alertBox warning flash";
    playBeep();
  }
}

function renderRoom(roomMsg) {
  const cars = roomMsg.cars || [];
  carsList.innerHTML = "";

  const myCarId = carIdEl.value.trim();
  const me = cars.find((c) => c.carId === myCarId);

  if (me) {
    meLabel.textContent = `${me.carId} / Pos ${me.position}`;
    meStatus.textContent = me.isBraking ? "Braking" : "Cruising";
    frontCar.textContent = me.frontCarId ?? "None";
    ttc.textContent = me.timeToCollisionSec == null ? "—" : `${me.timeToCollisionSec}s`;
    danger.textContent = me.dangerLevel;

    if (me.dangerLevel === "critical") {
      alertTitle.textContent = "BRAKE NOW";
      alertText.textContent = `Critical closing risk on ${me.frontCarId}. TTC ${me.timeToCollisionSec}s`;
      alertBox.className = "alertBox critical flash";
      playBeep();
    } else if (me.dangerLevel === "warning") {
      alertTitle.textContent = "Warning";
      alertText.textContent = `Risk increasing behind ${me.frontCarId}. TTC ${me.timeToCollisionSec}s`;
      alertBox.className = "alertBox warning";
    } else if (me.dangerLevel === "caution") {
      alertTitle.textContent = "Front car braking";
      alertText.textContent = `Brake event detected ahead. Maintain space.`;
      alertBox.className = "alertBox warning";
    } else {
      alertTitle.textContent = "No active emergency";
      alertText.textContent = "Waiting for convoy events...";
      alertBox.className = "alertBox safe";
    }
  }

  for (const car of cars) {
    const row = document.createElement("div");
    row.className = `carRow ${car.dangerLevel}`;

    row.innerHTML = `
      <div><strong>${car.carId}</strong></div>
      <div>Pos ${car.position}</div>
      <div>${car.speedKmh} km/h</div>
      <div>Gap ${car.gapToFrontM} m</div>
      <div>${car.isBraking ? "BRAKING" : "OK"}</div>
      <div>
        Front: ${car.frontCarId ?? "—"} |
        TTC: ${car.timeToCollisionSec ?? "—"} |
        Danger: ${car.dangerLevel}
      </div>
    `;

    carsList.appendChild(row);
  }
}

joinBtn.addEventListener("click", () => {
  ensureSocket();

  const tryJoin = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setTimeout(tryJoin, 150);
      return;
    }

    const state = getStateFromForm();

    send({
      type: "join",
      ...state
    });

    joined = true;
    log(`Joined convoy ${state.convoyId} as ${state.carId}`);
  };

  tryJoin();
});

updateBtn.addEventListener("click", () => {
  if (!joined) {
    log("Join a convoy first");
    return;
  }

  const state = getStateFromForm();
  send({
    type: "update_state",
    ...state,
    isBraking: false
  });

  log(`Updated state: speed=${state.speedKmh}, gap=${state.gapToFrontM}, pos=${state.position}`);
});

brakeBtn.addEventListener("click", () => {
  if (!joined) {
    log("Join a convoy first");
    return;
  }

  send({ type: "hard_brake" });
  log("Triggered HARD BRAKE");
});

releaseBtn.addEventListener("click", () => {
  if (!joined) {
    log("Join a convoy first");
    return;
  }

  send({ type: "release_brake" });
  log("Released brake");
});

setConn(false);
log("Page loaded");
