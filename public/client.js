let currentProject = new URLSearchParams(location.search).get('project') || 'emepath';
const palette = document.getElementById('palette');
const palInput = document.getElementById('palInput');
const palList = document.getElementById('palList');

function statusPill(s){ s=(s||'').toLowerCase(); return '<span class="pill '+s+'">'+s+'</span>'; }

async function loadProjects(){ const r=await fetch('/projects'); const j=await r.json(); const el=document.getElementById('projects'); el.innerHTML=''; (j.projects||[]).forEach(p=>{ const d=document.createElement('div'); d.className='pCard'; d.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between"><div><div style="font-weight:700">'+p.projectId+'</div><div style="margin-top:4px"><span class="stat">pending '+(p.status.counts.pending||0)+'</span><span class="stat">running '+(p.status.counts.running||0)+'</span><span class="stat">done '+(p.status.counts.done||0)+'</span></div></div><div>'+statusPill(p.status.queue.paused?'paused':'active')+'</div></div>'; d.onclick=()=>{currentProject=p.projectId; loadAll();}; el.appendChild(d); }); document.getElementById('projTitle').textContent='Flow — '+currentProject; }

async function loadChat(){ const r=await fetch('/chat?project='+encodeURIComponent(currentProject)); const j=await r.json(); const c=document.getElementById('chat'); c.innerHTML=''; (j.messages||[]).forEach(m=>{ const d=document.createElement('div'); d.className='bubble '+(m.role==='user'?'user':'asst'); d.innerHTML='<div style="opacity:.7;font-size:12px;margin-bottom:4px">'+m.role+'</div>'+m.content; c.appendChild(d); }); c.scrollTop=c.scrollHeight; }

async function loadAgents(){ const r=await fetch('/status?project='+encodeURIComponent(currentProject)); const j=await r.json(); const list=(j.status&&j.status.agents)||[]; lastAgents=list; const el=document.getElementById('agents'); el.innerHTML=''; list.forEach(a=>{ const d=document.createElement('div'); d.className='aRow'; d.innerHTML='<div>'+statusPill(a.status)+'</div><div style="flex:1"><div style="font-weight:600">'+a.goal+'</div><div style="color:var(--muted);font-size:12px">'+a.id+' · EOT '+(a.eots||0)+'</div></div><button class="btn runBtn" data-id="'+a.id+'">Run</button>'; el.appendChild(d); }); el.querySelectorAll('.runBtn').forEach(btn=>{ btn.onclick=async ()=>{ const id=btn.getAttribute('data-id'); const kind=prompt('Kind to run (distill/scan/query)?','distill')||'custom'; await fetch('/agent/'+encodeURIComponent(id)+'/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind})}); loadAgents(); }; }); drawGraph(list); }

async function loadLogs(){ const r=await fetch('/logs?project='+encodeURIComponent(currentProject)); const t=await r.text(); const el=document.getElementById('logs'); if(el) el.textContent=t; }
async function loadTerm(){ try{ const r=await fetch('/term'); const t=await r.text(); const el=document.getElementById('term'); if(el) el.textContent=t; }catch(e){} }

async function send(){ const t=document.getElementById('ta').value.trim(); if(!t) return; document.getElementById('ta').value=''; await fetch('/chat?project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t})}); loadProjects(); loadChat(); }

document.getElementById('send').onclick=send;
document.getElementById('pause').onclick=()=>fetch('/pause',{method:'POST'}).then(loadProjects);
document.getElementById('resume').onclick=()=>fetch('/resume',{method:'POST'}).then(loadProjects);

document.getElementById('openPalette').onclick=()=>openPalette();
document.getElementById('openInterrupt').onclick=()=>toggleInterrupt(true);
document.getElementById('closeInterrupt').onclick=()=>toggleInterrupt(false);
document.getElementById('sendInterrupt').onclick=sendInterrupt;

function loadAll(){ loadProjects(); loadAgents(); loadLogs(); loadChat(); loadPlan(); }
loadAll(); setInterval(loadAll, 5000);

// Path Graph prototype — simple radial layout
function drawGraph(agents){ const svg=document.getElementById('graph'); const W=svg.clientWidth||svg.parentElement.clientWidth||800; const H=svg.clientHeight||svg.parentElement.clientHeight||600; svg.setAttribute('viewBox','0 0 ' + W + ' ' + H); svg.innerHTML=''; const cx=W/2, cy=H/2; const R=Math.min(W,H)/3; svg.appendChild(makeDefs()); const root=document.createElementNS('http://www.w3.org/2000/svg','circle'); root.setAttribute('cx',cx); root.setAttribute('cy',cy); root.setAttribute('r',12); root.setAttribute('fill','url(#gradRoot)'); root.setAttribute('stroke','rgba(255,255,255,.3)'); svg.appendChild(root); if (typeof currentPlan==='object' && currentPlan && currentPlan.intent){ const t=document.createElementNS('http://www.w3.org/2000/svg','text'); t.setAttribute('x',cx+14); t.setAttribute('y',cy+4); t.setAttribute('fill','var(--muted)'); t.setAttribute('font-size','13'); t.textContent=trim(currentPlan.intent,40); svg.appendChild(t); } const n=Math.max(1,agents.length); agents.forEach((a,i)=>{ const ang=(i/n)*Math.PI*2 - Math.PI/2; const x=cx+R*Math.cos(ang), y=cy+R*Math.sin(ang); const path=document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d','M ' + cx + ' ' + cy + ' Q ' + (cx + (x - cx)/2) + ' ' + (cy + (y - cy)/2 - 40) + ' ' + x + ' ' + y); path.setAttribute('stroke', edgeColor(a.status)); path.setAttribute('stroke-width','2'); path.setAttribute('fill','none'); path.setAttribute('opacity','.7'); svg.appendChild(path); const node=document.createElementNS('http://www.w3.org/2000/svg','circle'); node.setAttribute('cx',x); node.setAttribute('cy',y); node.setAttribute('r',8); node.setAttribute('fill', nodeColor(a.status)); node.setAttribute('stroke','rgba(255,255,255,.3)'); svg.appendChild(node); const label=document.createElementNS('http://www.w3.org/2000/svg','text'); label.setAttribute('x',x+10); label.setAttribute('y',y+4); label.setAttribute('fill','var(--muted)'); label.setAttribute('font-size','12'); label.textContent=trim(a.goal,40); svg.appendChild(label); }); }
function makeDefs(){ const defs=document.createElementNS('http://www.w3.org/2000/svg','defs'); const grad=document.createElementNS('http://www.w3.org/2000/svg','radialGradient'); grad.setAttribute('id','gradRoot'); const s1=document.createElementNS('http://www.w3.org/2000/svg','stop'); s1.setAttribute('offset','0%'); s1.setAttribute('stop-color','var(--brand)'); const s2=document.createElementNS('http://www.w3.org/2000/svg','stop'); s2.setAttribute('offset','100%'); s2.setAttribute('stop-color','var(--accent)'); s2.setAttribute('stop-opacity','.5'); grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad); return defs; }
function nodeColor(s){ s=(s||'').toLowerCase(); if(s==='running') return '#60a5fa'; if(s==='done') return '#32d583'; if(s==='error') return '#ef4444'; if(s==='paused') return '#a78bfa'; return '#9ca3af'; }
function edgeColor(s){ s=(s||'').toLowerCase(); if(s==='running') return 'rgba(96,165,250,.8)'; if(s==='done') return 'rgba(50,213,131,.6)'; if(s==='error') return 'rgba(239,68,68,.6)'; if(s==='paused') return 'rgba(167,139,250,.6)'; return 'rgba(156,163,175,.4)'; }
function trim(s,n){ s=String(s||''); return s.length>n? s.slice(0,n-1)+'…': s; }

// Palette
const PRESETS=[
  {label:'Plan: Distill ./documents (autorun)', run:()=>fetch('/process?autorun=true&project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Distill ./documents',options:{autorun:true}})}).then(loadAll)},
  {label:'Scan current repo', run:()=>fetch('/control?project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Scan repository',actions:[{tool:'execute',args:{kind:'scan',input:JSON.stringify({root:"."})}}]})}).then(loadAll)},
  {label:'Query: "security policy"', run:()=>fetch('/control?project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Query security policy',actions:[{tool:'execute',args:{kind:'query',input:JSON.stringify({q:'security policy',k:8})}}]})}).then(loadAll)},
  {label:'Suggest fixes & features', run:()=>fetch('/control?project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Survey + suggest',actions:[{tool:'survey_env'},{tool:'suggest_fixes'},{tool:'suggest_features'}]})}).then(loadAll)},
];
function openPalette(){ palette.style.display='flex'; palInput.value=''; renderPalList(PRESETS); palInput.focus(); }
function closePalette(){ palette.style.display='none'; }
palInput.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closePalette(); } if(e.key==='Enter'){ const first=palList.querySelector('.palItem'); if(first){ first.click(); } } });
document.getElementById('openPalette').addEventListener('click',openPalette);
document.addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); openPalette(); } });
function renderPalList(items){ palList.innerHTML=''; items.forEach(it=>{ const d=document.createElement('div'); d.className='palItem'; d.textContent=it.label; d.onclick=()=>{ closePalette(); it.run(); }; palList.appendChild(d); }); }

// Interrupt
function toggleInterrupt(on){ document.getElementById('interrupt').style.display= on?'block':'none'; }
async function sendInterrupt(){ const a=document.getElementById('intA').value.trim(); const b=document.getElementById('intB').value.trim(); if(!a && !b) return; const r=await fetch('/interrupt?format=text&project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[a,b]})}); const t=await r.text(); document.getElementById('intOut').textContent=t; }

// Logs collapse and rolling terminal
document.getElementById('toggleLogs').addEventListener('click',()=>{ const w=document.getElementById('logsWrap'); const b=document.getElementById('toggleLogs'); const vis = w.style.display !== 'none'; w.style.display = vis ? 'none' : 'block'; b.textContent = vis ? 'Show' : 'Hide'; });
document.getElementById('toggleTerm').addEventListener('click',()=>{ const w=document.getElementById('termWrap'); const b=document.getElementById('toggleTerm'); const vis = w.style.display !== 'none'; w.style.display = vis ? 'none' : 'block'; b.textContent = vis ? 'Show' : 'Hide'; });
try { loadTerm(); } catch {}

// Watchbar countdown
async function pollWatch(){ try{ const r=await fetch('/watch/state'); const j=await r.json(); const s=j.state||{}; const wb=document.getElementById('watchbar'); if(!wb) return; if(s.active){ wb.style.display='inline-block'; const msg = s.step==='staging' ? `staging :\${s.targetPort||''}` : (s.step==='switching' ? 'switching' : `restart in \${s.seconds||0}s`); wb.textContent=msg; } else { wb.style.display='none'; } }catch(e){} }
setInterval(pollWatch, 1000);

// Chat export/clear actions
document.getElementById('exportChat').addEventListener('click',(e)=>{ e.preventDefault(); const url='/chat/export?project='+encodeURIComponent(currentProject); const a=document.createElement('a'); a.href=url; a.download='chat.'+currentProject+'.jsonl'; a.click(); });
document.getElementById('clearChat').addEventListener('click',async ()=>{ if(!confirm('Clear chat history? A backup will be created.')) return; await fetch('/chat/clear?project='+encodeURIComponent(currentProject),{method:'POST'}); await loadChat(); });

// Plan drawer
document.getElementById('openPlan').addEventListener('click',()=>togglePlan(true));
document.getElementById('closePlan').addEventListener('click',()=>togglePlan(false));
function togglePlan(on){ const el=document.getElementById('plan'); el.style.display= on?'block':'none'; if(on) renderPlanUI(); }
async function renderPlanUI(){ const el=document.getElementById('planBody'); el.innerHTML=''; try{ const r=await fetch('/plan?project='+encodeURIComponent(currentProject)); const j=await r.json(); const p=j.plan||{}; const wrap=document.createElement('div');
  const intent=document.createElement('div'); intent.innerHTML='<div class="topTitle">Intent</div><div class="stat">'+(p.intent||'—')+'</div>';
  const goals=document.createElement('div'); goals.innerHTML='<div class="topTitle" style="margin-top:8px">Goals</div>'; (p.goals||[]).forEach(g=>{ const it=document.createElement('div'); it.className='stat'; it.textContent=g; goals.appendChild(it); });
  const steps=document.createElement('div'); steps.innerHTML='<div class="topTitle" style="margin-top:8px">Steps</div>'; (p.plan||[]).forEach(s=>{ const it=document.createElement('div'); it.className='stat'; it.textContent=s; steps.appendChild(it); });
  const checklist=document.createElement('div'); checklist.innerHTML='<div class="topTitle" style="margin-top:8px">Checklist</div>'; (p.checklist||[]).forEach(c=>{ const box=document.createElement('div'); box.className='aRow'; const title=document.createElement('div'); title.style.flex='1'; title.innerHTML='<b>'+c.title+'</b><br><small style="color:var(--muted)">'+c.action+'</small>'; const btn=document.createElement('button'); btn.className='btn'; btn.textContent='Resolve'; btn.onclick=async ()=>{ let tool=null; if(c.action==='read_standards') tool='read_standards'; else if(c.action==='run_tests') tool='run_tests'; if(tool){ await fetch('/control?project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'resolve checklist',actions:[{tool}]})}); await renderPlanUI(); } }; box.appendChild(title); box.appendChild(btn); checklist.appendChild(box); });
  wrap.appendChild(intent); wrap.appendChild(goals); wrap.appendChild(steps); wrap.appendChild(checklist); el.appendChild(wrap); }catch(e){ el.textContent='No plan available.'; } }

 // Memory
 document.getElementById('openMemory').addEventListener('click',()=>toggleMemory(true));
 document.getElementById('closeMemory').addEventListener('click',()=>toggleMemory(false));
 function toggleMemory(on){ const el=document.getElementById('memory'); el.style.display= on?'block':'none'; if(on) loadMemory(); }
 async function loadPlan(){ try{ const r=await fetch('/plan?project='+encodeURIComponent(currentProject)); const j=await r.json(); currentPlan=j.plan||null; drawGraph(lastAgents||[]); }catch(e){} }
 async function loadMemory(){ try{ const r=await fetch('/memory?project='+encodeURIComponent(currentProject)); const j=await r.json(); const el=document.getElementById('memBody'); const fmt=(x)=> x && x.updatedAt ? new Date(x.updatedAt).toLocaleString() : '—'; el.innerHTML=''
   + '<div class="pCard" style="min-width:220px"><div class="topTitle">Short-term</div><div class="stat">size '+(j.short&&j.short.size||0)+'</div><div class="stat">updated '+fmt(j.short)+'</div></div>'
   + '<div class="pCard" style="min-width:220px"><div class="topTitle">Long-term</div><div class="stat">size '+(j.long&&j.long.size||0)+'</div><div class="stat">updated '+fmt(j.long)+'</div></div>'
   + '<div class="pCard" style="min-width:220px"><div class="topTitle">Personalization</div><div class="stat">'+(j.personalization&&j.personalization.exists?'exported':'not exported')+'</div><div class="stat" style="max-width:360px">'+(j.personalization&&j.personalization.path||'')+'</div></div>'; }catch(e){} }
