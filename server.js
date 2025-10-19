
/**
 * La cassaforte del folletto — server multi-room (Socket.IO)
 * Avvio locale:  npm i express socket.io nanoid  && node server.js
 * Deploy: Render / Railway / Fly — Node server standard (porta da process.env.PORT)
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { customAlphabet } = require('nanoid');
const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req,res)=>res.json({ ok:true }));

// Stato per stanza: mappa roomCode -> state
// NB: In-memory: su riavvio si perde (ok per demo/lezione). Per persistenza usare DB esterno.
const rooms = new Map();
// State schema:
// {
//   coins[], eliminated[], rolls[], current, centerCoins, borders{}, log[],
//   lastRoll, requiredMove, grace[], paused, players[], hostId
// }

const BORDER_NUMS = [3,4,5,6,8,9,10,11];
const MAX_ROLLS = 8;

function defaultState(p){
  return {
    coins: Array(p).fill(4),
    eliminated: Array(p).fill(false),
    rolls: Array(p).fill(0),
    grace: Array(p).fill(0), // 0=normale, 1=ultima chance prossimo turno, 2=ultima chance ora
    current: 0,
    centerCoins: 0,
    borders: Object.fromEntries(BORDER_NUMS.map(n=>[n,false])),
    log: ['Nuova partita. Ognuno ha 4 monete.'],
    lastRoll: null,
    requiredMove: null,
    paused: false,
    players: Array(p).fill(null), // {nick, avatar, socketId}
    hostId: null,
  };
}

function labelPlayer(st, i){
  const meta = st.players?.[i];
  return meta ? `${meta.avatar} ${meta.nick}` : `Giocatore ${i+1}`;
}

function nextAlive(st, i){
  for(let k=1;k<=st.coins.length;k++){
    const n=(i+k)%st.coins.length;
    if(!st.eliminated[n]) return n;
  }
  return i;
}

function announceMove(st, room){
  const m = st.requiredMove;
  if(!m) return;
  let line='';
  if(m.type==='deposit' && m.to==='center') line='Mossa: deposita 1 al CENTRO.';
  if(m.type==='deposit' && typeof m.to==='number') line=`Mossa: deposita 1 nel settore ${m.to}.`;
  if(m.type==='withdraw') line=`Mossa: preleva 1 dal settore ${m.from}.`;
  if(m.type==='collect') line='Mossa: raccogli TUTTE dai bordi (premi Azione).';
  if(m.type==='collectAll') line='Mossa: raccogli TUTTO (bordi + centro) (premi Azione).';
  if(line){ st.log.unshift(line); io.to(room).emit('state', st); }
}

function computeRequiredMove(st, total){
  if(BORDER_NUMS.includes(total)){
    return st.borders[total] ? {type:'withdraw', from: total} : {type:'deposit', to: total};
  }
  if(total===7) return {type:'deposit', to:'center'};
  if(total===2) return {type:'collect'};
  if(total===12) return {type:'collectAll'};
  return null;
}

function appendLog(st, room, line){
  st.log.unshift(line);
  st.log = st.log.slice(0, 160);
  io.to(room).emit('state', st);
}

function checkEnd(st, room){
  // 1) Ultimo rimasto
  const alive = st.eliminated.filter(e=>!e).length;
  if(alive<=1){
    const win = st.eliminated.findIndex(e=>!e);
    appendLog(st, room, `🎉 Fine: vince ${labelPlayer(st, win)}.`);
    io.to(room).emit('gameOver', { winners: [win], coins: st.coins });
    st.paused = true;
    return true;
  }
  // 2) Tutti i giocatori in gioco hanno fatto MAX_ROLLS lanci
  const allDone = st.rolls.every((r,i)=> st.eliminated[i] ? true : (r>=MAX_ROLLS));
  if(allDone){
    let max = -Infinity;
    for(let i=0;i<st.coins.length;i++) if(!st.eliminated[i]) max = Math.max(max, st.coins[i]);
    const winners = st.coins.map((c,i)=>({c,i})).filter(o=>!st.eliminated[o.i] && o.c===max).map(o=>o.i);
    const names = winners.map(i=>labelPlayer(st,i)).join(', ');
    appendLog(st, room, `⏱️ Fine turni (${MAX_ROLLS} a testa). Vincitore/i: ${names} (con ${max} monete).`);
    io.to(room).emit('gameOver', { winners, coins: st.coins });
    st.paused = true;
    return true;
  }
  return false;
}

io.on('connection', (socket)=>{
  let roomJoined = null;

  socket.on('createRoom', ({ playersCount })=>{
    const code = nanoid();
    const p = Math.max(3, Math.min(6, parseInt(playersCount||'3',10)));
    rooms.set(code, defaultState(p));
    rooms.get(code).hostId = socket.id;
    roomJoined = code;
    socket.join(code);
    socket.emit('roomCreated', { code });
    socket.emit('state', rooms.get(code));
  });

  socket.on('joinRoom', ({ code })=>{
    const room = String(code||'').toUpperCase();
    if(!rooms.has(room)){ socket.emit('errorMsg', 'Stanza non trovata'); return; }
    roomJoined = room;
    socket.join(room);
    socket.emit('state', rooms.get(room));
  });

  socket.on('claimSeat', ({ seat, nick, avatar })=>{
    const st = rooms.get(roomJoined); if(!st) return;
    if(seat<0 || seat>=st.coins.length) return;
    if(st.players[seat]) return;
    st.players[seat] = { nick: (nick||`Giocatore ${seat+1}`).slice(0,24), avatar: avatar||'🧚', socketId: socket.id };
    io.to(roomJoined).emit('state', st);
  });

  socket.on('rename', ({ seat, nick })=>{
    const st = rooms.get(roomJoined); if(!st) return;
    if(seat<0 || seat>=st.coins.length) return;
    if(!st.players[seat]) return;
    const old = st.players[seat].nick;
    st.players[seat].nick = (nick||old).slice(0,24);
    appendLog(st, roomJoined, `✏️ Rinominato: ${old} → ${st.players[seat].nick}`);
  });

  socket.on('startGame', ()=>{
    const st = rooms.get(roomJoined); if(!st) return;
    if(st.hostId !== socket.id) return; // solo host
    st.paused=false;
    io.to(roomJoined).emit('state', st);
  });

  socket.on('roll', ()=>{
    const st = rooms.get(roomJoined); if(!st || st.paused) return;
    st.lastRoll = { a: 1+Math.floor(Math.random()*6), b: 1+Math.floor(Math.random()*6) };
    st.rolls[st.current]++;
    appendLog(st, roomJoined, `${labelPlayer(st, st.current)} lancia: ${st.lastRoll.a} + ${st.lastRoll.b}`);
  });

  socket.on('confirmSum', ({ sum })=>{
    const st = rooms.get(roomJoined); if(!st || st.paused || !st.lastRoll) return;
    const total = st.lastRoll.a + st.lastRoll.b;
    if(parseInt(sum,10)!==total){ appendLog(st, roomJoined, 'Somma errata.'); return; }
    st.requiredMove = computeRequiredMove(st, total);
    io.to(roomJoined).emit('state', st);
    // eliminazione immediata se deve depositare con 0 monete
    if(st.requiredMove && st.requiredMove.type==='deposit' && st.coins[st.current]===0){
      st.eliminated[st.current]=true; st.grace[st.current]=0;
      appendLog(st, roomJoined, `❌ ${labelPlayer(st, st.current)} doveva depositare ma non ha monete: eliminato.`);
      return endMove(st, roomJoined);
    }
    announceMove(st, roomJoined);
  });

  socket.on('doAction', ()=>{
    const st = rooms.get(roomJoined); if(!st || st.paused || !st.requiredMove) return;
    const me = st.current; const mv = st.requiredMove;
    if(mv.type==='deposit'){
      if(mv.to==='center'){
        if(st.coins[me]<=0){ st.eliminated[me]=true; st.grace[me]=0; appendLog(st, roomJoined, `❌ ${labelPlayer(st, me)} doveva depositare al centro ma non ha monete: eliminato.`); return endMove(st, roomJoined); }
        st.coins[me]-=1; st.centerCoins+=1;
        appendLog(st, roomJoined, `${labelPlayer(st, me)} deposita 1 moneta al centro.`);
        if(st.coins[me]===0 && st.grace[me]===0){ st.grace[me]=1; appendLog(st, roomJoined, `⚠️ ${labelPlayer(st, me)} ha 0 monete: ultima chance al prossimo turno.`); }
        return endMove(st, roomJoined);
      } else if(typeof mv.to==='number'){
        const n = mv.to;
        if(st.borders[n]) return;
        if(st.coins[me]<=0){ st.eliminated[me]=true; st.grace[me]=0; appendLog(st, roomJoined, `❌ ${labelPlayer(st, me)} doveva depositare su ${n} ma non ha monete: eliminato.`); return endMove(st, roomJoined); }
        st.coins[me]-=1; st.borders[n]=true;
        appendLog(st, roomJoined, `${labelPlayer(st, me)} deposita 1 moneta nel settore ${n}.`);
        if(st.coins[me]===0 && st.grace[me]===0){ st.grace[me]=1; appendLog(st, roomJoined, `⚠️ ${labelPlayer(st, me)} ha 0 monete: ultima chance al prossimo turno.`); }
        return endMove(st, roomJoined);
      }
    } else if(mv.type==='withdraw'){
      const n = mv.from; if(!st.borders[n]) return;
      st.borders[n]=false; st.coins[me]+=1; if(st.coins[me]>0) st.grace[me]=0;
      appendLog(st, roomJoined, `${labelPlayer(st, me)} preleva 1 moneta dal settore ${n}.`);
      return endMove(st, roomJoined);
    } else if(mv.type==='collect'){
      let won=0; for(const n of BORDER_NUMS){ if(st.borders[n]){ st.borders[n]=false; won++; } }
      st.coins[me]+=won; if(st.coins[me]>0) st.grace[me]=0;
      appendLog(st, roomJoined, `🏆 ${labelPlayer(st, me)} vince ${won} moneta/e dai bordi.`);
      return endMove(st, roomJoined);
    } else if(mv.type==='collectAll'){
      let won = st.centerCoins; st.centerCoins=0;
      for(const n of BORDER_NUMS){ if(st.borders[n]){ st.borders[n]=false; won++; } }
      st.coins[me]+=won; if(st.coins[me]>0) st.grace[me]=0;
      appendLog(st, roomJoined, `🏆 ${labelPlayer(st, me)} vince TUTTE le monete: ${won}.`);
      return endMove(st, roomJoined);
    }
  });

  socket.on('hostControl', ({ action })=>{
    const st = rooms.get(roomJoined); if(!st || st.hostId!==socket.id) return;
    if(action==='pause') st.paused=true;
    if(action==='resume') st.paused=false;
    if(action==='reset'){
      const p = st.coins.length;
      Object.assign(st, defaultState(p), { hostId: socket.id });
    }
    io.to(roomJoined).emit('state', st);
  });

  socket.on('disconnect', ()=>{
    // Libera i posti del socket disconnesso
    for(const [code, st] of rooms){
      st.players = st.players.map(p=> p && p.socketId===socket.id ? null : p);
    }
    if(roomJoined && rooms.has(roomJoined)) io.to(roomJoined).emit('state', rooms.get(roomJoined));
  });

  function endMove(st, room){
    st.requiredMove = null;
    // eliminazione per ultima chance scaduta
    if(st.grace[st.current]===2 && st.coins[st.current]===0){
      st.eliminated[st.current]=true; st.grace[st.current]=0;
      appendLog(st, room, `❌ ${labelPlayer(st, st.current)} ha terminato il turno senza monete: eliminato (ultima chance esaurita).`);
    }
    if(checkEnd(st, room)) return;
    // passa turno
    st.current = nextAlive(st, st.current);
    if(st.grace[st.current]===1){ st.grace[st.current]=2; appendLog(st, room, `⚠️ ${labelPlayer(st, st.current)}: ultima chance in questo turno.`); }
    st.lastRoll=null;
    io.to(room).emit('state', st);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', ()=>{
  console.log('✅ Server avviato su', PORT);
});
