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
const WORLDS = ["hub", "parkour", "race", "city", "br"];
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
// DEVELOPER ACCOUNT: set the ADMIN_USER and ADMIN_PASS environment variables on your host.
// Only that exact username + password gets the slash commands. Nothing is hard-coded here, so nothing leaks via GitHub.
const cleanNameStr = n => String(n || "").replace(/[^\w \-.]/g, "").trim().slice(0, 16);
const ADMIN_KEY = cleanNameStr(process.env.ADMIN_USER).toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASS || "";
if (ADMIN_KEY && ADMIN_PASS) console.log("Developer account enabled for username: " + ADMIN_KEY);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);
const failed = new Map();                         // account key -> { count, until }  (brute-force throttle)
// Returns { key, acc } on success or { err } with a message for the player.
function authenticate(rawName, pass, skinHint) {
  const name = String(rawName || "").replace(/[^\w \-.]/g, "").trim().slice(0, 16);
  if (!name) return { err: "Enter a username (letters, numbers, spaces, - . _)." };
  const key = name.toLowerCase(), now = Date.now();
  const f = failed.get(key);
  if (f && f.until > now) return { err: "Too many wrong tries. Wait a minute and try again." };
  if (ADMIN_KEY && ADMIN_PASS && key === ADMIN_KEY) {              // the dev name ALWAYS needs the dev password (nobody else can squat it)
    const sh = x => crypto.createHash("sha256").update(String(x)).digest();
    if (!(typeof pass === "string" && crypto.timingSafeEqual(sh(pass), sh(ADMIN_PASS)))) {
      const n = (f ? f.count : 0) + 1;
      failed.set(key, n >= 5 ? { count: 0, until: now + 60000 } : { count: n, until: 0 });
      return { err: "Wrong password for that username." };
    }
    failed.delete(key);
    let a = accounts[key];
    if (!a) { const salt = crypto.randomBytes(16).toString("hex"); a = accounts[key] = { name: name, salt: salt, hash: hashPw(pass, salt).toString("hex"), skin: null, created: now }; saveAccounts(); }
    const h = validSkin(skinHint); if (!a.skin && h) { a.skin = h; saveAccounts(); }
    return { key: key, acc: a, admin: true, owner: true };
  }
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
  return { key: key, acc: acc, admin: !!acc.op };        // acc.op = promoted by the owner with /op
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
const info = p => ({ id: p.id, name: p.name, skin: p.skin, voice: p.voice, adm: p.admin ? 1 : 0, size: p.mods ? p.mods.size : 1 });
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

// ---------- shared map generators (identical to the ones in index.html) ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Parkour: a long chain of platforms heading toward -Z, getting harder (bigger gaps) as it goes.
function parkourData() {
  const rnd = mulberry32(777), R = (a, b) => a + rnd() * (b - a);
  const plats = [{ x: 0, y: -0.5, z: 0, w: 10, h: 1, d: 10, top: 0, kind: "start", i: 0 }];
  const cps = [{ x: 0, z: 0, top: 0 }];
  let px = 0, ptop = 0, pfront = -5;
  for (let i = 1; i <= 46; i++) {
    const k = rnd(); let w, d, kind;
    if (k < 0.55) { w = R(3.5, 6); d = R(3.5, 6); kind = "block"; }
    else if (k < 0.75) { w = R(2.2, 3); d = R(2.2, 3); kind = "small"; }
    else if (k < 0.95) { w = 1.6; d = R(7, 10); kind = "beam"; }
    else { w = R(7, 9); d = R(7, 9); kind = "wide"; }
    const gap = Math.min(4.6, R(2.2, 3.2) + i * 0.04);
    const top = ptop + R(-0.4, 0.9);
    const x = Math.max(-16, Math.min(16, px + R(-3.5, 3.5)));
    const z = pfront - gap - d / 2;
    plats.push({ x: x, y: top - 0.5, z: z, w: w, h: 1, d: d, top: top, kind: kind, i: i });
    px = x; ptop = top; pfront = z - d / 2;
    if (i % 10 === 0) cps.push({ x: x, z: z, top: top });
  }
  const fz = pfront - 3 - 6, ftop = ptop + 0.3;
  plats.push({ x: 0, y: ftop - 0.5, z: fz, w: 14, h: 1, d: 12, top: ftop, kind: "finish", i: 47 });
  return { plats: plats, cps: cps, finish: { x: 0, z: fz, top: ftop, w: 14, d: 12 } };
}
// Race track: a rounded rectangle. pts = centre line, gates = checkpoints, pads = boost pads (axis aligned).
function trackData() {
  const A = 70, B = 45, RC = 26, STEP = 1.6, cx = A - RC, cz = B - RC;
  const pts = [];
  const straight = (x0, z0, x1, z1) => {
    const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / STEP)), dx = (x1 - x0) / L, dz = (z1 - z0) / L;
    for (let i = 0; i < n; i++) pts.push({ x: x0 + (x1 - x0) * i / n, z: z0 + (z1 - z0) * i / n, dx: dx, dz: dz });
  };
  const arc = (ox, oz, a0, a1) => {
    const n = Math.max(1, Math.round(Math.abs(a1 - a0) * RC / STEP));
    for (let i = 0; i < n; i++) {
      const a = a0 + (a1 - a0) * i / n;
      pts.push({ x: ox + RC * Math.cos(a), z: oz + RC * Math.sin(a), dx: -Math.sin(a), dz: Math.cos(a) });
    }
  };
  const H = Math.PI / 2;
  straight(0, -B, cx, -B);   arc(cx, -cz, -H, 0);
  straight(A, -cz, A, cz);   arc(cx, cz, 0, H);
  straight(cx, B, -cx, B);   arc(-cx, cz, H, 2 * H);
  straight(-A, cz, -A, -cz); arc(-cx, -cz, 2 * H, 3 * H);
  straight(-cx, -B, 0, -B);
  const gates = [];
  for (let k = 0; k < 8; k++) gates.push(pts[Math.round(k * pts.length / 8) % pts.length]);
  const pads = [
    { x0: 18, x1: 24, z0: -B - 7, z1: -B + 7, dx: 1, dz: 0 },
    { x0: A - 7, x1: A + 7, z0: -3, z1: 3, dx: 0, dz: 1 },
    { x0: -24, x1: -18, z0: B - 7, z1: B + 7, dx: -1, dz: 0 },
    { x0: -A - 7, x1: -A + 7, z0: -3, z1: 3, dx: 0, dz: -1 }
  ];
  return { pts: pts, gates: gates, pads: pads, A: A, B: B, W: 22 };
}
// City: a 9x9 grid of towers (the middle cell is an open plaza).
function cityData() {
  const rnd = mulberry32(4242), R = (a, b) => a + rnd() * (b - a), out = [], CELL = 46;
  for (let gx = -4; gx <= 4; gx++) for (let gz = -4; gz <= 4; gz++) {
    const w = R(20, 29), d = R(20, 29), core = Math.abs(gx) <= 1 && Math.abs(gz) <= 1;
    const h = core ? R(95, 150) : R(28, 95), ox = R(-3, 3), oz = R(-3, 3), c = Math.floor(rnd() * 5);
    if (gx === 0 && gz === 0) continue;
    out.push({ cx: gx * CELL + ox, cz: gz * CELL + oz, w: w, d: d, h: h, c: c });
  }
  return out;
}
// Battle royale island (radius 120): houses with doors, trees, rocks, loot spots, drop spawns.
// The SERVER uses these same boxes to decide whether a bullet is blocked by a wall.
function brData() {
  const rnd = mulberry32(2024), R = (a, b) => a + rnd() * (b - a);
  const boxes = [], houses = [], trees = [], rocks = [], loot = [], spawns = [];
  const T = 0.4, H = 3.2, DW = 2.4, DH = 2.5;
  const add = (cx, cy, cz, sx, sy, sz, kind) => boxes.push({ x0: cx - sx / 2, y0: cy - sy / 2, z0: cz - sz / 2, x1: cx + sx / 2, y1: cy + sy / 2, z1: cz + sz / 2, kind: kind });
  const wall = (isX, fixed, c, len, door) => {
    const seg = (a0, a1, y0, y1) => {
      if (a1 - a0 < 0.01) return;
      const mid = (a0 + a1) / 2, l = a1 - a0, hy = (y0 + y1) / 2, sy = y1 - y0;
      if (isX) add(mid, hy, fixed, l, sy, T, "wall"); else add(fixed, hy, mid, T, sy, l, "wall");
    };
    const a0 = c - len / 2, a1 = c + len / 2;
    if (door === null) seg(a0, a1, 0, H);
    else { const g0 = c + door - DW / 2, g1 = c + door + DW / 2; seg(a0, g0, 0, H); seg(g1, a1, 0, H); seg(g0, g1, DH, H); }
  };
  for (let gx = -2; gx <= 2; gx++) for (let gz = -2; gz <= 2; gz++) {
    const skip = rnd() < 0.35, w = R(9, 13), d = R(9, 12), cx = gx * 44 + R(-5, 5), cz = gz * 44 + R(-5, 5), ds = Math.floor(rnd() * 4);
    const mx = w / 2 - DW / 2 - 1, mz = d / 2 - DW / 2 - 1, oN = R(-mx, mx), oS = R(-mx, mx), oE = R(-mz, mz), oW = R(-mz, mz);
    const l1 = { x: R(-w / 2 + 2, w / 2 - 2), z: R(-d / 2 + 2, d / 2 - 2) }, l2 = { x: R(-w / 2 + 2, w / 2 - 2), z: R(-d / 2 + 2, d / 2 - 2) };
    if (skip || (gx === 0 && gz === 0)) continue;
    wall(true, cz - d / 2, cx, w, ds === 0 ? oN : null); wall(true, cz + d / 2, cx, w, ds === 1 ? oS : null);
    wall(false, cx + w / 2, cz, d, ds === 2 ? oE : null); wall(false, cx - w / 2, cz, d, ds === 3 ? oW : null);
    add(cx, H + 0.15, cz, w + 0.6, 0.3, d + 0.6, "roof");
    houses.push({ cx: cx, cz: cz, w: w, d: d, h: H });
    loot.push({ x: cx + l1.x, z: cz + l1.z }, { x: cx + l2.x, z: cz + l2.z });
  }
  const nearHouse = (x, z, m) => houses.some(b => Math.abs(x - b.cx) < b.w / 2 + m && Math.abs(z - b.cz) < b.d / 2 + m);
  for (let i = 0; i < 100; i++) {
    const a = R(0, 6.283), r = Math.sqrt(rnd()) * 112, x = Math.sin(a) * r, z = Math.cos(a) * r, s = R(0.8, 1.4);
    if (nearHouse(x, z, 4) || Math.hypot(x, z) < 8) continue;
    add(x, 2 * s, z, 0.6 * s, 4 * s, 0.6 * s, "trunk"); trees.push({ x: x, z: z, s: s });
  }
  for (let i = 0; i < 26; i++) {
    const a = R(0, 6.283), r = Math.sqrt(rnd()) * 110, x = Math.sin(a) * r, z = Math.cos(a) * r, rr = R(1, 2.4), rot = R(0, 6.28);
    if (nearHouse(x, z, 3) || Math.hypot(x, z) < 8) continue;
    add(x, 0.6 * rr, z, 1.5 * rr, 1.2 * rr, 1.5 * rr, "rock"); rocks.push({ x: x, z: z, r: rr, rot: rot });
  }
  for (let i = 0; i < 26; i++) {
    const a = R(0, 6.283), r = Math.sqrt(rnd()) * 105, x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!nearHouse(x, z, 1.5)) loot.push({ x: x, z: z });
  }
  let tries = 0;
  while (spawns.length < 32 && tries++ < 400) {
    const a = R(0, 6.283), r = Math.sqrt(rnd()) * 100, x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!nearHouse(x, z, 2)) spawns.push({ x: x, z: z });
  }
  return { boxes: boxes, houses: houses, trees: trees, rocks: rocks, loot: loot, spawns: spawns, radius: 120 };
}
// Everything in the hub that can be removed with /remove (and brought back with /restore)
function hubDecor() {
  const out = [], rnd = mulberry32(99);
  for (let i = 0; i < 26; i++) { const a = rnd() * 6.283, r = 34 + rnd() * 18, s = 0.9 + rnd() * 0.7; out.push({ id: "h-t" + i, type: "tree", x: Math.sin(a) * r, z: Math.cos(a) * r, rot: 0, s: s }); }
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + 0.5; out.push({ id: "h-b" + i, type: "bench", x: Math.sin(a) * 22, z: Math.cos(a) * 22, rot: a, s: 1 }); }
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + 0.2; out.push({ id: "h-l" + i, type: "lamp", x: Math.sin(a) * 25.5, z: Math.cos(a) * 25.5, rot: 0, s: 1 }); }
  return out;
}
const PCOL = { red: 0xe84a4a, orange: 0xff8a1f, yellow: 0xffd34d, green: 0x3ecf6a, cyan: 0x3acfe0, blue: 0x3a7aff, purple: 0x9a5cff, pink: 0xff6bd6, white: 0xf4f4f4, black: 0x222633, gray: 0x9aa0b5, brown: 0x8a5a33 };
const PROP_TYPES = ["tree", "pine", "bush", "rock", "crate", "wall", "pillar", "platform", "lamp", "bench", "block"];

// ---------- BUILT / REMOVED OBJECTS (the owner's /build and /remove), saved in props.json ----------
const PROPS_FILE = path.join(path.dirname(DATA_FILE), "props.json");
let propsDb = { next: 1, props: {}, removed: { hub: [] } };
try { propsDb = Object.assign(propsDb, JSON.parse(fs.readFileSync(PROPS_FILE, "utf8"))); } catch (e) { }
for (const w of WORLDS) if (!Array.isArray(propsDb.props[w])) propsDb.props[w] = [];
if (!propsDb.removed || !Array.isArray(propsDb.removed.hub)) propsDb.removed = { hub: [] };
let propsTimer = null;
function saveProps() {
  if (propsTimer) return;
  propsTimer = setTimeout(() => {
    propsTimer = null;
    try { fs.mkdirSync(path.dirname(PROPS_FILE), { recursive: true }); fs.writeFileSync(PROPS_FILE + ".tmp", JSON.stringify(propsDb)); fs.renameSync(PROPS_FILE + ".tmp", PROPS_FILE); }
    catch (e) { console.log("could not save props: " + e.message); }
  }, 1000);
}
const HUB_DECOR = hubDecor(), MAX_PROPS = 500;
const propInfo = w => ({ props: propsDb.props[w] || [], rm: w === "hub" ? propsDb.removed.hub : [] });   // sent whenever you enter a world

// ---------- BATTLE ROYALE ----------
// The server decides everything: who is alive, loot pickups, bullet hits (against walls AND players),
// damage, and the shrinking zone. Clients only send "I shot in this direction" / "I walked over item N".
const BR = brData();
const BR_CD = Number(process.env.BR_COUNTDOWN_MS) || 20000;          // lobby countdown once 2+ players are waiting
const WEAPONS = {
  pistol:  { dmg: 20, iv: 260, range: 70,  pellets: 1, spread: 0.012, ammo: 30 },
  rifle:   { dmg: 13, iv: 105, range: 100, pellets: 1, spread: 0.022, ammo: 60 },
  shotgun: { dmg: 9,  iv: 850, range: 30,  pellets: 8, spread: 0.09,  ammo: 10 }
};
const ZONE_PLAN = [[115, 115, 40], [115, 75, 25], [75, 75, 25], [75, 45, 25], [45, 45, 20], [45, 22, 20], [22, 22, 15], [22, 8, 20], [8, 8, 10], [8, 0, 30]];  // radius from, to, seconds
const LOOT_BAG = ["pistol", "pistol", "pistol", "rifle", "shotgun", "shotgun", "heal", "heal", "heal", "ammo", "ammo", "ammo"];
const brRoom = { phase: "lobby", cdAt: 0, endAt: 0, winner: null, players: new Map(), segs: [], loot: new Map(), nextLoot: 1, test: false };

function rayBox(ox, oy, oz, dx, dy, dz, b) {
  let t0 = 0, t1 = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz], lo = [b.x0, b.y0, b.z0], hi = [b.x1, b.y1, b.z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo[i] || o[i] > hi[i]) return Infinity; }
    else {
      let a = (lo[i] - o[i]) / d[i], c = (hi[i] - o[i]) / d[i];
      if (a > c) { const t = a; a = c; c = t; }
      if (a > t0) t0 = a; if (c < t1) t1 = c;
      if (t0 > t1) return Infinity;
    }
  }
  return t0;
}
const brAliveIds = () => { const a = []; for (const [id, b] of brRoom.players) if (b.alive) a.push(id); return a; };
function curSeg(now) { for (const g of brRoom.segs) if (now < g.t1) return g; return brRoom.segs[brRoom.segs.length - 1] || null; }
const lootList = () => [...brRoom.loot.values()].map(l => [l.id, l.type, rnd2(l.x), l.y, rnd2(l.z)]);
function brState(extra) {
  const now = Date.now(), o = { t: "br", ph: brRoom.phase, cd: brRoom.cdAt, n: now, alive: brAliveIds(), zone: brRoom.phase === "live" ? curSeg(now) : null };
  if (brRoom.phase === "over") o.winner = brRoom.winner || "Nobody";
  return Object.assign(o, extra || {});
}
const brBroadcast = extra => toWorld("br", brState(extra));
function brPrivate(id) {                                  // your own health / weapons / ammo
  const bp = brRoom.players.get(id), p = players.get(id); if (!bp || !p) return;
  send(p.ws, { t: "brs", hp: Math.max(0, Math.round(bp.hp)), cur: bp.cur, weps: bp.weps });
}
function sendBrState(p) { const extra = {}; if (brRoom.phase === "live") extra.loot = lootList(); send(p.ws, brState(extra)); brPrivate(p.id); }

function brStart(force) {
  const ids = [...rooms.br.ids];
  brRoom.test = !!force && ids.length < 2;                 // a forced solo match never ends by itself (use /brend)
  if (ids.length < (force ? 1 : 2)) { brRoom.cdAt = 0; brBroadcast(); return; }
  const now = Date.now();
  brRoom.players.clear(); brRoom.loot.clear(); brRoom.nextLoot = 1;
  const spawns = BR.spawns.slice().sort(() => Math.random() - 0.5), drop = {};
  ids.forEach((id, i) => {
    brRoom.players.set(id, { hp: 100, alive: true, kills: 0, weps: {}, cur: null, lastShot: 0 });
    const sp = spawns[i % spawns.length]; drop[id] = [rnd2(sp.x), rnd2(sp.z)];
  });
  const ang = Math.random() * 6.283, off = Math.random() * 35, cx = Math.cos(ang) * off, cz = Math.sin(ang) * off;
  let t = now;
  brRoom.segs = ZONE_PLAN.map(p => { const g = { cx: rnd2(cx), cz: rnd2(cz), r0: p[0], r1: p[1], t0: t, t1: t + p[2] * 1000 }; t = g.t1; return g; });
  for (const spot of BR.loot) {
    const id = brRoom.nextLoot++;
    brRoom.loot.set(id, { id: id, type: LOOT_BAG[Math.floor(Math.random() * LOOT_BAG.length)], x: spot.x, y: 0.8, z: spot.z });
  }
  brRoom.phase = "live"; brRoom.cdAt = 0;
  brBroadcast({ start: true, drop: drop, loot: lootList() });
  for (const id of ids) brPrivate(id);
  toWorld("br", { t: "feed", m: "The match has begun! " + ids.length + " players dropped in." });
}
function brCheckEnd() {
  if (brRoom.phase !== "live") return;
  const alive = brAliveIds();
  if (alive.length > 1 || (brRoom.test && alive.length === 1)) return;
  const wp = alive.length ? players.get(alive[0]) : null;
  brRoom.winner = wp ? wp.name : "Nobody"; brRoom.phase = "over"; brRoom.endAt = Date.now() + 9000;
  brBroadcast();
  toWorld("br", { t: "feed", m: "🏆 " + brRoom.winner + " wins the match!" });
}
function brKill(id, killerId, cause) {
  const bp = brRoom.players.get(id); if (!bp || !bp.alive) return;
  bp.alive = false; bp.hp = 0;
  const p = players.get(id), k = killerId ? players.get(killerId) : null, kb = killerId ? brRoom.players.get(killerId) : null;
  if (kb) kb.kills++;
  if (p) { send(p.ws, { t: "brdead", by: k ? k.name : (cause || null) }); brPrivate(id); }
  const victim = p ? p.name : "Someone";
  toWorld("br", { t: "feed", m: k ? k.name + " eliminated " + victim : victim + " was eliminated" + (cause ? " (" + cause + ")" : "") });
  brBroadcast(); brCheckEnd();
}
function brLeave(id) { const bp = brRoom.players.get(id); if (bp && bp.alive && brRoom.phase === "live") brKill(id, null, "left the match"); }

function brTick() {
  const now = Date.now();
  if (brRoom.phase === "lobby") {
    const n = rooms.br.ids.size;
    if (n >= 2) { if (!brRoom.cdAt) { brRoom.cdAt = now + BR_CD; brBroadcast(); } else if (now >= brRoom.cdAt) brStart(); }
    else if (brRoom.cdAt) { brRoom.cdAt = 0; brBroadcast(); }
  } else if (brRoom.phase === "live") {
    const seg = curSeg(now), idx = brRoom.segs.indexOf(seg), dps = 1 + Math.floor(idx / 2) * 2;      // storm hurts more each stage
    const r = seg.r0 + (seg.r1 - seg.r0) * Math.min(1, Math.max(0, (now - seg.t0) / (seg.t1 - seg.t0)));
    for (const [id, bp] of brRoom.players) {
      if (!bp.alive) continue;
      const p = players.get(id); if (!p) { brKill(id, null, "disconnected"); continue; }
      if (p.mods.god) continue;
      if (Math.hypot(p.st[0] - seg.cx, p.st[2] - seg.cz) > r) { bp.hp -= dps * 0.2; if (bp.hp <= 0) brKill(id, null, "the storm"); else brPrivate(id); }
    }
    brCheckEnd();
  } else if (brRoom.phase === "over" && now >= brRoom.endAt) {
    brRoom.phase = "lobby"; brRoom.players.clear(); brRoom.loot.clear(); brRoom.segs = []; brRoom.cdAt = 0; brRoom.test = false;
    brBroadcast();
  }
}
setInterval(brTick, 200);

// Where was this player ~150 ms ago? (We aim at what the shooter SAW, which is a little in the past.)
function posAt(q, t) { const h = q.hist; for (let i = h.length - 1; i >= 0; i--) if (h[i][0] <= t) return h[i]; return h.length ? h[0] : [0, q.st[0], q.st[1], q.st[2]]; }
function brShoot(p, m) {
  if (brRoom.phase !== "live" || p.world !== "br") return;
  const bp = brRoom.players.get(p.id); if (!bp || !bp.alive || !bp.cur) return;
  const wd = WEAPONS[bp.cur], now = Date.now();
  if (now - bp.lastShot < wd.iv * 0.85 || (bp.weps[bp.cur] || 0) <= 0) return;               // fire-rate + ammo are enforced here
  if (!Array.isArray(m.o) || !Array.isArray(m.d) || m.o.length < 3 || m.d.length < 3) return;
  const ox = num(m.o[0], -2000, 2000), oy = num(m.o[1], -200, 600), oz = num(m.o[2], -2000, 2000);
  let dx = num(m.d[0], -1, 1), dy = num(m.d[1], -1, 1), dz = num(m.d[2], -1, 1); const l = Math.hypot(dx, dy, dz);
  if (l < 0.5) return; dx /= l; dy /= l; dz /= l;
  if (Math.hypot(ox - p.st[0], oy - (p.st[1] + 1.5), oz - p.st[2]) > 4) return;              // the shot must start at the shooter
  bp.lastShot = now; bp.weps[bp.cur]--;
  const targets = [];
  for (const [id, tb] of brRoom.players) { if (id === p.id || !tb.alive) continue; const q = players.get(id); if (q) targets.push({ id: id, q: q, tb: tb }); }
  const rewind = now - 150, dmg = new Map(); let firstEnd = null;
  for (let i = 0; i < wd.pellets; i++) {
    let px = dx + (Math.random() - 0.5) * 2 * wd.spread, py = dy + (Math.random() - 0.5) * 2 * wd.spread, pz = dz + (Math.random() - 0.5) * 2 * wd.spread;
    const pl = Math.hypot(px, py, pz); px /= pl; py /= pl; pz /= pl;
    let wallT = wd.range;
    for (const b of BR.boxes) { const t = rayBox(ox, oy, oz, px, py, pz, b); if (t > 0.01 && t < wallT) wallT = t; }       // walls stop bullets
    let bestT = wallT, best = null;
    for (const tg of targets) {
      const pos = posAt(tg.q, rewind);
      const sz = tg.q.mods.size || 1, t = rayBox(ox, oy, oz, px, py, pz, { x0: pos[1] - 0.55 * sz, x1: pos[1] + 0.55 * sz, y0: pos[2], y1: pos[2] + 1.95 * sz, z0: pos[3] - 0.55 * sz, z1: pos[3] + 0.55 * sz });
      if (t >= 0 && t < bestT) { bestT = t; best = { tg: tg, pos: pos }; }
    }
    const end = [ox + px * bestT, oy + py * bestT, oz + pz * bestT];
    if (i === 0) firstEnd = end;
    if (best) {
      const head = end[1] > best.pos[2] + 1.45 * (best.tg.q.mods.size || 1), e = dmg.get(best.tg.id) || { tg: best.tg, dmg: 0, head: false };
      e.dmg += wd.dmg * (head ? 2 : 1); e.head = e.head || head; dmg.set(best.tg.id, e);        // headshots do double damage
    }
  }
  toWorld("br", { t: "shot", id: p.id, o: [rnd2(ox), rnd2(oy), rnd2(oz)], e: firstEnd.map(rnd2) });
  let hs = false;
  for (const e of dmg.values()) { if (e.tg.q.mods.god) continue; e.tg.tb.hp -= e.dmg; hs = hs || e.head; if (e.tg.tb.hp <= 0) brKill(e.tg.id, p.id); else brPrivate(e.tg.id); }
  if (dmg.size) send(p.ws, { t: "hit", hs: hs });
  brPrivate(p.id);
}
function brPick(p, id) {
  if (brRoom.phase !== "live") return;
  const bp = brRoom.players.get(p.id), it = brRoom.loot.get(id); if (!bp || !bp.alive || !it) return;
  if (Math.hypot(p.st[0] - it.x, p.st[2] - it.z) > 4.5 || Math.abs(p.st[1] - it.y) > 5) return;      // you must actually be next to it
  brRoom.loot.delete(id); toWorld("br", { t: "lootgone", id: id });
  let tip;
  if (WEAPONS[it.type]) { bp.weps[it.type] = (bp.weps[it.type] || 0) + WEAPONS[it.type].ammo; if (!bp.cur) bp.cur = it.type; tip = "Picked up: " + it.type; }
  else if (it.type === "heal") { bp.hp = Math.min(100, bp.hp + 40); tip = "+40 health"; }
  else { let any = false; for (const k in bp.weps) { bp.weps[k] += Math.ceil(WEAPONS[k].ammo * 0.6); any = true; } tip = any ? "Ammo restocked" : "Ammo (find a weapon first)"; }
  send(p.ws, { t: "tip", m: tip }); brPrivate(p.id);
}

// ---------- DEVELOPER COMMANDS (only for the account set by ADMIN_USER / ADMIN_PASS) ----------
const sys = (p, m) => send(p.ws, { t: "sys", m: m });
function findPlayer(q, self) {                                 // name, or the start of a name; blank/"me" = yourself
  if (!q || q.toLowerCase() === "me") return self;
  q = q.toLowerCase(); let exact = null, pre = null;
  for (const pl of players.values()) { const n = pl.name.toLowerCase(); if (n === q) exact = pl; else if (n.startsWith(q) && !pre) pre = pl; }
  return exact || pre;
}
function setMods(t, patch) {                                   // fly / speed / etc. run on the player's own device; we just tell it
  Object.assign(t.mods, patch);
  if (patch.noclip) t.mods.fly = true;
  if (patch.fly === false) t.mods.noclip = false;
  send(t.ws, { t: "admin", mods: t.mods });
  if (patch.size !== undefined) toWorld(t.world, { t: "size", id: t.id, s: t.mods.size }, t.id);   // everyone else sees you grow / shrink
}
function changeWorld(p, w) {
  if (!WORLDS.includes(w) || w === p.world) return false;
  moveToWorld(p, w);
  send(p.ws, Object.assign({ t: "world", w: w, players: worldPlayers(w, p.id), lb: lbAll() }, propInfo(w)));
  if (w === "br") sendBrState(p);
  return true;
}
function brForceEnd() {
  if (brRoom.phase !== "live") return false;
  brRoom.test = false; brRoom.winner = "Nobody (ended by admin)"; brRoom.phase = "over"; brRoom.endAt = Date.now() + 4000;
  brBroadcast(); return true;
}
function adminCommand(p, text) {
  const parts = text.slice(1).trim().split(/\s+/), cmd = (parts.shift() || "").toLowerCase();
  const onoff = () => (parts[0] && /^(on|off)$/i.test(parts[0])) ? parts.shift().toLowerCase() === "on" : null;
  const target = q => {
    const t = findPlayer(q, p); if (!t) { sys(p, "No player matching '" + q + "'."); return null; }
    if (t.owner && !p.owner) { sys(p, "You can't use commands on the owner."); return null; }
    return t;
  };
  const live = t => { const bp = brRoom.players.get(t.id); return (brRoom.phase === "live" && bp && bp.alive) ? bp : null; };
  switch (cmd) {
    case "help":
      sys(p, "DEV COMMANDS  ·  /webshooters [on|off] [name]  ·  /car [on|off] [name]  ·  /fly [on|off] [name]  ·  /noclip [on|off] [name]  ·  /speed <n> [name]  ·  /jump <n> [name]  ·  /god [on|off] [name]  ·  /freeze <name>  ·  /unfreeze <name>  ·  /reset [name]");
      sys(p, "/size <0.2-8> [name]  ·  OWNER BUILDING: /build <" + PROP_TYPES.join("|") + "> [color] [size]  ·  /remove [type]  ·  /remove all [radius]  ·  /undo  ·  /clearprops  ·  /restore  ·  /props");
      sys(p, "/kill <name|all|me>  ·  /heal [name]  ·  /give <pistol|rifle|shotgun|all> [name]  ·  /ammo [name]  ·  /launch [name] [power]  ·  /kick <name>");
      sys(p, "/tp <name>  ·  /bring <name|all>  ·  /world <hub|parkour|race|city|br> [name]  ·  /brstart  ·  /brend  ·  /players  ·  /say <message>");
      if (p.owner) sys(p, "OWNER ONLY  ·  /op <name>  (make an existing account a developer)  ·  /deop <name>  ·  /ops  (list developers)");
      break;
    case "op": case "deop": {
      if (!p.owner) { sys(p, "Only the owner account can do that."); break; }
      if (!parts[0]) { sys(p, "Usage: /" + cmd + " <exact username>"); break; }
      const key = cleanNameStr(parts[0]).toLowerCase(), acc = accounts[key];
      if (!acc) { sys(p, "There's no account called '" + parts[0] + "'. They need to join once and create their account first."); break; }
      if (key === ADMIN_KEY) { sys(p, "That's you."); break; }
      const on = cmd === "op"; acc.op = on; saveAccounts();
      const t = [...players.values()].find(x => x.key === key);
      if (t) {                                              // they're online: switch it on/off right now
        t.admin = on; if (!on) setMods(t, { fly: false, noclip: false, speed: 1, jump: 1, freeze: false, god: false, size: 1, web: false, car: false });
        send(t.ws, { t: "dev", on: on ? 1 : 0, self: 1 }); toWorld(t.world, { t: "dev", id: t.id, on: on ? 1 : 0 }, t.id);
      }
      sys(p, acc.name + (on ? " is now a developer." : " is no longer a developer.")); break;
    }
    case "ops": {
      const list = Object.keys(accounts).filter(k => accounts[k].op).map(k => accounts[k].name);
      sys(p, "Owner: " + (accounts[ADMIN_KEY] ? accounts[ADMIN_KEY].name : ADMIN_KEY) + "  ·  Developers: " + (list.length ? list.join(", ") : "none yet")); break;
    }
    case "players": sys(p, "Online (" + players.size + "): " + [...players.values()].map(x => x.name + " [" + x.world + "]").join(", ")); break;
    case "fly": case "noclip": {
      const v = onoff(), t = target(parts[0]); if (!t) break;
      const nv = v === null ? !t.mods[cmd] : v; setMods(t, { [cmd]: nv }); sys(p, cmd + " " + (nv ? "ON" : "OFF") + " for " + t.name + (cmd === "fly" && nv ? "  (W/S follow your look direction, Space up, C down)" : "")); break;
    }
    case "size": {
      const n = parseFloat(parts[0]); if (!(n >= 0.2 && n <= 8)) { sys(p, "Usage: /size <0.2 to 8> [name]   (1 = normal, /size 1 resets)"); break; }
      const t = target(parts[1]); if (!t) break; setMods(t, { size: n }); sys(p, t.name + " is now size " + n); break;
    }
    case "build": {
      if (!p.owner) { sys(p, "Only the owner account can build."); break; }
      const type = (parts.shift() || "").toLowerCase();
      if (!PROP_TYPES.includes(type)) { sys(p, "Usage: /build <" + PROP_TYPES.join("|") + "> [color] [size]"); break; }
      let sc = 1, col = null;
      for (const a of parts) {
        const n = parseFloat(a);
        if (!isNaN(n)) sc = Math.max(0.3, Math.min(6, n));
        else if (PCOL[a.toLowerCase()] !== undefined) col = a.toLowerCase();
        else { sys(p, "Unknown color '" + a + "'. Colors: " + Object.keys(PCOL).join(", ")); sc = null; break; }
      }
      if (sc === null) break;
      const list = propsDb.props[p.world];
      if (list.length >= MAX_PROPS) { sys(p, "This world already has " + MAX_PROPS + " built objects. Use /remove or /clearprops."); break; }
      const yaw = p.st[3], dist = 3.5 + sc * 1.2;
      const d = { id: "p" + (propsDb.next++), type: type, x: rnd2(p.st[0] - Math.sin(yaw) * dist), y: rnd2(p.st[1]), z: rnd2(p.st[2] - Math.cos(yaw) * dist), rot: rnd2(yaw), s: sc, c: col, by: p.key };
      list.push(d); saveProps(); toWorld(p.world, { t: "prop", op: "add", p: d });
      sys(p, "Built a " + type + " in front of you. /undo takes back your last build, /remove deletes the nearest object."); break;
    }
    case "remove": {
      if (!p.owner) { sys(p, "Only the owner account can remove things."); break; }
      const w = p.world, custom = propsDb.props[w], cand = custom.map(d => ({ d: d, custom: true }));
      if (w === "hub") for (const d of HUB_DECOR) if (!propsDb.removed.hub.includes(d.id)) cand.push({ d: d, custom: false });
      const dist = d => Math.hypot(d.x - p.st[0], d.z - p.st[2]), found = [], a0 = (parts[0] || "").toLowerCase();
      if (a0 === "all") { const r = Math.max(2, Math.min(80, parseFloat(parts[1]) || 15)); for (const c of cand) if (dist(c.d) <= r) found.push(c); }
      else { let best = null, bd = 12; for (const c of cand) { if (a0 && c.d.type !== a0) continue; const dd = dist(c.d); if (dd < bd) { bd = dd; best = c; } } if (best) found.push(best); }
      if (!found.length) { sys(p, "Nothing found. Stand within 12 m of it, or use /remove all <radius> (default 15 m)."); break; }
      for (const c of found) {
        if (c.custom) custom.splice(custom.indexOf(c.d), 1); else propsDb.removed.hub.push(c.d.id);
        toWorld(w, { t: "prop", op: "del", id: c.d.id });
      }
      saveProps(); sys(p, "Removed " + found.length + " object(s). (/restore brings back removed hub decorations)"); break;
    }
    case "undo": {
      if (!p.owner) { sys(p, "Only the owner account can build."); break; }
      const list = propsDb.props[p.world]; let i = list.length - 1; while (i >= 0 && list[i].by !== p.key) i--;
      if (i < 0) { sys(p, "You haven't built anything in this world."); break; }
      const d = list.splice(i, 1)[0]; saveProps(); toWorld(p.world, { t: "prop", op: "del", id: d.id }); sys(p, "Took back your " + d.type + "."); break;
    }
    case "clearprops": {
      if (!p.owner) { sys(p, "Only the owner account can do that."); break; }
      const n = propsDb.props[p.world].length; propsDb.props[p.world] = []; saveProps(); toWorld(p.world, { t: "prop", op: "clear" }); sys(p, "Removed all " + n + " built objects in this world."); break;
    }
    case "restore": {
      if (!p.owner) { sys(p, "Only the owner account can do that."); break; }
      propsDb.removed.hub = []; saveProps(); toWorld("hub", { t: "prop", op: "restore" }); sys(p, "Hub decorations restored."); break;
    }
    case "props": sys(p, "Built objects in this world: " + propsDb.props[p.world].length + (p.world === "hub" ? "  ·  removed hub decorations: " + propsDb.removed.hub.length : "")); break;
    case "speed": case "jump": {
      const n = parseFloat(parts[0]); if (!(n >= 0.1 && n <= 20)) { sys(p, "Usage: /" + cmd + " <0.1 to 20> [name]"); break; }
      const t = target(parts[1]); if (!t) break; setMods(t, { [cmd]: n }); sys(p, cmd + " x" + n + " for " + t.name); break;
    }
    case "webshooters": case "webs": case "car": {
      const key = cmd === "car" ? "car" : "web", v = onoff(), t = target(parts[0]); if (!t) break;
      const nv = v === null ? !t.mods[key] : v; setMods(t, { [key]: nv });
      sys(p, (key === "car" ? "Car" : "Webshooters") + " " + (nv ? "ON" : "OFF") + " for " + t.name + (nv ? (key === "car" ? "  (W/S gas + brake, A/D steer, Space handbrake. /car again to get out)" : "  (hold left click or F to swing; Shift reels in; the web sticks to any object)") : ""));
      break;
    }
    case "god": { const v = onoff(), t = target(parts[0]); if (!t) break; const nv = v === null ? !t.mods.god : v; setMods(t, { god: nv }); sys(p, "god mode " + (nv ? "ON" : "OFF") + " for " + t.name + " (battle royale damage)"); break; }
    case "freeze": case "unfreeze": { const t = target(parts[0]); if (!t) break; setMods(t, { freeze: cmd === "freeze" }); sys(p, t.name + (cmd === "freeze" ? " frozen" : " unfrozen")); break; }
    case "reset": { const t = target(parts[0]); if (!t) break; setMods(t, { fly: false, noclip: false, speed: 1, jump: 1, freeze: false, god: false, size: 1, web: false, car: false }); sys(p, "Reset effects for " + t.name); break; }
    case "kill": {
      if (!parts[0]) { sys(p, "Usage: /kill <name|all|me>"); break; }
      let list;
      if (parts[0].toLowerCase() === "all") list = [...players.values()].filter(x => x.world === p.world && x.id !== p.id && (p.owner || !x.owner));
      else { const t = target(parts[0]); if (!t) break; list = [t]; }
      for (const t of list) { if (live(t)) brKill(t.id, null, "admin"); else send(t.ws, { t: "admin", respawn: 1 }); }   // outside a live match "kill" = send them back to spawn
      sys(p, "Eliminated " + list.length + " player(s)."); break;
    }
    case "heal": { const t = target(parts[0]); if (!t) break; const bp = live(t); if (bp) { bp.hp = 100; brPrivate(t.id); sys(p, "Healed " + t.name); } else sys(p, t.name + " isn't alive in a live battle royale."); break; }
    case "give": {
      const w = (parts[0] || "").toLowerCase(), names = w === "all" ? Object.keys(WEAPONS) : [w];
      if (!names.every(n => WEAPONS[n])) { sys(p, "Usage: /give <pistol|rifle|shotgun|all> [name]"); break; }
      const t = target(parts[1]); if (!t) break; const bp = live(t); if (!bp) { sys(p, t.name + " isn't alive in a live battle royale."); break; }
      for (const n of names) { bp.weps[n] = (bp.weps[n] || 0) + WEAPONS[n].ammo * 3; if (!bp.cur) bp.cur = n; }
      brPrivate(t.id); send(t.ws, { t: "tip", m: "Admin gave you: " + names.join(", ") }); sys(p, "Gave " + names.join(", ") + " to " + t.name); break;
    }
    case "ammo": { const t = target(parts[0]); if (!t) break; const bp = live(t); if (!bp) { sys(p, t.name + " isn't alive in a live battle royale."); break; } for (const k in bp.weps) bp.weps[k] += WEAPONS[k].ammo * 3; brPrivate(t.id); sys(p, "Refilled ammo for " + t.name); break; }
    case "launch": {
      let q = parts[0], pw = parts[1]; if (q && !isNaN(parseFloat(q))) { pw = q; q = undefined; }
      const t = target(q); if (!t) break; send(t.ws, { t: "admin", launch: [0, Math.max(5, Math.min(120, parseFloat(pw) || 30)), 0] }); sys(p, "Launched " + t.name); break;
    }
    case "kick": { const t = target(parts[0]); if (!t) break; if (t === p) { sys(p, "You can't kick yourself."); break; } send(t.ws, { t: "feed", m: "You were kicked by an admin." }); setTimeout(() => t.ws.close(), 150); sys(p, "Kicked " + t.name); break; }
    case "tp": {
      const t = target(parts[0]); if (!t || t === p) break;
      if (t.world !== p.world) changeWorld(p, t.world);
      send(p.ws, { t: "admin", tp: [t.st[0], t.st[1] + 0.5, t.st[2]] }); sys(p, "Teleported to " + t.name); break;
    }
    case "bring": {
      if (!parts[0]) { sys(p, "Usage: /bring <name|all>"); break; }
      const list = parts[0].toLowerCase() === "all" ? [...players.values()].filter(x => x.id !== p.id && (p.owner || !x.owner)) : [target(parts[0])].filter(Boolean);
      for (const t of list) {
        if (t === p) continue;
        if (t.world !== p.world) changeWorld(t, p.world);
        send(t.ws, { t: "admin", tp: [p.st[0] + (Math.random() - 0.5) * 3, p.st[1] + 0.5, p.st[2] + (Math.random() - 0.5) * 3] });
      }
      sys(p, "Brought " + list.filter(x => x !== p).length + " player(s) to you."); break;
    }
    case "world": {
      const w = (parts[0] || "").toLowerCase(); if (!WORLDS.includes(w)) { sys(p, "Usage: /world <hub|parkour|race|city|br> [name]"); break; }
      const t = target(parts[1]); if (!t) break; if (!changeWorld(t, w)) sys(p, t.name + " is already there."); else sys(p, "Sent " + t.name + " to " + w); break;
    }
    case "brstart":
      if (brRoom.phase !== "lobby") { sys(p, "A match is already running. Use /brend first."); break; }
      if (!rooms.br.ids.size) { sys(p, "Nobody is in the battle royale lobby yet. Use /world br first."); break; }
      brStart(true); sys(p, "Battle royale force-started" + (brRoom.test ? " (solo test: it won't end by itself, use /brend)." : ".")); break;
    case "brend": sys(p, brForceEnd() ? "Match ended." : "There's no live match."); break;
    case "say": { const m = parts.join(" "); if (!m) { sys(p, "Usage: /say <message>"); break; } const msg = JSON.stringify({ t: "feed", m: "📢 " + m }); for (const pl of players.values()) if (pl.ws.readyState === 1) pl.ws.send(msg); break; }
    default: sys(p, "Unknown command. Type /help");
  }
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
  if (p.world === "br") brLeave(p.id);
  p.gone = true;
  rooms[p.world].ids.delete(p.id);
  players.delete(p.id);
  toWorld(p.world, { t: "leave", id: p.id });
  console.log("- " + p.name + " #" + p.id + " (" + players.size + " online)");
}
function moveToWorld(p, world) {
  if (p.world === "br") brLeave(p.id);
  rooms[p.world].ids.delete(p.id);
  toWorld(p.world, { t: "leave", id: p.id });
  p.world = world;
  rooms[world].ids.add(p.id);
  toWorld(world, { t: "join", id: p.id, name: p.name, skin: p.skin, voice: p.voice, adm: p.admin ? 1 : 0, size: p.mods.size }, p.id);
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
            st: [0, 0, 0, 0, 1, 0, 0, 0, 0], voice: 0, lastChat: 0, lastSkin: 0, gone: false, hist: [], admin: !!auth.admin, owner: !!auth.owner, mods: { fly: false, noclip: false, speed: 1, jump: 1, freeze: false, god: false, size: 1, web: false, car: false } };
      players.set(id, p);
      rooms.hub.ids.add(id);
      send(ws, Object.assign({ t: "welcome", id: id, admin: !!auth.admin, name: p.name, skin: p.skin, world: "hub", players: worldPlayers("hub", id), lb: lbAll() }, propInfo("hub")));
      toWorld("hub", { t: "join", id: id, name: p.name, skin: p.skin, voice: 0, adm: p.admin ? 1 : 0 }, id);
      console.log("+ " + p.name + " #" + id + " (" + players.size + " online)");
      return;
    }
    if (!p || p.gone) return;

    switch (m.t) {
      case "st": {                       // [x, y, z, yaw, flags, emote, ax, ay, az]
        const a = m.s;
        if (!Array.isArray(a) || a.length < 9) return;
        p.st = [rnd2(num(a[0], -1500, 1500)), rnd2(num(a[1], -200, 600)), rnd2(num(a[2], -1500, 1500)),
                rnd2(num(a[3], -100, 100)), num(a[4], 0, 15) | 0, num(a[5], 0, 9) | 0,
                rnd2(num(a[6], -1500, 1500)), rnd2(num(a[7], -200, 600)), rnd2(num(a[8], -1500, 1500))];
        p.hist.push([now, p.st[0], p.st[1], p.st[2]]); if (p.hist.length > 25) p.hist.shift();   // position history for lag compensation
        break;
      }
      case "chat": {
        const text = cleanChat(m.m);
        if (!text) return;
        if (p.admin && text[0] === "/") { adminCommand(p, text); return; }     // dev commands skip the chat rate limit
        if (now - p.lastChat < 500) return;                                   // everyone else: 2 messages per second max
        p.lastChat = now;
        toWorld(p.world, { t: "chat", id: p.id, name: p.name, m: text, adm: p.admin ? 1 : 0 });
        break;
      }
      case "world": {
        if (!WORLDS.includes(m.w) || m.w === p.world) return;
        if (rooms[m.w].ids.size >= MAX_PER_WORLD) { send(ws, { t: "feed", m: "That world is full." }); send(ws, Object.assign({ t: "world", w: p.world, players: worldPlayers(p.world, p.id), lb: lbAll(), same: 1 }, propInfo(p.world))); return; }
        moveToWorld(p, m.w);
        send(ws, Object.assign({ t: "world", w: m.w, players: worldPlayers(m.w, p.id), lb: lbAll() }, propInfo(m.w)));
        if (m.w === "br") sendBrState(p);
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
      case "shoot": brShoot(p, m); break;
      case "pick": brPick(p, m.id | 0); break;
      case "wep": { const bp = brRoom.players.get(p.id); if (bp && bp.alive && WEAPONS[m.w] && bp.weps[m.w] !== undefined) { bp.cur = m.w; brPrivate(p.id); } break; }
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
