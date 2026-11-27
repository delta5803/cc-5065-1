#!/usr/bin/env node
// Runs the sampling-probability evidence in a CLEAN directory.
//
//   node tools/run_clean.js
//
// It copies the kernel + tools into a fresh temp directory (no node_modules, no
// stale artifacts, no hand-edited data files) and runs the headless checks
// there. The point is that the estimate/weight-sum evidence must come from the
// code alone: nothing in the checks reads a precomputed table or a file the
// operator could have edited. If a check is not reproducible from a pristine
// copy, this runner fails.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function copyInto(dst) {
  // Only source and tools; no data files. The checks generate their own inputs.
  fs.cpSync(path.join(root, 'src'), path.join(dst, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'tools'), { recursive: true });
  for (const f of ['validate.js', 'test_probability.js', 'test_jacobian.js', 'test_brdf.js', 'test_freeze.js']) {
    fs.copyFileSync(path.join(root, 'tools', f), path.join(dst, 'tools', f));
  }
}

function run(dir, script) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, 'tools', script)], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  const tail = (r.stdout || '').trim().split('\n').slice(-4).join('\n  ');
  console.log(`\n=== ${script} (clean) ${ok ? 'PASS' : 'FAIL'} in ${ms} ms ===`);
  if (tail) console.log('  ' + tail);
  if (!ok) {
    console.error(r.stderr || r.stdout);
  }
  return ok;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mis-clean-'));
try {
  console.log('clean directory:', tmp);
  copyInto(tmp);
  // Guard: the checks must not depend on any data file existing.
  const dataFiles = fs.readdirSync(tmp).filter(f => /\.(json|csv|dat|txt)$/i.test(f));
  if (dataFiles.length) {
    console.error('clean directory unexpectedly contains data files:', dataFiles);
    process.exit(1);
  }
  let allOk = true;
  for (const script of ['test_jacobian.js', 'test_brdf.js', 'test_freeze.js', 'test_probability.js', 'validate.js']) {
    allOk = run(tmp, script) && allOk;
  }
  console.log(`\n${allOk ? 'CLEAN RUN OK' : 'CLEAN RUN FAILED'}`);
  process.exit(allOk ? 0 : 1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
