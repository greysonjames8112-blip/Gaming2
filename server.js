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
const WORLDS = ["hub", "parkour", "race", "city", "br", "tag", "koth"];
const HERO_IDS = ["weaver", "bolt", "skyward", "titan", "blink", "glider", "zip", "mite", "phase", "jet"];
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
const info = p => ({ id: p.id, name: p.name, skin: p.skin, voice: p.voice, adm: p.admin ? 1 : 0, size: p.mods ? p.mods.size : 1, hero: p.hero || null });
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
// Race track: a twisty circuit (hairpin, S-bends, a chicane, long straights) built from a closed spline.
// pts = centre line, gates = checkpoints, pads = boost pads (axis aligned), obs = slalom barrels.
function trackData() {
  const CP = [[-20, -110], [70, -112], [130, -95], [155, -50], [130, -15], [80, -20], [30, 15], [30, 45], [80, 75], [130, 80], [155, 120],
              [110, 152], [30, 142], [-30, 112], [-80, 125], [-135, 100], [-150, 40], [-120, -10], [-140, -60], [-110, -100]];
  const n = CP.length, dense = [];
  for (let i = 0; i < n; i++) {                                // Catmull-Rom spline through the control points
    const p0 = CP[(i - 1 + n) % n], p1 = CP[i], p2 = CP[(i + 1) % n], p3 = CP[(i + 2) % n];
    for (let k = 0; k < 40; k++) {
      const t = k / 40, t2 = t * t, t3 = t2 * t, f = j => 0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
      dense.push([f(0), f(1)]);
    }
  }
  const cum = [0]; for (let i = 1; i <= dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i % dense.length][0] - dense[i - 1][0], dense[i % dense.length][1] - dense[i - 1][1]));
  const L = cum[dense.length], m = Math.round(L / 1.4), pts = [];
  for (let j = 0, s = 0; j < m; j++) {                         // resample at equal spacing
    const target = j * L / m; while (cum[s + 1] < target) s++;
    const k = (target - cum[s]) / (cum[s + 1] - cum[s]), A = dense[s], B = dense[(s + 1) % dense.length];
    pts.push({ x: A[0] + (B[0] - A[0]) * k, z: A[1] + (B[1] - A[1]) * k, dx: 0, dz: 0 });
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    pts[i].dx = (b.x - a.x) / l; pts[i].dz = (b.z - a.z) / l;
  }
  const gates = []; for (let k = 0; k < 10; k++) gates.push(pts[Math.round(k * pts.length / 10) % pts.length]);
  const pads = [], taken = [];
  for (let i = 0; i < pts.length; i++) {                       // boost pads on the straightest, axis-aligned stretches
    const p = pts[i], alongX = Math.abs(p.dx) > 0.985, alongZ = Math.abs(p.dz) > 0.985;
    if (!(alongX || alongZ) || pads.length >= 6 || taken.some(t => Math.abs(t - i) < pts.length / 9) || Math.abs(i - 0) < 25) continue;
    taken.push(i);
    pads.push(alongX ? { x0: p.x - 4, x1: p.x + 4, z0: p.z - 7, z1: p.z + 7, dx: Math.sign(p.dx), dz: 0 } : { x0: p.x - 7, x1: p.x + 7, z0: p.z - 4, z1: p.z + 4, dx: 0, dz: Math.sign(p.dz) });
  }
  const obs = [];
  for (const f of [0.2, 0.48, 0.74]) for (let k = 0; k < 6; k++) {   // slalom barrels
    const p = pts[(Math.round(f * pts.length) + k * 9) % pts.length], off = (k % 2 ? 1 : -1) * 5;
    obs.push({ x: p.x - p.dz * off, z: p.z + p.dx * off });
  }
  return { pts: pts, gates: gates, pads: pads, obs: obs, W: 22, length: L };
}
// Hero City: a huge 19x19 grid of towers (the middle 3x3 is the open plaza around the Hero Tower; ~10% of cells are parks).
function cityData() {
  const rnd = mulberry32(4242), R = (a, b) => a + rnd() * (b - a), buildings = [], parks = [], CELL = 46, N = 9;
  for (let gx = -N; gx <= N; gx++) for (let gz = -N; gz <= N; gz++) {
    const w = R(20, 29), d = R(20, 29), ox = R(-3, 3), oz = R(-3, 3), c = Math.floor(rnd() * 5), pk = rnd(), dist = Math.hypot(gx, gz), boost = R(4, 9);
    if (Math.abs(gx) <= 1 && Math.abs(gz) <= 1) continue;
    if (pk < 0.1) { parks.push({ cx: gx * CELL, cz: gz * CELL }); continue; }
    buildings.push({ cx: gx * CELL + ox, cz: gz * CELL + oz, w: w, d: d, h: R(26, 70) + Math.max(0, 10 - dist) * boost, c: c });
  }
  return { buildings: buildings, parks: parks, cell: CELL, half: N * CELL + 20 };
}
// Battle royale island (radius 260), laid out like a classic first-season battle royale map: a central lake with a lake house,
// a tall-building town just south-west of it, suburbs to the north-west, shops to the east, farms, a factory, a depot, a coast town, woods, a mine...
// Every box here is solid. The SERVER uses these same boxes to decide whether a bullet or grenade is blocked.
function brData() {
  const rnd = mulberry32(2024), R = (a, b) => a + rnd() * (b - a), PI2 = Math.PI * 2;
  const boxes = [], rooms = [], trees = [], rocks = [], loot = [], spawns = [], pois = [], silos = [], patches = [];
  const T = 0.4, F = 3.4, LAKE = { x: 0, z: 0, r: 36 };
  const add = (x0, y0, z0, x1, y1, z1, kind) => { if (x1 - x0 > 0.01 && y1 - y0 > 0.01 && z1 - z0 > 0.01) boxes.push({ x0: x0, y0: y0, z0: z0, x1: x1, y1: y1, z1: z1, kind: kind }); };
  const addC = (cx, cy, cz, sx, sy, sz, kind) => add(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, kind);
  const wall = (isX, fixed, c, len, h, door, kind) => {         // one wall; door = offset of a 2.6 x 2.6 doorway from the middle, or null
    const seg = (a0, a1, y0, y1) => { if (isX) add(a0, y0, fixed - T / 2, a1, y1, fixed + T / 2, kind); else add(fixed - T / 2, y0, a0, fixed + T / 2, y1, a1, kind); };
    const a0 = c - len / 2, a1 = c + len / 2;
    if (door === null) seg(a0, a1, 0, h);
    else { const g0 = c + door - 1.3, g1 = c + door + 1.3; seg(a0, g0, 0, h); seg(g1, a1, 0, h); seg(g0, g1, 2.6, h); }
  };
  const room = (cx, cz, w, d, h, doors, kind) => {              // doors = [north, south, east, west]
    wall(true, cz - d / 2, cx, w, h, doors[0], kind); wall(true, cz + d / 2, cx, w, h, doors[1], kind);
    wall(false, cx + w / 2, cz, d, h, doors[2], kind); wall(false, cx - w / 2, cz, d, h, doors[3], kind);
    rooms.push({ x: cx, z: cz, w: w, d: d });
  };
  const roofAt = (cx, cz, w, d, y, kind) => addC(cx, y + 0.15, cz, w + 0.6, 0.3, d + 0.6, kind || "roof");
  const lootAt = (x, z, y, hot) => loot.push({ x: x, y: y, z: z, hot: !!hot });
  // A building with 1+ floors. Each floor is a slab with a hole, and a 7-step staircase (0.49 m rise: you walk up it, no jumping) leads up through it.
  const multi = (cx, cz, w, d, floors, kind, door, hot) => {
    const H = floors * F;
    room(cx, cz, w, d, H, [door === 0 ? 0 : null, door === 1 ? 0 : null, null, null], kind);
    const ix0 = cx - w / 2 + T / 2, ix1 = cx + w / 2 - T / 2, iz0 = cz - d / 2 + T / 2, iz1 = cz + d / 2 - T / 2, n = 7, rise = F / n, run = 0.75, sw = 2.4;
    for (let k = 1; k < floors; k++) {
      // Flights hug the west wall (odd floors) or east wall (even floors), always at the NORTH end of the room. The lowest step is at the
      // south end, so you walk up from open floor and step off the top (next to the north wall) sideways onto the slab.
      const west = k % 2 === 1, sx0 = west ? ix0 : ix1 - sw, sx1 = sx0 + sw, zlo = iz0 + 0.2, zhi = zlo + n * run;
      for (let i = 0; i < n; i++) { const za = zhi - (i + 1) * run; add(sx0, (k - 1) * F, za, sx1, (k - 1) * F + (i + 1) * rise, za + run, "stair"); }
      const y1 = k * F, y0 = y1 - 0.3;
      add(ix0, y0, iz0, sx0, y1, iz1, "floor"); add(sx1, y0, iz0, ix1, y1, iz1, "floor"); add(sx0, y0, iz0, sx1, y1, zlo, "floor"); add(sx0, y0, zhi, sx1, y1, iz1, "floor");
    }
    for (let lv = 0; lv < floors; lv++) {
      lootAt(cx + R(-w / 4, w / 4), cz + R(-d / 4, d / 4), lv * F, hot); lootAt(cx + R(-w / 4, w / 4), cz + R(-d / 4, d / 4), lv * F, hot);
      addC(cx + R(-w / 5, w / 5), lv * F + 0.5, cz + R(-d / 6, d / 6), 1.6, 1, 0.9, "wood");                       // furniture = cover
    }
    roofAt(cx, cz, w, d, H, "roof");
  };
  const kinds = ["wall", "brick", "concrete", "wood"], pick = () => kinds[Math.floor(rnd() * kinds.length)];
  const poi = (name, x, z, r) => pois.push({ name: name, x: x, z: z, r: r });
  const silo = (x, z, r, h) => { silos.push({ x: x, z: z, r: r, h: h }); add(x - r, 0, z - r, x + r, h, z + r, "metal"); };
  const crates = (x, z, n, spread) => { for (let i = 0; i < n; i++) { const s = R(1.2, 1.8); addC(x + R(-spread, spread), s / 2, z + R(-spread, spread), s, s, s, "wood"); } };

  // --- Mirror Lake (centre): a lake house on an island
  poi("Mirror Lake", 0, 0, 40); multi(0, 0, 14, 12, 2, "wall", 1, true); patches.push({ x: 0, z: 0, r: 14, col: 0x6fae4f });
  // --- Leaning Towers: a tight 3x3 block of tall buildings with 2-4 floors
  poi("Leaning Towers", -70, 40, 45);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const fl = 2 + Math.floor(rnd() * 3), w = R(11, 14), d = R(11, 13); multi(-70 + i * 24, 40 + j * 24, w, d, fl, rnd() < 0.5 ? "glass" : "concrete", rnd() < 0.5 ? 0 : 1, true); }
  patches.push({ x: -70, z: 40, r: 42, col: 0x8b8f95 });
  // --- Cozy Park: houses in a ring around a little park
  poi("Cozy Park", -90, -70, 42);
  for (let i = 0; i < 10; i++) { const a = i / 10 * PI2, x = -90 + Math.cos(a) * 30, z = -70 + Math.sin(a) * 30; multi(x, z, 9, 9, rnd() < 0.4 ? 2 : 1, pick(), Math.sin(a) > 0 ? 0 : 1, false); }
  for (let i = 0; i < 6; i++) trees.push({ x: -90 + R(-9, 9), z: -70 + R(-9, 9), s: R(0.9, 1.4) });
  // --- Market Row: a street of shops with parked cars, plus a big supermarket
  poi("Market Row", 110, -60, 50);
  for (let i = 0; i < 5; i++) multi(80 + i * 14.5, -75, 13, 14, 1, i % 2 ? "brick" : "concrete", 1, true);
  multi(150, -50, 22, 16, 1, "metal", 0, true);
  for (let i = 0; i < 7; i++) addC(84 + i * 8, 0.8, -52, 4.2, 1.6, 2, "metal");
  // --- Brine Springs: a seaside town of small houses
  poi("Brine Springs", 60, 110, 40);
  for (let i = 0; i < 6; i++) { multi(30 + i * 13, 100, 9, 9, i % 3 === 0 ? 2 : 1, pick(), 1, false); multi(30 + i * 13, 122, 9, 9, 1, pick(), 0, false); }
  // --- Barn Acres: barns, silos and a farmhouse
  poi("Barn Acres", 170, 40, 45);
  const barn = (cx, cz) => { room(cx, cz, 14, 22, 5.5, [0, 0, null, null], "wood"); roofAt(cx, cz, 14, 22, 5.5, "roof"); lootAt(cx - 3, cz - 4, 0, true); lootAt(cx + 3, cz + 5, 0, true); addC(cx - 4, 0.7, cz, 1.4, 1.4, 1.4, "wood"); addC(cx - 4, 2.1, cz, 1.4, 1.4, 1.4, "wood"); addC(cx + 4, 0.7, cz + 2, 1.4, 1.4, 1.4, "wood"); };
  barn(150, 25); barn(185, 15); barn(165, 62); silo(200, 48, 3, 14); silo(207, 56, 3, 14); multi(205, 22, 12, 10, 2, "wood", 1, true);
  patches.push({ x: 175, z: 40, r: 48, col: 0xc9b868 });
  // --- Rusty Depot: a huge warehouse with shipping containers
  poi("Rusty Depot", -20, 170, 45);
  room(-20, 170, 40, 24, 8, [0, 1, null, null], "metal"); roofAt(-20, 170, 40, 24, 8, "roof"); crates(-20, 170, 14, 14);
  lootAt(-30, 168, 0, true); lootAt(-10, 172, 0, true); lootAt(-20, 165, 0, true); lootAt(-20, 176, 0, true);
  for (let i = 0; i < 4; i++) { addC(-40 + i * 14, 1.4, 195, 12, 2.8, 2.4, "metal"); if (i % 2 === 0) addC(-40 + i * 14, 4.2, 195, 12, 2.8, 2.4, "metal"); }
  addC(-5, 0.5, 190, 2, 1, 2, "wood"); addC(-5, 1.5, 192, 2, 1, 2, "wood"); patches.push({ x: -20, z: 175, r: 50, col: 0xc4a76a });
  // --- Fancy Shores: mansions along the south-west coast
  poi("Fancy Shores", -150, 150, 50);
  for (const m of [[-165, 135], [-135, 165], [-185, 105], [-120, 130]]) multi(m[0], m[1], 18, 14, 2, "wall", 1, true);
  // --- Slick Grove: houses and a gas station
  poi("Slick Grove", -170, -10, 45);
  for (let i = 0; i < 4; i++) { multi(-190 + i * 16, -25, 9, 9, 1, pick(), 1, false); multi(-190 + i * 16, 5, 9, 9, i % 2 ? 2 : 1, pick(), 0, false); }
  for (const s of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) addC(-150 + s[0] * 5, 2.2, -10 + s[1] * 4, 0.5, 4.4, 0.5, "metal");
  addC(-150, 4.65, -10, 12, 0.3, 10, "metal"); silo(-142, -22, 2.5, 5);
  // --- Pipe Factory: factory hall with chimneys, tanks and a long pipe
  poi("Pipe Factory", 80, -150, 45);
  room(80, -150, 36, 28, 9, [0, 1, null, null], "metal"); roofAt(80, -150, 36, 28, 9, "roof"); crates(80, -150, 10, 12);
  lootAt(70, -150, 0, true); lootAt(90, -148, 0, true); lootAt(80, -155, 0, true);
  addC(63, 12, -170, 5, 24, 5, "metal"); addC(98, 12, -170, 5, 24, 5, "metal"); silo(110, -130, 4, 10); silo(120, -140, 4, 10); addC(105, 6.5, -118, 30, 2, 2, "metal");
  for (const px of [92, 105, 118]) addC(px, 3, -118, 1, 6, 1, "metal");
  // --- Quiet Lodge: a big cabin in the north-west corner with smaller cabins
  poi("Quiet Lodge", -150, -130, 40);
  multi(-150, -130, 16, 12, 2, "wood", 1, true); multi(-175, -118, 8, 8, 1, "wood", 1, false); multi(-125, -115, 8, 8, 1, "wood", 1, false); multi(-160, -155, 8, 8, 1, "wood", 0, false);
  patches.push({ x: -150, z: -150, r: 9, col: 0x3a93d6 });
  // --- Pepper Patch: farm sheds and greenhouses
  poi("Pepper Patch", 20, -120, 40);
  for (let i = 0; i < 3; i++) { multi(0 + i * 18, -130, 8, 8, 1, "wood", 1, false); room(0 + i * 18, -108, 14, 8, 3, [0, null, null, null], "glass"); roofAt(0 + i * 18, -108, 14, 8, 3, "roof"); lootAt(0 + i * 18, -108, 0, false); }
  patches.push({ x: 18, z: -118, r: 36, col: 0x9a7a45 });
  // --- Shaft Hollow: a rocky mound with a tunnel
  poi("Shaft Hollow", -190, 70, 35);
  add(-198, 0, 62, -196, 3.2, 80, "concrete"); add(-192, 0, 62, -190, 3.2, 80, "concrete"); add(-199, 3.2, 62, -189, 3.6, 80, "concrete");
  lootAt(-194, 77, 0, true); lootAt(-194, 70, 0, true);
  for (let i = 0; i < 9; i++) { const a = R(0, PI2), r = R(8, 20), s = R(2.5, 5); rocks.push({ x: -194 + Math.cos(a) * r, z: 72 + Math.sin(a) * r, r: s, rot: R(0, 6) }); }
  // --- Soggy Swamp: huts and marsh
  poi("Soggy Swamp", 140, 150, 40);
  for (let i = 0; i < 6; i++) multi(125 + (i % 3) * 18, 140 + Math.floor(i / 3) * 20, 8, 8, 1, "wood", i % 2, false);
  patches.push({ x: 140, z: 150, r: 34, col: 0x4a7a55 });
  // --- Whisper Woods: a dense forest in the west
  poi("Whisper Woods", -130, 90, 45);

  for (const r of rooms) { /* (rooms are used below to keep trees and loot out of buildings) */ }
  const inLake = (x, z, m) => Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + m && !(Math.abs(x) < 9 && Math.abs(z) < 9);
  const nearRoom = (x, z, m) => rooms.some(r => Math.abs(x - r.x) < r.w / 2 + m && Math.abs(z - r.z) < r.d / 2 + m);
  const nearSilo = (x, z) => silos.some(s => Math.hypot(x - s.x, z - s.z) < s.r + 3);
  for (let i = 0; i < 90; i++) {                                        // woods
    const a = R(0, PI2), r = Math.sqrt(rnd()) * 45, x = -130 + Math.cos(a) * r, z = 90 + Math.sin(a) * r, s = R(0.9, 1.6);
    if (!nearRoom(x, z, 6) && !inLake(x, z, 3) && !nearSilo(x, z)) trees.push({ x: x, z: z, s: s });
  }
  for (let i = 0; i < 160; i++) {                                       // scattered trees
    const a = R(0, PI2), r = Math.sqrt(rnd()) * 245, x = Math.cos(a) * r, z = Math.sin(a) * r, s = R(0.8, 1.5);
    if (nearRoom(x, z, 7) || inLake(x, z, 3) || nearSilo(x, z) || pois.some(p => p.name !== "Whisper Woods" && Math.hypot(x - p.x, z - p.z) < p.r * 0.55)) continue;
    trees.push({ x: x, z: z, s: s });
  }
  for (const t of trees) add(t.x - 0.3 * t.s, 0, t.z - 0.3 * t.s, t.x + 0.3 * t.s, 4 * t.s, t.z + 0.3 * t.s, "trunk");
  for (let i = 0; i < 45; i++) {
    const a = R(0, PI2), r = Math.sqrt(rnd()) * 245, x = Math.cos(a) * r, z = Math.sin(a) * r, s = R(1, 2.6), rot = R(0, 6.28);
    if (nearRoom(x, z, 4) || inLake(x, z, 2) || nearSilo(x, z)) continue;
    rocks.push({ x: x, z: z, r: s, rot: rot });
  }
  for (const k of rocks) add(k.x - 0.75 * k.r, 0, k.z - 0.75 * k.r, k.x + 0.75 * k.r, 1.2 * k.r, k.z + 0.75 * k.r, "rock");
  for (let i = 0; i < 70; i++) {                                        // loose loot on the ground
    const a = R(0, PI2), r = Math.sqrt(rnd()) * 235, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!nearRoom(x, z, 1.5) && !inLake(x, z, 0) && !nearSilo(x, z)) lootAt(x, z, 0, false);
  }
  let tries = 0;
  while (spawns.length < 64 && tries++ < 800) {
    const a = R(0, PI2), r = Math.sqrt(rnd()) * 235, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!inLake(x, z, 0)) spawns.push({ x: x, z: z });
  }
  return { boxes: boxes, rooms: rooms, trees: trees, rocks: rocks, loot: loot, spawns: spawns, pois: pois, silos: silos, patches: patches, lake: LAKE, radius: 260 };
}
// Ray vs box (slab test): distance along the ray, or Infinity.
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
// One physics step of a thrown grenade: gravity, bounces off walls/floors (server and client run the same code).
function stepGrenade(g, dt, boxes) {
  g.vy -= 22 * dt;
  const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt, nz = g.z + g.vz * dt, dx = nx - g.x, dy = ny - g.y, dz = nz - g.z, len = Math.hypot(dx, dy, dz);
  if (len > 1e-6) {
    let bt = len, hb = null;
    for (const b of boxes) { const t = rayBox(g.x, g.y, g.z, dx / len, dy / len, dz / len, b); if (t >= 0 && t < bt) { bt = t; hb = b; } }
    if (hb) {
      const px = g.x + dx / len * bt, py = g.y + dy / len * bt, pz = g.z + dz / len * bt;
      const d = [px - hb.x0, hb.x1 - px, py - hb.y0, hb.y1 - py, pz - hb.z0, hb.z1 - pz];
      let m = 0; for (let i = 1; i < 6; i++) if (Math.abs(d[i]) < Math.abs(d[m])) m = i;
      if (m === 0) g.vx = -Math.abs(g.vx) * 0.4; else if (m === 1) g.vx = Math.abs(g.vx) * 0.4;
      else if (m === 2) g.vy = -Math.abs(g.vy) * 0.4; else if (m === 3) { g.vy = Math.abs(g.vy) * 0.4; g.vx *= 0.7; g.vz *= 0.7; }
      else if (m === 4) g.vz = -Math.abs(g.vz) * 0.4; else g.vz = Math.abs(g.vz) * 0.4;
      g.x = px - dx / len * 0.06; g.y = py - dy / len * 0.06; g.z = pz - dz / len * 0.06;
      return;
    }
  }
  g.x = nx; g.y = ny; g.z = nz;
  if (g.y < 0.2) { g.y = 0.2; if (g.vy < 0) g.vy = -g.vy * 0.45; g.vx *= 0.75; g.vz *= 0.75; if (Math.abs(g.vy) < 1) g.vy = 0; }
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
// The server decides everything: who is alive, loot pickups, bullet + explosion damage (shield first, then health), and the shrinking zone.
// Clients only send "I shot / threw / used / picked up this".
const BR = brData();
const BR_CD = Number(process.env.BR_COUNTDOWN_MS) || 20000;          // lobby countdown once 2+ players are waiting
const WEAPONS = {
  pistol:  { dmg: 20, iv: 260,  range: 80,  pellets: 1, spread: 0.012, ammo: 30 },
  smg:     { dmg: 9,  iv: 70,   range: 60,  pellets: 1, spread: 0.035, ammo: 90 },
  rifle:   { dmg: 14, iv: 105,  range: 120, pellets: 1, spread: 0.022, ammo: 60 },
  shotgun: { dmg: 9,  iv: 850,  range: 32,  pellets: 8, spread: 0.09,  ammo: 10 },
  sniper:  { dmg: 75, iv: 1500, range: 320, pellets: 1, spread: 0.002, ammo: 8 },
  rocket:  { dmg: 0,  iv: 2500, range: 220, pellets: 1, spread: 0.01,  ammo: 4, boom: { r: 6.5, dmg: 95 } }
};
const ZONE_PLAN = [[255, 255, 60], [255, 170, 40], [170, 170, 35], [170, 105, 35], [105, 105, 30], [105, 60, 30], [60, 60, 25], [60, 28, 25], [28, 28, 15], [28, 0, 40]];  // radius from, to, seconds
const LOOT_COMMON = ["pistol", "pistol", "smg", "shotgun", "grenade", "grenade", "medkit", "medkit", "shield", "ammo", "ammo", "ammo"];
const LOOT_HOT = ["rifle", "rifle", "smg", "shotgun", "sniper", "rocket", "grenade", "grenade", "medkit", "shield", "shield", "ammo", "ammo"];
const ITEM_NAME = { pistol: "Pistol", smg: "SMG", rifle: "Assault Rifle", shotgun: "Shotgun", sniper: "Sniper Rifle", rocket: "Rocket Launcher" };
const brRoom = { phase: "lobby", cdAt: 0, endAt: 0, winner: null, players: new Map(), segs: [], loot: new Map(), nextLoot: 1, test: false, grenades: [], nextG: 1 };

const brAliveIds = () => { const a = []; for (const [id, b] of brRoom.players) if (b.alive) a.push(id); return a; };
function curSeg(now) { for (const g of brRoom.segs) if (now < g.t1) return g; return brRoom.segs[brRoom.segs.length - 1] || null; }
const lootList = () => [...brRoom.loot.values()].map(l => [l.id, l.type, rnd2(l.x), rnd2(l.y), rnd2(l.z)]);
function brState(extra) {
  const now = Date.now(), o = { t: "br", ph: brRoom.phase, cd: brRoom.cdAt, n: now, alive: brAliveIds(), zone: brRoom.phase === "live" ? curSeg(now) : null };
  if (brRoom.phase === "over") o.winner = brRoom.winner || "Nobody";
  return Object.assign(o, extra || {});
}
const brBroadcast = extra => toWorld("br", brState(extra));
function brPrivate(id) {                                  // your own health / shield / weapons / items
  const bp = brRoom.players.get(id), p = players.get(id); if (!bp || !p) return;
  send(p.ws, { t: "brs", hp: Math.max(0, Math.round(bp.hp)), sh: Math.max(0, Math.round(bp.sh)), cur: bp.cur, weps: bp.weps, g: bp.g, mk: bp.mk, sp: bp.sp });
}
function sendBrState(p) { const extra = {}; if (brRoom.phase === "live") extra.loot = lootList(); send(p.ws, brState(extra)); brPrivate(p.id); }

function brStart(force) {
  const ids = [...rooms.br.ids];
  brRoom.test = !!force && ids.length < 2;                 // a forced solo match never ends by itself (use /brend)
  if (ids.length < (force ? 1 : 2)) { brRoom.cdAt = 0; brBroadcast(); return; }
  const now = Date.now();
  brRoom.players.clear(); brRoom.loot.clear(); brRoom.nextLoot = 1; brRoom.grenades = [];
  const spawns = BR.spawns.slice().sort(() => Math.random() - 0.5), drop = {};
  ids.forEach((id, i) => {
    brRoom.players.set(id, { hp: 100, sh: 0, alive: true, kills: 0, weps: {}, cur: null, g: 0, mk: 0, sp: 0, lastShot: 0, lastThrow: 0, lastUse: 0 });
    const sp = spawns[i % spawns.length]; drop[id] = [rnd2(sp.x), rnd2(sp.z)];
  });
  const ang = Math.random() * 6.283, off = Math.random() * 80, cx = Math.cos(ang) * off, cz = Math.sin(ang) * off;
  let t = now;
  brRoom.segs = ZONE_PLAN.map(p => { const g = { cx: rnd2(cx), cz: rnd2(cz), r0: p[0], r1: p[1], t0: t, t1: t + p[2] * 1000 }; t = g.t1; return g; });
  for (const spot of BR.loot) {
    const id = brRoom.nextLoot++, bag = spot.hot ? LOOT_HOT : LOOT_COMMON;
    brRoom.loot.set(id, { id: id, type: bag[Math.floor(Math.random() * bag.length)], x: spot.x, y: spot.y + 0.8, z: spot.z });
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
  if (killerId === id) killerId = null;
  const p = players.get(id), k = killerId ? players.get(killerId) : null, kb = killerId ? brRoom.players.get(killerId) : null;
  if (kb) kb.kills++;
  if (p) { send(p.ws, { t: "brdead", by: k ? k.name : (cause || null) }); brPrivate(id); }
  const victim = p ? p.name : "Someone";
  toWorld("br", { t: "feed", m: k ? k.name + " eliminated " + victim + (cause ? " (" + cause + ")" : "") : victim + " was eliminated" + (cause ? " (" + cause + ")" : "") });
  brBroadcast(); brCheckEnd();
}
function brLeave(id) { const bp = brRoom.players.get(id); if (bp && bp.alive && brRoom.phase === "live") brKill(id, null, "left the match"); }
// Damage always eats the shield first. God-mode devs take none.
function brDamage(id, tb, dmg, killerId, cause) {
  const q = players.get(id); if (!q || (q.mods && q.mods.god) || !tb.alive) return false;
  const a = Math.min(tb.sh, dmg); tb.sh -= a; dmg -= a; tb.hp -= dmg;
  if (tb.hp <= 0) { brKill(id, killerId, cause); return true; }
  brPrivate(id); return false;
}
// Explosion: damage falls off with distance, and walls shield you.
function brExplode(pos, radius, maxDmg, byId, cause, gid) {
  toWorld("br", { t: "boom", p: [rnd2(pos[0]), rnd2(pos[1]), rnd2(pos[2])], r: radius, id: gid });
  for (const [id, tb] of [...brRoom.players]) {
    if (!tb.alive) continue;
    const q = players.get(id); if (!q) continue;
    const sz = q.mods.size || 1, cx = q.st[0], cy = q.st[1] + 1.0 * sz, cz = q.st[2], dx = cx - pos[0], dy = cy - pos[1], dz = cz - pos[2], dist = Math.hypot(dx, dy, dz);
    if (dist > radius) continue;
    if (dist > 0.5) {
      let blocked = false;
      for (const b of BR.boxes) { const t = rayBox(pos[0], pos[1], pos[2], dx / dist, dy / dist, dz / dist, b); if (t > 0.05 && t < dist - 0.3) { blocked = true; break; } }
      if (blocked) continue;
    }
    let dmg = Math.max(8, maxDmg * (1 - dist / radius)); if (id === byId) dmg *= 0.5;
    brDamage(id, tb, dmg, byId, cause);
  }
}

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
    brRoom.phase = "lobby"; brRoom.players.clear(); brRoom.loot.clear(); brRoom.segs = []; brRoom.cdAt = 0; brRoom.test = false; brRoom.grenades = [];
    brBroadcast();
  }
}
setInterval(brTick, 200);
setInterval(() => {                                                 // thrown grenades: 20 physics steps a second, 2.6 s fuse
  if (!brRoom.grenades.length) return;
  const now = Date.now();
  for (let i = brRoom.grenades.length - 1; i >= 0; i--) {
    const g = brRoom.grenades[i];
    stepGrenade(g, 0.05, BR.boxes);
    if (now - g.t0 >= 2600) { brRoom.grenades.splice(i, 1); if (brRoom.phase === "live") brExplode([g.x, g.y, g.z], 7, 100, g.by, "grenade", g.id); }
  }
}, 50);

// Where was this player ~150 ms ago? (We aim at what the shooter SAW, which is a little in the past.)
function posAt(q, t) { const h = q.hist; for (let i = h.length - 1; i >= 0; i--) if (h[i][0] <= t) return h[i]; return h.length ? h[0] : [0, q.st[0], q.st[1], q.st[2]]; }
function readAim(p, m) {
  if (!Array.isArray(m.o) || !Array.isArray(m.d) || m.o.length < 3 || m.d.length < 3) return null;
  const ox = num(m.o[0], -2000, 2000), oy = num(m.o[1], -200, 600), oz = num(m.o[2], -2000, 2000);
  let dx = num(m.d[0], -1, 1), dy = num(m.d[1], -1, 1), dz = num(m.d[2], -1, 1); const l = Math.hypot(dx, dy, dz);
  if (l < 0.5) return null;
  if (Math.hypot(ox - p.st[0], oy - (p.st[1] + 1.5 * (p.mods.size || 1)), oz - p.st[2]) > 4 + 2 * (p.mods.size || 1)) return null;   // it must start at the player
  return { o: [ox, oy, oz], d: [dx / l, dy / l, dz / l] };
}
function brShoot(p, m) {
  if (brRoom.phase !== "live" || p.world !== "br") return;
  const bp = brRoom.players.get(p.id); if (!bp || !bp.alive || !bp.cur) return;
  const wd = WEAPONS[bp.cur], now = Date.now();
  if (now - bp.lastShot < wd.iv * 0.85 || (bp.weps[bp.cur] || 0) <= 0) return;               // fire-rate + ammo are enforced here
  const aim = readAim(p, m); if (!aim) return;
  const ox = aim.o[0], oy = aim.o[1], oz = aim.o[2];
  bp.lastShot = now; bp.weps[bp.cur]--;
  const targets = [];
  for (const [id, tb] of brRoom.players) { if (id === p.id || !tb.alive) continue; const q = players.get(id); if (q) targets.push({ id: id, q: q, tb: tb }); }
  const rewind = now - 150, dmg = new Map(); let firstEnd = null;
  for (let i = 0; i < wd.pellets; i++) {
    let px = aim.d[0] + (Math.random() - 0.5) * 2 * wd.spread, py = aim.d[1] + (Math.random() - 0.5) * 2 * wd.spread, pz = aim.d[2] + (Math.random() - 0.5) * 2 * wd.spread;
    const pl = Math.hypot(px, py, pz); px /= pl; py /= pl; pz /= pl;
    let wallT = wd.range;
    for (const b of BR.boxes) { const t = rayBox(ox, oy, oz, px, py, pz, b); if (t > 0.01 && t < wallT) wallT = t; }       // walls stop bullets
    let bestT = wallT, best = null;
    for (const tg of targets) {
      const pos = posAt(tg.q, rewind), sz = tg.q.mods.size || 1;
      const t = rayBox(ox, oy, oz, px, py, pz, { x0: pos[1] - 0.55 * sz, x1: pos[1] + 0.55 * sz, y0: pos[2], y1: pos[2] + 1.95 * sz, z0: pos[3] - 0.55 * sz, z1: pos[3] + 0.55 * sz });
      if (t >= 0 && t < bestT) { bestT = t; best = { tg: tg, pos: pos, sz: sz }; }
    }
    const end = [ox + px * bestT, oy + py * bestT, oz + pz * bestT];
    if (i === 0) firstEnd = end;
    if (bp.cur === "rocket") { toWorld("br", { t: "shot", id: p.id, k: "rocket", o: [rnd2(ox), rnd2(oy), rnd2(oz)], e: end.map(rnd2) }); brExplode(end, wd.boom.r, wd.boom.dmg, p.id, "rocket"); brPrivate(p.id); return; }
    if (best) {
      const head = end[1] > best.pos[2] + 1.45 * best.sz, e = dmg.get(best.tg.id) || { tg: best.tg, dmg: 0, head: false };
      e.dmg += wd.dmg * (head ? 2 : 1); e.head = e.head || head; dmg.set(best.tg.id, e);        // headshots do double damage
    }
  }
  toWorld("br", { t: "shot", id: p.id, o: [rnd2(ox), rnd2(oy), rnd2(oz)], e: firstEnd.map(rnd2) });
  let hs = false;
  for (const e of dmg.values()) { hs = hs || e.head; brDamage(e.tg.id, e.tg.tb, e.dmg, p.id, bp.cur); }
  if (dmg.size) send(p.ws, { t: "hit", hs: hs });
  brPrivate(p.id);
}
function brThrow(p, m) {
  if (brRoom.phase !== "live" || p.world !== "br") return;
  const bp = brRoom.players.get(p.id), now = Date.now(); if (!bp || !bp.alive || bp.g <= 0 || now - bp.lastThrow < 800) return;
  const aim = readAim(p, m); if (!aim) return;
  bp.lastThrow = now; bp.g--;
  const id = brRoom.nextG++, v = [aim.d[0] * 19, aim.d[1] * 19 + 5, aim.d[2] * 19];
  brRoom.grenades.push({ id: id, x: aim.o[0], y: aim.o[1], z: aim.o[2], vx: v[0], vy: v[1], vz: v[2], t0: now, by: p.id });
  toWorld("br", { t: "gthrow", id: id, o: aim.o.map(rnd2), v: v.map(rnd2) });
  brPrivate(p.id);
}
function brUse(p, k) {
  const bp = brRoom.players.get(p.id), now = Date.now(); if (brRoom.phase !== "live" || !bp || !bp.alive || now - bp.lastUse < 700) return;
  if (k === "med" && bp.mk > 0 && bp.hp < 100) { bp.mk--; bp.hp = Math.min(100, bp.hp + 50); bp.lastUse = now; send(p.ws, { t: "tip", m: "+50 health" }); }
  else if (k === "shield" && bp.sp > 0 && bp.sh < 100) { bp.sp--; bp.sh = Math.min(100, bp.sh + 50); bp.lastUse = now; send(p.ws, { t: "tip", m: "+50 shield" }); }
  else return;
  brPrivate(p.id);
}
function brPick(p, id) {
  if (brRoom.phase !== "live") return;
  const bp = brRoom.players.get(p.id), it = brRoom.loot.get(id); if (!bp || !bp.alive || !it) return;
  if (Math.hypot(p.st[0] - it.x, p.st[2] - it.z) > 4.5 || Math.abs(p.st[1] - (it.y - 0.8)) > 2.4) return;      // you must actually be next to it (and on the same floor)
  brRoom.loot.delete(id); toWorld("br", { t: "lootgone", id: id });
  let tip;
  if (WEAPONS[it.type]) { bp.weps[it.type] = (bp.weps[it.type] || 0) + WEAPONS[it.type].ammo; if (!bp.cur) bp.cur = it.type; tip = "Picked up: " + ITEM_NAME[it.type]; }
  else if (it.type === "grenade") { bp.g = Math.min(10, bp.g + 3); tip = "+3 grenades (G to throw)"; }
  else if (it.type === "medkit") { bp.mk = Math.min(5, bp.mk + 1); tip = "Medkit (H to use)"; }
  else if (it.type === "shield") { bp.sp = Math.min(5, bp.sp + 1); tip = "Shield potion (J to use)"; }
  else { let any = false; for (const k in bp.weps) { bp.weps[k] += Math.ceil(WEAPONS[k].ammo * 0.6); any = true; } tip = any ? "Ammo restocked" : "Ammo (find a weapon first)"; }
  send(p.ws, { t: "tip", m: tip }); brPrivate(p.id);
}

// ---------- TAG ARENA + KING OF THE HILL ----------
// Tag: one player is IT; touch someone to pass it on; whoever spends the least time as IT wins.
// King of the Hill: stand ALONE on the ring to score (bumping rivals shoves them); first to 60 points wins.
const MG_CD = Number(process.env.MG_COUNTDOWN_MS) || 15000;
const MG_LEN = { tag: 90000, koth: 150000 };
const KOTH = { x: 0, z: 0, r: 8, y0: 4 };                    // must match the arena in index.html
const MG = {};
for (const mode of ["tag", "koth"]) MG[mode] = { phase: "lobby", cdAt: 0, endAt: 0, scores: new Map(), parts: new Set(), it: 0, tagAt: 0, winner: null, test: false, lastBroadcast: 0, lastShove: new Map() };
function mgState(mode, extra) {
  const m = MG[mode];
  return Object.assign({ t: "mg", mode: mode, ph: m.phase, cd: m.cdAt, end: m.endAt, n: Date.now(), it: m.it, parts: [...m.parts], scores: [...m.scores].map(e => [e[0], Math.round(e[1] * 10) / 10]) },
                       m.phase === "over" ? { winner: m.winner } : {}, extra || {});
}
function mgBroadcast(mode, extra) { toWorld(mode, mgState(mode, extra)); MG[mode].lastBroadcast = Date.now(); }
function mgStart(mode, force) {
  const m = MG[mode], ids = [...rooms[mode].ids];
  if (ids.length < (force ? 1 : 2)) { m.cdAt = 0; mgBroadcast(mode); return; }
  const now = Date.now();
  m.phase = "live"; m.cdAt = 0; m.endAt = now + MG_LEN[mode]; m.parts = new Set(ids); m.scores = new Map(ids.map(id => [id, 0])); m.test = !!force && ids.length < 2; m.tagAt = now + 2500; m.lastShove.clear();
  m.it = mode === "tag" ? ids[Math.floor(Math.random() * ids.length)] : 0;
  mgBroadcast(mode); toWorld(mode, { t: "feed", m: (mode === "tag" ? "Tag" : "King of the Hill") + " round started!" });
}
function mgEnd(mode) {
  const m = MG[mode]; let best = null;
  for (const [id, sc] of m.scores) { if (!players.get(id)) continue; if (best === null || (mode === "tag" ? sc < m.scores.get(best) : sc > m.scores.get(best))) best = id; }
  m.winner = best ? players.get(best).name : "Nobody"; m.phase = "over"; m.endAt = Date.now() + 8000;
  mgBroadcast(mode); toWorld(mode, { t: "feed", m: "🏆 " + m.winner + " wins!" });
}
function mgLeave(p) {
  const mode = p.world; if (mode !== "tag" && mode !== "koth") return;
  const m = MG[mode]; m.parts.delete(p.id); m.scores.delete(p.id);
  if (m.phase === "live" && mode === "tag" && m.it === p.id) { const rest = [...m.parts]; m.it = rest.length ? rest[Math.floor(Math.random() * rest.length)] : 0; m.tagAt = Date.now() + 1500; }
  if (m.phase === "live") mgBroadcast(mode);
}
function mgTick() {
  const now = Date.now();
  for (const mode of ["tag", "koth"]) {
    const m = MG[mode], room = rooms[mode];
    if (m.phase === "lobby") {
      const n = room.ids.size;
      if (n >= 2) { if (!m.cdAt) { m.cdAt = now + MG_CD; mgBroadcast(mode); } else if (now >= m.cdAt) mgStart(mode); }
      else if (m.cdAt) { m.cdAt = 0; mgBroadcast(mode); }
    } else if (m.phase === "live") {
      const live = [...m.parts].map(id => players.get(id)).filter(Boolean);
      if (!m.test && live.length < 2) { mgEnd(mode); continue; }
      if (!live.length) { m.phase = "lobby"; m.scores.clear(); m.parts.clear(); m.it = 0; continue; }
      if (mode === "tag") {
        const it = m.it ? players.get(m.it) : null;
        if (it) {
          m.scores.set(m.it, (m.scores.get(m.it) || 0) + 0.1);
          if (now > m.tagAt) for (const q of live) {
            if (q.id === m.it) continue;
            if (Math.hypot(q.st[0] - it.st[0], q.st[2] - it.st[2]) < 2.0 && Math.abs(q.st[1] - it.st[1]) < 2.5) { m.it = q.id; m.tagAt = now + 2000; mgBroadcast(mode); break; }
          }
        } else { m.it = live[0].id; mgBroadcast(mode); }
      } else {
        const inside = live.filter(q => Math.hypot(q.st[0] - KOTH.x, q.st[2] - KOTH.z) < KOTH.r && q.st[1] > KOTH.y0 - 0.5);
        if (inside.length === 1) m.scores.set(inside[0].id, (m.scores.get(inside[0].id) || 0) + 0.1);
        for (let i = 0; i < inside.length; i++) for (let j = i + 1; j < inside.length; j++) {          // shove: players pressed together on the hill bounce apart
          const a = inside[i], b = inside[j], d = Math.hypot(a.st[0] - b.st[0], a.st[2] - b.st[2]);
          if (d < 1.8 && d > 0.01) for (const pr of [[a, b], [b, a]]) {
            const x = pr[0], y = pr[1]; if (now - (m.lastShove.get(x.id) || 0) < 900) continue; m.lastShove.set(x.id, now);
            send(x.ws, { t: "shove", v: [(x.st[0] - y.st[0]) / d * 13, 7, (x.st[2] - y.st[2]) / d * 13] });
          }
        }
        if ([...m.scores.values()].some(v => v >= 60)) { mgEnd(mode); continue; }
      }
      if (now >= m.endAt) mgEnd(mode);
      else if (now - m.lastBroadcast >= 1000) mgBroadcast(mode);
    } else if (m.phase === "over" && now >= m.endAt) {
      m.phase = "lobby"; m.cdAt = 0; m.scores.clear(); m.parts.clear(); m.it = 0; m.test = false; mgBroadcast(mode);
    }
  }
}
setInterval(mgTick, 100);

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
  if (w === "br") sendBrState(p); else if (w === "tag" || w === "koth") send(p.ws, mgState(w));
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
      sys(p, "/kill <name|all|me>  ·  /heal [name]  ·  /give <weapon|all> [name]  ·  /ammo [name]  ·  /launch [name] [power]  ·  /kick <name>");
      sys(p, "/tp <name>  ·  /bring <name|all>  ·  /world <hub|parkour|race|city|br|tag|koth> [name]  ·  /brstart  ·  /brend  ·  /mgstart  ·  /mgend  ·  /players  ·  /say <message>");
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
      if (!names.every(n => WEAPONS[n])) { sys(p, "Usage: /give <" + Object.keys(WEAPONS).join("|") + "|all> [name]"); break; }
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
      const w = (parts[0] || "").toLowerCase(); if (!WORLDS.includes(w)) { sys(p, "Usage: /world <" + WORLDS.join("|") + "> [name]"); break; }
      const t = target(parts[1]); if (!t) break; if (!changeWorld(t, w)) sys(p, t.name + " is already there."); else sys(p, "Sent " + t.name + " to " + w); break;
    }
    case "brstart":
      if (brRoom.phase !== "lobby") { sys(p, "A match is already running. Use /brend first."); break; }
      if (!rooms.br.ids.size) { sys(p, "Nobody is in the battle royale lobby yet. Use /world br first."); break; }
      brStart(true); sys(p, "Battle royale force-started" + (brRoom.test ? " (solo test: it won't end by itself, use /brend)." : ".")); break;
    case "brend": sys(p, brForceEnd() ? "Match ended." : "There's no live match."); break;
    case "mgstart": case "mgend": {                                  // tag / king of the hill rounds
      const mode = (parts[0] || p.world).toLowerCase();
      if (mode !== "tag" && mode !== "koth") { sys(p, "Usage: /" + cmd + " <tag|koth>   (or stand in that arena)"); break; }
      if (cmd === "mgend") { sys(p, MG[mode].phase === "live" ? (mgEnd(mode), "Round ended.") : "No live round."); break; }
      if (MG[mode].phase !== "lobby") { sys(p, "A round is already running. Use /mgend first."); break; }
      if (!rooms[mode].ids.size) { sys(p, "Nobody is in that arena. Use /world " + mode + " first."); break; }
      mgStart(mode, true); sys(p, "Round force-started" + (MG[mode].test ? " (solo test)." : ".")); break;
    }
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
  mgLeave(p);
  p.gone = true;
  rooms[p.world].ids.delete(p.id);
  players.delete(p.id);
  toWorld(p.world, { t: "leave", id: p.id });
  console.log("- " + p.name + " #" + p.id + " (" + players.size + " online)");
}
function moveToWorld(p, world) {
  if (p.world === "br") brLeave(p.id);
  mgLeave(p); p.hero = null;                                // heroes only exist in Hero City
  rooms[p.world].ids.delete(p.id);
  toWorld(p.world, { t: "leave", id: p.id });
  p.world = world;
  rooms[world].ids.add(p.id);
  toWorld(world, { t: "join", id: p.id, name: p.name, skin: p.skin, voice: p.voice, adm: p.admin ? 1 : 0, size: p.mods.size, hero: null }, p.id);
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
            st: [0, 0, 0, 0, 1, 0, 0, 0, 0], voice: 0, lastChat: 0, lastSkin: 0, gone: false, hist: [], hero: null, admin: !!auth.admin, owner: !!auth.owner, mods: { fly: false, noclip: false, speed: 1, jump: 1, freeze: false, god: false, size: 1, web: false, car: false } };
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
        if (m.w === "br") sendBrState(p); else if (m.w === "tag" || m.w === "koth") send(ws, mgState(m.w));
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
        if (room.raceStart && now < room.raceStart + 150000) { send(ws, { t: "feed", m: "A race is already underway." }); return; }
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
      case "hero": {                      // pick a hero (only in Hero City); everyone else sees the icon + size
        const h = m.h === null ? null : (HERO_IDS.includes(m.h) ? m.h : undefined);
        if (h === undefined || (h && p.world !== "city")) return;
        p.hero = h; toWorld(p.world, { t: "hero", id: p.id, h: h }, p.id); break;
      }
      case "throw": brThrow(p, m); break;
      case "use": brUse(p, m.k); break;
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
