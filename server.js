const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── GAME CONFIG ──────────────────────────────────────────────────────────────
const TICK_RATE = 20; // 20 ticks per second
const MAP_SIZE = 55;
const BASE_LOCK_TIME = 8000; // 8 seconds after steal
const SLOW_DURATION = 4000; // 4 seconds slow after stealing
const STEAL_COOLDOWN = 3000;

const BRAINROT_TYPES = [
  { id: 0, name: "Tralalero",  color: "#44aaff", income: 5,   price: 100,  rarity: "common",    emoji: "🐟" },
  { id: 1, name: "Cappuccino", color: "#cc8844", income: 12,  price: 250,  rarity: "common",    emoji: "☕" },
  { id: 2, name: "Bombardiro", color: "#44aa44", income: 25,  price: 500,  rarity: "rare",      emoji: "✈️" },
  { id: 3, name: "Tung Tung",  color: "#ff5555", income: 50,  price: 1000, rarity: "epic",      emoji: "🥁" },
  { id: 4, name: "Lirili",     color: "#ffaa00", income: 100, price: 2500, rarity: "legendary", emoji: "🐘" },
];

// ─── GAME STATE ───────────────────────────────────────────────────────────────
let players = {};   // socketId -> player data
let conveyor = [];  // current shop items
let conveyorTimer = 0;

function newConveyor() {
  conveyor = [...BRAINROT_TYPES]
    .sort(() => Math.random() - 0.5)
    .slice(0, 5)
    .map(t => ({ ...t, price: Math.round(t.price * (0.85 + Math.random() * 0.35)) }));
}
newConveyor();

// ─── PLAYER SPAWN POSITIONS ──────────────────────────────────────────────────
const SPAWN_POINTS = [
  { x:  0,  z: 30 },
  { x: -30, z: -22 },
  { x:  30, z: -22 },
  { x: -30, z:  22 },
  { x:  30, z:  22 },
  { x:   0, z: -30 },
];

function getSpawn(index) {
  return SPAWN_POINTS[index % SPAWN_POINTS.length];
}

// Each player has their own base at their spawn
function getBase(spawnIndex) {
  const s = SPAWN_POINTS[spawnIndex % SPAWN_POINTS.length];
  return { x: s.x, z: s.z };
}

let playerCount = 0;

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('join', ({ name }) => {
    const cleanName = String(name || 'Spieler').slice(0, 16).replace(/[<>]/g, '');
    const spawnIndex = playerCount++;
    const spawn = getSpawn(spawnIndex);

    players[socket.id] = {
      id: socket.id,
      name: cleanName,
      x: spawn.x,
      z: spawn.z,
      spawnIndex,
      baseX: spawn.x,
      baseZ: spawn.z,
      money: 500,
      brainrots: [],       // array of brainrot type ids
      baseLocked: false,
      baseLockUntil: 0,
      slow: false,
      slowUntil: 0,
      stealCooldownUntil: 0,
      lastSeen: Date.now(),
    };

    // Send full state to new player
    socket.emit('init', {
      selfId: socket.id,
      players: sanitizePlayers(),
      conveyor,
      brainrotTypes: BRAINROT_TYPES,
      spawnIndex,
    });

    // Tell everyone else about new player
    socket.broadcast.emit('playerJoined', sanitizePlayer(players[socket.id]));
    console.log(`${cleanName} joined (spawn ${spawnIndex})`);
  });

  // Player movement
  socket.on('move', ({ x, z, rot }) => {
    const p = players[socket.id];
    if (!p) return;
    // Clamp & validate
    p.x = Math.max(-MAP_SIZE, Math.min(MAP_SIZE, +x || 0));
    p.z = Math.max(-MAP_SIZE, Math.min(MAP_SIZE, +z || 0));
    p.rot = +rot || 0;
    p.lastSeen = Date.now();
  });

  // Buy from conveyor
  socket.on('buy', ({ typeId }) => {
    const p = players[socket.id];
    if (!p) return;
    const item = conveyor.find(c => c.id === typeId);
    if (!item) return;
    if (p.money < item.price) {
      socket.emit('error', 'Zu wenig Geld!');
      return;
    }
    p.money -= item.price;
    p.brainrots.push(typeId);
    socket.emit('moneyUpdate', p.money);
    io.emit('baseUpdate', { playerId: socket.id, brainrots: p.brainrots });
  });

  // Steal attempt
  socket.on('steal', ({ targetId }) => {
    const thief = players[socket.id];
    const target = players[targetId];
    if (!thief || !target) return;

    const now = Date.now();

    // Cooldown check
    if (now < thief.stealCooldownUntil) {
      socket.emit('error', 'Noch auf Cooldown!');
      return;
    }

    // Distance check (server-side validation)
    const dx = thief.x - target.baseX;
    const dz = thief.z - target.baseZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > 14) {
      socket.emit('error', 'Zu weit weg!');
      return;
    }

    // Locked check
    if (target.baseLocked && now < target.baseLockUntil) {
      socket.emit('stealFail', { reason: 'locked', remainingMs: target.baseLockUntil - now });
      return;
    }

    // No brainrots
    if (target.brainrots.length === 0) {
      socket.emit('stealFail', { reason: 'empty' });
      return;
    }

    // STEAL!
    const stolenTypeId = target.brainrots.pop();
    const stolenType = BRAINROT_TYPES.find(t => t.id === stolenTypeId);
    thief.brainrots.push(stolenTypeId);
    thief.money += Math.round((stolenType?.price || 100) * 0.3);
    thief.slow = true;
    thief.slowUntil = now + SLOW_DURATION;
    thief.stealCooldownUntil = now + STEAL_COOLDOWN;

    // Lock victim's base
    target.baseLocked = true;
    target.baseLockUntil = now + BASE_LOCK_TIME;

    // Notify thief
    socket.emit('stealSuccess', {
      stolenTypeId,
      bonus: Math.round((stolenType?.price || 100) * 0.3),
      newMoney: thief.money,
      yourBrainrots: thief.brainrots,
    });

    // Notify victim
    io.to(targetId).emit('gotStolen', {
      thiefName: thief.name,
      stolenTypeId,
      lockDurationMs: BASE_LOCK_TIME,
      yourBrainrots: target.brainrots,
    });

    // Tell everyone about base changes
    io.emit('baseUpdate', { playerId: socket.id, brainrots: thief.brainrots });
    io.emit('baseUpdate', { playerId: targetId, brainrots: target.brainrots });
    io.emit('baseLocked', { playerId: targetId, until: target.baseLockUntil });

    console.log(`${thief.name} stole from ${target.name}`);
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) {
      console.log(`${p.name} left`);
      delete players[socket.id];
      io.emit('playerLeft', socket.id);
    }
  });
});

// ─── GAME TICK ────────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();

  // Passive income every second (tick runs 20x/s, so every 20 ticks = 1s)
  conveyorTimer++;

  // Unlock bases
  Object.values(players).forEach(p => {
    if (p.baseLocked && now > p.baseLockUntil) {
      p.baseLocked = false;
      io.to(p.id).emit('baseUnlocked');
    }
    if (p.slow && now > p.slowUntil) {
      p.slow = false;
      io.to(p.id).emit('slowEnd');
    }
  });

  // Passive income (every 20 ticks = 1 second)
  if (conveyorTimer % 20 === 0) {
    Object.values(players).forEach(p => {
      if (p.brainrots.length > 0) {
        const income = p.brainrots.reduce((sum, tid) => {
          const t = BRAINROT_TYPES.find(bt => bt.id === tid);
          return sum + (t ? t.income : 0);
        }, 0);
        p.money += income;
        io.to(p.id).emit('moneyUpdate', p.money);
      }
    });
  }

  // Refresh conveyor every 30 seconds
  if (conveyorTimer % 600 === 0) {
    newConveyor();
    io.emit('conveyorRefresh', conveyor);
  }

  // Broadcast all positions every tick
  const positions = Object.values(players).map(p => ({
    id: p.id, x: p.x, z: p.z, rot: p.rot || 0, slow: p.slow
  }));
  io.emit('positions', positions);

}, 1000 / TICK_RATE);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function sanitizePlayer(p) {
  return {
    id: p.id, name: p.name,
    x: p.x, z: p.z, rot: p.rot || 0,
    spawnIndex: p.spawnIndex,
    baseX: p.baseX, baseZ: p.baseZ,
    money: p.money, brainrots: p.brainrots,
    baseLocked: p.baseLocked, baseLockUntil: p.baseLockUntil,
    slow: p.slow,
  };
}
function sanitizePlayers() {
  return Object.values(players).map(sanitizePlayer);
}

// Remove AFK players after 60s
setInterval(() => {
  const now = Date.now();
  Object.entries(players).forEach(([id, p]) => {
    if (now - p.lastSeen > 60000) {
      io.sockets.sockets.get(id)?.disconnect();
    }
  });
}, 10000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🧠 Steal a Brainrot Server läuft auf Port ${PORT}`));
