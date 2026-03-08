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

// ===== Map state =====
let map = null;
let convoyPolyline = null;
const mapMarkers = new Map();

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
  let cumulativeBehindLeader = 0;

  for (let i = 0; i < sorted.length; i++) {
    const car = sorted[i];

    if (i === 0) {
      const leaderPoint = pointFromBase(
        MAP_BASE.lat,
        MAP_BASE.lng,
        0,
        0,
        ROAD_BEARING_DEG
      );

      points.push({
        ...car,
        lat: leaderPoint.lat,
        lng: leaderPoint.lng
      });
      continue;
    }

    cumulativeBehindLeader += Number(car.gapToFrontM || 0) * MAP_GAP_SCALE;

    const point = pointFromBase(
      MAP_BASE.lat,
      MAP_BASE.lng,
      -cumulativeBehindLeader,
      ROAD_LANE_OFFSET_M,
      ROAD_BEARING_DEG
    );

    points.push({
      ...car,
      lat: point.lat,
      lng: point.lng
    });
  }

  return points;
}

function markerHtmlForCar(car, isMe) {
  const bg =
    car.dangerLevel === "critical"
      ? "#d92d20"
      : car.dangerLevel === "warning"
      ? "#b1791c"
      : car.dangerLevel === "caution"
      ? "#3559d8"
      : "#153e2d";

  const border = isMe ? "3px solid #ffffff" : "2px solid #dbe7ff";
  const label = `${car.carId}${car.isBraking ? " • BRAKE" : ""}`;

  return `
    <div style="
      background:${bg};
      color:#fff;
      border:${border};
      border-radius:999px;
      padding:8px 12px;
      font-weight:800;
      font-size:12px;
      white-space:nowrap;
      box-shadow:0 6px 18px rgba(0,0,0,0.25);
    ">
      ${label}
    </div>
  `;
}

function upsertMarker(car) {
  const isMe = car.carId === carIdEl.value.trim();
  const existing = mapMarkers.get(car.carId);

  const icon = L.divIcon({
    className: "mapCarLabel",
    html: markerHtmlForCar(car, isMe),
    iconSize: [90, 30],
    iconAnchor: [45, 15]
  });

  const popupHtml = `
    <div>
      <strong>${car.carId}</strong><br />
      Position: ${car.position}<br />
      Speed: ${car.speedKmh} km/h<br />
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
