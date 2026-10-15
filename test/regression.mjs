// Zero GPU: real builders/executor + deterministic subprocess mocks. NOT audio inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveConfig } from '../src/config.js';
import { STAGES } from '../src/stages.js';
import { runStage, runSeparation, wavInfo } from '../src/execution.js';
import { apply } from '../src/index.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cover-regression-'));
const file = (...x) => path.join(root, ...x);
function wav(p, duration = 1) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const data = Buffer.alloc(Math.round(duration * 44100) * 2), h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(data.length + 36, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(44100, 24); h.writeUInt32LE(88200, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40); fs.writeFileSync(p, Buffer.concat([h, data]));
}
wav(file('input', 'new-song.wav')); fs.writeFileSync(file('model.pt'), 'test-model'); fs.writeFileSync(file('config.yaml'), 'test: true');
const cfg = resolveConfig({ voiceModel: file('model.pt'), targetLufs: -19 });
const ok = { ok: true, code: 0, timedOut: false, ms: 1, stdout: '', stderr: '', cmdline: 'MOCK process' };
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const noOutput = async () => ok;
const flag = (args, name) => args[args.indexOf(name) + 1];
const results = [];
async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch(e) { results.push({ name, ok: false, error: e.stack }); } }

await test('karaoke stages ONLY vocals and checks both nested stems', async () => {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    const inp = flag(args, '--input_folder'), out = flag(args, '--store_dir');
    const files = fs.readdirSync(inp);
    assert.deepEqual(files, ['new-song.wav']);
    const kara = flag(args, '--model_type') === 'bs_roformer';
    if (kara) assert.equal(sha(path.join(inp, files[0])), sha(file('separation', 'new-song', 'vocals.wav')));
    wav(path.join(out, 'new-song', kara ? 'Vocals.wav' : 'vocals.wav'));
    wav(path.join(out, 'new-song', 'instrumental.wav'));
    return ok;
  };
  const r = await runSeparation(cfg, { inputFolder: file('input'), outDir: file('separation') }, { run });
  assert.equal(calls.length, 2); assert.equal(r.ok, true); assert.equal(r.karaokeResult.artifacts.length, 2);
});
await test('empty source directory fails before subprocess', async () => {
  fs.mkdirSync(file('empty'));
  const r = await runSeparation(cfg, { inputFolder: file('empty'), outDir: file('empty-out') }, { run: () => assert.fail('must not run') });
  assert.equal(r.ok, false);
});
await test('exit zero without stems fails; no karaoke launch', async () => {
  let count = 0;
  const r = await runSeparation(cfg, { inputFolder: file('input'), outDir: file('missing') }, { run: async () => { count++; return ok; } });
  assert.equal(count, 1); assert.equal(r.ok, false); assert.equal(r.artifactsOk, false);
});
await test('existing expected output rejected before launch', async () => {
  const r = await runSeparation(cfg, { inputFolder: file('input'), outDir: file('separation') }, { run: () => assert.fail('must not run') });
  assert.equal(r.phase, 'precondition'); assert.match(r.error, /already exists/);
});
await test('wrong-key stale output cannot satisfy key zero', async () => {
  wav(file('stale', 'lead_pilot_k+12.wav'));
  const r = await runStage(cfg, 'convert', { src: file('input/new-song.wav'), key: 0, outDir: file('stale') }, { run: noOutput });
  assert.equal(r.ok, false); assert.equal(r.artifactsOk, false);
});
await test('matching name but invalid WAV fails', async () => {
  const args = { src: file('input/new-song.wav'), key: 0, outDir: file('invalid') };
  const r = await runStage(cfg, 'convert', args, { run: async () => { fs.writeFileSync(STAGES.convert(cfg,args).expects[0], Buffer.alloc(2048)); return ok; } });
  assert.equal(r.ok, false); assert.match(r.error, /RIFF/);
});
await test('pilot validates empty/out of bounds window before launch', async () => {
  const r = await runStage(cfg, 'convert', { src: file('input/new-song.wav'), start: 1, duration: 25, key: 0, outDir: file('outside') }, { run: () => assert.fail() });
  assert.equal(r.phase, 'precondition'); assert.match(r.error, /outside/);
});
await test('pilot/full share key/backend and explicit effective model/config', () => {
  for (const mode of ['pilot', 'full']) {
    const s = STAGES.convert(cfg, { mode, key: 0, src: file('input/new-song.wav'), outDir: file('args') });
    assert.equal(flag(s.args, '--model'), cfg.voiceModel); assert.equal(flag(s.args, '--key'), '0'); assert.equal(flag(s.args, '--backend'), 'baseline');
    assert.equal(flag(s.args, '--mode'), mode); assert.equal(flag(s.args, '--duration'), '25'); assert.ok(!s.args.join(' ').includes('p51'));
  }
  assert.equal(flag(STAGES.mix(cfg, { out:'new.wav', inst:'i',lead:'l',harm:'h' }).args, '--target'), '-19');
  assert.equal(flag(STAGES.verify(cfg, { wav:'x.wav' }).args, '--target-lufs'), '-19');
});
await test('valid conversion verifies source/model provenance and duration', async () => {
  const a = { src: file('input/new-song.wav'), key: 0, outDir: file('valid') };
  const s = STAGES.convert(cfg,a);
  const r = await runStage(cfg, 'convert', a, { run: async () => {
    wav(s.expects[0]); fs.writeFileSync(s.expects[1], JSON.stringify({ effective:{key:0}, modelSha256:sha(cfg.voiceModel),sourceSha256:sha(a.src) })); return ok;
  } });
  assert.equal(r.ok, true); assert.ok(fs.existsSync(r.manifestPath));
});
await test('verify WARN/pass=false is not successful', async () => {
  const a = { wav:file('input/new-song.wav'),json:file('warn.json') };
  const r = await runStage(cfg,'verify',a,{run:async()=>{fs.writeFileSync(a.json,JSON.stringify({checks:[{pass:true},{pass:false}]}));return {...ok,stdout:'[PASS]\n[WARN]'};}});
  assert.equal(r.artifactsOk,true);assert.equal(r.technicalChecksPassed,false);assert.equal(r.ok,false);
});
await test('verify all true is technical success, not listening approval', async () => {
  const a = {wav:file('input/new-song.wav'),json:file('pass.json')};
  const r=await runStage(cfg,'verify',a,{run:async()=>{fs.writeFileSync(a.json,JSON.stringify({checks:[{pass:true}]}));return ok;}});
  assert.equal(r.ok,true);assert.equal(JSON.parse(fs.readFileSync(r.manifestPath)).listeningAccepted,false);
});
await test('plugin schemas expose new routing controls and strict harmonic input', async () => {
  const registry=new Map();await apply({logger:{info(){},warn(){}},get:()=>({register:d=>registry.set(d.name,d)})},cfg);
  for(const field of ['backend','start','duration','step','method','tStart'])assert.ok(registry.get('cover_convert').parameters.properties[field]);
  assert.ok(registry.get('cover_shift').parameters.required.includes('harmSrc'));
  const schema=registry.get('cover_convert').output.schema;
  for(const key of ['artifactsOk','technicalChecksPassed','manifestPath'])assert.ok(schema.properties[key]);
});
console.log(JSON.stringify({scope:'CPU mocks only; no inference/no listening test',root,passed:results.filter(x=>x.ok).length,total:results.length,results},null,2));
process.exitCode=results.some(x=>!x.ok)?1:0;
