'use strict';
const http=require('node:http'),net=require('node:net'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {TextDecoder}=require('node:util');
const {Decoder}=require('./protocol');
const MAX=1024*1024;
function createBridge(options={}){
 const rooms=new Map(),clients=new Set(),publishers=new Set();
 const ttl=options.ttl??10000;
 const metrics={accepted:0,rejected:0,tcpFatal:0};let warnings=0,lastWarning=0;
 function diagnose(event,error){
  const now=Date.now();if(warnings>=5&&now-lastWarning<30000)return;
  ++warnings;lastWarning=now;
  const detail={event,message:String(error.message||error).slice(0,120)};
  if(options.onDiagnostic)options.onDiagnostic(detail);else console.warn('[s45-share]',JSON.stringify(detail));
 }
 function active(){const now=Date.now();return [...rooms.values()].filter(r=>now-r.time<ttl);}
 function wsSend(s,obj){
  if(s.destroyed||s.writableLength>MAX){s.destroy();return;}
  const p=Buffer.from(JSON.stringify(obj));let h;
  if(p.length<126)h=Buffer.from([129,p.length]);
  else if(p.length<65536){h=Buffer.alloc(4);h[0]=129;h[1]=126;h.writeUInt16BE(p.length,2);}
  else {h=Buffer.alloc(10);h[0]=129;h[1]=127;h.writeBigUInt64BE(BigInt(p.length),2);}
  s.write(Buffer.concat([h,p]));
 }
 function roomList(s){wsSend(s,{type:'rooms',rooms:active().map(r=>r.frame.room)});}
 function message(s,text){
  let msg;try{msg=JSON.parse(text);}catch{throw Error('invalid JSON');}
  if(msg.type==='rooms')roomList(s);
  else if(msg.type==='subscribe'){
   if(typeof msg.room!=='string'||! /^(?:\d{6})?$/.test(msg.room))throw Error('invalid room');
   s.room=msg.room;wsSend(s,{type:'subscribed',room:s.room});
   const r=rooms.get(s.room);if(r&&Date.now()-r.time<ttl)wsSend(s,r.frame);
  }else throw Error('unsupported message');
 }
 const publicFiles=new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/protocol.js','protocol.js'],['/map.png','map.png']]);
 const web=http.createServer((req,res)=>{
  if(req.url==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('ok');return;}
  const f=publicFiles.get(req.url.split('?')[0]);
  if(!f){res.writeHead(404);res.end('Not found');return;}
  fs.readFile(path.join(__dirname,f),(e,data)=>{
   if(e){res.writeHead(404);res.end('Not found');return;}
   const ext=path.extname(f);
   res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png'})[ext],
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'"});res.end(data);
  });
 });
 web.on('upgrade',(req,s,head)=>{
  const key=req.headers['sec-websocket-key'];
  if(req.url!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||req.headers['sec-websocket-version']!=='13'||!key||Buffer.from(key,'base64').length!==16){s.destroy();return;}
  // Reject cross-origin browser access to this otherwise unauthenticated relay.
  if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host){s.destroy();return;}}catch{s.destroy();return;}}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  clients.add(s);s.room='';let pending=Buffer.alloc(0),fragments=[],fragmentSize=0,fragmented=false;
  function consume(data){
   try{
    pending=Buffer.concat([pending,data]);if(pending.length>MAX+14)throw Error('buffer limit');
    while(pending.length>=2){
     const b=pending,fin=!!(b[0]&128),op=b[0]&15;
     if(b[0]&112||!(b[1]&128))throw Error('bad websocket frame');
     let n=b[1]&127,offset=2;
     if(n===126){if(b.length<4)return;n=b.readUInt16BE(2);offset=4;}
     else if(n===127){if(b.length<10)return;const v=b.readBigUInt64BE(2);if(v>BigInt(MAX))throw Error('limit');n=Number(v);offset=10;}
     if(n>MAX||(op>=8&&(!fin||n>125)))throw Error('limit');
     if(b.length<offset+4+n)return;
     const mask=b.subarray(offset,offset+4),p=Buffer.from(b.subarray(offset+4,offset+4+n));for(let i=0;i<n;i++)p[i]^=mask[i%4];
     pending=b.subarray(offset+4+n);
     if(op===8){s.end(Buffer.from([136,0]));return;}
     if(op===9){s.write(Buffer.concat([Buffer.from([138,p.length]),p]));continue;}
     if(op===10)continue;
     if(op===1){if(fragmented)throw Error('nested fragment');fragments=[p];fragmentSize=n;fragmented=!fin;}
     else if(op===0&&fragmented){fragments.push(p);fragmentSize+=n;if(fin)fragmented=false;}
     else throw Error('unsupported opcode');
     if(fragmentSize>MAX)throw Error('message limit');
     if(fin){message(s,new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(fragments)));fragments=[];fragmentSize=0;}
    }
   }catch{s.destroy();}
  }
  s.on('data',consume);s.on('error',()=>{});s.on('close',()=>clients.delete(s));roomList(s);if(head.length)consume(head);
 });
 function publish(s,items){
  for(const {frame}of items){
   if(!rooms.has(frame.room)&&rooms.size>=1000)throw Error('room limit');
   ++metrics.accepted;
   rooms.set(frame.room,{frame,time:Date.now(),owner:s});
   for(const c of clients)if(c.room===frame.room)wsSend(c,frame);
  }
 }
 const tcp=net.createServer(s=>{
  publishers.add(s);s.setTimeout(30000,()=>{diagnose('tcp_idle',Error('30s without upload'));s.destroy();});s.setEncoding('utf8');
  const decoder=new Decoder(error=>{++metrics.rejected;diagnose('frame_rejected',error);});let ended=false;
  s.on('data',data=>{try{publish(s,decoder.push(data));}catch(error){++metrics.tcpFatal;diagnose('tcp_fatal',error);s.destroy();}});
  s.on('end',()=>{try{publish(s,decoder.finish());ended=true;}catch(error){++metrics.rejected;diagnose('eof_rejected',error);s.destroy();}});
  s.on('error',()=>{});
  s.on('close',()=>{
   publishers.delete(s);
   for(const [id,r]of rooms)if(r.owner===s){if(ended)r.owner=null;else rooms.delete(id);}
  });
 });
 const timer=setInterval(()=>{
  const now=Date.now();for(const [id,r]of rooms)if(now-r.time>=ttl)rooms.delete(id);
  for(const c of clients)roomList(c);
 },Math.min(1000,ttl));timer.unref();
 return {web,tcp,rooms,metrics,
  async listen(){await new Promise((r,j)=>{web.once('error',j);web.listen(options.httpPort??8888,options.host??'127.0.0.1',r);});try{await new Promise((r,j)=>{tcp.once('error',j);tcp.listen(options.tcpPort??9999,options.host??'127.0.0.1',r);});}catch(e){web.close();clearInterval(timer);throw e;}return this;},
  async close(){clearInterval(timer);for(const s of clients)s.destroy();for(const s of publishers)s.destroy();await Promise.all([new Promise(r=>web.close(r)),new Promise(r=>tcp.close(r))]);}
 };
}
function optionsFromEnvironment(env){
 function port(value,fallback){const n=Number(value??fallback);if(!Number.isInteger(n)||n<1||n>65535)throw Error('invalid listening port');return n;}
 const httpPort=port(env.HTTP_PORT??env.PORT,8888),tcpPort=port(env.TCP_PORT,9999);
 if(httpPort===tcpPort)throw Error('HTTP and TCP ports must differ');
 return {host:env.HOST||(env.PORT?'0.0.0.0':'127.0.0.1'),httpPort,tcpPort};
}
if(require.main===module){
 let opts;try{opts=optionsFromEnvironment(process.env);}catch(e){console.error(e.message);process.exit(1);}
 const bridge=createBridge(opts);
 bridge.listen().then(()=>console.log('网页 http://'+opts.host+':'+opts.httpPort+' / TCP '+opts.tcpPort)).catch(e=>{console.error(e.message);process.exitCode=1;});
 for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>bridge.close().then(()=>process.exit()));
}
module.exports={createBridge,optionsFromEnvironment};
