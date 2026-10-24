const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6 });
const PORT = process.env.PORT || 3000;
const players = new Map();
const cleanText = (v, max=180) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0,max);

app.get('/health', (_req,res) => res.json({ok:true, players:players.size}));
app.use(express.static(__dirname));

io.on('connection', socket => {
  socket.emit('init', { players: Object.fromEntries([...players.entries()].map(([id,p])=>[id,p])) });
  socket.on('join', payload => {
    const p = {
      id: socket.id,
      name: cleanText(payload?.name,18) || 'Guest',
      color: Number(payload?.color) || 0x70e1d0,
      x: 0, y: 0, z: 0, yaw: 0, mode: 'HANGOUT', drawing: null
    };
    players.set(socket.id,p);
    socket.broadcast.emit('playerJoined', p);
  });
  socket.on('move', data => {
    const p = players.get(socket.id); if (!p || !data) return;
    // Bound incoming values so malformed clients cannot send infinite coordinates.
    p.x = clamp(data.x,-200,200); p.y = clamp(data.y,0,80); p.z = clamp(data.z,-200,200);
    p.yaw = clamp(data.yaw,-1000,1000);
    p.mode = cleanText(data.mode,20) || 'HANGOUT';
  });
  socket.on('chat', text => {
    const p = players.get(socket.id); if (!p) return;
    const message = cleanText(text,180); if (!message) return;
    io.emit('chat', {name:p.name, text:message, at:Date.now()});
  });
  socket.on('drawing', image => {
    const p = players.get(socket.id); if (!p || typeof image !== 'string' || image.length > 350000) return;
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(image)) return;
    p.drawing = image;
    socket.broadcast.emit('drawing', {id:socket.id, image});
  });
  socket.on('mode', mode => {
    const p = players.get(socket.id); if (!p) return;
    p.mode = cleanText(mode,20) || 'HANGOUT';
    socket.broadcast.emit('state', Object.fromEntries([[socket.id,p]]));
  });
  socket.on('voice-ready', () => socket.broadcast.emit('voice-ready', socket.id));
  socket.on('signal', packet => {
    if (!packet || typeof packet.to !== 'string' || !packet.data) return;
    const target = io.sockets.sockets.get(packet.to);
    if (target) target.emit('signal', {from:socket.id, data:packet.data});
  });
  socket.on('disconnect', () => {
    players.delete(socket.id);
    socket.broadcast.emit('playerLeft', socket.id);
  });
});

// Broadcast compact snapshots; clients interpolate between updates.
setInterval(() => {
  const state = Object.fromEntries([...players.entries()].map(([id,p])=>[id,{
    x:p.x,y:p.y,z:p.z,yaw:p.yaw,mode:p.mode,name:p.name,color:p.color,drawing:p.drawing
  }]));
  io.emit('state', state);
}, 100);

function clamp(n,min,max) { n=Number(n); return Number.isFinite(n) ? Math.max(min,Math.min(max,n)) : 0; }

server.listen(PORT, '0.0.0.0', () => console.log(`Portal Plaza listening on ${PORT}`));
