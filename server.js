const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Servir fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Route catch-all pour SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Stockage des rooms
const rooms = {};

// Génération de pseudo simple
function generateRandomUsername() {
  const adjectives = ['Rouge', 'Noir', 'Blanc', 'Gris', 'Bleu', 'Vert'];
  const nouns = ['Fantome', 'Ombre', 'Echo', 'Visiteur', 'Voyageur'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 999) + 1;
  return `${adj}${noun}${num}`;
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  let currentRoom = null;

  socket.on('joinRoom', (roomName) => {
    try {
      currentRoom = roomName || 'default';
      socket.join(currentRoom);
      
      // Créer la room si elle n'existe pas
      if (!rooms[currentRoom]) {
        rooms[currentRoom] = {
          users: {},
          playlist: [],
          currentIndex: -1,
          playerState: { playing: false, currentTime: 0, updatedAt: Date.now() }
        };
      }
      
      const room = rooms[currentRoom];
      const username = generateRandomUsername();
      
      // Ajouter l'utilisateur
      room.users[socket.id] = { 
        username, 
        videoOn: false, 
        micOn: false, 
        isAdmin: false 
      };
      
      // Envoyer les données initiales
      socket.emit('joinOk', { username, isAdmin: false });
      socket.emit('videoState', { 
        playlist: room.playlist, 
        currentIndex: room.currentIndex, 
        playerState: room.playerState 
      });
      
      // Notifier les autres
      socket.to(currentRoom).emit('userJoined', { 
        id: socket.id, 
        username, 
        videoOn: false, 
        micOn: false, 
        isAdmin: false 
      });
      
      io.to(currentRoom).emit('system', { 
        text: username, 
        event: 'joined', 
        count: Object.keys(room.users).length 
      });
      
      io.to(currentRoom).emit('userList', 
        Object.entries(room.users).map(([id, u]) => ({
          id, 
          username: u.username, 
          videoOn: u.videoOn, 
          micOn: u.micOn, 
          isAdmin: u.isAdmin
        }))
      );
      
      console.log(`User ${username} joined room ${currentRoom}`);
      
    } catch (error) {
      console.error('Error in joinRoom:', error);
      socket.emit('joinError', 'Server error');
    }
  });

  socket.on('message', (text) => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      if (!room) return;
      
      const user = room.users[socket.id];
      if (!user) return;
      
      // Message YouTube
      if (text.trim().startsWith('!ytb ')) {
        // TODO: Implémenter YouTube plus tard
        return;
      }
      
      // Message normal
      io.to(currentRoom).emit('message', {
        username: user.username,
        text,
        id: socket.id,
        time: new Date().toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit'
        })
      });
      
    } catch (error) {
      console.error('Error in message:', error);
    }
  });

  socket.on('disconnect', () => {
    try {
      if (!currentRoom) return;
      const room = rooms[currentRoom];
      if (!room) return;
      
      const user = room.users[socket.id];
      if (!user) return;
      
      delete room.users[socket.id];
      
      socket.to(currentRoom).emit('peerLeft', { id: socket.id });
      io.to(currentRoom).emit('system', {
        text: user.username,
        event: 'left',
        count: Object.keys(room.users).length
      });
      
      console.log(`User ${user.username} left room ${currentRoom}`);
      
    } catch (error) {
      console.error('Error in disconnect:', error);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
