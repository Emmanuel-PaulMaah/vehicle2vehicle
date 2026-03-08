import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static("public"));

const rooms = new Map();
/*
rooms = Map<
  convoyId,
  Map<
    socket,
    {
      convoyId,
      carId,
      position,
      speedKmh,
      gapToFrontM,
      isBraking,
      lastUpdate
    }
  >
>
*/

function getRoom(convoyId) {
  if (!rooms.has(convoyId)) rooms.set(convoyId, new Map());
  return rooms.get(convoyId);
}

function broadcastRoomState(convoyId) {
  const room = rooms.get(convoyId);
  if (!room) return;

  const cars = [...room.values()]
    .sort((a, b) => a.position - b.position)
    .map((car) => ({
      carId: car.carId,
      convoyId: car.convoyId,
      position: car.position,
      speedKmh: car.speedKmh,
      gapToFrontM: car.gapToFrontM,
      isBraking: car.isBraking,
      lastUpdate: car.lastUpdate
    }));

  const leaderByPosition = new Map(cars.map((c) => [c.position, c]));
  const enrichedCars = cars.map((car) => {
    const frontCar = leaderByPosition.get(car.position - 1) || null;

    let relativeSpeedMps = 0;
    let timeToCollisionSec = null;
    let dangerLevel = "safe";

    if (frontCar) {
      relativeSpeedMps = Math.max(
        0,
        (car.speedKmh - frontCar.speedKmh) / 3.6
      );

      if (relativeSpeedMps > 0 && car.gapToFrontM > 0) {
        timeToCollisionSec = car.gapToFrontM / relativeSpeedMps;
      }

      if (frontCar.isBraking) {
        if (timeToCollisionSec !== null && timeToCollisionSec < 2.0) {
          dangerLevel = "critical";
        } else if (timeToCollisionSec !== null && timeToCollisionSec < 4.0) {
          dangerLevel = "warning";
        } else {
          dangerLevel = "caution";
        }
      }
    }

    return {
      ...car,
      frontCarId: frontCar?.carId ?? null,
      relativeSpeedMps: Number(relativeSpeedMps.toFixed(2)),
      timeToCollisionSec:
        timeToCollisionSec === null ? null : Number(timeToCollisionSec.toFixed(2)),
      dangerLevel
    };
  });

  const payload = JSON.stringify({
    type: "room_state",
    convoyId,
    cars: enrichedCars,
    sentAt: Date.now()
  });

  for (const socket of room.keys()) {
    if (socket.readyState === 1) socket.send(payload);
  }
}

function sendToRoom(convoyId, messageObj) {
  const room = rooms.get(convoyId);
  if (!room) return;
  const payload = JSON.stringify(messageObj);
  for (const socket of room.keys()) {
    if (socket.readyState === 1) socket.send(payload);
  }
}

wss.on("connection", (socket) => {
  let currentConvoyId = null;

  socket.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "join") {
        currentConvoyId = String(msg.convoyId || "").trim();
        if (!currentConvoyId) return;

        const room = getRoom(currentConvoyId);

        room.set(socket, {
          convoyId: currentConvoyId,
          carId: String(msg.carId || "CAR"),
          position: Number(msg.position || 1),
          speedKmh: Number(msg.speedKmh || 0),
          gapToFrontM: Number(msg.gapToFrontM || 20),
          isBraking: false,
          lastUpdate: Date.now()
        });

        sendToRoom(currentConvoyId, {
          type: "system",
          message: `${msg.carId} joined convoy ${currentConvoyId}`
        });

        broadcastRoomState(currentConvoyId);
        return;
      }

      if (!currentConvoyId) return;

      const room = rooms.get(currentConvoyId);
      if (!room || !room.has(socket)) return;

      const car = room.get(socket);

      if (msg.type === "update_state") {
        car.speedKmh = Number(msg.speedKmh ?? car.speedKmh);
        car.position = Number(msg.position ?? car.position);
        car.gapToFrontM = Number(msg.gapToFrontM ?? car.gapToFrontM);
        car.isBraking = Boolean(msg.isBraking ?? car.isBraking);
        car.lastUpdate = Date.now();

        room.set(socket, car);
        broadcastRoomState(currentConvoyId);
        return;
      }

      if (msg.type === "hard_brake") {
        car.isBraking = true;
        car.lastUpdate = Date.now();
        room.set(socket, car);

        sendToRoom(currentConvoyId, {
          type: "hard_brake_event",
          sourceCarId: car.carId,
          sourcePosition: car.position,
          sentAt: Date.now(),
          message: `${car.carId} triggered HARD BRAKE`
        });

        broadcastRoomState(currentConvoyId);
        return;
      }

      if (msg.type === "release_brake") {
        car.isBraking = false;
        car.lastUpdate = Date.now();
        room.set(socket, car);
        broadcastRoomState(currentConvoyId);
      }
    } catch (err) {
      console.error("Bad message:", err);
    }
  });

  socket.on("close", () => {
    if (!currentConvoyId) return;
    const room = rooms.get(currentConvoyId);
    if (!room) return;

    const departed = room.get(socket);
    room.delete(socket);

    if (departed) {
      sendToRoom(currentConvoyId, {
        type: "system",
        message: `${departed.carId} left convoy ${currentConvoyId}`
      });
    }

    if (room.size === 0) {
      rooms.delete(currentConvoyId);
    } else {
      broadcastRoomState(currentConvoyId);
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
