import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

assert.ok(process.env.npm_execpath, 'Run with npm run test:package');
const [pack] = JSON.parse(execFileSync(process.execPath,
  [process.env.npm_execpath, 'pack', '--dry-run', '--json'], { encoding: 'utf8' }));
const allowed = /^(?:LICENSE|README\.md|package\.json|cordis\.(?:patch|dev)\.yml|src\/[^/]+\.js|runtime\/[^/]+\.py|materials\/[^/]+\.(?:json|md)|docs\/[^/]+\.md|scripts\/[^/]+\.(?:mjs|ps1))$/;
for (const file of pack.files) assert.match(file.path, allowed, `Unexpected package file: ${file.path}`);
for (const path of [
  'src/index.js', 'src/execution.js',
  'runtime/long_audio.py', 'runtime/convert.py', 'runtime/mix.py', 'runtime/guided_core.py', 'runtime/validate_model.py',
  'runtime/shift.py', 'runtime/mix_master.py', 'runtime/verify_mix.py',
  'materials/manifest.json', 'scripts/verify-materials.mjs',
]) {
  assert.ok(pack.files.some(file => file.path === path), `Missing packaged file: ${path}`);
}
console.log(`Package file boundary passed: ${pack.files.length} files; no audio, weights, logs or caches.`);
