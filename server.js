import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

// Wheel segments (you can tune values/labels)
const WHEEL_SEGMENTS = [
  { type: "money", value: 100, label: "+$100" },
  { type: "money", value: 200, label: "+$200" },
  { type: "money", value: 300, label: "+$300" },
  { type: "loseTurn", value: 0, label: "LOSE TURN" },
  { type: "money", value: 400, label: "+$400" },
  { type: "bankrupt", value: 0, label: "BANKRUPT" },
  { type: "money", value: 500, label: "+$500" },
  { type: "money", value: 1000, label: "JACKPOT" }
];

// roomCode -> room state
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function buildMaskedPhrase(phrase, usedLetters) {
  return phrase
    .split("")
    .map((ch) => {
      if (ch === " ") return " ";
      if (usedLetters.has(ch)) return ch;
      return "_";
    })
    .join("");
}

function nextPlayerId(room, currentId) {
  const ids = Object.keys(room.players);
  if (ids.length === 0) return null;
  const idx = ids.indexOf(currentId);
  if (idx === -1) return ids[0];
  return ids[(idx + 1) % ids.length];
}

function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const publicState = {
    category: room.category,
    maskedPhrase: room.maskedPhrase,
    usedLetters: Array.from(room.usedLetters),
    currentPlayerId: room.currentPlayerId,
    currentSpin: room.currentSpin,
    status: room.status, // waiting | spinning | guessing | solved
    solved: room.solved,
    phraseLength: room.phrase.length
  };

  const playersArray = Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    score: p.score
  }));

  io.to(roomCode).emit("stateUpdate", {
    roomCode,
    players: playersArray,
    state: publicState
  });
}

io.on("connection", (socket) => {
  const id = socket.id;
  console.log("Client connected:", id);

  // HOST: create room
  socket.on("createRoom", (callback) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      hostId: id,
      players: {}, // { socketId: { name, score } }
      category: "",
      phrase: "",
      maskedPhrase: "",
      usedLetters: new Set(),
      currentPlayerId: null,
      currentSpin: null,
      status: "waiting",
      solved: false
    };

    socket.join(roomCode);
    console.log(`Room created: ${roomCode} by host ${id}`);
    callback({ success: true, roomCode });
  });

  // PLAYER: join room
  socket.on("joinRoom", ({ roomCode, name }, callback) => {
    const room = rooms[roomCode];
    if (!room) {
      return callback({ success: false, message: "Room not found" });
    }
    if (Object.keys(room.players).length >= 6) {
      return callback({ success: false, message: "Room full (max 6)." });
    }

    room.players[id] = { name, score: 0 };
    if (!room.currentPlayerId) {
      room.currentPlayerId = id;
    }

    socket.join(roomCode);
    console.log(`${name} joined room ${roomCode}`);

    broadcastState(roomCode);
    callback({ success: true });
  });

  // HOST: set category + phrase
  socket.on("setPuzzle", ({ roomCode, category, phrase }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.hostId !== id) return; // only host

    const cleanPhrase = phrase.toUpperCase();
    room.category = category;
    room.phrase = cleanPhrase;
    room.usedLetters = new Set();
    room.maskedPhrase = buildMaskedPhrase(cleanPhrase, room.usedLetters);
    room.status = "waiting";
    room.solved = false;
    room.currentSpin = null;

    console.log(`Puzzle set for room ${roomCode}: [${category}] ${cleanPhrase}`);
    broadcastState(roomCode);
  });

  // CURRENT PLAYER: spin wheel
  socket.on("spinWheel", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.currentPlayerId !== id) return; // only current player
    if (room.status === "spinning" || room.solved) return;

    const idx = Math.floor(Math.random() * WHEEL_SEGMENTS.length);
    const segment = WHEEL_SEGMENTS[idx];

    room.currentSpin = { index: idx, ...segment };
    room.status = "spinning";

    // Inform all clients to animate to this segment index
    io.to(roomCode).emit("spinResult", {
      roomCode,
      index: idx,
      segment
    });

    // Handle instant effects
    if (segment.type === "bankrupt") {
      room.players[id].score = 0;
      room.status = "waiting";
      room.currentSpin = null;
      room.currentPlayerId = nextPlayerId(room, id);
      io.to(roomCode).emit("message", {
        type: "system",
        text: `${room.players[id].name} hit BANKRUPT! Score reset to 0. Next player’s turn.`
      });
      broadcastState(roomCode);
    } else if (segment.type === "loseTurn") {
      room.status = "waiting";
      room.currentSpin = null;
      const oldName = room.players[id].name;
      room.currentPlayerId = nextPlayerId(room, id);
      io.to(roomCode).emit("message", {
        type: "system",
        text: `${oldName} LOSES their turn! Next player’s turn.`
      });
      broadcastState(roomCode);
    } else {
      // Money segment -> proceed to guessing
      room.status = "guessing";
      broadcastState(roomCode);
    }
  });

  // CURRENT PLAYER: guess a letter (consonant)
  socket.on("guessLetter", ({ roomCode, letter }, callback) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.currentPlayerId !== id) return;
    if (room.status !== "guessing") return;

    const upper = (letter || "").toUpperCase();
    if (!upper.match(/^[A-Z]$/)) {
      return callback && callback({ success: false, message: "Invalid letter." });
    }

    // You could add vowel/consonant logic here if you want
    if (room.usedLetters.has(upper)) {
      return callback && callback({ success: false, message: "Letter already used." });
    }

    room.usedLetters.add(upper);

    // Count occurrences
    let count = 0;
    for (const ch of room.phrase) {
      if (ch === upper) count++;
    }

    const seg = room.currentSpin;
    if (count > 0 && seg && seg.type === "money") {
      const gain = seg.value * count;
      room.players[id].score += gain;
      io.to(roomCode).emit("message", {
        type: "system",
        text: `${room.players[id].name} found ${count} × ${upper}! (+$${gain})`
      });
    } else if (count === 0) {
      io.to(roomCode).emit("message", {
        type: "system",
        text: `${room.players[id].name} guessed ${upper} but it’s not in the puzzle.`
      });
      // Move to next player
      room.currentPlayerId = nextPlayerId(room, id);
    }

    room.maskedPhrase = buildMaskedPhrase(room.phrase, room.usedLetters);
    room.currentSpin = null;
    room.status = "waiting";

    // Check if solved
    if (room.maskedPhrase === room.phrase) {
      room.solved = true;
      room.status = "solved";
      io.to(roomCode).emit("message", {
        type: "system",
        text: `The puzzle has been fully revealed!`
      });
    }

    broadcastState(roomCode);
    callback && callback({ success: true, count });
  });

  // CURRENT PLAYER: attempt to solve full phrase
  socket.on("solvePuzzle", ({ roomCode, guess }, callback) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.currentPlayerId !== id) return;
    if (room.solved) return;

    const cleanGuess = (guess || "").toUpperCase().trim();
    const correct = cleanGuess === room.phrase;

    if (correct) {
      room.solved = true;
      room.status = "solved";
      room.maskedPhrase = room.phrase;
      // Bonus for solving
      room.players[id].score += 1000;
      io.to(roomCode).emit("message", {
        type: "system",
        text: `${room.players[id].name} SOLVED THE PUZZLE! (+$1000 bonus)`
      });
    } else {
      io.to(roomCode).emit("message", {
        type: "system",
        text: `${room.players[id].name} tried to solve but was wrong. Next player’s turn.`
      });
      room.currentPlayerId = nextPlayerId(room, id);
    }

    broadcastState(roomCode);
    callback && callback({ success: true, correct });
  });

  // HOST: move to next player (manual control if needed)
  socket.on("nextPlayer", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== id) return;
    room.currentPlayerId = nextPlayerId(room, room.currentPlayerId);
    room.status = "waiting";
    room.currentSpin = null;
    io.to(roomCode).emit("message", {
      type: "system",
      text: `Host advanced to next player.`
    });
    broadcastState(roomCode);
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log("Client disconnected:", id);
    for (const roomCode of Object.keys(rooms)) {
      const room = rooms[roomCode];
      if (!room.players[id]) continue;

      const leftName = room.players[id].name;
      delete room.players[id];

      if (room.currentPlayerId === id) {
        room.currentPlayerId = nextPlayerId(room, id);
      }

      io.to(roomCode).emit("message", {
        type: "system",
        text: `${leftName} left the game.`
      });

      // If no players at all, you might want to auto-delete the room
      if (Object.keys(room.players).length === 0) {
        console.log("Deleting empty room", roomCode);
        delete rooms[roomCode];
      } else {
        broadcastState(roomCode);
      }
    }
  });
});

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log("Wheel of Fortune server running on port", port);
});
