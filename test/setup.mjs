/**
 * cover_setup / 音色解析的契约测试。
 * 本机没有材料时自动跳过（CI 不依赖任何模型）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../src/index.js';
import { resolveConfig, findVoice, bundledScripts } from '../src/config.js';

const cfg = resolveConfig({});
const scripts = bundledScripts();
assert.equal(scripts.length, 15);
assert.ok(scripts.every((s) => s.ok), '15 bundled scripts must exist');

const registry = new Map();
await apply({
  logger: { info() {}, warn() {} },
  get: () => ({ register: (d) => registry.set(d.name, d) }),
}, cfg);

assert.ok(registry.has('cover_setup'));
const setup = await registry.get('cover_setup').execute({});
assert.equal(typeof setup.rendered, 'string');
assert.match(setup.rendered, /随包脚本: 15\/15/);
assert.match(setup.rendered, /演示资产: 祥子/);
assert.match(setup.rendered, /pan\.baidu\.com/);
assert.equal(setup.voices.length, cfg.voices.length);

if (!cfg.voices.length) {
  console.log(JSON.stringify({ passed: 3, total: 3, skipped: 'no local voice models' }));
  process.exit(0);
}

const voice = cfg.voices.find((v) => v.name.includes('祥子')) ?? cfg.voices[0];
assert.ok(findVoice(cfg, voice.name), 'voice lookup by name');
assert.equal(findVoice(cfg, '不存在的音色'), null);

// 造一个 0.2 s 的 44.1 kHz 单声道 WAV，用于 dry-run 的时长校验
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-setup-'));
const wav = path.join(dir, 'src.wav');
const frames = 8820;
const buf = Buffer.alloc(44 + frames * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22); buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(88200, 28);
buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
buf.writeUInt32LE(frames * 2, 40);
fs.writeFileSync(wav, buf);

const out = path.join(dir, 'conv');
const res = await registry.get('cover_convert').execute({
  src: wav, key: 0, outDir: out, voice: voice.name, mode: 'pilot', dryRun: true,
});
assert.equal(res.ok, true, res.error);
assert.match(res.cmdline, new RegExp(voice.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(res.cmdline, /--duration 25/);

console.log(JSON.stringify({ passed: 8, total: 8, voice: voice.name }));
