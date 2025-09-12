// gateway/usecases/runtime.js
import { spawn } from 'child_process';
import { getMachineProfile, getUserProfile } from '../db/hwStore.js';

let serverProc = null;

export async function startLlamaServerUseCase(req, res){
  if (serverProc && !serverProc.killed) return res.status(409).json({ ok:false, error:'server already running' });

  const scope = req.body?.scope === 'user' ? 'user' : 'machine';
  const prof = scope==='user' && req.session?.userId ? getUserProfile(req.session.userId) : getMachineProfile();
  if (!prof?.recommend?.server) return res.status(400).json({ ok:false, error:'no hardware profile; run /optimize/hw/run first' });

  const cmd = prof.recommend.server.cmd;
  const args = prof.recommend.server.args;
  const env = { ...process.env, ...prof.recommend.server.env };

  serverProc = spawn(cmd, args, { env, stdio:['ignore','pipe','pipe'] });
  let started = false;

  serverProc.stdout.on('data', d => {
    const s = d.toString();
    if (!started && /listening|http server running|serving/i.test(s)) { started = true; }
    process.stdout.write(`[llama-server] ${s}`);
  });
  serverProc.stderr.on('data', d => process.stderr.write(`[llama-server] ${d}`));
  serverProc.on('close', code => { serverProc = null; console.log(`[llama-server] exited ${code}`); });

  res.json({ ok:true, pid: serverProc.pid, cmd, args, scope });
}

export async function stopLlamaServerUseCase(_req, res){
  if (!serverProc) return res.json({ ok:true, already:'stopped' });
  serverProc.kill('SIGTERM');
  res.json({ ok:true, stopping:true });
}
