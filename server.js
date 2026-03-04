const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

let users = {};
let playlist = [], currentIndex = -1;
let playerState = { playing: false, currentTime: 0, updatedAt: Date.now() };

function extractYouTubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
function normalizeName(n) {
  return n.toLowerCase().replace(/l/g,'i').replace(/1/g,'i').replace(/0/g,'o').replace(/\|/g,'i');
}
function isNameTaken(n) {
  return Object.values(users).some(u => normalizeName(u.username) === normalizeName(n));
}

io.on('connection', (socket) => {
  socket.on('join', (username) => {
    const trimmed = username.trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 20) { socket.emit('joinError','LENGTH'); return; }
    if (isNameTaken(trimmed)) { socket.emit('joinError','TAKEN'); return; }
    users[socket.id] = { username: trimmed, videoOn: false, micOn: false };
    socket.emit('joinOk', trimmed);
    socket.emit('existingUsers', Object.entries(users).filter(([id])=>id!==socket.id).map(([id,u])=>({id,...u})));
    socket.emit('videoState', { playlist, currentIndex, playerState });
    socket.broadcast.emit('userJoined', { id: socket.id, username: trimmed, videoOn: false, micOn: false });
    io.emit('system', { text: trimmed, event: 'joined', count: Object.keys(users).length });
    io.emit('userList', Object.entries(users).map(([id,u])=>({id,...u})));
  });

  socket.on('message', (text) => {
    const u = users[socket.id]; if (!u) return;
    if (text.trim().startsWith('!ytb ')) {
      const videoId = extractYouTubeId(text.trim().slice(5).trim());
      if (!videoId) { socket.emit('system',{text:'',event:'ytbInvalid',count:Object.keys(users).length}); return; }
      if (playlist.length >= 5) { socket.emit('system',{text:'',event:'ytbFull',count:Object.keys(users).length}); return; }
      playlist.push({ url: text, videoId, addedBy: u.username });
      if (currentIndex===-1) { currentIndex=0; playerState={playing:true,currentTime:0,updatedAt:Date.now()}; }
      io.emit('videoState',{playlist,currentIndex,playerState});
      io.emit('system',{text:u.username,event:'ytbAdded',count:Object.keys(users).length,total:playlist.length});
      return;
    }
    io.emit('message', { username: u.username, text, id: socket.id, time: new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}) });
  });

  socket.on('videoControl', ({action,value}) => {
    const u=users[socket.id]; if(!u) return;
    if (action==='play')   { playerState={playing:true,currentTime:value??playerState.currentTime,updatedAt:Date.now()}; io.emit('videoState',{playlist,currentIndex,playerState}); }
    else if(action==='pause')  { playerState={playing:false,currentTime:value??playerState.currentTime,updatedAt:Date.now()}; io.emit('videoState',{playlist,currentIndex,playerState}); }
    else if(action==='seek')   { playerState={...playerState,currentTime:value,updatedAt:Date.now()}; io.emit('videoState',{playlist,currentIndex,playerState}); }
    else if(action==='next')   { if(currentIndex<playlist.length-1){currentIndex++;playerState={playing:true,currentTime:0,updatedAt:Date.now()};io.emit('videoState',{playlist,currentIndex,playerState});io.emit('system',{text:u.username,event:'ytbNext',count:Object.keys(users).length});} }
    else if(action==='prev')   { if(currentIndex>0){currentIndex--;playerState={playing:true,currentTime:0,updatedAt:Date.now()};io.emit('videoState',{playlist,currentIndex,playerState});io.emit('system',{text:u.username,event:'ytbPrev',count:Object.keys(users).length});} }
    else if(action==='remove') { if(value>=0&&value<playlist.length){playlist.splice(value,1);if(currentIndex>=playlist.length)currentIndex=playlist.length-1;if(playlist.length===0){currentIndex=-1;playerState.playing=false;}io.emit('videoState',{playlist,currentIndex,playerState});io.emit('system',{text:u.username,event:'ytbRemoved',count:Object.keys(users).length});} }
    else if(action==='select') { currentIndex=value;playerState={playing:true,currentTime:0,updatedAt:Date.now()};io.emit('videoState',{playlist,currentIndex,playerState});io.emit('system',{text:u.username,event:'ytbSelect',count:Object.keys(users).length}); }
  });

  socket.on('webrtc-offer',   ({to,offer})     => io.to(to).emit('webrtc-offer',  {from:socket.id,fromName:users[socket.id]?.username,offer}));
  socket.on('webrtc-answer',  ({to,answer})    => io.to(to).emit('webrtc-answer', {from:socket.id,answer}));
  socket.on('webrtc-ice',     ({to,candidate}) => io.to(to).emit('webrtc-ice',    {from:socket.id,candidate}));
  socket.on('webrtc-hangup',  ({to})           => io.to(to).emit('webrtc-hangup', {from:socket.id}));

  socket.on('mediaState', ({videoOn,micOn}) => {
    if(users[socket.id]){users[socket.id].videoOn=videoOn;users[socket.id].micOn=micOn;}
    socket.broadcast.emit('peerMediaState',{id:socket.id,videoOn,micOn});
    io.emit('userList',Object.entries(users).map(([id,u])=>({id,...u})));
  });

  socket.on('disconnect', () => {
    const u=users[socket.id]; if(!u) return;
    delete users[socket.id];
    socket.broadcast.emit('peerLeft',{id:socket.id});
    io.emit('system',{text:u.username,event:'left',count:Object.keys(users).length});
    io.emit('userList',Object.entries(users).map(([id,u])=>({id,...u})));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
