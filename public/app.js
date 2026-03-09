const convoyIdEl = document.getElementById("convoyId");
const carIdEl = document.getElementById("carId");
const positionEl = document.getElementById("position");
const speedKmhEl = document.getElementById("speedKmh");
const gapToFrontMEl = document.getElementById("gapToFrontM");

const joinBtn = document.getElementById("joinBtn");
const updateBtn = document.getElementById("updateBtn");
const brakeBtn = document.getElementById("brakeBtn");
const releaseBtn = document.getElementById("releaseBtn");
const testBeepBtn = document.getElementById("testBeepBtn");

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

// ===== Map state =====
let map = null;
let convoyPolyline = null;
const mapMarkers = new Map();

// ========================
// Convoy animation state
// ========================

let animationRunning = false;
let lastFrameTime = null;

const carSimState = new Map();
// carId -> { distBehindLeader, speedMps }

const SPEED_SCALE = 0.5;
// slows simulation so movement is readable

const BRAKE_DECEL_MPS2 = 8;
const FOLLOWER_BRAKE_DECEL_MPS2 = 6;
const CATCHUP_ACCEL_MPS2 = 2.5;
const RESUME_ACCEL_MPS2 = 3.2;
const GAP_EASE_MPS = 8;

// repeating warning beep state
let beepIntervalId = null;
let audioCtx = null;

const MAP_BASE = {
  lat: 6.5244,   // Lagos-ish default
  lng: 3.3792
};

const ROAD_BEARING_DEG = 90; // Eastward
const ROAD_LANE_OFFSET_M = 0;

// Demo-only exaggeration so convoy spacing reads clearly on the map.
// Real GPS mode later will not need this.
const MAP_GAP_SCALE = 6;
const SINGLE_CAR_ZOOM = 19;
const CONVOY_MAX_ZOOM = 19;
const CONVOY_PADDING = [20, 20];

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
    stopWarningBeep();
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
  renderMap(msg);
  startAnimation();
}
  });
}

async function ensureAudioReady() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      log(`AudioContext created: state=${audioCtx.state}`);
    }

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
      log(`AudioContext resumed: state=${audioCtx.state}`);
    }

    return audioCtx.state === "running";
  } catch (err) {
    log(`Audio init failed: ${err.message}`);
    return false;
  }
}

async function playBeepOnce() {
  try {
    const ready = await ensureAudioReady();
    if (!ready) {
      log("Audio not ready for beep");
      return;
    }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "square";
    osc.frequency.value = 980;

    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.24);

    log("Beep played");
  } catch (err) {
    log(`Beep failed: ${err.message}`);
  }
}

async function startWarningBeep() {
  if (beepIntervalId) return;

  const ready = await ensureAudioReady();
  if (!ready) {
    log("Could not start repeating beep");
    return;
  }

  log("Starting repeating warning beep");
  playBeepOnce();

  beepIntervalId = setInterval(() => {
    playBeepOnce();
  }, 700);
}

function stopWarningBeep() {
  if (!beepIntervalId) return;
  clearInterval(beepIntervalId);
  beepIntervalId = null;
  log("Stopped warning beep");
}

function handleBrakeEvent(msg) {
  const myPos = Number(positionEl.value);
  if (!joined) return;

  if (msg.sourcePosition < myPos) {
    alertTitle.textContent = "Brake alert ahead";
    alertText.textContent = `${msg.sourceCarId} in front triggered HARD BRAKE. Check following distance now.`;
    alertBox.className = "alertBox warning flash";
    playBeepOnce();
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

        const immediateFrontIsBraking =
      Boolean(me.frontCarId) &&
      cars.some((c) => c.carId === me.frontCarId && c.isBraking);

    if (immediateFrontIsBraking) {
      startWarningBeep();
    } else {
      stopWarningBeep();
    }

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

  if (!me) {
    stopWarningBeep();
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

// =====================
// Map helpers
// =====================

function initMap() {
  if (map) return;

  map = L.map("map", {
    zoomControl: true
  }).setView([MAP_BASE.lat, MAP_BASE.lng], 16);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  convoyPolyline = L.polyline([], {
    weight: 5,
    opacity: 0.75
  }).addTo(map);

  log("Map initialized");
}

function metersToLatLngOffset(northMeters, eastMeters, baseLat) {
  const dLat = northMeters / 111320;
  const dLng = eastMeters / (111320 * Math.cos((baseLat * Math.PI) / 180));
  return { dLat, dLng };
}

function pointFromBase(baseLat, baseLng, forwardMeters, sideMeters, bearingDeg = 0) {
  const theta = (bearingDeg * Math.PI) / 180;

  const northMeters =
    Math.cos(theta) * forwardMeters +
    Math.cos(theta + Math.PI / 2) * sideMeters;

  const eastMeters =
    Math.sin(theta) * forwardMeters +
    Math.sin(theta + Math.PI / 2) * sideMeters;

  const { dLat, dLng } = metersToLatLngOffset(northMeters, eastMeters, baseLat);

  return {
    lat: baseLat + dLat,
    lng: baseLng + dLng
  };
}

function computeMapPoints(cars) {
  const sorted = [...cars].sort((a, b) => a.position - b.position);
  if (!sorted.length) return [];

  const points = [];

  for (let i = 0; i < sorted.length; i++) {
    const car = sorted[i];

    if (!carSimState.has(car.carId)) {
      const fallbackDist = i === 0
        ? 0
        : sorted
            .slice(1, i + 1)
            .reduce((sum, c) => sum + Number(c.gapToFrontM || 0) * MAP_GAP_SCALE, 0);

      carSimState.set(car.carId, {
        distBehindLeader: fallbackDist,
        speedMps: (Number(car.speedKmh || 0) / 3.6) * SPEED_SCALE
      });
    }

    const sim = carSimState.get(car.carId);

    const point = pointFromBase(
      MAP_BASE.lat,
      MAP_BASE.lng,
      -sim.distBehindLeader,
      ROAD_LANE_OFFSET_M,
      ROAD_BEARING_DEG
    );

    points.push({
      ...car,
      lat: point.lat,
      lng: point.lng,
      animatedSpeedMps: sim.speedMps
    });
  }

  return points;
}

function markerHtmlForCar(car, isMe) {
  let stateClass = "state-safe";

  if (car.isBraking) {
    stateClass = "state-braking";
  } else if (car.dangerLevel === "critical") {
    stateClass = "state-critical";
  } else if (car.dangerLevel === "warning") {
    stateClass = "state-warning";
  } else if (car.dangerLevel === "caution") {
    stateClass = "state-caution";
  }

  const meClass = isMe ? "is-me" : "";
  const brakingClass = car.isBraking ? "is-braking" : "";

  return `
    <div class="carMarkerWrap">
      <div class="carMarkerLabel">${car.carId}</div>
      <div class="carMarkerBody ${stateClass} ${meClass} ${brakingClass}">
        <div class="carMarkerCabin"></div>
      </div>
    </div>
  `;
}

function upsertMarker(car) {
  const isMe = car.carId === carIdEl.value.trim();
  const existing = mapMarkers.get(car.carId);

  const icon = L.divIcon({
    className: "mapCarLabel",
    html: markerHtmlForCar(car, isMe),
    iconSize: [56, 28],
    iconAnchor: [28, 14]
  });

   const popupHtml = `
    <div>
      <strong>${car.carId}</strong><br />
      Position: ${car.position}<br />
      Cruise speed: ${car.speedKmh} km/h<br />
      Animated speed: ${Math.round((car.animatedSpeedMps || 0) * 3.6)} km/h<br />
      Gap: ${car.gapToFrontM} m<br />
      Front car: ${car.frontCarId ?? "—"}<br />
      TTC: ${car.timeToCollisionSec ?? "—"}<br />
      Danger: ${car.dangerLevel}<br />
      Status: ${car.isBraking ? "BRAKING" : "OK"}
    </div>
  `;

  if (!existing) {
    const marker = L.marker([car.lat, car.lng], { icon }).addTo(map);
    marker.bindPopup(popupHtml);
    mapMarkers.set(car.carId, marker);
    return;
  }

  existing.setLatLng([car.lat, car.lng]);
  existing.setIcon(icon);
  existing.setPopupContent(popupHtml);
}

function renderMap(roomMsg) {
  initMap();

  const cars = roomMsg.cars || [];
  const points = computeMapPoints(cars);

  const seenIds = new Set(points.map((p) => p.carId));

  for (const point of points) {
    upsertMarker(point);
  }

  for (const [carId, marker] of mapMarkers.entries()) {
    if (!seenIds.has(carId)) {
      map.removeLayer(marker);
      mapMarkers.delete(carId);
    }
  }

  const linePoints = points
    .sort((a, b) => a.position - b.position)
    .map((p) => [p.lat, p.lng]);

  convoyPolyline.setLatLngs(linePoints);

    if (linePoints.length === 1) {
    map.setView(linePoints[0], SINGLE_CAR_ZOOM);
  } else if (linePoints.length > 1) {
    const bounds = L.latLngBounds(linePoints);
    map.fitBounds(bounds, {
      padding: CONVOY_PADDING,
      maxZoom: CONVOY_MAX_ZOOM
    });
  }
}

joinBtn.addEventListener("click", async () => {
  await ensureAudioReady();
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

updateBtn.addEventListener("click", async () => {
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

brakeBtn.addEventListener("click", async () => {
  await ensureAudioReady();

  if (!joined) {
    log("Join a convoy first");
    return;
  }

  send({ type: "hard_brake" });
  log("Triggered HARD BRAKE");
});

releaseBtn.addEventListener("click", async () => {
  await ensureAudioReady();

  if (!joined) {
    log("Join a convoy first");
    return;
  }

  send({ type: "release_brake" });
  log("Released brake");
});

function updateSimulation(dt) {
  if (!lastRoomState) return;

  const cars = [...lastRoomState.cars].sort((a, b) => a.position - b.position);
  if (!cars.length) return;

  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];

    if (!carSimState.has(car.carId)) {
      const distBehindLeader =
        i === 0
          ? 0
          : cars
              .slice(1, i + 1)
              .reduce((sum, c) => sum + Number(c.gapToFrontM || 0) * MAP_GAP_SCALE, 0);

      carSimState.set(car.carId, {
        distBehindLeader,
        speedMps: (Number(car.speedKmh || 0) / 3.6) * SPEED_SCALE
      });
    }
  }

  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const sim = carSimState.get(car.carId);
    const targetCruiseSpeed = (Number(car.speedKmh || 0) / 3.6) * SPEED_SCALE;

    if (i === 0) {
      if (car.isBraking) {
        sim.speedMps = Math.max(0, sim.speedMps - BRAKE_DECEL_MPS2 * dt);
      } else {
        sim.speedMps = Math.min(
          targetCruiseSpeed,
          sim.speedMps + RESUME_ACCEL_MPS2 * dt
        );
      }

      sim.distBehindLeader += sim.speedMps * dt;
      continue;
    }

    const frontCar = cars[i - 1];
    const frontSim = carSimState.get(frontCar.carId);

    const desiredGap = Number(car.gapToFrontM || 0) * MAP_GAP_SCALE;
    const actualGap = sim.distBehindLeader - frontSim.distBehindLeader;
    const frontIsBraking = Boolean(frontCar.isBraking);

    if (frontIsBraking) {
      sim.speedMps = Math.max(0, sim.speedMps - FOLLOWER_BRAKE_DECEL_MPS2 * dt);
    } else {
      const gapError = actualGap - desiredGap;

      if (gapError > desiredGap * 0.25) {
        sim.speedMps = Math.min(
          targetCruiseSpeed,
          sim.speedMps + CATCHUP_ACCEL_MPS2 * dt
        );
      } else {
        sim.speedMps = Math.min(
          targetCruiseSpeed,
          sim.speedMps + RESUME_ACCEL_MPS2 * dt
        );
      }
    }

    sim.distBehindLeader += sim.speedMps * dt;

    const newActualGap = sim.distBehindLeader - frontSim.distBehindLeader;

    if (newActualGap < desiredGap) {
      sim.distBehindLeader = frontSim.distBehindLeader + desiredGap;
      sim.speedMps = Math.min(sim.speedMps, frontSim.speedMps + GAP_EASE_MPS * 0.02);
    }
  }
}

function animationLoop(ts) {

  if (!animationRunning) return;

  if (!lastFrameTime) lastFrameTime = ts;

  const dt = (ts - lastFrameTime) / 1000;

  lastFrameTime = ts;

  updateSimulation(dt);

  if (lastRoomState) renderMap(lastRoomState);

  requestAnimationFrame(animationLoop);
}

function startAnimation() {

  if (animationRunning) return;

  animationRunning = true;

  requestAnimationFrame(animationLoop);

  log("Convoy animation started");
}

testBeepBtn.addEventListener("click", async () => {
  await ensureAudioReady();
  await playBeepOnce();
});

setConn(false);
stopWarningBeep();
log("Page loaded");
