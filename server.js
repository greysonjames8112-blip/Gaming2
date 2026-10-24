// =====================================================================
// PIXEL PLAZA server
//  * Serves index.html and runs the WebSocket game server on one port.
//  * Players live in "worlds" (hub, parkour, race, city). The server relays
//    each player's position to the others in the same world 15x per second.
//  * It also handles: chat, painted skins, voice-chat signaling (WebRTC),
//    race countdowns and best-time leaderboards.
//  Movement is client-side (it's a hangout game, not a competitive shooter);
//  the server clamps and sanity-checks everything it relays.
// =====================================================================
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const WORLDS = ["hub", "parkour", "race", "city"];
const MAX_PLAYERS = 60;
const MAX_PER_WORLD = 24;
const MAX_VOICE = 8;                 // voice is a WebRTC mesh, so keep groups small
const TICK_MS = 66;                  // ~15 snapshots per second

const players = new Map();           // id -> player
const rooms = {};
for (const w of WORLDS) rooms[w] = { ids: new Set(), raceStart: 0, finishers: [] };
const boards = { parkour: [], race: [] };      // best times: [{ name, time }]
let nextId = 1;

// ---------- accounts (username + password; each account keeps its own painted skin) ----------
// Stored in a JSON file. Set DATA_FILE to a path on a persistent disk to keep accounts forever.
// (Free hosts like Render wipe their disk on redeploy, so the game also caches your skin on
// your own device and re-uploads it if the server has forgotten it.)
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "accounts.json");
let accounts = Object.create(null);
try { accounts = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) { }
let saveTimer = null;
function saveAccounts() {                         // debounced + atomic (write temp file, then rename)
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(accounts));
      fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
    } catch (e) { console.log("could not save accounts: " + e.message); }
  }, 1000);
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);
const failed = new Map();                         // account key -> { count, until }  (brute-force throttle)
// Returns { key, acc } on success or { err } with a message for the player.
function authenticate(rawName, pass, skinHint) {
  const name = String(rawName || "").replace(/[^\w \-.]/g, "").trim().slice(0, 16);
  if (!name) return { err: "Enter a username (letters, numbers, spaces, - . _)." };
  const key = name.toLowerCase(), now = Date.now();
  const f = failed.get(key);
  if (f && f.until > now) return { err: "Too many wrong tries. Wait a minute and try again." };
  let acc = accounts[key];
  if (acc) {
    const okPw = typeof pass === "string" && pass.length <= 64 &&
      crypto.timingSafeEqual(hashPw(pass, acc.salt), Buffer.from(acc.hash, "hex"));
    if (!okPw) {
      const n = (f ? f.count : 0) + 1;
      failed.set(key, n >= 5 ? { count: 0, until: now + 60000 } : { count: n, until: 0 });
      return { err: "Wrong password for that username." };
    }
    failed.delete(key);
  } else {
    if (typeof pass !== "string" || pass.length < 4 || pass.length > 64) return { err: "New username! Pick a password (4 to 64 characters) to create the account." };
    if (Object.keys(accounts).length >= 5000) return { err: "This server has reached its account limit." };
    const salt = crypto.randomBytes(16).toString("hex");
    acc = accounts[key] = { name: name, salt: salt, hash: hashPw(pass, salt).toString("hex"), skin: null, created: now };
    saveAccounts();
  }
  const hint = validSkin(skinHint);
  if (!acc.skin && hint) { acc.skin = hint; saveAccounts(); }      // adopt the device's cached look if the server has none
  return { key: key, acc: acc };
}

// ---------- helpers ----------
const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
const rnd2 = n => Math.round(n * 100) / 100;
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function toWorld(world, obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const id of rooms[world].ids) {
    if (id === exceptId) continue;
    const p = players.get(id);
    if (p && p.ws.readyState === 1) p.ws.send(msg);
  }
}
const info = p => ({ id: p.id, name: p.name, skin: p.skin, voice: p.voice });
const worldPlayers = (world, exceptId) =>
  [...rooms[world].ids].filter(id => id !== exceptId).map(id => info(players.get(id)));
const lbList = mode => boards[mode].map(e => [e.name, e.time]);
const lbAll = () => ({ parkour: lbList("parkour"), race: lbList("race") });
function fmt(t) { const m = Math.floor(t / 60); return m + ":" + (t - m * 60).toFixed(1).padStart(4, "0"); }

// Skins are PNG data URLs painted by players (256x256). We only check the shape here;
// the client draws them onto a canvas, so a bad image can't hurt anyone.
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

// ---------- HTTP ----------
const INDEX = path.join(__dirname, "index.html");
const httpServer = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    fs.readFile(INDEX, (err, data) => {
      if (err) { res.writeHead(500); res.end("index.html missing"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(data);
    });
  } else if (url === "/health") { res.writeHead(200); res.end("ok"); }
  else { res.writeHead(404); res.end("not found"); }
});
const wss = new WebSocketServer({ server: httpServer, maxPayload: 128 * 1024 });

function removePlayer(p) {
  if (p.gone) return;
  p.gone = true;
  rooms[p.world].ids.delete(p.id);
  players.delete(p.id);
  toWorld(p.world, { t: "leave", id: p.id });
  console.log("- " + p.name + " #" + p.id + " (" + players.size + " online)");
}
function moveToWorld(p, world) {
  rooms[p.world].ids.delete(p.id);
  toWorld(p.world, { t: "leave", id: p.id });
  p.world = world;
  rooms[world].ids.add(p.id);
  toWorld(world, { t: "join", id: p.id, name: p.name, skin: p.skin, voice: p.voice }, p.id);
}

// ---------- connections ----------
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
      const auth = authenticate(m.name, m.pass, m.skin);
      if (auth.err) { send(ws, { t: "authfail", m: auth.err }); setTimeout(() => ws.close(), 200); return; }
      // Same account logged in somewhere else? The new login takes over (they proved they know the password).
      for (const other of [...players.values()]) if (other.key === auth.key) { send(other.ws, { t: "feed", m: "Logged in from another device." }); removePlayer(other); other.ws.close(); }
      const id = nextId++;
      p = { id: id, key: auth.key, ws: ws, name: auth.acc.name, skin: auth.acc.skin, world: "hub",
            st: [0, 0, 0, 0, 1, 0, 0, 0, 0], voice: 0, lastChat: 0, lastSkin: 0, gone: false };
      players.set(id, p);
      rooms.hub.ids.add(id);
      send(ws, { t: "welcome", id: id, name: p.name, skin: p.skin, world: "hub", players: worldPlayers("hub", id), lb: lbAll() });
      toWorld("hub", { t: "join", id: id, name: p.name, skin: p.skin, voice: 0 }, id);
      console.log("+ " + p.name + " #" + id + " (" + players.size + " online)");
      return;
    }
    if (!p || p.gone) return;

    switch (m.t) {
      case "st": {                       // [x, y, z, yaw, flags, emote, ax, ay, az]
        const a = m.s;
        if (!Array.isArray(a) || a.length < 9) return;
        p.st = [rnd2(num(a[0], -1500, 1500)), rnd2(num(a[1], -200, 600)), rnd2(num(a[2], -1500, 1500)),
                rnd2(num(a[3], -100, 100)), num(a[4], 0, 7) | 0, num(a[5], 0, 9) | 0,
                rnd2(num(a[6], -1500, 1500)), rnd2(num(a[7], -200, 600)), rnd2(num(a[8], -1500, 1500))];
        break;
      }
      case "chat": {
        const text = cleanChat(m.m);
        if (!text || now - p.lastChat < 500) return;      // 2 messages per second max
        p.lastChat = now;
        toWorld(p.world, { t: "chat", id: p.id, name: p.name, m: text });
        break;
      }
      case "world": {
        if (!WORLDS.includes(m.w) || m.w === p.world) return;
        if (rooms[m.w].ids.size >= MAX_PER_WORLD) { send(ws, { t: "feed", m: "That world is full." }); send(ws, { t: "world", w: p.world, players: worldPlayers(p.world, p.id), lb: lbAll(), same: 1 }); return; }
        moveToWorld(p, m.w);
        send(ws, { t: "world", w: m.w, players: worldPlayers(m.w, p.id), lb: lbAll() });
        break;
      }
      case "skin": {
        const s = validSkin(m.s);
        if (!s || now - p.lastSkin < 1500) return;
        p.lastSkin = now; p.skin = s;
        accounts[p.key].skin = s; saveAccounts();            // saved to the account, not the device
        toWorld(p.world, { t: "skin", id: p.id, s: s }, p.id);
        break;
      }
      case "voice": {                    // player turned voice chat on/off
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
      case "rtc": {                      // WebRTC signaling relay (offers, answers, ICE)
        const target = players.get(m.to | 0);
        if (target && target.world === p.world) send(target.ws, { t: "rtc", from: p.id, d: m.d });
        break;
      }
      case "race": {                     // someone pressed "Start race"
        if (p.world !== "race") return;
        const room = rooms.race;
        if (room.raceStart && now < room.raceStart + 75000) { send(ws, { t: "feed", m: "A race is already underway." }); return; }
        room.raceStart = now + 5000; room.finishers = [];
        toWorld("race", { t: "racecd", at: room.raceStart, n: now });
        toWorld("race", { t: "feed", m: p.name + " started a race!" });
        break;
      }
      case "fin": {                      // finished a race / parkour course
        if (m.mode === "race" && p.world === "race") {
          const room = rooms.race;
          if (!room.raceStart || now < room.raceStart + 10000 || room.finishers.includes(p.id)) return;
          const time = (now - room.raceStart) / 1000;       // race time is measured by the server
          room.finishers.push(p.id);
          addTime("race", p.name, time);
          toWorld("race", { t: "feed", m: p.name + " finished #" + room.finishers.length + " in " + fmt(time) });
          toWorld("race", { t: "lb", lb: lbAll() });
        } else if (m.mode === "parkour" && p.world === "parkour") {
          const time = num(m.time, 0, 7200);
          if (time < 20) return;                            // can't beat the course in under 20 s
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
    if (p) removePlayer(p);
  });
  ws.on("error", () => { });
});

// ---------- snapshots (15 Hz): each player gets the others in their world ----------
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

// Drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 10000);

httpServer.listen(PORT, () => console.log("PIXEL PLAZA running on http://localhost:" + PORT));
process.on("SIGTERM", () => { wss.close(); httpServer.close(() => process.exit(0)); });
