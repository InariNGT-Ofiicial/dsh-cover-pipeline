import { existsSync, readdirSync, statSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { run } from './runner.js';
import { STAGES } from './stages.js';

export function wavInfo(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`Not a RIFF WAV: ${file}`);
  let fmt, data;
  for (let p = 12; p + 8 <= b.length;) {
    const size = b.readUInt32LE(p + 4), tag = b.toString('ascii', p, p + 4);
    if (p + 8 + size > b.length) throw new Error(`Truncated WAV chunk: ${file}`);
    if (tag === 'fmt ' && size >= 16) fmt = { channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), align: b.readUInt16LE(p + 20) };
    if (tag === 'data') data = size;
    p += 8 + size + (size % 2);
  }
  if (!fmt?.rate || !fmt.align || !fmt.channels || !data || data % fmt.align) throw new Error(`Empty or invalid WAV: ${file}`);
  return { ...fmt, frames: data / fmt.align, duration: data / fmt.align / fmt.rate };
}

export function inputsIn(folder) {
  const files = readdirSync(folder, { withFileTypes: true }).filter(f => f.isFile() && /\.(wav|mp3|flac)$/i.test(f.name)).map(f => resolve(folder, f.name));
  if (!files.length) throw new Error('Input directory contains no WAV/MP3/FLAC files');
  const stems = files.map(f => basename(f, extname(f)).toLowerCase());
  if (new Set(stems).size !== stems.length) throw new Error('Input basenames collide; use unique song names');
  return files;
}

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const failure = (label, error, phase = 'precondition') => ({ ok: false, phase, label, error: String(error?.message ?? error), cmdline: '', artifacts: [], artifactsOk: false });

function processFailure(r) {
  if (r.timedOut) return 'Subprocess timed out';
  const lines = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const oom = lines.find(s => /(?:CUDA|GPU|Accelerator).*out of memory|OutOfMemoryError/i.test(s));
  const cause = oom ?? [...lines].reverse().find(s => /(?:Error|Exception):|: error:|\[spawn error\]/.test(s));
  return `Subprocess failed (exit ${r.code ?? 'unknown'}${r.signal ? `, signal ${r.signal}` : ''})${cause ? ': ' + cause.slice(0, 1800) : ''}`;
}

export async function runStage(cfg, key, args, opts = {}) {
  let spec, expected, inputs;
  try {
    spec = STAGES[key](cfg, args);
    if (['shift', 'cut', 'release', 'qcCrack', 'qcConv', 'qcSection', 'qcBright', 'qcSource'].includes(key)
        && !existsSync(spec.args[0])) throw new Error(`Missing optional/conditional tool script: ${spec.args[0]}`);
    inputs = opts.requires ?? [];
    const missing = inputs.filter(p => !p || !existsSync(p));
    if (missing.length) throw new Error(`Missing required inputs: ${missing.join(', ')}`);
    expected = [...(spec.expects ?? [])];
    if (key === 'separate' || key === 'karaoke') {
      const sources = args.sources ?? inputsIn(args.inputFolder);
      expected = sources.flatMap(f => [resolve(args.outDir, basename(f, extname(f)), key === 'karaoke' ? 'Vocals.wav' : 'vocals.wav'), resolve(args.outDir, basename(f, extname(f)), 'instrumental.wav')]);
    }
    if (['separate', 'karaoke', 'convert'].includes(key) && !expected.length) throw new Error('Stage has no explicit expected outputs');
    if (key === 'convert') {
      const model = args.model ?? cfg.voiceModel;
      if (!model || !existsSync(model) || !existsSync(resolve(dirname(model), 'config.yaml'))) throw new Error('Effective model and sibling config.yaml must exist');
      const info = wavInfo(args.src);
      if (!Number.isInteger(args.key)) throw new Error('key must be an integer semitone');
      if (!['pilot', 'full'].includes(args.mode ?? 'pilot')) throw new Error('Invalid conversion mode');
      const start = args.start ?? 0, duration = args.duration ?? 25;
      if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0 || start >= info.duration) throw new Error('Pilot selection is empty/outside input');
      if ((args.mode ?? 'pilot') === 'full' && start !== 0) throw new Error('full mode must start at zero');
    }
    // Never overwrite or accept a previous run as the result of this invocation.
    const existing = expected.filter(existsSync);
    if (existing.length) throw new Error(`Output already exists; choose a fresh run path: ${existing.join(', ')}`);
    if (args.dryRun === true) return { ok: true, phase: 'dry-run', label: spec.label, cmdline: [spec.cmd, ...spec.args].map(x => /\s/.test(x) ? JSON.stringify(x) : x).join(' '), cwd: spec.cwd, expects: expected, artifacts: [], artifactsOk: false };
  } catch (e) { return failure(spec?.label ?? key, e); }

  const started = Date.now(), runId = randomUUID();
  const lock = expected.length ? expected[0] + '.cover-lock' : null;
  if (lock) {
    try { mkdirSync(dirname(lock), { recursive: true }); writeFileSync(lock, runId, { flag: 'wx' }); }
    catch (e) { return failure(spec.label, `Output is locked or inaccessible: ${e.message}`); }
  }
  let r;
  try { r = await (opts.run ?? run)(spec.cmd, spec.args, { cwd: spec.cwd, timeoutMs: args.timeoutMs ?? cfg.timeoutMs, maxOutputChars: cfg.maxOutputChars }); }
  catch (e) { if (lock) unlinkSync(lock); return failure(spec.label, e, 'executed'); }
  let artifacts = [], artifactsOk = false, technicalChecksPassed, error;
  try {
    artifacts = expected.map(p => {
      if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`Missing output: ${p}`);
      const st = statSync(p);
      if (st.size === 0 || st.mtimeMs < started - 2000) throw new Error(`Empty/stale output: ${p}`);
      if (/\.wav$/i.test(p)) wavInfo(p);
      return { path: p, exists: true, sizeBytes: st.size };
    });
    if (key === 'convert') {
      const input = wavInfo(args.src), output = wavInfo(expected[0]);
      const wanted = (args.mode ?? 'pilot') === 'full' ? input.duration : Math.min(args.duration ?? 25, input.duration - (args.start ?? 0));
      if (Math.abs(output.duration - wanted) > 0.03) throw new Error(`Wrong output duration: ${output.duration}, expected ${wanted}`);
      const provenance = JSON.parse(readFileSync(expected[1], 'utf8'));
      if (provenance.effective?.key !== args.key || provenance.modelSha256 !== hash(args.model ?? cfg.voiceModel) || provenance.sourceSha256 !== hash(args.src)) throw new Error('Conversion provenance mismatch');
    }
    if (key === 'verify') {
      const report = JSON.parse(readFileSync(expected[0], 'utf8'));
      if (!Array.isArray(report.checks) || !report.checks.length || report.checks.some(c => typeof c.pass !== 'boolean')) throw new Error('Invalid verification JSON');
      technicalChecksPassed = report.checks.every(c => c.pass);
      if (!technicalChecksPassed) error = 'Technical checks contain WARN/fail; this is not a listening verdict';
    }
    artifactsOk = true;
  } catch (e) { error = e.message; }
  if (!r.ok) error = `${processFailure(r)}${error ? '; artifact validation: ' + error : ''}`;
  const result = { ok: r.ok && artifactsOk && technicalChecksPassed !== false, phase: 'executed', label: spec.label, cmdline: r.cmdline, cwd: spec.cwd, exitCode: r.code ?? -1, timedOut: r.timedOut, ms: r.ms, artifacts, artifactsOk, stdout: r.stdout, stderr: r.stderr };
  if (technicalChecksPassed !== undefined) result.technicalChecksPassed = technicalChecksPassed;
  if (error) result.error = error;
  // Each output-bearing stage gets an immutable, uniquely named provenance record.
  if (expected.length) {
    try {
      const dir = dirname(expected[0]); mkdirSync(dir, { recursive: true });
      const manifestPath = resolve(dir, `${key}-${runId}.manifest.json`);
      const files = paths => paths.filter(p => p && existsSync(p) && statSync(p).isFile()).map(p => ({ path: p, sha256: hash(p) }));
      const scripts = [spec.args[0], resolve(spec.cwd, spec.args[0])];
      const model = key === 'convert' ? (args.model ?? cfg.voiceModel) : null;
      writeFileSync(manifestPath, JSON.stringify({ runId, started, stage: key, args, effectiveConfig: { voiceModel: cfg.voiceModel, targetLufs: cfg.targetLufs }, command: spec, inputs: files(inputs), outputs: files(expected), scripts: files(scripts), model: files(model ? [model, resolve(dirname(model), 'config.yaml')] : []), result, listeningAccepted: false }, null, 2), { flag: 'wx' });
      result.manifestPath = manifestPath;
    } catch (e) { result.ok = false; result.error = `Provenance write failed: ${e.message}`; }
  }
  if (lock) unlinkSync(lock);
  return result;
}

export async function runSeparation(cfg, args, opts = {}) {
  let sources;
  try { sources = inputsIn(args.inputFolder); } catch (e) { return failure('S1/S2', e); }
  const first = await runStage(cfg, 'separate', { ...args, sources }, { ...opts, requires: sources });
  if (!first.ok || args.karaoke === false) return first;
  const stageDir = resolve(args.outDir, `.kara-input-${randomUUID()}`);
  const staged = sources.map(f => resolve(stageDir, basename(f, extname(f)) + '.wav'));
  if (!args.dryRun) {
    mkdirSync(stageDir, { recursive: true });
    sources.forEach((f, i) => copyFileSync(resolve(args.outDir, basename(f, extname(f)), 'vocals.wav'), staged[i]));
  }
  const kara = await runStage(cfg, 'karaoke', { inputFolder: stageDir, sources: staged, outDir: resolve(args.outDir, 'kara'), dryRun: args.dryRun, timeoutMs: args.timeoutMs }, { ...opts, requires: args.dryRun ? [] : staged });
  return { ...first, ok: first.ok && kara.ok, ...(!kara.ok ? { error: `Secondary separation failed: ${kara.error ?? 'see karaokeResult'}` } : {}), karaokeResult: kara };
}
