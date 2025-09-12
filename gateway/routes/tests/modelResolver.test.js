import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveModelPath } from '../modelResolver.js';

describe('modelResolver.resolveModelPath', () => {
  it('throws if arg is missing', () => {
    expect(() => resolveModelPath()).toThrow();
  });

  it('returns direct path for absolute .gguf files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-'));
    const p = path.join(dir, 'mini.gguf');
    // Write minimal GGUF header magic so resolver accepts it
    fs.writeFileSync(p, 'GGUFv3');
    const out = resolveModelPath(p);
    expect(out).toBeTruthy();
    expect(out.path).toBe(p);
    expect(out.source).toBe('direct');
  });
});
