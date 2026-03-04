const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// In-memory only — no database
let users = {}; // socketId -> { username, videoOn, micOn }

// YouTube playlist sync state
let playlist = [];       // [{ url, videoId, addedBy }]
let currentIndex = -1;   // index en cours
let playerState = {      // état partagé
  playing: false,
  currentTime: 0,
  updatedAt: Date.now()
};

function extractYouTubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

io.on('connection', (socket) => {

  // JOIN
  socket.on('join', (username) => {
    users[socket.id] = { username, videoOn: false, micOn: false };

    // Send existing users to newcomer
    socket.emit('existingUsers', Object.entries(users)
      .filter(([id]) => id !== socket.id)
      .map(([id, u]) => ({ id, ...u }))
    );

    // Notify others
    socket.broadcast.emit('userJoined', { id: socket.id, username, videoOn: false, micOn: false });

    io.emit('system', { text: `${username} a rejoint le salon`, count: Object.keys(users).length });
    io.emit('userList', Object.entries(users).map(([id, u]) => ({ id, ...u })));
  });

  // Send current video state to newcomer
  socket.on('join', () => {}, true); // already handled above, but send video state after join
  socket.emit('videoState', { playlist, currentIndex, playerState });

  // CHAT MESSAGE (handles !ytb command too)
  socket.on('message', (text) => {
    const u = users[socket.id];
    if (!u) return;

    // !ytb command
    if (text.trim().startsWith('!ytb ')) {
      const url = text.trim().slice(5).trim();
      const videoId = extractYouTubeId(url);
      if (!videoId) {
        socket.emit('system', { text: '❌ Lien YouTube invalide.', count: Object.keys(users).length });
        return;
      }
      if (playlist.length >= 5) {
        socket.emit('system', { text: '❌ Playlist pleine (max 5 vidéos). Retire une vidéo d\'abord.', count: Object.keys(users).length });
        return;
      }
      playlist.push({ url, videoId, addedBy: u.username });
      // Auto-play first video added
      if (currentIndex === -1) {
        currentIndex = 0;
        playerState = { playing: true, currentTime: 0, updatedAt: Date.now() };
      }
      io.emit('videoState', { playlist, currentIndex, playerState });
      io.emit('system', { text: `🎬 ${u.username} a ajouté une vidéo à la playlist (${playlist.length}/5)`, count: Object.keys(users).length });
      return;
    }

    io.emit('message', {
      username: u.username, text, id: socket.id,
      time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    });
  });

  // VIDEO CONTROLS (play/pause/seek/next/prev/remove)
  socket.on('videoControl', ({ action, value }) => {
    const u = users[socket.id];
    if (!u) return;

    if (action === 'play') {
      playerState = { playing: true, currentTime: value ?? playerState.currentTime, updatedAt: Date.now() };
      io.emit('videoState', { playlist, currentIndex, playerState });
    } else if (action === 'pause') {
      playerState = { playing: false, currentTime: value ?? playerState.currentTime, updatedAt: Date.now() };
      io.emit('videoState', { playlist, currentIndex, playerState });
    } else if (action === 'seek') {
      playerState = { ...playerState, currentTime: value, updatedAt: Date.now() };
      io.emit('videoState', { playlist, currentIndex, playerState });
    } else if (action === 'next') {
      if (currentIndex < playlist.length - 1) {
        currentIndex++;
        playerState = { playing: true, currentTime: 0, updatedAt: Date.now() };
        io.emit('videoState', { playlist, currentIndex, playerState });
        io.emit('system', { text: `⏭ ${u.username} a passé à la vidéo suivante`, count: Object.keys(users).length });
      }
    } else if (action === 'prev') {
      if (currentIndex > 0) {
        currentIndex--;
        playerState = { playing: true, currentTime: 0, updatedAt: Date.now() };
        io.emit('videoState', { playlist, currentIndex, playerState });
        io.emit('system', { text: `⏮ ${u.username} a repassé à la vidéo précédente`, count: Object.keys(users).length });
      }
    } else if (action === 'remove') {
      const idx = value;
      if (idx >= 0 && idx < playlist.length) {
        const removed = playlist.splice(idx, 1)[0];
        if (currentIndex >= playlist.length) currentIndex = playlist.length - 1;
        if (playlist.length === 0) { currentIndex = -1; playerState.playing = false; }
        io.emit('videoState', { playlist, currentIndex, playerState });
        io.emit('system', { text: `🗑 ${u.username} a retiré une vidéo de la playlist`, count: Object.keys(users).length });
      }
    } else if (action === 'select') {
      currentIndex = value;
      playerState = { playing: true, currentTime: 0, updatedAt: Date.now() };
      io.emit('videoState', { playlist, currentIndex, playerState });
      io.emit('system', { text: `🎬 ${u.username} a changé de vidéo`, count: Object.keys(users).length });
    }
  });

  // WebRTC SIGNALING
  socket.on('webrtc-offer',   ({ to, offer })     => io.to(to).emit('webrtc-offer',   { from: socket.id, fromName: users[socket.id]?.username, offer }));
  socket.on('webrtc-answer',  ({ to, answer })    => io.to(to).emit('webrtc-answer',  { from: socket.id, answer }));
  socket.on('webrtc-ice',     ({ to, candidate }) => io.to(to).emit('webrtc-ice',     { from: socket.id, candidate }));
  socket.on('webrtc-hangup',  ({ to })            => io.to(to).emit('webrtc-hangup',  { from: socket.id }));

  // MEDIA STATE (cam/mic toggle)
  socket.on('mediaState', ({ videoOn, micOn }) => {
    if (users[socket.id]) { users[socket.id].videoOn = videoOn; users[socket.id].micOn = micOn; }
    socket.broadcast.emit('peerMediaState', { id: socket.id, videoOn, micOn });
    io.emit('userList', Object.entries(users).map(([id, u]) => ({ id, ...u })));
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const u = users[socket.id];
    if (!u) return;
    delete users[socket.id];
    socket.broadcast.emit('peerLeft', { id: socket.id });
    io.emit('system', { text: `${u.username} a quitté le salon`, count: Object.keys(users).length });
    io.emit('userList', Object.entries(users).map(([id, u]) => ({ id, ...u })));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
