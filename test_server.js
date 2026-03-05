// Test simple pour vérifier que le serveur démarre
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// Route catch-all pour SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = {};

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  let currentRoom = null;

  socket.on('joinRoom', (roomName) => {
    console.log('Joining room:', roomName);
    if (currentRoom) {
      socket.leave(currentRoom);
    }
    
    currentRoom = roomName || 'default';
    socket.join(currentRoom);
    
    if (!rooms[currentRoom]) {
      rooms[currentRoom] = {
        users: {},
        playlist: [],
        currentIndex: -1,
        playerState: { playing: false, currentTime: 0, updatedAt: Date.now() }
      };
    }
    
    const roomData = rooms[currentRoom];
    
    // Générer pseudo aléatoire
    const username = `User${Math.floor(Math.random() * 1000)}`;
    roomData.users[socket.id] = { username, videoOn: false, micOn: false, isAdmin: false };

    socket.emit('joinOk', { username, isAdmin: false });
    socket.to(currentRoom).broadcast.emit('userJoined', { id: socket.id, username });
    io.to(currentRoom).emit('system', { text: username, event: 'joined', count: Object.keys(roomData.users).length });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].users[socket.id];
      io.to(currentRoom).emit('system', { text: 'User', event: 'left', count: Object.keys(rooms[currentRoom].users).length });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
