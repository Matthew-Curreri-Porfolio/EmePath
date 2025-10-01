let currentProject = new URLSearchParams(location.search).get('project') || '';
let currentPlan = null;
let lastAgents = null;
let termSource = null;
let termAutoScroll = true;
let seenPorts = new Set();

// Utilities
function statusPill(s) { s = (s || '').toLowerCase(); return '<span class="pill ' + s + '">' + s + '</span>'; }
function trim(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function isNearBottom(el, threshold = 40) {
  return el ? el.scrollHeight - el.scrollTop - el.clientHeight < threshold : true;
}

// Actions feed helpers
const actionsFeedItems = [];
function addActionFeedback(label, text) {
  const el = document.getElementById('actionsFeed');
  if (!el) return;
  const ts = new Date().toLocaleTimeString();
  const d = document.createElement('div');
  d.className = 'item';
  const body = String(text || '').trim();
  d.innerHTML = `<details><summary>${label} — ${ts}</summary><pre>${body}</pre></details>`;
  el.prepend(d);
  actionsFeedItems.unshift({ ts, label, text: body });
  while (actionsFeedItems.length > 50 && el.lastChild) { el.removeChild(el.lastChild); actionsFeedItems.pop(); }
}

// Projects
async function loadProjects() { const r = await fetch('/projects'); const j = await r.json(); const el = document.getElementById('projects'); el.innerHTML = ''; const projects = (j.projects || []); if (!currentProject || !projects.some(p => p.projectId === currentProject)) { currentProject = (projects[0] && projects[0].projectId) || ''; } projects.forEach(p => { const actionDir = (p.config && p.config.actionDir) || '.'; const status = p.status || {}; const counts = status.counts || {}; const queue = status.queue || {}; const stateLabel = p.active === false ? 'inactive' : (queue.paused ? 'paused' : 'active'); const d = document.createElement('div'); d.className = 'pCard' + (p.projectId === currentProject ? ' active' : ''); d.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between"><div><div style="font-weight:700">${p.projectId}</div><div style="margin-top:4px"><span class="stat" title="Click to edit actionDir" style="cursor:pointer" onclick="event.stopPropagation(); editActionDir(this,'${p.projectId}')"><u>actionDir:</u> ${actionDir}</span><span class="stat">pending ${counts.pending||0}</span><span class="stat">running ${counts.running||0}</span><span class="stat">done ${counts.done||0}</span></div></div><div style="display:flex;gap:4px"><button class="btn sm delBtn" data-id="${p.projectId}">×</button><div class="status">${statusPill(stateLabel)}</div></div></div>`; d.onclick = (e) => { if (!e.target.classList.contains('delBtn')) { currentProject = p.projectId; loadAll(); } }; el.appendChild(d); }); el.querySelectorAll('.delBtn').forEach(btn => { btn.onclick = async (e) => { e.stopPropagation(); const projectId = btn.getAttribute('data-id'); if (!confirm('Delete project "' + projectId + '"? This will remove all agents and data for this project.')) return; try { await fetch('/projects/' + projectId, { method: 'DELETE' }); await loadProjects(); } catch (err) { console.error(err); } } }); document.getElementById('projTitle').textContent = 'Flow — ' + (currentProject || ''); }

function editActionDir(elem, projectId) { const currentText = elem.textContent.replace(/^.*?actionDir:\s*/, ''); const newDir = prompt('New action directory:', currentText); if (newDir !== null && newDir.trim() !== '' && newDir !== currentText) { fetch('/projects/' + encodeURIComponent(projectId) + '/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionDir: newDir.trim() }) }).then(r => r.json()).then(j => { if (j.ok) { loadProjects(); } else { alert('Error updating actionDir'); } }).catch(err => { alert('Error updating actionDir'); }); } }

// Chat
async function loadChat() {
  try {
    const r = await fetch('/chat?project=' + encodeURIComponent(currentProject));
    const j = await r.json();
    const c = document.getElementById('chat');
    if (!c) return;
    c.innerHTML = '';
    const msgs = (j.messages || []);
    msgs.forEach((m) => {
      const d = document.createElement('div');
      d.className = 'bubble ' + (m.role === 'user' ? 'user' : 'asst');
      const role = document.createElement('div');
      role.style.opacity = '.7';
      role.style.fontSize = '12px';
      role.style.marginBottom = '4px';
      role.textContent = m.role;
      const body = document.createElement('div');
      body.textContent = m.content;
      const foot = document.createElement('div');
      foot.style.marginTop = '6px';
      foot.style.opacity = '.8';
      const pin = document.createElement('button');
      pin.className = 'btn sm';
      pin.textContent = '📌 Pin';
      pin.title = 'Pin this message (no agent spawn)';
      pin.onclick = async () => {
        try {
          await fetch('/pin?project=' + encodeURIComponent(currentProject), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: m.content }) });
          await loadPlan();
          await loadAgents();
          await loadPins();
        } catch (err) { console.error(err); }
      };
      foot.appendChild(pin);
      d.appendChild(role);
      d.appendChild(body);
      d.appendChild(foot);
      c.appendChild(d);
    });
    c.scrollTop = c.scrollHeight;
  } catch (e) { console.error(e); }
}

async function loadPins() {
  const el = document.getElementById('pins');
  const clearBtn = document.getElementById('clearPins');
  if (!el) return;
  try {
    const r = await fetch('/pins?project=' + encodeURIComponent(currentProject));
    const j = await r.json();
    const pins = Array.isArray(j.pins) ? j.pins : [];
    el.innerHTML = '';
    if (!pins.length) {
      el.classList.remove('show');
      if (clearBtn) clearBtn.disabled = true;
      return;
    }
    el.classList.add('show');
    if (clearBtn) clearBtn.disabled = false;
    pins.forEach((pin) => {
      const card = document.createElement('div');
      card.className = 'pinCard';
      const meta = document.createElement('div');
      meta.className = 'pin-meta';
      const label = pin.kind ? pin.kind.toUpperCase() : 'PIN';
      const time = pin.ts ? new Date(pin.ts).toLocaleString() : '';
      meta.innerHTML = `<span>${label}</span><span>${time}</span>`;
      const text = document.createElement('div');
      text.className = 'pin-text';
      text.textContent = pin.text;
      const actions = document.createElement('div');
      actions.className = 'pin-actions';
      const useBtn = document.createElement('button');
      useBtn.className = 'btn sm';
      useBtn.textContent = 'Use';
      useBtn.onclick = () => {
        const ta = document.getElementById('ta');
        if (ta) { ta.value = pin.text; ta.focus(); }
      };
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn sm';
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = async () => {
        if (!confirm('Remove this pin?')) return;
        await fetch('/pins/' + encodeURIComponent(pin.id) + '?project=' + encodeURIComponent(currentProject), { method: 'DELETE' });
        await loadPins();
        await loadAgents();
        await loadPlan();
      };
      actions.appendChild(useBtn);
      actions.appendChild(removeBtn);
      if (pin.agentId) {
        const removeAgentBtn = document.createElement('button');
        removeAgentBtn.className = 'btn sm';
        removeAgentBtn.textContent = 'Remove Agent';
        removeAgentBtn.onclick = async () => {
          if (!confirm('Remove the agent spawned from this pin?')) return;
          await fetch('/agent/' + encodeURIComponent(pin.agentId), { method: 'DELETE' });
          await loadAgents();
          await loadPins();
          await loadPlan();
        };
        actions.appendChild(removeAgentBtn);
      }
      card.appendChild(meta);
      card.appendChild(text);
      card.appendChild(actions);
      el.appendChild(card);
    });
  } catch (e) {
    if (clearBtn) clearBtn.disabled = true;
    el.classList.remove('show');
    console.error(e);
  }
}

async function sendMessage() {
  const ta = document.getElementById('ta');
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  ta.value = '';
  try {
    // Always log chat for history
    await fetch('/chat?project=' + encodeURIComponent(currentProject), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });

    // Optionally route to controller if LLM Control is enabled
    const ctl = document.getElementById('ctlMode');
    const useController = !!(ctl && ctl.checked);
    if (useController) {
      const r = await fetch('/control?project=' + encodeURIComponent(currentProject), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, options: { loop: true, maxTurns: 3 } })
      });
      // Capture feedback
      let payload = null; let raw = '';
      try { payload = await r.json(); } catch { try { raw = await r.text(); } catch {} }
      const out = (payload && (payload.text || payload.raw)) || raw || '';
      if (out) addActionFeedback('Controller (chat)', out);
    }

    await loadProjects();
    await loadChat();
    await loadPins();
    await loadPlan();
    await loadAgents();
  } catch (e) { console.error(e); }
}

// Agents
async function loadAgents() {
  const r = await fetch('/status?project=' + encodeURIComponent(currentProject));
  const j = await r.json();
  const list = (j.status && j.status.agents) || [];
  lastAgents = list;
  const el = document.getElementById('agents');
  if (!el) return;
  el.innerHTML = '';
  list.forEach(a => {
    const d = document.createElement('div');
    d.className = 'aRow';
    d.innerHTML = '<div>' + statusPill(a.status) + '</div>' +
      '<div style="flex:1"><div style="font-weight:600">' + trim(a.goal || '', 72) + '</div><div style="color:var(--muted);font-size:12px">' + a.id + ' · EOT ' + (a.eots || 0) + '</div></div>' +
      '<div class="agent-actions"><button class="btn removeBtn sm" data-id="' + a.id + '">Remove</button></div>';
    el.appendChild(d);
  });
  el.querySelectorAll('.removeBtn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-id');
      if (!confirm('Remove this agent?')) return;
      await fetch('/agent/' + encodeURIComponent(id), { method: 'DELETE' });
      await loadAgents();
      await loadPlan();
    };
  });
  drawGraph(list);
}

// Logs & Terminal
async function loadLogs() {
  const el = document.getElementById('logs'); if (!el) return; try { const es = new EventSource('/logs/sse?project=' + encodeURIComponent(currentProject)); es.onmessage = (ev) => { try { const d = JSON.parse(ev.data); el.textContent = d.text || ''; } catch { } }; es.onerror = () => { es.close(); }; } catch (e) { const r = await fetch('/logs?project=' + encodeURIComponent(currentProject)); const t = await r.text(); el.textContent = t; }
}
async function loadTerm() {
  const el = document.getElementById('term');
  if (!el) return;
  const wrap = document.getElementById('termWrap');
  const scrollBtn = document.getElementById('termScrollBottom');
  if (!el.dataset.bound) {
    el.dataset.bound = '1';
    el.addEventListener('scroll', () => {
      const near = isNearBottom(el);
      termAutoScroll = near;
      if (scrollBtn) {
        const hidden = wrap && wrap.style.display === 'none';
        scrollBtn.style.display = (!near && !hidden) ? 'inline-flex' : 'none';
      }
    });
  }
  if (scrollBtn && !scrollBtn.dataset.bound) {
    scrollBtn.dataset.bound = '1';
    scrollBtn.addEventListener('click', () => {
      termAutoScroll = true;
      el.scrollTop = el.scrollHeight;
      scrollBtn.style.display = 'none';
    });
  }
  termAutoScroll = true;
  el.scrollTop = el.scrollHeight;
  if (termSource) {
    termSource.close();
    termSource = null;
  }
  try {
    termSource = new EventSource('/term/sse');
    termSource.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        el.textContent = d.text || '';
      } catch {
        el.textContent = ev.data || '';
      }
      if (termAutoScroll) {
        el.scrollTop = el.scrollHeight;
        if (scrollBtn) scrollBtn.style.display = 'none';
      } else if (scrollBtn && (!wrap || wrap.style.display !== 'none')) {
        scrollBtn.style.display = 'inline-flex';
      }
    };
    termSource.onerror = () => {
      termSource.close();
      termSource = null;
    };
  } catch (e) {
    try {
      const r = await fetch('/term');
      const t = await r.text();
      el.textContent = t;
      if (termAutoScroll) el.scrollTop = el.scrollHeight;
    } catch (err) { console.error(err); }
  }
}

// Plan & Memory
async function loadPlan() { try { const r = await fetch('/plan?project=' + encodeURIComponent(currentProject)); const j = await r.json(); currentPlan = j.plan || null; drawGraph(lastAgents || []); updateChatContext(currentPlan); } catch (e) { } }
function updateChatContext(plan) {
  const el = document.getElementById('chatContext'); if (!el) return;
  if (!plan) { el.textContent = ''; return; }
  const intent = String(plan.intent || '').trim();
  const goals = Array.isArray(plan.goals) ? plan.goals.length : 0;
  const steps = Array.isArray(plan.plan) ? plan.plan.length : 0;
  el.textContent = `Intent: ${intent || '—'} • Goals: ${goals} • Steps: ${steps}`;
}
async function loadMemory() {
  try {
    const r = await fetch('/memory?project=' + encodeURIComponent(currentProject)); const j = await r.json(); const el = document.getElementById('memBody'); const fmt = (x) => x && x.updatedAt ? new Date(x.updatedAt).toLocaleString() : '—'; el.innerHTML = ''
      + '<div class="pCard" style="min-width:220px"><div class="topTitle">Short-term</div><div class="stat">size ' + (j.short && j.short.size || 0) + '</div><div class="stat">updated ' + fmt(j.short) + '</div></div>'
      + '<div class="pCard" style="min-width:220px"><div class="topTitle">Long-term</div><div class="stat">size ' + (j.long && j.long.size || 0) + '</div><div class="stat">updated ' + fmt(j.long) + '</div></div>'
      + '<div class="pCard" style="min-width:220px"><div class="topTitle">Personalization</div><div class="stat">' + (j.personalization && j.personalization.exists ? 'exported' : 'not exported') + '</div><div class="stat" style="max-width:360px">' + (j.personalization && j.personalization.path || '') + '</div></div>';
  } catch (e) { }
}

// Graph
function drawGraph(agents) {
  const svg = document.getElementById('graph'); const W = svg.clientWidth || svg.parentElement.clientWidth || 800; const H = svg.clientHeight || svg.parentElement.clientHeight || 600; svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.innerHTML = ''; const cx = W / 2, cy = H / 2; const R = Math.min(W, H) / 3; svg.appendChild(makeDefs()); const root = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); root.setAttribute('cx', cx); root.setAttribute('cy', cy); root.setAttribute('r', 12); root.setAttribute('fill', 'url(#gradRoot)'); root.setAttribute('stroke', 'rgba(255,255,255,.3)'); svg.appendChild(root); if (typeof currentPlan === 'object' && currentPlan && currentPlan.intent) { const t = document.createElementNS('http://www.w3.org/2000/svg', 'text'); t.setAttribute('x', cx + 14); t.setAttribute('y', cy + 4); t.setAttribute('fill', 'var(--muted)'); t.setAttribute('font-size', '13'); t.textContent = trim(currentPlan.intent, 40); svg.appendChild(t); }
  // Goals/steps rings
  const rg = R * 0.65, rs = R * 0.95; const goals = Array.isArray(currentPlan && currentPlan.goals) ? currentPlan.goals : []; const steps = Array.isArray(currentPlan && currentPlan.plan) ? currentPlan.plan : [];
  const ng = Math.max(1, goals.length); goals.forEach((g, i) => { const ang = (i / ng) * Math.PI * 2 - Math.PI / 2; const x = cx + rg * Math.cos(ang), y = cy + rg * Math.sin(ang); const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); node.setAttribute('cx', x); node.setAttribute('cy', y); node.setAttribute('r', 7); node.setAttribute('fill', '#6ad4ff'); node.setAttribute('opacity', '.9'); svg.appendChild(node); const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.setAttribute('x', x + 9); label.setAttribute('y', y + 4); label.setAttribute('fill', 'var(--muted)'); label.setAttribute('font-size', '12'); label.textContent = trim(g, 36); svg.appendChild(label); const edge = document.createElementNS('http://www.w3.org/2000/svg', 'line'); edge.setAttribute('x1', cx); edge.setAttribute('y1', cy); edge.setAttribute('x2', x); edge.setAttribute('y2', y); edge.setAttribute('stroke', 'rgba(106,212,255,.45)'); edge.setAttribute('stroke-width', '1.2'); svg.appendChild(edge); });
  const ns = Math.max(1, steps.length); steps.forEach((s, i) => { const ang = (i / ns) * Math.PI * 2 - Math.PI / 2; const x = cx + rs * Math.cos(ang), y = cy + rs * Math.sin(ang); const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); node.setAttribute('cx', x); node.setAttribute('cy', y); node.setAttribute('r', 5); node.setAttribute('fill', '#a78bfa'); node.setAttribute('opacity', '.8'); svg.appendChild(node); const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.setAttribute('x', x + 8); label.setAttribute('y', y + 4); label.setAttribute('fill', 'var(--muted)'); label.setAttribute('font-size', '11'); label.textContent = trim(s, 40); svg.appendChild(label); });
  // Agents ring
  const n = Math.max(1, agents.length); agents.forEach((a, i) => { const ang = (i / n) * Math.PI * 2 - Math.PI / 2; const x = cx + R * Math.cos(ang), y = cy + R * Math.sin(ang); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M ' + cx + ' ' + cy + ' Q ' + (cx + (x - cx) / 2) + ' ' + (cy + (y - cy) / 2 - 40) + ' ' + x + ' ' + y); path.setAttribute('stroke', edgeColor(a.status)); path.setAttribute('stroke-width', '2'); path.setAttribute('fill', 'none'); path.setAttribute('opacity', '.6'); svg.appendChild(path); const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); node.setAttribute('cx', x); node.setAttribute('cy', y); node.setAttribute('r', 8); node.setAttribute('fill', nodeColor(a.status)); node.setAttribute('stroke', 'rgba(255,255,255,.3)'); svg.appendChild(node); const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.setAttribute('x', x + 10); label.setAttribute('y', y + 4); label.setAttribute('fill', 'var(--muted)'); label.setAttribute('font-size', '12'); label.textContent = trim(a.goal, 40); svg.appendChild(label); });
}
function makeDefs() { const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); const grad = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient'); grad.setAttribute('id', 'gradRoot'); const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', 'var(--brand)'); const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', 'var(--accent)'); s2.setAttribute('stop-opacity', '.5'); grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad); return defs; }
function nodeColor(s) { s = (s || '').toLowerCase(); if (s === 'running') return '#60a5fa'; if (s === 'done') return '#32d583'; if (s === 'error') return '#ef4444'; if (s === 'paused') return '#a78bfa'; return '#9ca3af'; }
function edgeColor(s) { s = (s || '').toLowerCase(); if (s === 'running') return 'rgba(96,165,250,.8)'; if (s === 'done') return 'rgba(50,213,131,.6)'; if (s === 'error') return 'rgba(239,68,68,.6)'; if (s === 'paused') return 'rgba(167,139,250,.6)'; return 'rgba(156,163,175,.4)'; }

// Palette
const palette = document.getElementById('palette');
const palInput = document.getElementById('palInput');
const palList = document.getElementById('palList');
let PRESETS = [];
async function loadConfig() {
  try {
    if (!currentProject) return;
    const r = await fetch('/projects/' + encodeURIComponent(currentProject) + '/config');
    const j = await r.json();
    const actionDir = j.config?.actionDir || '.';
    // Sync LLM Control checkbox with server config (default true)
    const ctl = document.getElementById('ctlMode');
    if (ctl) {
      const v = (j.config && typeof j.config.llmControl === 'boolean') ? !!j.config.llmControl : true;
      ctl.checked = v;
      if (!ctl.dataset.bound) {
        ctl.dataset.bound = '1';
        ctl.addEventListener('change', async () => {
          try {
            await fetch('/projects/' + encodeURIComponent(currentProject) + '/config', {
              method: 'PUT', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ llmControl: !!ctl.checked })
            });
          } catch (e) { console.error(e); }
        });
      }
    }
    PRESETS = [
      // LLM-driven agent creation and orchestration
      { label: 'LLM: Design & spawn agents', run: async () => {
          const task = prompt('Describe the task for agents:');
          if (!task) return;
          try {
            const r = await fetch('/process?autorun=true&project=' + encodeURIComponent(currentProject), {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: task, options: { autorun: true } })
            });
            let j = null; try { j = await r.json(); } catch {}
            if (j && (j.text || j.plan)) addActionFeedback('Process (autorun)', j.text || JSON.stringify(j.plan));
            await loadAgents();
            await loadPlan();
          } catch (e) { console.error(e); }
        }
      },
      { label: 'LLM: Continue plan', run: async () => {
          try {
            const r = await fetch('/control?project=' + encodeURIComponent(currentProject), {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: 'continue plan', options: { loop: true, maxTurns: 2 } })
            });
            let j = null; try { j = await r.json(); } catch {}
            if (j && (j.text || j.raw)) addActionFeedback('Continue plan', j.text || j.raw);
            await loadAgents();
            await loadPlan();
          } catch (e) { console.error(e); }
        }
      },
      { label: 'LLM: Controller (multi-turn)', run: async () => {
          const task = prompt('Controller task (LLM chooses tools/actions):');
          if (!task) return;
          try {
            const r = await fetch('/control?project=' + encodeURIComponent(currentProject), {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: task, options: { loop: true, maxTurns: 3 } })
            });
            let j = null; try { j = await r.json(); } catch {}
            if (j && (j.text || j.raw)) addActionFeedback('Controller', j.text || j.raw);
            await loadAgents();
            await loadPlan();
          } catch (e) { console.error(e); }
        }
      },
      { label: 'LLM: Toggle auto memory', run: async () => {
          try {
            const r = await fetch('/auto/state');
            const j = await r.json();
            const next = !(j && j.enabled);
            await fetch('/auto/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
            alert('Auto memory updater ' + (next ? 'enabled' : 'disabled'));
          } catch (e) { console.error(e); }
        }
      },

      // Existing quick actions
      { label: `Plan: Distill ${actionDir}/documents (autorun)`, run: () => fetch('/process?autorun=true&project=' + encodeURIComponent(currentProject), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `Distill ${actionDir}/documents`, options: { autorun: true } }) }).then(loadAll) },
      { label: 'Scan current repo', run: () => fetch('/control?project=' + encodeURIComponent(currentProject), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Scan repository', actions: [{ tool: 'execute', args: { kind: 'scan', input: JSON.stringify({ root: "." }) } }] }) }).then(loadAll) },
      { label: 'Query: "security policy"', run: () => fetch('/control?project=' + encodeURIComponent(currentProject), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Query security policy', actions: [{ tool: 'execute', args: { kind: 'query', input: JSON.stringify({ q: 'security policy', k: 8 }) } }] }) }).then(loadAll) },
      { label: 'Suggest fixes & features', run: () => fetch('/control?project=' + encodeURIComponent(currentProject), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Survey + suggest', actions: [{ tool: 'survey_env' }, { tool: 'suggest_fixes' }, { tool: 'suggest_features' }] }) }).then(loadAll) },
    ];
  } catch (e) { console.error(e); }
}
function openPalette() { palette.style.display = 'flex'; palInput.value = ''; renderPalList(PRESETS); palInput.focus(); }
function closePalette() { palette.style.display = 'none'; }
palInput.addEventListener('keydown', e => { if (e.key === 'Escape') { closePalette(); } if (e.key === 'Enter') { const first = palList.querySelector('.palItem'); if (first) { first.click(); } } });
document.getElementById('openPalette').addEventListener('click', openPalette);
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); } });
function renderPalList(items) { palList.innerHTML = ''; items.forEach(it => { const d = document.createElement('div'); d.className = 'palItem'; d.textContent = it.label; d.onclick = () => { closePalette(); it.run(); }; palList.appendChild(d); }); }

// Interrupt
function toggleInterrupt(on) { document.getElementById('interrupt').style.display = on ? 'block' : 'none'; }
document.getElementById('openInterrupt').addEventListener('click', () => toggleInterrupt(true));
document.getElementById('closeInterrupt').addEventListener('click', () => toggleInterrupt(false));
document.getElementById('sendInterrupt').addEventListener('click', async () => { const a = document.getElementById('intA').value.trim(); const b = document.getElementById('intB').value.trim(); if (!a && !b) return; const r = await fetch('/interrupt?format=text&project=' + encodeURIComponent(currentProject), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [a, b] }) }); const t = await r.text(); document.getElementById('intOut').textContent = t; });

// Logs collapse + terminal
document.getElementById('toggleLogs').addEventListener('click', () => { const w = document.getElementById('logsWrap'); const b = document.getElementById('toggleLogs'); const vis = w.style.display !== 'none'; w.style.display = vis ? 'none' : 'block'; b.textContent = vis ? 'Show' : 'Hide'; });
document.getElementById('toggleTerm').addEventListener('click', () => { const w = document.getElementById('termWrap'); const b = document.getElementById('toggleTerm'); const vis = w.style.display !== 'none'; w.style.display = vis ? 'none' : 'block'; b.textContent = vis ? 'Show' : 'Hide'; if (!vis) { termAutoScroll = true; requestAnimationFrame(() => { const el = document.getElementById('term'); if (el) { el.scrollTop = el.scrollHeight; } }); } });
document.getElementById('toggleAgents').addEventListener('click', () => { const w = document.getElementById('agentsWrap'); const b = document.getElementById('toggleAgents'); const vis = w.style.display !== 'none'; w.style.display = vis ? 'none' : 'block'; b.textContent = vis ? 'Show' : 'Hide'; });
document.getElementById('togglePorts').addEventListener('click', () => { const w = document.getElementById('portsWrap'); const b = document.getElementById('togglePorts'); const vis = w.style.display !== 'none'; w.style.display = vis ? 'none' : 'block'; b.textContent = vis ? 'Show' : 'Hide'; });
document.getElementById('toggleActions').addEventListener('click', () => { const w = document.getElementById('actionsWrap'); const b = document.getElementById('toggleActions'); const vis = w.style.display !== 'none'; w.style.display = vis ? 'none' : 'block'; b.textContent = vis ? 'Show' : 'Hide'; });
document.getElementById('clearActions').addEventListener('click', () => { const el = document.getElementById('actionsFeed'); if (el) el.innerHTML = ''; actionsFeedItems.length = 0; });

// Plan drawer
document.getElementById('openPlan').addEventListener('click', () => togglePlan(true));
document.getElementById('closePlan').addEventListener('click', () => togglePlan(false));
function togglePlan(on) { const el = document.getElementById('plan'); el.style.display = on ? 'block' : 'none'; if (on) renderPlanUI(); }
async function renderPlanUI() {
  const el = document.getElementById('planBody'); el.innerHTML = ''; try {
    const r = await fetch('/plan?project=' + encodeURIComponent(currentProject)); const j = await r.json(); const p = j.plan || {}; const wrap = document.createElement('div');
    const intent = document.createElement('div'); intent.innerHTML = '<div class="topTitle">Intent</div><div class="stat">' + (p.intent || '—') + '</div>';
    const goals = document.createElement('div'); goals.innerHTML = '<div class="topTitle" style="margin-top:8px">Goals</div>'; (p.goals || []).forEach(g => { const it = document.createElement('div'); it.className = 'stat'; it.textContent = g; goals.appendChild(it); });
    const steps = document.createElement('div'); steps.innerHTML = '<div class="topTitle" style="margin-top:8px">Steps</div>'; (p.plan || []).forEach(s => { const it = document.createElement('div'); it.className = 'stat'; it.textContent = s; steps.appendChild(it); });
    const checklist = document.createElement('div'); checklist.innerHTML = '<div class="topTitle" style="margin-top:8px">Checklist</div>'; (p.checklist || []).forEach(c => { const box = document.createElement('div'); box.className = 'aRow'; const title = document.createElement('div'); title.style.flex = '1'; title.innerHTML = '<b>' + c.title + '</b><br><small style="color:var(--muted)">' + c.action + '</small>'; const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = 'Resolve'; btn.onclick = async () => { let tool = null; if (c.action === 'read_standards') tool = 'read_standards'; else if (c.action === 'run_tests') tool = 'run_tests'; if (tool) { await fetch('/control?project=' + encodeURIComponent(currentProject), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'resolve checklist', actions: [{ tool }] }) }); await renderPlanUI(); } }; box.appendChild(title); box.appendChild(btn); checklist.appendChild(box); });
    wrap.appendChild(intent); wrap.appendChild(goals); wrap.appendChild(steps); wrap.appendChild(checklist); el.appendChild(wrap);
  } catch (e) { el.textContent = 'No plan available.'; }
}

// Memory drawer
document.getElementById('openMemory').addEventListener('click', () => toggleMemory(true));
document.getElementById('closeMemory').addEventListener('click', () => toggleMemory(false));
function toggleMemory(on) { const el = document.getElementById('memory'); el.style.display = on ? 'block' : 'none'; if (on) loadMemory(); }

// Chat controls
document.getElementById('send').addEventListener('click', () => { sendMessage(); });
const chatInput = document.getElementById('ta');
if (chatInput) {
  chatInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      await sendMessage();
    }
  });
}
document.getElementById('createProject').addEventListener('click', async () => { const projectId = prompt('New project name (letters, numbers, underscore, dash only):'); if (!projectId) return; if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) { alert('Invalid project name'); return; } const actionDir = prompt('Action directory (leave empty for current directory "."):'); const payload = { projectId }; if (actionDir !== null && actionDir.trim() !== '') payload.actionDir = actionDir.trim(); try { await fetch('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); await loadProjects(); } catch (err) { console.error(err); alert('Failed to create project'); } });
document.getElementById('pause').addEventListener('click', () => fetch('/pause', { method: 'POST' }).then(loadProjects));
document.getElementById('resume').addEventListener('click', () => fetch('/resume', { method: 'POST' }).then(loadProjects));
document.getElementById('exportChat').addEventListener('click', (e) => { e.preventDefault(); const url = '/chat/export?project=' + encodeURIComponent(currentProject); const a = document.createElement('a'); a.href = url; a.download = 'chat.' + currentProject + '.jsonl'; a.click(); });
document.getElementById('clearChat').addEventListener('click', async () => { if (!confirm('Clear chat history? A backup will be created.')) return; await fetch('/chat/clear?project=' + encodeURIComponent(currentProject), { method: 'POST' }); await loadChat(); });
const clearPinsBtn = document.getElementById('clearPins');
if (clearPinsBtn) {
  clearPinsBtn.addEventListener('click', async () => {
    if (clearPinsBtn.disabled) return;
    if (!confirm('Remove all pins for this project?')) return;
    await fetch('/pins?project=' + encodeURIComponent(currentProject), { method: 'DELETE' });
    await loadPins();
    await loadAgents();
    await loadPlan();
  });
}
document.getElementById('clearTerm').addEventListener('click', async () => {
  try { await fetch('/term/clear', { method: 'POST' }); } catch (e) { console.error(e); }
  const term = document.getElementById('term');
  if (term) { term.textContent = ''; term.scrollTop = 0; }
  termAutoScroll = true;
  const scrollBtn = document.getElementById('termScrollBottom');
  if (scrollBtn) scrollBtn.style.display = 'none';
});
document.getElementById('clearLogs').addEventListener('click', async () => {
  try { await fetch('/logs/clear?project=' + encodeURIComponent(currentProject), { method: 'POST' }); } catch (e) { console.error(e); }
  const logs = document.getElementById('logs');
  if (logs) { logs.textContent = ''; logs.scrollTop = 0; }
});

// Watchbar
async function pollWatch() { try { const r = await fetch('/watch/state'); const j = await r.json(); const s = j.state || {}; const wb = document.getElementById('watchbar'); if (!wb) return; if (s.active) { wb.style.display = 'inline-block'; const msg = s.step === 'staging' ? `staging :${s.targetPort || ''}` : (s.step === 'switching' ? 'switching' : `restart in ${s.seconds || 0}s`); wb.textContent = msg; } else { wb.style.display = 'none'; } } catch (e) { } }

async function loadPorts() {
  try {
    const el = document.getElementById('ports');
    if (!el) return;

    // Initialize header + container once (avoid flicker)
    let header = el.querySelector('#portsHeader');
    let container = el.querySelector('#portsContainer');
    if (!header || !container) {
      el.innerHTML = '';
      header = document.createElement('div');
      header.id = 'portsHeader';
      header.className = 'aRow';
      header.style.background = 'var(--card)';
      header.style.borderBottom = '1px solid var(--border)';
      header.style.fontWeight = 'bold';
      header.innerHTML = `
        <div>Port</div>
        <div>User</div>
        <div>Command</div>
        <div>PID</div>
        <div>Actions</div>
      `;
      el.appendChild(header);
      container = document.createElement('div');
      container.id = 'portsContainer';
      el.appendChild(container);
      // First render will populate all rows below
      seenPorts.clear();
    }

    const r = await fetch('/api/ports');
    const j = await r.json();
    const ports = j.ports || [];

    // Build current set and prune rows for ports that disappeared
    const current = new Set(ports.map(p => String(p.port)));
    Array.from(container.querySelectorAll('.aRow[data-port]')).forEach(row => {
      const port = row.getAttribute('data-port');
      if (!current.has(port)) {
        if (row.parentNode) row.parentNode.removeChild(row);
        seenPorts.delete(port);
      }
    });

    // Only add new rows; no rewrite, no flicker
    const toAdd = [];
    for (const p of ports) {
      const key = String(p.port);
      if (!seenPorts.has(key)) {
        toAdd.push(p);
      }
    }
    // Sort by numeric port for consistent ordering
    toAdd.sort((a, b) => Number(a.port) - Number(b.port));
    if (toAdd.length === 0) return; // nothing new

    for (const p of toAdd) {
      const row = document.createElement('div');
      row.className = 'aRow';
      row.dataset.port = String(p.port);
      row.innerHTML = `
        <div>${p.port}</div>
        <div>${p.user}</div>
        <div>${p.command}</div>
        <div>${p.process}</div>
        <div><button class="btn sm kill-btn" data-port="${p.port}">Kill</button></div>
      `;
      // Insert in sorted position among existing rows
      const existing = Array.from(container.querySelectorAll('.aRow[data-port]'));
      const before = existing.find(r => Number(r.getAttribute('data-port')) > Number(p.port));
      if (before) container.insertBefore(row, before); else container.appendChild(row);

      const btn = row.querySelector('.kill-btn');
      if (btn) {
        btn.addEventListener('click', async (e) => {
          const port = e.currentTarget.getAttribute('data-port');
          if (confirm(`Kill process on port ${port}?`)) {
            await fetch(`/api/ports/${port}/kill`, { method: 'POST' });
            // Remove the row immediately and forget the port
            const rsel = el.querySelector(`.aRow[data-port="${port}"]`);
            if (rsel && rsel.parentNode) rsel.parentNode.removeChild(rsel);
            seenPorts.delete(String(port));
          }
        });
      }
      // Mark as seen after insertion
      seenPorts.add(String(p.port));
    }
  } catch (e) {
    console.error('Error loading ports:', e);
  }
}

async function loadAll() {
  // Ensure a valid currentProject before loading config and actions
  await loadProjects();
  await loadConfig();
  loadAgents();
  loadLogs();
  loadTerm();
  loadChat();
  loadPlan();
  loadPorts();
}

loadAll();
setInterval(pollWatch, 1000);
setInterval(loadPorts, 5000);
