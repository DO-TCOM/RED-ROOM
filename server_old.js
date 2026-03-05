const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

  // VIDEO CONTROLS — admin only
  socket.on('videoControl', ({action,value}) => {
    const u=users[socket.id]; if(!u) return;
    if (!isAdmin(socket.id)) return;
    if (action==='play')        { playerState={playing:true,currentTime:value??playerState.currentTime,updatedAt:Date.now()}; io.emit('videoState',{playlist,currentIndex,playerState}); }
    else if(action==='pause')   { playerState={playing:false,currentTime:value??playerState.currentTime,updatedAt:Date.now()}; io.emit('videoState',{playlist,currentIndex,playerState}); }
    else if(action==='seek')    { playerState={...playerState,currentTime:value,updatedAt:Date.now()}; io.emit('videoState',{playlist,currentIndex,playerState}); }
    else if(action==='next')    { if(currentIndex<playlist.length-1){currentIndex++;playerState={playing:true,currentTime:0,updatedAt:Date.now()};io.emit('videoState',{playlist,currentIndex,playerState});io.emit('system',{text:u.username,event:'ytbNext',count:Object.keys(users).length});} }
    else if(action==='prev')    { if(currentIndex>0){currentIndex--;playerState={playing:true,currentTime:0,updatedAt:Date.now()};io.emit('videoState',{playlist,currentIndex,playerState});io.emit('system',{text:u.username,event:'ytbPrev',count:Object.keys(users).length});} }
    else if(action==='remove')  { if(value>=0&&value<playlist.length){playlist.splice(value,1);if(currentIndex>=playlist.length)currentIndex=playlist.length-1;if(playlist.length===0){currentIndex=-1;playerState.playing=false;}io.emit('videoState',{playlist,currentIndex,playerState});io.emit('system',{text:u.username,event:'ytbRemoved',count:Object.keys(users).length});} }
    else if(action==='select')  { currentIndex=value;playerState={playing:true,currentTime:0,updatedAt:Date.now()};io.emit('videoState',{playlist,currentIndex,playerState});io.emit('system',{text:u.username,event:'ytbSelect',count:Object.keys(users).length}); }
  });

  // KICK — admin only
  socket.on('kick', (targetId) => {
    if (!isAdmin(socket.id)) return;
    const target = users[targetId]; if (!target) return;
    io.to(targetId).emit('kicked');
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) targetSocket.disconnect(true);
    delete users[targetId];
    io.emit('system', { text: target.username, event: 'kicked', count: Object.keys(users).length });
    io.emit('userList', Object.entries(users).map(([id,u])=>({id, username:u.username, videoOn:u.videoOn, micOn:u.micOn, isAdmin:u.isAdmin})));
  });

  socket.on('webrtc-offer',   ({to,offer})     => io.to(to).emit('webrtc-offer',  {from:socket.id,fromName:users[socket.id]?.username,offer}));
  socket.on('webrtc-answer',  ({to,answer})    => io.to(to).emit('webrtc-answer', {from:socket.id,answer}));
  socket.on('webrtc-ice',     ({to,candidate}) => io.to(to).emit('webrtc-ice',    {from:socket.id,candidate}));
  socket.on('webrtc-hangup',  ({to})           => io.to(to).emit('webrtc-hangup', {from:socket.id}));

  socket.on('mediaState', ({videoOn,micOn}) => {
    if(users[socket.id]){users[socket.id].videoOn=videoOn;users[socket.id].micOn=micOn;}
    socket.broadcast.emit('peerMediaState',{id:socket.id,videoOn,micOn});
    io.emit('userList',Object.entries(users).map(([id,u])=>({id, username:u.username, videoOn:u.videoOn, micOn:u.micOn, isAdmin:u.isAdmin})));
  });

  socket.on('disconnect', () => {
    const u=users[socket.id]; if(!u) return;
    delete users[socket.id];
    socket.broadcast.emit('peerLeft',{id:socket.id});
    io.emit('system',{text:u.username,event:'left',count:Object.keys(users).length});
    io.emit('userList',Object.entries(users).map(([id,u])=>({id, username:u.username, videoOn:u.videoOn, micOn:u.micOn, isAdmin:u.isAdmin})));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
