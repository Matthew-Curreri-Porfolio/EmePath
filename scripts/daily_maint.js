#!/usr/bin/env node
import { encodeAllMemories } from '../gateway/agents/db_manager.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  try {
    const reencode = String(process.env.REENCODE || '').toLowerCase() === 'true';
    const result = await encodeAllMemories({ reencode });
    console.log('db_manager:', result);
  } catch (e) {
    console.error('db_manager error:', e && e.message || e);
    process.exitCode = 1;
  }
  try {
    const backupScript = path.resolve(__dirname, './backup_db.sh');
    await new Promise((resolve, reject) => {
      const child = spawn(backupScript, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('backup exit '+code)));
    });
  } catch (e) {
    console.error('backup error:', e && e.message || e);
    process.exitCode = 1;
  }
}

run();
