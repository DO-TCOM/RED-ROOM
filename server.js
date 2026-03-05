const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = {};

function generateRandomUsername() {
  const adjectives = ['Rouge', 'Noir', 'Blanc', 'Gris', 'Bleu', 'Vert'];
  const nouns = ['Fantome', 'Ombre', 'Echo', 'Visiteur', 'Voyageur'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 999) + 1;
  return `${adj}${noun}${num}`;
}

function extractYouTubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function getRoom(name) {
  if (!rooms[name]) {
    rooms[name] = {
      users: {},
      playlist: [],
      currentIndex: -1,
      playerState: { playing: false, currentTime: 0, updatedAt: Date.now() }
    };
  }
  return rooms[name];
}

function broadcastUserList(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  io.to(roomName).emit('userList',
    Object.entries(room.users).map(([id, u]) => ({
      id, username: u.username, videoOn: u.videoOn, micOn: u.micOn, isAdmin: u.isAdmin
    }))
  );
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  let currentRoom = null;

  socket.on('joinRoom', (roomName) => {
    try {
      currentRoom = roomName || 'default';
      socket.join(currentRoom);

      const room = getRoom(currentRoom);
      const username = generateRandomUsername();
      room.users[socket.id] = { username, videoOn: false, micOn: false, isAdmin: false };

      socket.emit('joinOk', { username, isAdmin: false });
      socket.emit('existingUsers',
        Object.entries(room.users)
          .filter(([id]) => id !== socket.id)
          .map(([id, u]) => ({ id, ...u }))
      );
      socket.emit('videoState', {
        playlist: room.playlist, currentIndex: room.currentIndex, playerState: room.playerState
      });
      socket.to(currentRoom).emit('userJoined', {
        id: socket.id, username, videoOn: false, micOn: false, isAdmin: false
      });
      io.to(currentRoom).emit('system', {
        text: username, event: 'joined', count: Object.keys(room.users).length
      });
      broadcastUserList(currentRoom);
      console.log(`${username} joined ${currentRoom}`);
    } catch (err) {
      console.error('joinRoom error:', err);
      socket.emit('joinError', 'Server error');
    }
  });

  socket.on('webrtc-offer',   ({ to, offer })     => io.to(to).emit('webrtc-offer',  { from: socket.id, fromName: rooms[currentRoom]?.users[socket.id]?.username, offer }));
  socket.on('webrtc-answer',  ({ to, answer })    => io.to(to).emit('webrtc-answer', { from: socket.id, answer }));
  socket.on('webrtc-ice',     ({ to, candidate }) => io.to(to).emit('webrtc-ice',    { from: socket.id, candidate }));
  socket.on('webrtc-hangup',  ({ to })            => io.to(to).emit('webrtc-hangup', { from: socket.id }));

  socket.on('mediaState', ({ videoOn, micOn }) => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      if (!room?.users[socket.id]) return;
      room.users[socket.id].videoOn = videoOn;
      room.users[socket.id].micOn = micOn;
      socket.to(currentRoom).emit('peerMediaState', { id: socket.id, videoOn, micOn });
      broadcastUserList(currentRoom);
    } catch (err) { console.error('mediaState error:', err); }
  });

  socket.on('message', (text) => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      const user = room?.users[socket.id];
      if (!user) return;

      if (text.trim().startsWith('!ytb ')) {
        const videoUrl = text.trim().slice(5).trim();
        const videoId = extractYouTubeId(videoUrl);
        if (!videoId) { socket.emit('system', { text: '', event: 'ytbInvalid', count: Object.keys(room.users).length }); return; }
        if (room.playlist.length >= 5) { socket.emit('system', { text: '', event: 'ytbFull', count: Object.keys(room.users).length }); return; }
        room.playlist.push({ url: videoUrl, videoId, addedBy: user.username });
        if (room.currentIndex === -1) { room.currentIndex = 0; room.playerState = { playing: true, currentTime: 0, updatedAt: Date.now() }; }
        io.to(currentRoom).emit('videoState', { playlist: room.playlist, currentIndex: room.currentIndex, playerState: room.playerState });
        io.to(currentRoom).emit('system', { text: user.username, event: 'ytbAdded', count: Object.keys(room.users).length, total: room.playlist.length });
        return;
      }

      io.to(currentRoom).emit('message', {
        username: user.username, text, id: socket.id,
        time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      });
    } catch (err) { console.error('message error:', err); }
  });

  socket.on('videoControl', ({ action, value }) => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      if (!room?.users[socket.id]) return;
      const ps = room.playerState;
      if      (action === 'play')   { room.playerState = { playing: true,  currentTime: value ?? ps.currentTime, updatedAt: Date.now() }; }
      else if (action === 'pause')  { room.playerState = { playing: false, currentTime: value ?? ps.currentTime, updatedAt: Date.now() }; }
      else if (action === 'seek')   { room.playerState = { ...ps, currentTime: value, updatedAt: Date.now() }; }
      else if (action === 'next')   { if (room.currentIndex < room.playlist.length - 1) { room.currentIndex++; room.playerState = { playing: true, currentTime: 0, updatedAt: Date.now() }; } }
      else if (action === 'prev')   { if (room.currentIndex > 0) { room.currentIndex--; room.playerState = { playing: true, currentTime: 0, updatedAt: Date.now() }; } }
      else if (action === 'select') { room.currentIndex = value; room.playerState = { playing: true, currentTime: 0, updatedAt: Date.now() }; }
      else if (action === 'remove') {
        if (value >= 0 && value < room.playlist.length) {
          room.playlist.splice(value, 1);
          if (room.currentIndex >= room.playlist.length) room.currentIndex = room.playlist.length - 1;
          if (room.playlist.length === 0) { room.currentIndex = -1; room.playerState.playing = false; }
        }
      }
      io.to(currentRoom).emit('videoState', { playlist: room.playlist, currentIndex: room.currentIndex, playerState: room.playerState });
    } catch (err) { console.error('videoControl error:', err); }
  });

  socket.on('kick', (targetId) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room?.users[socket.id]?.isAdmin) return;
    const target = room.users[targetId];
    if (!target) return;
    io.to(targetId).emit('kicked');
    io.sockets.sockets.get(targetId)?.disconnect(true);
    delete room.users[targetId];
    io.to(currentRoom).emit('system', { text: target.username, event: 'kicked', count: Object.keys(room.users).length });
    broadcastUserList(currentRoom);
  });

  socket.on('disconnect', () => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      const user = room?.users[socket.id];
      if (!user) return;
      delete room.users[socket.id];
      socket.to(currentRoom).emit('peerLeft', { id: socket.id });
      io.to(currentRoom).emit('system', { text: user.username, event: 'left', count: Object.keys(room.users).length });
      broadcastUserList(currentRoom);
      console.log(`${user.username} left ${currentRoom}`);
    } catch (err) { console.error('disconnect error:', err); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
