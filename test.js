'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net');
const {once}=require('node:events');
const {Decoder,parseFrame,project,minionDirection,projectMinion,MAX_BUFFER}=require('./protocol'),{createBridge,optionsFromEnvironment}=require('./server');
const raw='gameData123456[==][==]105,1000,2000,8192000,0,136,136,50,0==---0,10,60,200,200==---100,100,2==120,120,1==';
test('legacy reconstructed 9-column frame stays compatible',()=>{
 const f=parseFrame(raw);assert.equal(f.room,'123456');assert.equal(f.protocol,'original-s45');
 assert.equal(f.actors[0].field4,8192000);assert.equal(f.actors[0].field9,0);assert.equal(f.actors[0].camp,undefined);
 assert.equal(f.actors[0].percent,50);assert.equal(f.monsters[0].field3,60);assert.equal(f.minions.length,2);
 assert.deepEqual(f.actors[0].raw,['105','1000','2000','8192000','0','136','136','50','0']);
});
test('every TCP split preserves boundaries, final frame waits for EOF',()=>{
 for(let i=0;i<=raw.length;i++){const d=new Decoder();assert.equal(d.push(raw.slice(0,i)).length,0);assert.equal(d.push(raw.slice(i)).length,0);assert.equal(d.finish()[0].raw,raw);}
 const d=new Decoder();assert.equal([...raw].flatMap(c=>d.push(c)).length,0);assert.equal(d.finish().length,1);
});
test('coalesced messages, split next header, and no premature last record',()=>{
 const d=new Decoder();assert.equal(d.push(raw+raw+'gameD').length,1);
 assert.equal(d.push(raw.slice(5)).length,1);assert.equal(d.finish()[0].frame.minions.length,2);
 const e=new Decoder(),at=raw.indexOf('120,120');assert.equal(e.push(raw.slice(0,at)).length,0);
 assert.equal(e.push(raw.slice(at)+raw).length,1);assert.equal(e.finish().length,1);
});
test('empty groups, empty final group and partial EOF',()=>{
 assert.equal(parseFrame('gameData000001[==][==]------').actors.length,0);
 const d=new Decoder();assert.equal(d.push('gameData000001[==][==]------gameData').length,1);assert.throws(()=>d.finish());
 assert.equal(parseFrame(raw.replace('100,100,2==120,120,1==','')).minions.length,0);
});
test('rejects migrated S44 grammar and invalid data',()=>{
 for(const text of [raw+'---2',raw.replace('50,0==','50,0,1,0,0=='),raw.replace('123456','A12345'),raw.replace('1000','NaN'),raw.slice(0,-1)])
 assert.throws(()=>parseFrame(text));
 assert.throws(()=>new Decoder().push('x'.repeat(MAX_BUFFER+1)));
 assert.throws(()=>new Decoder().push('invalid data'));
});
test('original coordinate center conversion, not S44 screen offsets',()=>{
 assert.deepEqual(project(136,136,{left:0,top:0,size:312,flip:false},true),[340,340]);
 assert.deepEqual(project(0,0,{left:0,top:0,size:312,flip:true}),[680,680]);
});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function inbox(ws){
 const pending=[],waiters=[];
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data),i=waiters.findIndex(w=>w.p(m));if(i>=0){const w=waiters.splice(i,1)[0];clearTimeout(w.t);w.r(m);}else pending.push(m);});
 return p=>{const i=pending.findIndex(p);if(i>=0)return Promise.resolve(pending.splice(i,1)[0]);return new Promise((r,j)=>{const w={p,r,t:setTimeout(()=>j(Error('message timeout')),3000)};waiters.push(w);});};
}
test('TCP -> relay -> websocket room isolation, EOF and expiry',async t=>{
 const bridge=createBridge({httpPort:0,tcpPort:0,ttl:400});await bridge.listen();t.after(()=>bridge.close());
 const base='http://127.0.0.1:'+bridge.web.address().port;
 const html=await fetch(base+'/');assert.equal(html.status,200);assert.match(await html.text(),/protocol.js/);
 for(const url of ['/server.js','/test.js','/.backup/index.html','/../server.js'])assert.equal((await fetch(base+url)).status,404);
 const ws=new WebSocket(base.replace('http:','ws:')+'/ws'),next=inbox(ws);t.after(()=>ws.close());await once(ws,'open');
 assert.deepEqual((await next(m=>m.type==='rooms')).rooms,[]);
 ws.send(JSON.stringify({type:'subscribe',room:'123456'}));await next(m=>m.type==='subscribed');
 const tcp=net.connect(bridge.tcp.address().port,'127.0.0.1');await once(tcp,'connect');t.after(()=>tcp.destroy());
 tcp.write(raw);await delay(25);assert.equal(bridge.rooms.size,0);
 tcp.write(raw.slice(0,8));assert.equal((await next(m=>m.type==='frame')).minions.length,2);
 tcp.write(raw.slice(8));tcp.end();await delay(30);assert.equal(bridge.rooms.size,1);
 ws.send(JSON.stringify({type:'rooms'}));assert.deepEqual((await next(m=>m.type==='rooms'&&m.rooms.length===1)).rooms,['123456']);
 ws.send(JSON.stringify({type:'subscribe',room:'654321'}));await next(m=>m.type==='subscribed'&&m.room==='654321');
 await delay(850);assert.equal(bridge.rooms.size,0);
});
test('malformed publisher does not terminate relay',async t=>{
 const bridge=createBridge({httpPort:0,tcpPort:0});await bridge.listen();t.after(()=>bridge.close());
 const tcp=net.connect(bridge.tcp.address().port,'127.0.0.1');await once(tcp,'connect');tcp.write('invalid data');await once(tcp,'close');
 assert.equal((await fetch('http://127.0.0.1:'+bridge.web.address().port+'/')).status,200);
});

test('Railway production starts without password variables',()=>{
 for(const env of [{NODE_ENV:'production',PORT:'3000'},{RAILWAY_ENVIRONMENT_ID:'x',PORT:'3000'},{NODE_ENV:'production',PORT:'3000',WEB_PASSWORD:'old-ignored-value'}]){
  const opts=optionsFromEnvironment(env);assert.equal(opts.httpPort,3000);assert.equal(opts.host,'0.0.0.0');assert.equal(opts.webPassword,undefined);
 }
 for(const env of [{PORT:'bad'},{PORT:'9999'},{PORT:'0'}])assert.throws(()=>optionsFromEnvironment(env));
});
test('HTTP resources and WebSocket work without credentials',async t=>{
 const bridge=createBridge({httpPort:0,tcpPort:0,webPassword:'old-ignored-value'});await bridge.listen();t.after(()=>bridge.close());
 const base='http://127.0.0.1:'+bridge.web.address().port;
 for(const resource of ['/','/healthz','/app.js','/protocol.js','/map.png']){
  const response=await fetch(base+resource);assert.equal(response.status,200);assert.equal(response.headers.get('www-authenticate'),null);
 }
 const ws=new WebSocket(base.replace('http:','ws:')+'/ws'),next=inbox(ws);t.after(()=>ws.close());await once(ws,'open');
 assert.equal((await next(m=>m.type==='rooms')).type,'rooms');
 ws.send(JSON.stringify({type:'subscribe',room:'123456'}));assert.equal((await next(m=>m.type==='subscribed')).room,'123456');
});

const battle=raw.replace('136,136,50,0==','-20,136,50.000000,7,257==');
test('original battle frame has ten columns including float F8',()=>{
 const f=parseFrame(battle);assert.equal(f.actors[0].raw.length,10);assert.equal(f.actors[0].x,-20);assert.equal(f.actors[0].field8,50);assert.equal(f.actors[0].field9,7);assert.equal(f.actors[0].field10,257);
 for(let i=0;i<=battle.length;i++){
  const d=new Decoder();const frames=[...d.push(battle.slice(0,i)),...d.push(battle.slice(i)+battle),...d.finish()];assert.equal(frames.length,2);
 }
});
test('original %f non-finite opaque F8 stays raw without serializing NaN',()=>{
 for(const value of ['nan','-nan','inf','-inf','+inf']){
  const f=parseFrame(battle.replace('50.000000',value));assert.equal(f.actors[0].field8,null);assert.equal(f.actors[0].raw[7],value);assert.equal(JSON.parse(JSON.stringify(f)).actors[0].field8,null);
 }
});
test('bad delimited frame is discarded without losing later good frames',()=>{
 const errors=[],d=new Decoder(e=>errors.push(e.message));
 const frames=d.push(battle+raw.replace('105,1000','105,broken')+battle+battle);
 assert.equal(frames.length,2);assert.equal(d.rejected,1);assert.match(errors[0],/actors/);assert.equal(d.finish().length,1);
});
test('lobby to battle on same TCP connection does not reconnect',async t=>{
 const diagnostics=[],bridge=createBridge({httpPort:0,tcpPort:0,onDiagnostic:d=>diagnostics.push(d)});await bridge.listen();t.after(()=>bridge.close());
 const ws=new WebSocket('ws://127.0.0.1:'+bridge.web.address().port+'/ws'),next=inbox(ws);t.after(()=>ws.close());await once(ws,'open');
 ws.send(JSON.stringify({type:'subscribe',room:'123456'}));await next(m=>m.type==='subscribed');
 const tcp=net.connect(bridge.tcp.address().port,'127.0.0.1');await once(tcp,'connect');t.after(()=>tcp.destroy());
 tcp.write('gameData123456[==][==]------'+battle+battle);
 assert.equal((await next(m=>m.type==='frame'&&m.actors.length===1)).actors[0].raw.length,10);
 const bad=battle.replace('105,1000','105,broken');tcp.write(bad+battle+battle);
 await delay(40);assert.equal(tcp.destroyed,false);assert.equal(bridge.metrics.tcpFatal,0);assert.equal(bridge.metrics.rejected,1);assert.ok(bridge.metrics.accepted>=4);assert.equal(diagnostics[0].event,'frame_rejected');
 tcp.write(battle);assert.equal((await next(m=>m.type==='frame'&&m.actors.length===1)).actors[0].field10,257);
});

test('world minion projection restores sender scale, offsets and camp orientation',()=>{
 const c={left:0,top:0,size:100000,flip:false};
 assert.deepEqual(projectMinion({x:0,y:0},c,2400,1),[340,340]);
 assert.deepEqual(projectMinion({x:50000,y:50000},c,2400,1),[680,0]);
 assert.deepEqual(projectMinion({x:-50000,y:-50000},c,2400,-1),[680,0]);
 assert.deepEqual(projectMinion({x:25100,y:-24800},{...c,left:100,top:200},1200,1),[680,680]);
 assert.deepEqual(projectMinion({x:50000,y:50000},{...c,flip:true},2400,1),[0,680]);
 assert.equal(minionDirection([{field3:2}]),1);assert.equal(minionDirection([{field3:1}]),-1);
 assert.equal(minionDirection([{field3:1},{field3:2}]),null);assert.equal(minionDirection([]),null);
 assert.equal(minionDirection([], '-1'),-1);assert.equal(projectMinion({x:1,y:1},c,0,1),null);
 assert.equal(projectMinion({x:1,y:1},c,2400,null),null);
 assert.deepEqual(projectMinion({x:156,y:156},{...c,size:312},2400,null,'map'),[340,340]);
});
test('received large minion coordinates become visible instead of outside canvas',()=>{
 const coords=[[-2728,-3749],[46815,-31992],[-2988,-2881],[47657,-31945],[761,1660],[1488,1110],[39865,48253],[48305,40031],[40750,40699]];
 let oldVisible=0,newVisible=0;
 for(const [x,y]of coords){
  const old=project(x,y,{left:0,top:0,size:311.785714,flip:false});
  if(old.every(v=>v>=0&&v<=680))++oldVisible;
  const next=projectMinion({x,y},{left:0,top:0,size:100000,flip:false},2400,1);
  if(next.every(v=>v>=0&&v<=680))++newVisible;
 }
 assert.equal(oldVisible,0);assert.equal(newVisible,9);
});

test('actual app renderer draws nine received world-space minions',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8'),nodes=new Map(),arcs=[],intervals=[];
 const ctx={clearRect(){arcs.length=0;},beginPath(){},arc(x,y,r){arcs.push([x,y,r]);},fill(){},stroke(){},fillText(){},fillRect(){}};
 for(const tag of html.match(/<[^>]+id="[^"]+"[^>]*>/g)){
  const id=/id="([^"]+)"/.exec(tag)[1],value=/value="([^"]*)"/.exec(tag)?.[1]||'';
  nodes.set(id,{value,checked:false,textContent:'',replaceChildren(){},append(){},getContext(){return ctx;}});
 }
 nodes.get('minionMode').value='world';nodes.get('minionDirection').value='auto';
 let connection;
 class Socket{static OPEN=1;constructor(){this.readyState=1;connection=this;}send(){}close(){}}
 const sandbox={document:{getElementById(id){assert.ok(nodes.has(id),'missing DOM '+id);return nodes.get(id);},createElement(){return {append(){}};}},location:{protocol:'http:',host:'localhost'},WebSocket:Socket,URL,ShareProtocol:require('./protocol'),setInterval(fn){intervals.push(fn);},setTimeout(){},clearTimeout(){},alert(){throw Error('unexpected alert');}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'app.js'),'utf8'),sandbox);
 nodes.get('room').value='123456';nodes.get('join').onclick();
 const minions=[[-2728,-3749],[46815,-31992],[-2988,-2881],[47657,-31945],[761,1660],[1488,1110],[39865,48253],[48305,40031],[40750,40699]].map(([x,y])=>({x,y,field3:2}));
 connection.onmessage({data:JSON.stringify({type:'frame',protocol:'original-s45',room:'123456',actors:[],monsters:[],minions})});
 assert.equal(arcs.length,9);assert.ok(arcs.every(([x,y])=>x>=0&&x<=680&&y>=0&&y<=680));
 intervals[0]();assert.match(nodes.get('freshness').textContent,/可见 9，画布外 0/);
});

test('embedded hero portraits are served safely without external hosts',async t=>{
 const bridge=createBridge({httpPort:0,tcpPort:0});await bridge.listen();t.after(()=>bridge.close());
 const base='http://127.0.0.1:'+bridge.web.address().port;
 for(const id of [105,106,135,159,171,515]){
  const response=await fetch(base+'/heroes/'+id+'.png');assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0,8)],[137,80,78,71,13,10,26,10]);
 }
 for(const uri of ['/heroes/9999.png','/heroes/../server.js','/heroes/%2e%2e%2fserver.js','/heroes/foo.png'])assert.equal((await fetch(base+uri)).status,404);
});

test('actual app uses cached portraits, ID fallback and clears late image loads',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),nodes=new Map(),images=[],draws=[];
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
 const ctx={clearRect(){draws.length=0;},beginPath(){},arc(){},fill(){},stroke(){},fillText(){},fillRect(){},save(){},restore(){},clip(){},drawImage(...args){draws.push(args);}};
 for(const tag of html.match(/<[^>]+id="[^"]+"[^>]*>/g)){
  const id=/id="([^"]+)"/.exec(tag)[1],value=/value="([^"]*)"/.exec(tag)?.[1]||'';
  nodes.set(id,{value,checked:false,textContent:'',replaceChildren(){},append(){},getContext(){return ctx;}});
 }
 nodes.get('minionMode').value='world';nodes.get('minionDirection').value='auto';
 class Portrait{constructor(){images.push(this);}}
 let connection;class Socket{static OPEN=1;constructor(){this.readyState=1;connection=this;}send(){}close(){}}
 const sandbox={document:{getElementById(id){assert.ok(nodes.has(id));return nodes.get(id);},createElement(){return {append(){}};}},location:{protocol:'http:',host:'localhost'},WebSocket:Socket,URL,Image:Portrait,ShareProtocol:require('./protocol'),setInterval(){},setTimeout(){},clearTimeout(){},alert(){throw Error('unexpected alert');}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'app.js'),'utf8'),sandbox);
 nodes.get('room').value='123456';nodes.get('join').onclick();
 const data={type:'frame',protocol:'original-s45',room:'123456',actors:[{id:171,x:136,y:136,hp:1000,maxHp:2000,percent:50,field10:null}],monsters:[],minions:[]};
 connection.onmessage({data:JSON.stringify(data)});assert.equal(images.length,1);assert.equal(images[0].src,'/heroes/171.png');assert.equal(draws.length,0);
 images[0].onload();assert.equal(draws.length,1);assert.equal(draws[0][0],images[0]);
 connection.onmessage({data:JSON.stringify(data)});assert.equal(images.length,1);assert.equal(draws.length,1);
 data.actors[0].id=9999;connection.onmessage({data:JSON.stringify(data)});assert.equal(images.length,2);images[1].onerror();
 connection.onmessage({data:JSON.stringify(data)});assert.equal(images.length,2);assert.equal(draws.length,0);
 nodes.get('leave').onclick();images[0].onload();assert.equal(draws.length,0);
});
