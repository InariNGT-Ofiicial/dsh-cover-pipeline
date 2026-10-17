#!/usr/bin/env node
/**
 * 材料校验：随包脚本 + 目录 + 权重 + 选中音色的 sha256。
 *
 * 用法：
 *   node scripts/verify-materials.mjs [--root D:/AI-Song] [--voice 祥子]
 *        [--json out.json] [--write-config] [--hash-all]
 *
 * 退出码：0 全齐 / 1 有缺失 / 2 参数错误。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as pjoin } from 'node:path';

import {
  resolveConfig, findVoice, bundledScripts, repoRoot, LOCAL_CONFIG,
} from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = pjoin(here, '..', 'materials', 'manifest.json');

function parseArgs(argv) {
  const out = { root: '', voice: '', json: '', writeConfig: false, hashAll: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i] ?? '';
    else if (a === '--voice') out.voice = argv[++i] ?? '';
    else if (a === '--json') out.json = argv[++i] ?? '';
    else if (a === '--write-config') out.writeConfig = true;
    else if (a === '--hash-all') out.hashAll = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`未知参数: ${a}`); process.exit(2); }
  }
  return out;
}

const sha256 = (file) => new Promise((resolvePromise, reject) => {
  const h = createHash('sha256');
  createReadStream(file)
    .on('data', (d) => h.update(d))
    .on('error', reject)
    .on('end', () => resolvePromise(h.digest('hex')));
});

const bytes = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/verify-materials.mjs [--root D:/AI-Song] [--voice 祥子] [--json out.json] [--write-config] [--hash-all]');
    return 0;
  }

  let manifest = { voiceModels: [], pretrains: [] };
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (e) { console.error(`[warn] 读不到 ${manifestPath}: ${e.message}`); }

  const cfg = resolveConfig(args.root ? { songRoot: args.root } : {});
  const scripts = bundledScripts();
  const voices = cfg.voices;
  const picked = args.voice ? findVoice(cfg, args.voice) : (voices.find((v) => v.model === cfg.voiceModel) ?? null);

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const badScripts = scripts.filter((s) => !s.ok);
  add(`随包流水线脚本 ${scripts.length - badScripts.length}/${scripts.length}`, badScripts.length === 0,
    badScripts.length ? `缺: ${badScripts.map((s) => `${s.kind}/${s.file}`).join(', ')}` : 'runtime/ + pipeline/ 齐全');

  for (const [label, p] of [
    ['MSST 目录', cfg.msstDir],
    ['DDSP 目录', cfg.ddspDir],
    ['MSST python', cfg.msstEnv],
    ['DDSP python', cfg.ddspEnv],
  ]) add(label, !!p && existsSync(p), p || '(未发现)');

  for (const item of manifest.pretrains ?? []) {
    const p = pjoin(cfg.songRoot, item.target);
    const ok = existsSync(p);
    add(item.name, ok, ok ? `${bytes(statSync(p).size)}  ${p}` : `缺: ${p}`);
  }

  if (picked) {
    const meta = (manifest.voiceModels ?? []).find((v) => v.name === picked.name);
    const sizeOk = existsSync(picked.model)
      && (!meta || statSync(picked.model).size === meta.sizeBytes);
    let hash = '';
    if (existsSync(picked.model)) hash = await sha256(picked.model);
    const hashOk = !meta || hash === meta.sha256;
    add(`音色 ${picked.name}(${picked.steps}步)`, sizeOk && hashOk,
      `${sizeOk ? '大小 OK' : '大小不符'}  sha256 ${hash.slice(0, 16)}…  ${picked.model}`);
    if (!hashOk) add(`音色 ${picked.name} 哈希`, false, `清单 ${meta.sha256}，实际 ${hash}`);
  } else {
    add('默认音色', false, args.voice ? `音色库没有 "${args.voice}"` : '未发现任何音色模型');
  }

  const ok = checks.every((c) => c.ok);
  const lines = [
    `【材料校验】根目录: ${cfg.songRoot || '(未发现)'}`,
    `随包脚本: ${scripts.filter((s) => s.ok).length}/${scripts.length}`,
    `音色库: ${voices.length} 个${voices.length ? ' — ' + voices.map((v) => `${v.name}(${v.steps}步)`).join(' / ') : ''}`,
    '',
    ...checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name} — ${c.detail}`),
    '',
    ok ? '✅ 材料齐全，可以开跑。' : '❌ 还有缺失；下载入口见 materials/README.md。',
  ];

  let wrote = '';
  if (args.writeConfig) {
    const local = {};
    for (const k of ['songRoot', 'pipelineRoot', 'probeDir', 'mixDir', 'msstDir', 'msstEnv',
      'ddspDir', 'ddspEnv', 'ffmpeg', 'voiceLibDir', 'voiceModel', 'qualityLibDir',
      'scriptsDir', 'mixScriptDir']) local[k] = cfg[k] ?? '';
    if (picked) local.voiceModel = picked.model;
    writeFileSync(LOCAL_CONFIG, JSON.stringify(local, null, 2), 'utf8');
    wrote = LOCAL_CONFIG;
    lines.push('', `已写入: ${wrote}`, '★ 重启 DSH 或重新加载插件后生效。');
  }

  const report = {
    ok, root: cfg.songRoot, voice: picked?.name ?? '', voices: voices.map((v) => ({ name: v.name, steps: v.steps, model: v.model })),
    checks, wrote,
  };
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2), 'utf8');
  console.log(lines.join('\n'));
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[fatal] ${e.stack || e}`);
  process.exit(1);
});
