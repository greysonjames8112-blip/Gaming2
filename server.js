// =====================================================================
// PIXEL PLAZA Server - Production Render Build
// =====================================================================
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// Render injects PORT automatically into process.env
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0"; // Explicitly bind to all interfaces for Render

const WORLDS = ["hub", "parkour", "race", "city"];
const MAX_PLAYERS = 60;
const MAX_PER_WORLD = 24;
const MAX_VOICE = 8;
const TICK_MS = 66;

const players = new Map();
const rooms = {};
for (const w of WORLDS) rooms[w] = { ids: new Set(), raceStart: 0, finishers: [] };
const boards = { parkour: [], race: [] };
let nextId = 1;

// Utility functions
const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
const rnd2 = n => Math.round(n * 100) / 100;

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { }
  }
}

function toWorld(world, obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const id of rooms[world].ids) {
    if (id === exceptId) continue;
    const p = players.get(id);
    if (p && p.ws && p.ws.readyState === 1) {
      try { p.ws.send(msg); } catch (e) { }
    }
  }
}

const info = p => ({ id: p.id, name: p.name, skin: p.skin, voice: p.voice });
const worldPlayers = (world, exceptId) =>
  [...rooms[world].ids].filter(id => id !== exceptId).map(id => info(players.get(id)));
const lbList = mode => boards[mode].map(e => [e.name, e.time]);
const lbAll = () => ({ parkour: lbList("parkour"), race: lbList("race") });
function fmt(t) { const m = Math.floor(t / 60); return m + ":" + (t - m * 60).toFixed(1).padStart(4, "0"); }

function validSkin(s) {
  return typeof s === "string" && s.length < 90000 && /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(s) ? s : null;
}
function cleanName(n, id) {
  const s = String(n || "").replace(/[^\w \-.]/g, "").trim().slice(0, 16);
  return s || "Player" + id;
}
function cleanChat(t) {
  return String(t || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
}
function addTime(mode, name, time) {
  const list = boards[mode];
  const ex = list.find(e => e.name === name);
  if (ex) { if (time < ex.time) ex.time = time; else return false; }
  else list.push({ name: name, time: time });
  list.sort((a, b) => a.time - b.time);
  if (list.length > 5) list.length = 5;
  return true;
}

// HTTP Server setup
const INDEX_PATH = path.resolve(__dirname, "index.html");

const httpServer = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    fs.readFile(INDEX_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("500 Internal Error: index.html missing from root directory.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(data);
    });
  } else if (url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  }
});

// WebSocket Server attached to the HTTP server
const wss = new WebSocketServer({ server: httpServer, maxPayload: 128 * 1024 });

function moveToWorld(p, world) {
  rooms[p.world].ids.delete(p.id);
  toWorld(p.world, { t: "leave", id: p.id });
  p.world = world;
  rooms[world].ids.add(p.id);
  toWorld(world, { t: "join", id: p.id, name: p.name, skin: p.skin, voice: p.voice }, p.id);
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  let p = null, count = 0;
  const timer = setInterval(() => { count = 0; }, 1000);

  ws.on("message", (data) => {
    if (++count > 120) { ws.close(1008, "rate limit"); return; }
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    const now = Date.now();

    if (m.t === "join" && !p) {
      if (players.size >= MAX_PLAYERS) { send(ws, { t: "full" }); ws.close(); return; }
      const id = nextId++;
      p = { id: id, ws: ws, name: cleanName(m.name, id), skin: validSkin(m.skin), world: "hub",
            st: [0, 0, 0, 0, 1, 0, 0, 0, 0], voice: 0, lastChat: 0, lastSkin: 0 };
      players.set(id, p);
      rooms.hub.ids.add(id);
      send(ws, { t: "welcome", id: id, world: "hub", players: worldPlayers("hub", id), lb: lbAll() });
      toWorld("hub", { t: "join", id: id, name: p.name, skin: p.skin, voice: 0 }, id);
      return;
    }
    if (!p) return;

    switch (m.t) {
      case "st": {
        const a = m.s;
        if (!Array.isArray(a) || a.length < 9) return;
        p.st = [rnd2(num(a[0], -1500, 1500)), rnd2(num(a[1], -200, 600)), rnd2(num(a[2], -1500, 1500)),
                rnd2(num(a[3], -100, 100)), num(a[4], 0, 7) | 0, num(a[5], 0, 9) | 0,
                rnd2(num(a[6], -1500, 1500)), rnd2(num(a[7], -200, 600)), rnd2(num(a[8], -1500, 1500))];
        break;
      }
      case "chat": {
        const text = cleanChat(m.m);
        if (!text || now - p.lastChat < 500) return;
        p.lastChat = now;
        toWorld(p.world, { t: "chat", id: p.id, name: p.name, m: text });
        break;
      }
      case "world": {
        if (!WORLDS.includes(m.w) || m.w === p.world) return;
        if (rooms[m.w].ids.size >= MAX_PER_WORLD) {
          send(ws, { t: "feed", m: "That world is full." });
          send(ws, { t: "world", w: p.world, players: worldPlayers(p.world, p.id), lb: lbAll(), same: 1 });
          return;
        }
        moveToWorld(p, m.w);
        send(ws, { t: "world", w: m.w, players: worldPlayers(m.w, p.id), lb: lbAll() });
        break;
      }
      case "skin": {
        const s = validSkin(m.s);
        if (!s || now - p.lastSkin < 1500) return;
        p.lastSkin = now; p.skin = s;
        toWorld(p.world, { t: "skin", id: p.id, s: s }, p.id);
        break;
      }
      case "voice": {
        const on = m.on ? 1 : 0;
        if (on) {
          let n = 0;
          for (const id of rooms[p.world].ids) if (players.get(id).voice) n++;
          if (!p.voice && n >= MAX_VOICE) { send(ws, { t: "voicefull" }); return; }
        }
        p.voice = on;
        toWorld(p.world, { t: "voice", id: p.id, on: on }, p.id);
        break;
      }
      case "rtc": {
        const target = players.get(m.to | 0);
        if (target && target.world === p.world) send(target.ws, { t: "rtc", from: p.id, d: m.d });
        break;
      }
      case "race": {
        if (p.world !== "race") return;
        const room = rooms.race;
        if (room.raceStart && now < room.raceStart + 75000) { send(ws, { t: "feed", m: "A race is already underway." }); return; }
        room.raceStart = now + 5000; room.finishers = [];
        toWorld("race", { t: "racecd", at: room.raceStart, n: now });
        toWorld("race", { t: "feed", m: p.name + " started a race!" });
        break;
      }
      case "fin": {
        if (m.mode === "race" && p.world === "race") {
          const room = rooms.race;
          if (!room.raceStart || now < room.raceStart + 10000 || room.finishers.includes(p.id)) return;
          const time = (now - room.raceStart) / 1000;
          room.finishers.push(p.id);
          addTime("race", p.name, time);
          toWorld("race", { t: "feed", m: p.name + " finished #" + room.finishers.length + " in " + fmt(time) });
          toWorld("race", { t: "lb", lb: lbAll() });
        } else if (m.mode === "parkour" && p.world === "parkour") {
          const time = num(m.time, 0, 7200);
          if (time < 20) return;
          addTime("parkour", p.name, time);
          toWorld("parkour", { t: "feed", m: p.name + " finished the parkour in " + fmt(time) });
          toWorld("parkour", { t: "lb", lb: lbAll() });
        }
        break;
      }
      case "ping": send(ws, { t: "pong", c: num(m.c, 0, 1e15) }); break;
    }
  });

  ws.on("close", () => {
    clearInterval(timer);
    if (!p) return;
    rooms[p.world].ids.delete(p.id);
    players.delete(p.id);
    toWorld(p.world, { t: "leave", id: p.id });
  });
  ws.on("error", () => { });
});

// Snapshot sync tick
setInterval(() => {
  const n = Date.now();
  for (const w of WORLDS) {
    const ids = [...rooms[w].ids];
    if (ids.length < 2) continue;
    const entries = ids.map(id => [id].concat(players.get(id).st));
    for (const id of ids) {
      const pl = players.get(id);
      send(pl.ws, { t: "s", n: n, p: entries.filter(e => e[0] !== id) });
    }
  }
}, TICK_MS);

// Heartbeat ping/pong
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 10000);

// Global Error Handler to prevent crash loop on Render
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`PIXEL PLAZA running on http://${HOST}:${PORT}`);
});

process.on("SIGTERM", () => {
  wss.close();
  httpServer.close(() => process.exit(0));
});
