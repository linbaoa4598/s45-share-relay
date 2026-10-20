(function(root,factory){if(typeof module==='object')module.exports=factory();else root.ShareProtocol=factory();})(globalThis,function(){
'use strict';
const MAX_BUFFER=1024*1024,HEADER='gameData';
function rows(text,count,group){
 if(!text)return [];
 if(!text.endsWith('=='))throw Error('record must end in ==');
 const parts=text.slice(0,-2).split('==');
 if(parts.length>4096)throw Error('too many records');
 return parts.map(s=>{
  const f=s.split(',');const counts=Array.isArray(count)?count:[count];
  if(!counts.includes(f.length))throw Error(group+' columns='+f.length+' expected='+counts.join('/'));
  if(f.some((x,i)=>{
   // The original float formatter uses %f; NaN/Inf in its opaque F8 must
   // not tear down a live TCP stream. Keep the raw string, expose null.
   if(group==='actors'&&i===7&&/^[+-]?(nan|inf(?:inity)?)$/i.test(x))return false;
   return !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(x)||!Number.isFinite(Number(x));
  }))throw Error(group+' invalid numeric value');
  return f;
 });
}
function parseFrame(raw){
 const m=/^gameData(\d{6})\[==\]\[==\]([\s\S]*)$/.exec(raw);
 if(!m)throw Error('invalid S45 header');
 const g=m[2].split('---');if(g.length!==3)throw Error('S45 requires exactly three groups');
 const actors=rows(g[0],[9,10],'actors').map(raw=>{const f=raw.map(Number);return {id:f[0],hp:f[1],maxHp:f[2],field4:f[3],field5:f[4],x:f[5],y:f[6],field8:Number.isFinite(f[7])?f[7]:null,field9:f[8],field10:f.length===10?f[9]:null,percent:f[2]>0?Math.max(0,Math.min(100,f[1]/f[2]*100)):0,raw};});
 const monsters=rows(g[1],5,'monsters').map(raw=>{const f=raw.map(Number);return {field1:f[0],field2:f[1],field3:f[2],x:f[3],y:f[4],raw};});
 const minions=rows(g[2],3,'minions').map(raw=>{const f=raw.map(Number);return {x:f[0],y:f[1],field3:f[2],raw};});
 return {type:'frame',protocol:'original-s45',room:m[1],actors,monsters,minions,receivedAt:Date.now()};
}
// No end marker exists in the recovered S45 wire grammar. Never guess a
// boundary from a recv(), timeout, or == (which merely ends one record).
// Delimit at the next gameData header; flush the final frame only on TCP EOF.
class Decoder{
 constructor(onRejected=()=>{}){this.buffer='';this.onRejected=onRejected;this.rejected=0;}
 push(chunk){
  this.buffer+=chunk;if(this.buffer.length>MAX_BUFFER*2)throw Error('buffer limit');
  const out=[];
  for(;;){
   if(!this.buffer)break;
   if(!this.buffer.startsWith(HEADER)&&!HEADER.startsWith(this.buffer))throw Error('invalid prefix');
   const next=this.buffer.indexOf(HEADER,HEADER.length);
   if(next<0)break;
   const raw=this.buffer.slice(0,next);if(raw.length>MAX_BUFFER)throw Error('frame limit');
   this.buffer=this.buffer.slice(next);
   try{out.push({raw,frame:parseFrame(raw)});}catch(e){++this.rejected;this.onRejected(e);}
  }
  if(this.buffer.length>MAX_BUFFER)throw Error('frame limit');
  return out;
 }
 finish(){if(!this.buffer)return [];const raw=this.buffer;this.buffer='';return [{raw,frame:parseFrame(raw)}];}
}
function project(x,y,c,actor=false){
 // 0x1b02644 subtracts 0x14 from hero x/y for the old 40px portrait.
 let px=(x+(actor?20:0)-c.left)/c.size,py=(y+(actor?20:0)-c.top)/c.size;
 if(c.flip){px=1-px;py=1-py;}return [px*680,py*680];
}
// 0x1b02644 sends int(world * outputWidth/2400) + minion offset,
// unlike heroes/monsters which have already been projected to the minimap.
function minionDirection(minions,override='auto'){
 if(override==='1'||override==='-1')return Number(override);
 const camps=new Set(minions.map(m=>m.field3).filter(c=>c===1||c===2));
 // Original loop sends only the enemy camp. Local 1 -> +1, local 2 -> -1.
 return camps.size===1?([...camps][0]===2?1:-1):null;
}
function projectMinion(m,c,outputWidth,direction,mode='world'){
 if(![m.x,m.y,c.left,c.top,c.size].every(Number.isFinite)||c.size<=0)return null;
 if(mode==='map')return project(m.x,m.y,c);
 if(!Number.isFinite(outputWidth)||outputWidth<=0||![1,-1].includes(direction))return null;
 const wx=(m.x-c.left)*2400/outputWidth,wy=(m.y-c.top)*2400/outputWidth;
 let x=0.5+wx*direction/c.size,y=0.5-wy*direction/c.size;
 if(c.flip){x=1-x;y=1-y;}return [x*680,y*680];
}
return {Decoder,parseFrame,project,minionDirection,projectMinion,MAX_BUFFER};
});
