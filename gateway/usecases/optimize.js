// gateway/usecases/optimize.js
import { resolveBaseGGUF, optimize } from '../lib/hw.js';
import {
  getMachineProfile,
  setMachineProfile,
  getUserProfile,
  setUserProfile,
} from '../db/hwStore.js';

function isoSeconds(d = new Date()) {
  const t = Math.floor(d.getTime() / 1000) * 1000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function runHwOptimizeUseCase(req, res, deps) {
  const body = req.body || {};
  const modelArg = String(body.model || '');
  const deep = !!body.deep;
  const quick = !!body.quick;
  if (!modelArg)
    return res.status(400).json({
      ok: false,
      error: 'model is required (ollama id or /abs/path/model.gguf)',
    });

  const gguf = modelArg.startsWith('/')
    ? modelArg
    : await resolveBaseGGUF(modelArg);
  if (!gguf)
    return res.status(404).json({
      ok: false,
      error: 'could not resolve model to a local .gguf path',
    });

  const prof = await optimize({ model: gguf, deep, quick });
  const scope = body.scope === 'user' ? 'user' : 'machine';

  let saved = null;
  if (scope === 'user' && req.session?.userId) {
    saved = setUserProfile(req.session.userId, { ...prof, scope: 'user' });
  } else {
    saved = setMachineProfile({ ...prof, scope: 'machine' });
  }

  res.json({ ok: true, scope, profile: saved });
}

export async function getHwProfileUseCase(req, res) {
  const scope = req.query?.scope === 'user' ? 'user' : 'machine';
  const prof =
    scope === 'user' && req.session?.userId
      ? getUserProfile(req.session.userId)
      : getMachineProfile();
  if (!prof) return res.status(404).json({ ok: false, error: 'no profile' });
  res.json({ ok: true, scope, profile: prof });
}
