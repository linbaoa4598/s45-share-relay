'use strict';
const $=id=>document.getElementById(id),canvas=$('map'),ctx=canvas.getContext('2d');
let socket,room='',frame=null,retry,epoch=0,lastFrame=0,minionVisible=0,minionOutside=0,minionUnresolved=0;
let wildCalibration=new ShareProtocol.WildCalibration(),wildHits=[],wildSelected=-1,wildDrag=null,wildInputDirty=false;
function wildStorageKey(){return 's45-wild-v1:'+location.host+':'+room;}
function saveWild(){try{if(room&&typeof localStorage!=='undefined')localStorage.setItem(wildStorageKey(),JSON.stringify(wildCalibration));}catch{$('wildHint').textContent='浏览器不允许保存，当前调整仍可用';}}
function loadWild(){
 let saved={};try{if(room&&typeof localStorage!=='undefined')saved=JSON.parse(localStorage.getItem(wildStorageKey())||'{}')||{};}catch{}
 wildCalibration=new ShareProtocol.WildCalibration(saved);wildInputDirty=false;wildSelected=-1;wildHits=[];
 $('wildMarkerScale').value=wildCalibration.markerScale;$('wildLayoutScale').value=wildCalibration.layoutScale;
}
function wildPanel(){
 const chooser=$('wildSelect');
 const signature=wildHits.map(h=>h.key).join(',');
 if(chooser.dataset&&chooser.dataset.signature!==signature){
  chooser.dataset.signature=signature;chooser.replaceChildren();
  const first=document.createElement('option');first.value='-1';first.textContent='请选择野怪';chooser.append(first);
  for(const h of wildHits){const option=document.createElement('option');option.value=String(h.key);option.textContent='ID '+h.monster.field3+' · 点位 '+(h.key+1);chooser.append(option);}
 }
 chooser.value=String(wildSelected);
 const hit=wildHits.find(h=>h.key===wildSelected);
 if(hit&&!wildInputDirty){$('wildX').value=hit.x.toFixed(1);$('wildY').value=hit.y.toFixed(1);}
 if(!hit){$('wildX').value='';$('wildY').value='';}
 for(const id of ['wildX','wildY','wildApply','wildNudgeLeft','wildNudgeRight','wildNudgeUp','wildNudgeDown','wildResetOne'])$(id).disabled=!hit;
 $('wildScaleText').textContent='标记 '+wildCalibration.markerScale.toFixed(2)+'× / 布局 '+wildCalibration.layoutScale.toFixed(2)+'×';
}
const portraits=new Map();
function portrait(id){
 if(!Number.isInteger(id)||id<1||id>9999)return null;
 if(portraits.has(id))return portraits.get(id);
 const entry={image:new Image(),state:'loading'};portraits.set(id,entry);
 entry.image.decoding='async';
 entry.image.onload=()=>{entry.state='ready';if(frame&&frame.actors.some(h=>h.id===id))render();};
 entry.image.onerror=()=>{entry.state='failed';};
 entry.image.src='/heroes/'+id+'.png';return entry;
}
$('endpoint').value=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws';
function clear(){wildHits=[];wildDrag=null;wildPanel();minionVisible=0;minionOutside=0;minionUnresolved=0;frame=null;lastFrame=0;ctx.clearRect(0,0,680,680);$('heroes').textContent='暂无数据';}
function send(m){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(m));}
function join(id){if(!/^(?:\d{6})?$/.test(id)){alert('请输入六位数字房间号');return;}saveWild();room=id;loadWild();$('room').value=id;clear();send({type:'subscribe',room});}
function connect(){
 clearTimeout(retry);const mine=++epoch;socket?.close();clear();$('status').textContent='正在连接…';
 try{const url=new URL($('endpoint').value);if(!['ws:','wss:'].includes(url.protocol))throw Error();socket=new WebSocket(url);}catch{$('status').textContent='WebSocket 地址无效';return;}
 socket.onopen=()=>{if(mine!==epoch)return;$('status').textContent='服务器已连接';send({type:'subscribe',room});send({type:'rooms'});};
 socket.onmessage=e=>{
  if(mine!==epoch)return;
  try{const m=JSON.parse(e.data);
   if(m.type==='rooms'){
    $('rooms').replaceChildren();if(!m.rooms.length)$('rooms').textContent='暂无在线房间';
    for(const id of m.rooms){const b=document.createElement('button');b.textContent=id;b.onclick=()=>join(id);$('rooms').append(b);}
   }else if(m.type==='frame'&&m.room===room&&m.protocol==='original-s45'){frame=m;lastFrame=Date.now();render();}
  }catch{$('status').textContent='收到无法识别的数据';}
 };
 socket.onclose=()=>{if(mine!==epoch)return;clear();$('status').textContent='连接断开，2 秒后重连';retry=setTimeout(connect,2000);};
 socket.onerror=()=>{if(mine===epoch)$('status').textContent='连接失败';};
}
function config(group){return {left:Number($(group+'Left').value),top:Number($(group+'Top').value),size:Number($(group+'Size').value),flip:$('flip').checked};}
function render(){
 ctx.clearRect(0,0,680,680);$('heroes').replaceChildren();if(!frame)return;
 const a=config('actor'),w=config('wild'),b=config('minion');
 if([a,w,b].some(c=>![c.left,c.top,c.size].every(Number.isFinite)||c.size<=0)){$('freshness').textContent='坐标校准值无效';return;}
 function dot(x,y,color,r){if(!Number.isFinite(x)||!Number.isFinite(y))return;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();}
 ctx.textAlign='center';
 wildHits=wildCalibration.bind(frame.monsters).map(bound=>{const [x,y]=wildCalibration.point(bound,w);return {...bound,x,y};});
 for(const hit of wildHits){
  const m=hit.monster,{x,y}=hit,scale=wildCalibration.markerScale;
  dot(x,y,hit.key===wildSelected?'#9dfbea':'#ffcc66',5*scale);
  ctx.font=(14*scale)+'px sans-serif';ctx.fillStyle='#ffe3a0';ctx.fillText(m.field2+'/'+m.field3,x,y-9*scale);
  if(hit.key===wildSelected){ctx.beginPath();ctx.arc(x,y,10*scale,0,Math.PI*2);ctx.strokeStyle='#9dfbea';ctx.lineWidth=2;ctx.stroke();}
 }
 wildPanel();
 minionVisible=0;minionOutside=0;minionUnresolved=0;
 const direction=ShareProtocol.minionDirection(frame.minions,$('minionDirection').value);
 for(const m of frame.minions){
  const point=ShareProtocol.projectMinion(m,b,Number($('width').value),direction,$('minionMode').value);
  if(!point){++minionUnresolved;continue;}
  const [x,y]=point;if(x<0||y<0||x>680||y>680){++minionOutside;continue;}
  ++minionVisible;dot(x,y,'#b7ff9e',5);ctx.strokeStyle='#193b21';ctx.lineWidth=1.5;ctx.stroke();
 }
 for(const h of frame.actors){
  const [x,y]=ShareProtocol.project(h.x,h.y,a,true),avatar=portrait(h.id);
  if(avatar&&avatar.state==='ready'){
   ctx.save();ctx.beginPath();ctx.arc(x,y,18,0,Math.PI*2);ctx.clip();ctx.drawImage(avatar.image,x-18,y-18,36,36);ctx.restore();
   ctx.beginPath();ctx.arc(x,y,18,0,Math.PI*2);ctx.strokeStyle='#ff8796';ctx.lineWidth=2;ctx.stroke();
  }else{
   dot(x,y,'#f397a3',18);ctx.fillStyle='#14202c';ctx.font='bold 12px sans-serif';ctx.fillText(String(h.id),x,y+4);
  }
  ctx.fillStyle='#111a';ctx.fillRect(x-21,y+21,42,5);ctx.fillStyle='#7bdcc0';ctx.fillRect(x-21,y+21,42*h.percent/100,5);
  const row=document.createElement('div');row.className='hero';
  const name=document.createElement('strong'),data=document.createElement('span');
  name.textContent='#'+h.id+' · '+h.hp+'/'+h.maxHp;
  data.textContent='F4: '+h.field4+' / F5: '+h.field5+' / F8: '+h.field8+' / F9: '+h.field9+(h.field10===null?'':' / F10: '+h.field10);
  const title=document.createElement('div');title.className='hero-title';
  if(avatar&&avatar.state==='ready'){
   const icon=document.createElement('img');icon.src=avatar.image.src;icon.alt='英雄 '+h.id;icon.className='hero-portrait';icon.onerror=()=>{icon.hidden=true;};title.append(icon);
  }
  title.append(name);row.append(title,data);$('heroes').append(row);
 }
 if(!frame.actors.length)$('heroes').textContent='本帧无上传英雄';
}
function selectWild(key){wildInputDirty=false;wildSelected=Number(key);render();}
function wildEventPoint(e){const r=canvas.getBoundingClientRect();return [(e.clientX-r.left)*canvas.width/r.width,(e.clientY-r.top)*canvas.height/r.height];}
$('wildEdit').onchange=()=>{canvas.style.touchAction=$('wildEdit').checked?'none':'auto';canvas.style.cursor=$('wildEdit').checked?'crosshair':'default';wildDrag=null;};
$('wildSelect').onchange=()=>selectWild($('wildSelect').value);
canvas.onpointerdown=e=>{
 if(!$('wildEdit').checked||!frame||e.isPrimary===false||(e.button!==undefined&&e.button!==0))return;
 const [x,y]=wildEventPoint(e);let hit=null,best=Math.max(20,12*wildCalibration.markerScale)**2;
 for(const h of wildHits){const distance=(h.x-x)**2+(h.y-y)**2;if(h.key>=0&&distance<best){hit=h;best=distance;}}
 if(!hit)return;e.preventDefault();wildInputDirty=false;wildSelected=hit.key;
 const anchor=wildCalibration.anchors[hit.key];wildDrag={pointer:e.pointerId,key:hit.key,x,y,dx:anchor.dx,dy:anchor.dy};
 canvas.setPointerCapture?.(e.pointerId);render();
};
canvas.onpointermove=e=>{
 if(!wildDrag||e.pointerId!==wildDrag.pointer)return;
 const [x,y]=wildEventPoint(e);wildCalibration.move(wildDrag.key,wildDrag.dx+x-wildDrag.x,wildDrag.dy+y-wildDrag.y);render();
};
function endWildDrag(e){if(!wildDrag||e.pointerId!==wildDrag.pointer)return;wildDrag=null;saveWild();}
canvas.onpointerup=endWildDrag;canvas.onpointercancel=endWildDrag;canvas.onlostpointercapture=endWildDrag;
$('wildMarkerScale').oninput=()=>{wildCalibration.markerScale=Number($('wildMarkerScale').value);render();saveWild();};
$('wildLayoutScale').oninput=()=>{wildCalibration.layoutScale=Number($('wildLayoutScale').value);render();saveWild();};
$('wildX').oninput=$('wildY').oninput=()=>{wildInputDirty=true;};
$('wildApply').onclick=()=>{
 const h=wildHits.find(h=>h.key===wildSelected);if(!h)return;
 const x=Number($('wildX').value),y=Number($('wildY').value),anchor=wildCalibration.anchors[h.key];
 if(wildCalibration.move(h.key,anchor.dx+x-h.x,anchor.dy+y-h.y)){wildInputDirty=false;render();saveWild();}
};
function nudgeWild(dx,dy){wildInputDirty=false;const h=wildCalibration.anchors[wildSelected];if(!h)return;wildCalibration.move(wildSelected,h.dx+dx,h.dy+dy);render();saveWild();}
$('wildNudgeLeft').onclick=()=>nudgeWild(-1,0);$('wildNudgeRight').onclick=()=>nudgeWild(1,0);
$('wildNudgeUp').onclick=()=>nudgeWild(0,-1);$('wildNudgeDown').onclick=()=>nudgeWild(0,1);
$('wildResetOne').onclick=()=>{wildInputDirty=false;wildCalibration.reset(wildSelected);render();saveWild();};
$('wildResetAll').onclick=()=>{wildInputDirty=false;wildCalibration=new ShareProtocol.WildCalibration();wildSelected=-1;$('wildMarkerScale').value=1;$('wildLayoutScale').value=1;render();saveWild();};
$('join').onclick=()=>join($('room').value.trim());$('room').onkeydown=e=>{if(e.key==='Enter')$('join').click();};$('leave').onclick=()=>join('');
$('reconnect').onclick=connect;
$('calculate').onclick=()=>{
 const width=Number($('width').value);if(!Number.isFinite(width)||width<320||width>7680)return;
 const side=width/11.2*1.455;
 for(const group of ['actor','wild'])$(group+'Size').value=side.toFixed(6);
 render();
};
for(const group of ['actor','wild','minion'])for(const field of ['Left','Top','Size'])$(group+field).oninput=render;
$('flip').oninput=render;$('width').oninput=render;$('minionDirection').onchange=render;
$('minionMode').onchange=()=>{$('minionSize').value=$('minionMode').value==='world'?100000:311.785714;render();};
setInterval(()=>{
 if(lastFrame&&Date.now()-lastFrame>3000)clear();
 $('freshness').textContent=lastFrame?'房间 '+room+' · '+((Date.now()-lastFrame)/1000).toFixed(1)+' 秒前 · 英雄 '+frame.actors.length+' / 野怪 '+frame.monsters.length+' / 兵线 '+frame.minions.length+'（可见 '+minionVisible+'，画布外 '+minionOutside+(minionUnresolved?'，待校准 '+minionUnresolved:'')+'）':room?'房间 '+room+'：等待新帧（需下一帧头或发送端正常关闭才能划定完整消息）':'请选择六位数字房间号。';
},250);
connect();
