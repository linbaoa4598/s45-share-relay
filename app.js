'use strict';
const $=id=>document.getElementById(id),canvas=$('map'),ctx=canvas.getContext('2d');
let socket,room='',frame=null,retry,epoch=0,lastFrame=0;
$('endpoint').value=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws';
function clear(){frame=null;lastFrame=0;ctx.clearRect(0,0,680,680);$('heroes').textContent='暂无数据';}
function send(m){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(m));}
function join(id){if(!/^(?:\d{6})?$/.test(id)){alert('请输入六位数字房间号');return;}room=id;$('room').value=id;clear();send({type:'subscribe',room});}
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
 for(const m of frame.monsters){const [x,y]=ShareProtocol.project(m.x,m.y,w);dot(x,y,'#ffcc66',5);ctx.font='14px sans-serif';ctx.fillStyle='#ffe3a0';ctx.fillText(m.field2+'/'+m.field3,x,y-9);}
 for(const m of frame.minions){const [x,y]=ShareProtocol.project(m.x,m.y,b);dot(x,y,'#a2dba0',4);}
 for(const h of frame.actors){
  const [x,y]=ShareProtocol.project(h.x,h.y,a,true);dot(x,y,'#89cfff',16);
  ctx.fillStyle='#14202c';ctx.font='bold 12px sans-serif';ctx.fillText(String(h.id),x,y+4);
  ctx.fillStyle='#111a';ctx.fillRect(x-21,y+21,42,5);ctx.fillStyle='#7bdcc0';ctx.fillRect(x-21,y+21,42*h.percent/100,5);
  const row=document.createElement('div');row.className='hero';
  const name=document.createElement('strong'),data=document.createElement('span');
  name.textContent='#'+h.id+' · '+h.hp+'/'+h.maxHp;
  data.textContent='F4: '+h.field4+' / F5: '+h.field5+' / F8: '+h.field8+' / F9: '+h.field9+(h.field10===null?'':' / F10: '+h.field10);
  row.append(name,data);$('heroes').append(row);
 }
 if(!frame.actors.length)$('heroes').textContent='本帧无上传英雄';
}
$('join').onclick=()=>join($('room').value.trim());$('room').onkeydown=e=>{if(e.key==='Enter')$('join').click();};$('leave').onclick=()=>join('');
$('reconnect').onclick=connect;
$('calculate').onclick=()=>{
 const width=Number($('width').value);if(!Number.isFinite(width)||width<320||width>7680)return;
 const side=width/11.2*1.455;
 for(const group of ['actor','wild'])$(group+'Size').value=side.toFixed(6);
 render();
};
for(const group of ['actor','wild','minion'])for(const field of ['Left','Top','Size'])$(group+field).oninput=render;
$('flip').oninput=render;
setInterval(()=>{
 if(lastFrame&&Date.now()-lastFrame>3000)clear();
 $('freshness').textContent=lastFrame?'房间 '+room+' · '+((Date.now()-lastFrame)/1000).toFixed(1)+' 秒前 · 英雄 '+frame.actors.length+' / 野怪 '+frame.monsters.length+' / 兵线 '+frame.minions.length:room?'房间 '+room+'：等待新帧（需下一帧头或发送端正常关闭才能划定完整消息）':'请选择六位数字房间号。';
},250);
connect();
