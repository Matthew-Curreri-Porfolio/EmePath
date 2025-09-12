// gateway/db/hwStore.js
// Simple JSON store for hardware profiles (machine-level + per-user)

import fs from 'fs';
import path from 'path';

const FILE = path.resolve(process.cwd(), 'gateway/db/hw-profiles.json');

function isoSeconds(d=new Date()){
  const t = Math.floor(d.getTime()/1000)*1000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/,'Z');
}

function readAll(){
  try { return JSON.parse(fs.readFileSync(FILE,'utf8')); } catch { return { machine:null, users:{} }; }
}
function writeAll(data){
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function getMachineProfile(){
  const s = readAll(); return s.machine || null;
}
export function setMachineProfile(profile){
  const s = readAll();
  const now = isoSeconds();
  const p = { ...(profile||{}), id: profile?.id || 'machine', scope:'machine', updatedAt: now, createdAt: profile?.createdAt || now };
  s.machine = p; writeAll(s); return p;
}

export function getUserProfile(userId){
  const s = readAll(); return (s.users && s.users[userId]) || null;
}
export function setUserProfile(userId, profile){
  const s = readAll();
  const now = isoSeconds();
  if (!s.users) s.users = {};
  const p = { ...(profile||{}), id: profile?.id || `user_${userId}`, scope:'user', userId, updatedAt: now, createdAt: profile?.createdAt || now };
  s.users[userId] = p; writeAll(s); return p;
}
