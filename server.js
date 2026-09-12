const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ROOM = '280425';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
    return res.end('ok');
  }
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const safe = path.normalize(requested).replace(/^([.][.][\\/])+/, '');
  const file = path.join(__dirname, 'public', safe);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
      return res.end('Not found');
    }
    const ext = path.extname(file);
    const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
    res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream'});
    res.end(data);
  });
});

const wss = new WebSocket.Server({server});
let players = {host:null, guest:null};
let game = null;
let pauseTimer = null;

function shuffle(deck) {
  for (let i=deck.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [deck[i],deck[j]]=[deck[j],deck[i]];
  }
}

function makeDeck() {
  const suits=['♠','♥','♦','♣'];
  const ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const deck=[];
  for (const suit of suits) for (const rank of ranks) deck.push({suit,rank,id:Math.random().toString(36).slice(2)});
  shuffle(deck); return deck;
}

function freshGame(scores=[0,0]) {
  const deck=makeDeck();
  const hands=[[],[]];
  for(let i=0;i<4;i++){ hands[0].push(deck.pop()); hands[1].push(deck.pop()); }
  // İlk masa: 3 kapalı + 1 açık. Destedeki son 4 kart masaya konur.
  const pile=[];
  for(let i=0;i<4;i++) pile.push(deck.pop());
  return {deck,hands,pile,scores:[...scores],captured:[[],[]],turn:0,done:false,winner:null,lastCapture:-1,paused:false};
}

function roleIndex(role){ return role==='host'?0:1; }
function nameOf(index){ return index===0?'Yakışıklım':'Yavrum'; }
function connected(){ return !!(players.host && players.guest && players.host.readyState===WebSocket.OPEN && players.guest.readyState===WebSocket.OPEN); }

function publicState(role){
  if(!game) return null;
  const me=roleIndex(role), opp=1-me;
  return {
    deckCount:game.deck.length,
    pile:game.pile,
    scores:[...game.scores],
    turn:game.turn,
    myHand:game.hands[me],
    opponentCardCount:game.hands[opp].length,
    finished:game.done,
    winner:game.winner,
    paused:game.paused,
    connected:connected()
  };
}

function sendAll(){
  for(const role of ['host','guest']){
    const ws=players[role];
    if(ws && ws.readyState===WebSocket.OPEN){
      ws.send(JSON.stringify({type:'state',state:publicState(role),players:{host:!!players.host,guest:!!players.guest}}));
    }
  }
}
function sendEvent(ev, onlyRole=null){
  const packet=JSON.stringify({type:'event',event:ev});
  const list=onlyRole?[players[onlyRole]]:[players.host,players.guest];
  for(const ws of list) if(ws && ws.readyState===WebSocket.OPEN) ws.send(packet);
}
function cardPoints(card){
  if(card.rank==='A'||card.rank==='J') return 1;
  if(card.rank==='2'&&card.suit==='♣') return 2;
  if(card.rank==='10'&&card.suit==='♦') return 3;
  return 0;
}
function addCardPoints(player,cards){
  let total=0;
  for(const c of cards) total+=cardPoints(c);
  game.scores[player]+=total;
  return total;
}
function finishGame(winner){
  game.done=true; game.winner=winner; game.paused=false;
  sendAll();
  sendEvent({type:'finish',winner,winnerName:nameOf(winner),scores:[...game.scores]});
}
function check52(player){
  if(game.scores[player]>=52){ finishGame(player); return true; }
  return false;
}
function dealNextRound(){
  if(game.done) return;
  if(game.deck.length===0){ finishRound(); return; }
  for(let i=0;i<4 && game.deck.length;i++){
    if(game.deck.length) game.hands[0].push(game.deck.pop());
    if(game.deck.length) game.hands[1].push(game.deck.pop());
  }
  game.turn=game.lastCapture>=0?game.lastCapture:game.turn;
  game.paused=false;
  sendAll();
  sendEvent({type:'deal'});
}
function finishRound(){
  // Son eli bitince yerde kalan kartlar son alan oyuncuya gider.
  if(game.pile.length && game.lastCapture>=0) game.captured[game.lastCapture].push(...game.pile.splice(0));
  const a=game.captured[0].length,b=game.captured[1].length;
  let bonusPlayer=-1;
  if(a>b) bonusPlayer=0; else if(b>a) bonusPlayer=1;
  if(bonusPlayer>=0){
    game.scores[bonusPlayer]+=3;
    sendEvent({type:'roundBonus',player:bonusPlayer,points:3,label:'Çok kart +3'});
    if(check52(bonusPlayer)) return;
  }
  // Deste tamamen bittiğinde burada tur kapanır; 52'ye ulaşılmadıysa yüksek puan kazanır.
  const winner=game.scores[0]===game.scores[1] ? (game.lastCapture>=0?game.lastCapture:0) : (game.scores[0]>game.scores[1]?0:1);
  finishGame(winner);
}
function afterCapture(player,cards,kind,points){
  game.paused=true;
  sendAll();
  // Yakalanan kartları alan oyuncuya 5 saniye göster.
  sendEvent({type:'revealCapture',player,cards,seconds:5,kind,points});
  clearTimeout(pauseTimer);
  pauseTimer=setTimeout(()=>{
    if(!game || game.done) return;
    game.paused=false;
    if(game.hands[0].length===0 && game.hands[1].length===0){
      if(game.deck.length>0) dealNextRound(); else finishRound();
    } else {
      sendAll();
    }
  },5000);
}
function play(player,id){
  if(!game || game.done || game.paused || !connected() || game.turn!==player) return;
  const idx=game.hands[player].findIndex(c=>c.id===id); if(idx<0) return;
  const played=game.hands[player].splice(idx,1)[0];
  const top=game.pile[game.pile.length-1];
  game.pile.push(played);
  let capture=false,pisti=false,pistiPoints=0;
  if(played.rank==='J'){
    capture=true;
    if(top && top.rank==='J' && game.pile.length===2){pisti=true;pistiPoints=20;}
  } else if(top && played.rank===top.rank){
    capture=true;
    if(game.pile.length===2){pisti=true;pistiPoints=10;}
  }
  let points=0;
  if(capture){
    const capturedCards=game.pile.splice(0);
    game.captured[player].push(...capturedCards);
    game.lastCapture=player;
    points=addCardPoints(player,capturedCards);
    if(pisti){ game.scores[player]+=pistiPoints; points+=pistiPoints; }
    sendEvent({type:'play',player,card:played,points:points,kind:pisti?'pisti':'capture'});
    if(check52(player)) return;
    game.turn=1-player;
    afterCapture(player,capturedCards,pisti?'pisti':'capture',points);
    return;
  }
  game.turn=1-player;
  sendAll();
  sendEvent({type:'play',player,card:played,points:0,kind:'play'});
  if(game.hands[0].length===0 && game.hands[1].length===0){
    if(game.deck.length>0) dealNextRound(); else finishRound();
  }
}

wss.on('connection',(ws)=>{
  let role=null;
  ws.on('message',(raw)=>{
    let m; try{m=JSON.parse(raw)}catch{return;}
    if(m.type==='join'){
      const wanted=m.role==='guest'?'guest':'host';
      if(players[wanted] && players[wanted].readyState===WebSocket.OPEN){ ws.send(JSON.stringify({type:'error',message:'Bu taraf zaten bağlı.'})); return; }
      role=wanted; players[role]=ws;
      if(!game || game.done) game=freshGame([0,0]);
      ws.send(JSON.stringify({type:'joined',role,room:ROOM}));
      sendAll();
    } else if(m.type==='play' && role) play(roleIndex(role),m.id);
    else if(m.type==='reset' && role){
      clearTimeout(pauseTimer); pauseTimer=null;
      game=freshGame([0,0]);
      sendAll(); sendEvent({type:'restart'});
    }
  });
  ws.on('close',()=>{ if(role && players[role]===ws) players[role]=null; sendAll(); });
});

wss.on('error',err=>console.error('WebSocket server error:',err.message));
setInterval(()=>{ for(const ws of [players.host,players.guest]) if(ws&&ws.readyState===WebSocket.OPEN) ws.ping(); },25000);
server.listen(PORT,'0.0.0.0',()=>console.log(`Pisti online: port ${PORT} | Oda: ${ROOM}`));
