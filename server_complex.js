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

const ADMIN_USERNAME = 'OG';
const ADMIN_PASSWORD = 'admin';

function extractYouTubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function generateRandomUsername() {
  const adjectives = ['Rouge', 'Noir', 'Blanc', 'Gris', 'Bleu', 'Vert', 'Or', 'Argent', 'Froid', 'Chaud', 'Sombre', 'Lumineux', 'Silencieux', 'Mystique', 'Secret'];
  const nouns = ['Fantôme', 'Ombre', 'Écho', 'Visiteur', 'Voyageur', 'Étranger', 'Invité', 'Passant', 'Observateur', 'Silence', 'Mystère', 'Secret'];
  const numbers = Math.floor(Math.random() * 999) + 1;
  
  let username;
  let attempts = 0;
  do {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    username = `${adj}${noun}${numbers}`;
    attempts++;
  } while (attempts < 50);
  
  return username;
}

function normalizeName(n) {
  return n.toLowerCase().replace(/l/g,'i').replace(/1/g,'i').replace(/0/g,'o').replace(/\|/g,'i');
}

const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;

  function getRoomData(roomName) {
    if (!rooms[roomName]) {
      rooms[roomName] = {
        users: {},
        playlist: [],
        currentIndex: -1,
        playerState: { playing: false, currentTime: 0, updatedAt: Date.now() }
      };
    }
    return rooms[roomName];
  }

  function isAdmin(roomData, socketId) {
    return roomData.users[socketId]?.isAdmin === true;
  }

  function isNameTaken(roomData, n) {
    return Object.values(roomData.users).some(u => normalizeName(u.username) === normalizeName(n));
  }

  socket.on('joinRoom', (roomName) => {
    if (currentRoom) {
      socket.leave(currentRoom);
    }
    
    currentRoom = roomName || 'default';
    socket.join(currentRoom);
    
    const roomData = getRoomData(currentRoom);
    
    // Auto-join with random username
    const username = generateRandomUsername();
    const isAdminUser = false;
    
    roomData.users[socket.id] = { username, videoOn: false, micOn: false, isAdmin: isAdminUser };

    socket.emit('joinOk', { username, isAdmin: isAdminUser });
    socket.emit('existingUsers', Object.entries(roomData.users).filter(([id])=>id!==socket.id).map(([id,u])=>({id,...u})));
    socket.emit('videoState', { playlist: roomData.playlist, currentIndex: roomData.currentIndex, playerState: roomData.playerState });
    
    // Émet aux autres dans la room seulement si la room existe
    if (currentRoom && rooms[currentRoom]) {
      try {
        socket.to(currentRoom).broadcast.emit('userJoined', { id: socket.id, username, videoOn: false, micOn: false, isAdmin: isAdminUser });
        io.to(currentRoom).emit('system', { text: username, event: 'joined', count: Object.keys(roomData.users).length });
        io.to(currentRoom).emit('userList', Object.entries(roomData.users).map(([id,u])=>({id, username:u.username, videoOn:u.videoOn, micOn:u.micOn, isAdmin:u.isAdmin})));
      } catch (error) {
        console.error('Error emitting to room:', error);
      }
    }
  });

  socket.on('message', (text) => {
    if (!currentRoom) return;
    const roomData = getRoomData(currentRoom);
    const u = roomData.users[socket.id]; 
    if (!u) return;
    
    if (text.trim().startsWith('!ytb ')) {
      const videoId = extractYouTubeId(text.trim().slice(5).trim());
      if (!videoId) { socket.emit('system',{text:'',event:'ytbInvalid',count:Object.keys(roomData.users).length}); return; }
      if (roomData.playlist.length >= 5) { socket.emit('system',{text:'',event:'ytbFull',count:Object.keys(roomData.users).length}); return; }
      roomData.playlist.push({ url: text, videoId, addedBy: u.username });
      if (roomData.currentIndex===-1) { 
        roomData.currentIndex=0; 
        roomData.playerState={playing:true,currentTime:0,updatedAt:Date.now()}; 
      }
      try {
        io.to(currentRoom).emit('videoState',{playlist:roomData.playlist,currentIndex:roomData.currentIndex,playerState:roomData.playerState});
        io.to(currentRoom).emit('system',{text:u.username,event:'ytbAdded',count:Object.keys(roomData.users).length,total:roomData.playlist.length});
      } catch (error) {
        console.error('Error in ytb message:', error);
      }
      return;
    }
    try {
      io.to(currentRoom).emit('message', { username: u.username, text, id: socket.id, time: new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}) });
    } catch (error) {
      console.error('Error emitting message:', error);
    }
  });

  // VIDEO CONTROLS — admin only
  socket.on('videoControl', ({action,value}) => {
    if (!currentRoom) return;
    const roomData = getRoomData(currentRoom);
    const u = roomData.users[socket.id]; 
    if(!u) return;
    if (!isAdmin(roomData, socket.id)) return;
    
    try {
      if (action==='play')        { roomData.playerState={playing:true,currentTime:value??roomData.playerState.currentTime,updatedAt:Date.now()}; io.to(currentRoom).emit('videoState',{playlist:roomData.playlist,currentIndex:roomData.currentIndex,playerState:roomData.playerState}); }
      else if(action==='pause')   { roomData.playerState={playing:false,currentTime:value??roomData.playerState.currentTime,updatedAt:Date.now()}; io.to(currentRoom).emit('videoState',{playlist:roomData.playlist,currentIndex:roomData.currentIndex,playerState:roomData.playerState}); }
      else if(action==='seek')    { roomData.playerState={...roomData.playerState,currentTime:value,updatedAt:Date.now()}; io.to(currentRoom).emit('videoState',{playlist:roomData.playlist,currentIndex:roomData.currentIndex,playerState:roomData.playerState}); }
      else if(action==='next')    { if(roomData.currentIndex<roomData.playlist.length-1){roomData.currentIndex++;roomData.playerState={playing:true,currentTime:0,updatedAt:Date.now()};io.to(currentRoom).emit('videoState',{playlist:roomData.playlist,currentIndex:roomData.currentIndex,playerState:roomData.playerState});io.to(currentRoom).emit('system',{text:u.username,event:'ytbNext',count:Object.keys(roomData.users).length});} }
      else if(action==='prev')    { if(roomData.currentIndex>0){roomData.currentIndex--;roomData.playerState={playing:true,currentTime:0,updatedAt:Date.now()};io.to(currentRoom).emit('videoState',{playlist:roomData.playlist,currentIndex:roomData.currentIndex,playerState:roomData.playerState});io.to(currentRoom).emit('system',{text:u.username,event:'ytbPrev',count:Object.keys(roomData.users).length});} }
      else if(action==='remove')  { if(value>=0&&value<roomData.playlist.length){roomData.playlist.splice(value,1);if(roomData.currentIndex>=roomData.playlist.length)roomData.currentIndex=roomData.playlist.length-1;if(roomData.playlist.length===0){roomData.currentIndex=-1;roomData.playerState.playing=false;}io.to(currentRoom).emit('videoState',{playlist:roomData.playlist,currentIndex:roomData.currentIndex,playerState:roomData.playerState});io.to(currentRoom).emit('system',{text:u.username,event:'ytbRemoved',count:Object.keys(roomData.users).length});} }
      else if(action==='select')  { roomData.currentIndex=value;roomData.playerState={playing:true,currentTime:0,updatedAt:Date.now()};io.to(currentRoom).emit('videoState',{playlist:roomData.playlist,currentIndex:roomData.currentIndex,playerState:roomData.playerState});io.to(currentRoom).emit('system',{text:u.username,event:'ytbSelect',count:Object.keys(roomData.users).length}); }
    } catch (error) {
      console.error('Error in videoControl:', error);
    }
  });

  // KICK — admin only
  socket.on('kick', (targetId) => {
    if (!currentRoom) return;
    const roomData = getRoomData(currentRoom);
    if (!isAdmin(roomData, socket.id)) return;
    const target = roomData.users[targetId]; 
    if (!target) return;
    io.to(targetId).emit('kicked');
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) targetSocket.disconnect(true);
    delete roomData.users[targetId];
    io.to(currentRoom).emit('system', { text: target.username, event: 'kicked', count: Object.keys(roomData.users).length });
    io.to(currentRoom).emit('userList', Object.entries(roomData.users).map(([id,u])=>({id, username:u.username, videoOn:u.videoOn, micOn:u.micOn, isAdmin:u.isAdmin})));
  });

  socket.on('webrtc-offer',   ({to,offer})     => io.to(to).emit('webrtc-offer',  {from:socket.id,fromName:getRoomData(currentRoom)?.users[socket.id]?.username,offer}));
  socket.on('webrtc-answer',  ({to,answer})    => io.to(to).emit('webrtc-answer', {from:socket.id,answer}));
  socket.on('webrtc-ice',     ({to,candidate}) => io.to(to).emit('webrtc-ice',    {from:socket.id,candidate}));
  socket.on('webrtc-hangup',  ({to})           => io.to(to).emit('webrtc-hangup', {from:socket.id}));

  socket.on('mediaState', ({videoOn,micOn}) => {
    if (!currentRoom) return;
    const roomData = getRoomData(currentRoom);
    if(roomData.users[socket.id]){
      roomData.users[socket.id].videoOn=videoOn;
      roomData.users[socket.id].micOn=micOn;
    }
    if (currentRoom && rooms[currentRoom]) {
      socket.to(currentRoom).broadcast.emit('peerMediaState',{id:socket.id,videoOn,micOn});
      io.to(currentRoom).emit('userList',Object.entries(roomData.users).map(([id,u])=>({id, username:u.username, videoOn:u.videoOn, micOn:u.micOn, isAdmin:u.isAdmin})));
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const roomData = getRoomData(currentRoom);
    const u = roomData.users[socket.id]; 
    if(!u) return;
    delete roomData.users[socket.id];
    if (currentRoom && rooms[currentRoom]) {
      socket.to(currentRoom).broadcast.emit('peerLeft',{id:socket.id});
      io.to(currentRoom).emit('system',{text:u.username,event:'left',count:Object.keys(roomData.users).length});
      io.to(currentRoom).emit('userList',Object.entries(roomData.users).map(([id,u])=>({id, username:u.username, videoOn:u.videoOn, micOn:u.micOn, isAdmin:u.isAdmin})));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
