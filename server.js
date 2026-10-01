import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/index.html");
});

const rooms = new Map();

function makeRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase().slice(0, 5);
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function send(ws, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function roomState(room, playerId) {
  const me = room.players.findIndex(p => p.id === playerId);

  return {
    type: "state",
    room: room.code,
    status: room.status,
    turn: room.turn,
    table: room.table,
    pot: room.pot,
    winner: room.winner,
    players: room.players.map(p => ({
      name: p.name,
      online: !!p.ws,
      cards: p.hand.length,
      tokens: p.tokens
    })),
    me,
    hand: me >= 0 ? room.players[me].hand : []
  };
}

function broadcast(room) {
  for (const player of room.players) {
    send(player.ws, roomState(room, player.id));
  }
}

function newGame(room) {
  room.status = "play";
  room.winner = null;
  room.turn = 0;
  room.table = null;
  room.pot = 0;

  const deck = Array.from({ length: 52 }, (_, i) => i);

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  room.players.forEach((player, index) => {
    player.hand = deck.slice(index * 9, index * 9 + 9).sort((a, b) => a - b);
  });
}

function playCard(room, player, cards) {
  if (room.status !== "play") {
    return "ເກມຍັງບໍ່ເລີ່ມ";
  }

  if (room.players[room.turn] !== player) {
    return "ຍັງບໍ່ຮອດຕາຂອງເຈົ້າ";
  }

  if (!Array.isArray(cards) || cards.length < 1 || cards.length > 4) {
    return "ເລືອກໄພ່ 1-4 ໃບ";
  }

  for (const card of cards) {
    if (!player.hand.includes(card)) {
      return "ໄພ່ບໍ່ຖືກຕ້ອງ";
    }
  }

  player.hand = player.hand.filter(card => !cards.includes(card));

  room.table = {
    cards,
    player: room.turn
  };

  if (player.hand.length === 0) {
    room.status = "end";
    room.winner = room.turn;
  } else {
    room.turn = (room.turn + 1) % room.players.length;
  }

  return null;
}

wss.on("connection", ws => {
  let room = null;
  let playerId = null;

  ws.on("message", raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // CREATE ROOM
    if (msg.type === "create") {
      let code = makeRoomCode();

      while (rooms.has(code)) {
        code = makeRoomCode();
      }

      playerId = makeId();

      room = {
        code,
        status: "lobby",
        turn: 0,
        table: null,
        pot: 0,
        winner: null,
        players: [{
          id: playerId,
          name: String(msg.name || "Player").slice(0, 20),
          hand: [],
          tokens: 100,
          ws
        }]
      };

      rooms.set(code, room);

      send(ws, {
        type: "created",
        room: code,
        session: playerId
      });

      broadcast(room);
      return;
    }

    // JOIN ROOM
    if (msg.type === "join") {
      const code = String(msg.room || msg.code || "")
        .toUpperCase()
        .trim();

      room = rooms.get(code);

      if (!room) {
        send(ws, {
          type: "error",
          message: "ບໍ່ພົບ Room Code"
        });
        return;
      }

      if (room.players.length >= 5) {
        send(ws, {
          type: "error",
          message: "ຫ້ອງເຕັມແລ້ວ"
        });
        return;
      }

      playerId = msg.session || makeId();

      const existing = room.players.find(p => p.id === playerId);

      if (existing) {
        existing.ws = ws;
      } else {
        room.players.push({
          id: playerId,
          name: String(msg.name || "Player").slice(0, 20),
          hand: [],
          tokens: 100,
          ws
        });
      }

      send(ws, {
        type: "joined",
        room: code,
        session: playerId
      });

      broadcast(room);
      return;
    }

    if (!room || !playerId) return;

    const player = room.players.find(p => p.id === playerId);

    if (!player) return;

    // START GAME
    if (msg.type === "start") {
      if (room.players.length < 2) {
        send(ws, {
          type: "error",
          message: "ຕ້ອງມີຢ່າງໜ້ອຍ 2 ຄົນ"
        });
        return;
      }

      newGame(room);
      broadcast(room);
      return;
    }

    // PLAY
    if (msg.type === "play" || msg.type === "action") {
      const cards = msg.cards || msg.data || [];

      const error = playCard(room, player, cards);

      if (error) {
        send(ws, {
          type: "error",
          message: error
        });
        return;
      }

      broadcast(room);
      return;
    }

    // PASS
    if (msg.type === "pass") {
      if (room.status !== "play") return;

      if (room.players[room.turn] !== player) {
        send(ws, {
          type: "error",
          message: "ຍັງບໍ່ຮອດຕາຂອງເຈົ້າ"
        });
        return;
      }

      room.turn = (room.turn + 1) % room.players.length;

      broadcast(room);
    }
  });

  ws.on("close", () => {
    if (!room || !playerId) return;

    const player = room.players.find(p => p.id === playerId);

    if (player) {
      player.ws = null;
    }

    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Phaikoi server running on port ${PORT}`);
});
