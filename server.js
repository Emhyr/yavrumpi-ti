const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const ROOM = "280425";
const server = http.createServer((req,res)=>{
  let file = req.url === "/" ? "/index.html" : req.url;
  if(req.url === "/health"){res.writeHead(200,{"Content-Type":"text/plain"});return res.end("ok");}
  const full = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[\/\\])+/, ""));
  fs.readFile(full,(err,data)=>{
    if(err){res.writeHead(404);return res.end("Not found");}
    const ext=path.extname(full);
    const type={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"}[ext]||"application/octet-stream";
    res.writeHead(200,{"Content-Type":type});res.end(data);
  });
});

const wss = new WebSocket.Server({server});
wss.on("error", err => console.error("WebSocket server error:", err.message));
setInterval(() => {
  for (const ws of [players.host, players.guest]) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, 25000);
let players = {host:null, guest:null};
let game = null;

function freshGame(){
  const suits=["♠","♥","♦","♣"], ranks=["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  let deck=[];
  for(const suit of suits) for(const rank of ranks) deck.push({suit,rank,id:Math.random().toString(36).slice(2)});
  for(let i=deck.length-1;i;i--){let j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]]}
  let hands=[[],[]];
  for(let i=0;i<4;i++){hands[0].push(deck.pop());hands[1].push(deck.pop())}
  return {deck,hands,pile:[deck.pop(),deck.pop(),deck.pop(),deck.pop()],scores:[0,0],captured:[[],[]],turn:0,done:false,lastCapture:-1};
}
function publicState(forRole){
  if(!game)return null;
  const me = forRole==="host" ? 0 : 1;
  const opp = 1-me;
  return {
    deckCount:game.deck.length,
    pile:game.pile,
    scores:game.scores,
    turn:game.turn,
    myHand:game.hands[me],
    opponentCardCount:game.hands[opp].length,
    finished:!!game.done
  };
}
function sendAll(){
  const packet=(role)=>JSON.stringify({
    type:"state",
    state:publicState(role),
    players:{host:!!players.host,guest:!!players.guest}
  });
  if(players.host && players.host.readyState===WebSocket.OPEN) players.host.send(packet("host"));
  if(players.guest && players.guest.readyState===WebSocket.OPEN) players.guest.send(packet("guest"));
}
function cardPoints(c){
  if(c.rank==="A"||c.rank==="J")return 1;
  if(c.rank==="2"&&c.suit==="♣")return 2;
  if(c.rank==="10"&&c.suit==="♦")return 3;
  return 0;
}
function finishIfNeeded(){
  if(game.hands[0].length||game.hands[1].length||game.deck.length)return false;
  if(game.lastCapture>=0) game.captured[game.lastCapture].push(...game.pile.splice(0));
  if(game.captured[0].length>game.captured[1].length)game.scores[0]+=3;
  else if(game.captured[1].length>game.captured[0].length)game.scores[1]+=3;
  game.done=true; return true;
}
function play(player,id){
  if(!game||game.done||game.turn!==player)return;
  const i=game.hands[player].findIndex(c=>c.id===id); if(i<0)return;
  const c=game.hands[player].splice(i,1)[0], top=game.pile.at(-1);
  game.pile.push(c);
  let take=false,pisti=false,pistiPoints=0;
  if(c.rank==="J") {
    take=true;
    if(top&&top.rank==="J"&&game.pile.length===2){pisti=true;pistiPoints=20;}
  } else if(top&&c.rank===top.rank){
    take=true;
    pisti=game.pile.length===2;
    pistiPoints=10;
  }
  let event={type:"play",player,card:c,points:0,kind:"play"};
  if(take){
    game.captured[player].push(...game.pile.splice(0));game.lastCapture=player;
    const captured=game.pile.slice();
    const bonus=captured.reduce((sum,card)=>sum+cardPoints(card),0);
    game.scores[player]+=bonus;
    event.points=bonus;
    if(pisti){game.scores[player]+=pistiPoints;event.points+=pistiPoints;event.kind="pisti";}
    else event.kind="capture";
  }
  game.turn=1-player;
  if(!game.hands[0].length&&!game.hands[1].length&&!game.deck.length)finishIfNeeded();
  else if(!game.hands[0].length&&!game.hands[1].length){
    for(let i=0;i<4&&game.deck.length;i++){game.hands[0].push(game.deck.pop());game.hands[1].push(game.deck.pop())}
    game.turn=game.lastCapture>=0?game.lastCapture:game.turn;
    sendAll();
    sendEvent(event);
    sendEvent({type:"deal"});
    return;
  }
  sendAll();
  sendEvent(event);
}
function sendEvent(event){
  const packet=JSON.stringify({type:"event",event});
  for(const ws of [players.host,players.guest]) if(ws&&ws.readyState===WebSocket.OPEN) ws.send(packet);
}

wss.on("connection",(ws)=>{
  let role=null;
  ws.on("message",(raw)=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(m.type==="join"){
      const wanted=m.role==="guest"?"guest":"host";
      if(players[wanted] && players[wanted].readyState===WebSocket.OPEN){ws.send(JSON.stringify({type:"error",message:"Bu taraf zaten bağlı."}));return}
      role=wanted;players[role]=ws;
      if(!game || game.done || (game.hands[0].length===0 && game.hands[1].length===0 && game.deck.length===0)) game=freshGame();
      ws.send(JSON.stringify({type:"joined",role,room:ROOM}));
      sendAll();
    }
    if(m.type==="play" && role) play(role==="host"?0:1,m.id);
    if(m.type==="reset" && role==="host"){game=freshGame();sendAll();}
  });
  ws.on("close",()=>{if(role&&players[role]===ws)players[role]=null;sendAll()});
});
server.listen(PORT, "0.0.0.0", ()=>console.log(`Pisti online: port ${PORT} | Oda: ${ROOM}`));

{"name":"yavruma-ozel-pisti","version":"1.0.0","private":true,"scripts":{"start":"node server.js"},"dependencies":{"ws":"^8.18.0"}}
