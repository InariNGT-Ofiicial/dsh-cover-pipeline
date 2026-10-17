/**
 * 配置：内置默认值 + 自动发现 + 合并/归一化。
 *
 * 设计原则：
 *   1. 不再引用任何旧歌工程的 `_probe` / `pipeline` 路径。
 *   2. 核心脚本全部在 `runtime/`：5 个 adapter + shift + mix_master + verify_mix。
 *   3. 路径默认留空，安装后按 songRoot 自动发现；`cover.local.json` 可覆盖。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDir = fileURLToPath(new URL('../runtime/', import.meta.url))
  .replace(/\\/g, '/')
  .replace(/\/+$/, '');

export const runtimePath = name => `${runtimeDir}/${name}`;
export const runtimeRoot = runtimeDir;

const repoPath = rel => fileURLToPath(new URL('../' + rel, import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
export const repoRoot = repoPath('.');
export const BUNDLED = {
  materials: repoPath('materials'),
};
export const LOCAL_CONFIG = repoPath('cover.local.json');

/** 机器相关的默认值。空字符串 = 交给自动发现。 */
export const DEFAULTS = {
  songRoot: '',
  pipelineRoot: '',
  probeDir: '',
  mixDir: '',

  msstDir: '',
  msstEnv: '',
  ddspDir: '',
  ddspEnv: '',

  ffmpeg: '',
  voiceModel: '',
  voiceLibDir: '',

  targetLufs: -14.0,
  timeoutMs: 3_600_000,
  maxOutputChars: 6000,
};

/** MSST 分离用到的权重（相对 msstDir） */
export const MSST_ASSETS = {
  vocalModel: 'pretrain/MelBandRoformer_kim.ckpt',
  vocalConfig: 'configs/config_vocals_mel_band_roformer_kim.yaml',
  karaModel: 'pretrain/bs_roformer_karaoke_frazer_becruily.ckpt',
  karaConfig: 'configs/config_karaoke_frazer_becruily.yaml',
};

/** DDSP 侧的预训练件（相对 ddspDir） */
export const DDSP_ASSETS = {
  hifigan: 'pretrain/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02/model.ckpt',
  contentvec: 'pretrain/contentvec/checkpoint_best_legacy_500.pt',
};

/** 混音/验收实现（都在 runtime/） */
export const MIX_SCRIPTS = {
  mix: 'mix_master.py',
  verify: 'verify_mix.py',
};

const PATH_KEYS = [
  'songRoot', 'pipelineRoot', 'probeDir', 'mixDir',
  'msstDir', 'msstEnv', 'ddspDir', 'ddspEnv',
  'ffmpeg', 'voiceModel', 'voiceLibDir',
];

export function toPosixPath(p) {
  if (typeof p !== 'string' || p === '') return p;
  const s = p.replace(/\\/g, '/');
  return isAbsolute(s) ? s : resolve(s).replace(/\\/g, '/');
}

export function join(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p, i) => (i === 0 ? String(p).replace(/\/+$/, '') : String(p).replace(/^\/+|\/+$/g, '')))
    .join('/');
}

const isFile = (p) => { try { return !!p && existsSync(p) && statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return !!p && existsSync(p) && statSync(p).isDirectory(); } catch { return false; } };
const hasFile = (dir, name) => isFile(join(dir, name));

function children(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name));
  } catch { return []; }
}

function filesOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch { return []; }
}

export function loadLocalConfig() {
  try {
    if (!isFile(LOCAL_CONFIG)) return {};
    const o = JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

function pickSongRoot(cfg) {
  const candidates = [
    cfg.songRoot,
    process.env.DSH_COVER_ROOT,
    'D:/AI-Song',
    'C:/AudioWork',
    process.cwd(),
  ].filter(Boolean);
  const seen = new Set();
  for (const c of candidates) {
    const p = toPosixPath(c);
    if (seen.has(p)) continue;
    seen.add(p);
    if (!isDir(p)) continue;
    const kids = children(p).map((d) => basename(d));
    if (kids.some((n) => /^0[123][_-]/.test(n))) return p;
  }
  return cfg.songRoot || 'D:/AI-Song';
}

function childByPrefix(root, re) {
  return children(root).find((d) => re.test(basename(d))) || '';
}

function findDdsp(root) {
  const parent = childByPrefix(root, /^02[_-]/);
  const pools = parent ? [parent, ...children(parent)] : [root, ...children(root)];
  for (const p of pools) if (hasFile(p, 'batch_infer.py')) return p;
  if (parent) {
    for (const p of children(parent)) {
      const hit = children(p).find((d) => hasFile(d, 'batch_infer.py'));
      if (hit) return hit;
    }
  }
  return '';
}

function pickPython(dir) {
  for (const rel of ['env/python.exe', 'env/Scripts/python.exe', 'python.exe', 'Scripts/python.exe']) {
    if (hasFile(dir, rel)) return join(dir, rel);
  }
  return '';
}

/** 扫描音色库，返回 [{name, dir, exp, model, config, steps}]，按步数降序。 */
export function listVoices(cfg) {
  const libs = [];
  if (isDir(cfg.voiceLibDir)) libs.push(cfg.voiceLibDir);
  if (cfg.songRoot) {
    for (const d of children(cfg.songRoot)) {
      if (/^03[_-]/.test(basename(d)) && !libs.includes(d)) libs.push(d);
    }
  }
  const out = [];
  const seen = new Set();
  for (const lib of libs) {
    for (const vd of children(lib)) {
      const name = basename(vd).split('_')[0] || basename(vd);
      for (const exp of children(vd)) {
        if (!/^exp/i.test(basename(exp))) continue;
        const rt = children(exp).find((d) => /reflow/i.test(basename(d))) || exp;
        for (const f of filesOf(rt)) {
          const m = /^model_(\d+)\.pt$/.exec(f);
          if (!m || Number(m[1]) <= 0) continue;
          const model = join(rt, f);
          if (seen.has(model)) continue;
          seen.add(model);
          out.push({
            name, dir: vd, exp: rt, model,
            config: join(rt, 'config.yaml'),
            steps: Number(m[1]),
          });
        }
      }
    }
  }
  return out.sort((a, b) => b.steps - a.steps || a.name.localeCompare(b.name));
}

const normVoice = (s) => String(s ?? '').toLowerCase().replace(/_步数\d+/g, '').replace(/[_\s-]/g, '');

export function findVoice(cfg, query) {
  // cfg.voices 是启动时快照；材料在启动后才解压时为空，故空则现扫一次。
  const vs = Array.isArray(cfg.voices) && cfg.voices.length ? cfg.voices : listVoices(cfg);
  const q = normVoice(query);
  if (!q) return null;
  const exact = vs.filter((v) => normVoice(v.name) === q);
  if (exact.length) return exact[0];
  const part = vs.filter((v) => normVoice(v.name).includes(q) || q.includes(normVoice(v.name)));
  return part[0] ?? null;
}

function discover(cfg) {
  const out = {};
  const root = pickSongRoot(cfg);
  if (!isDir(cfg.songRoot) || cfg.songRoot !== root) out.songRoot = root;

  if (!hasFile(cfg.msstDir, 'inference.py')) {
    const d = childByPrefix(root, /^01[_-]/) || children(root).find((p) => hasFile(p, 'inference.py'));
    if (d) out.msstDir = d;
  }
  if (!hasFile(cfg.ddspDir, 'batch_infer.py')) {
    const d = findDdsp(root);
    if (d) out.ddspDir = d;
  }
  const msst = out.msstDir || cfg.msstDir;
  const ddsp = out.ddspDir || cfg.ddspDir;
  if (!isFile(cfg.msstEnv)) {
    const p = pickPython(msst);
    if (p) out.msstEnv = p;
  }
  if (!isFile(cfg.ddspEnv)) {
    const p = pickPython(ddsp);
    if (p) out.ddspEnv = p;
  }

  // 干净工程目录：不再指向任何旧歌的 _probe / _pipeline_bqll
  if (!isDir(cfg.probeDir)) out.probeDir = join(root, 'cover_runs');
  if (!isDir(cfg.mixDir)) out.mixDir = join(root, 'cover_runs');
  if (!cfg.pipelineRoot) out.pipelineRoot = join(root, 'cover_runs');

  if (!isDir(cfg.voiceLibDir)) {
    const lib = childByPrefix(root, /^03[_-]/);
    if (lib) out.voiceLibDir = lib;
  }
  if (!isFile(cfg.voiceModel)) {
    const vs = listVoices({ ...cfg, ...out });
    const pick = vs.find((v) => v.name.includes('祥子')) || vs[0];
    if (pick) out.voiceModel = pick.model;
  }
  if (!isFile(cfg.ffmpeg)) {
    const p = join(msst, 'env/ffmpeg.exe');
    if (isFile(p)) out.ffmpeg = p;
  }
  return out;
}

export function resolveConfig(raw) {
  const local = loadLocalConfig();
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}), ...local };
  for (const k of PATH_KEYS) {
    if (typeof cfg[k] === 'string') cfg[k] = toPosixPath(cfg[k]);
  }
  Object.assign(cfg, discover(cfg));
  for (const k of PATH_KEYS) {
    if (typeof cfg[k] === 'string') cfg[k] = toPosixPath(cfg[k]);
  }
  for (const k of ['targetLufs']) {
    const n = Number(cfg[k]);
    if (Number.isFinite(n)) cfg[k] = n;
  }
  for (const k of ['timeoutMs', 'maxOutputChars']) {
    const n = Number(cfg[k]);
    if (Number.isFinite(n) && n > 0) cfg[k] = Math.floor(n);
  }
  // 工程目录按需创建；否则第一次 cover_mix 会因 cwd 不存在而 spawn 失败。
  for (const k of ['probeDir', 'mixDir']) {
    try { if (cfg[k]) mkdirSync(cfg[k], { recursive: true }); } catch { /* 只读位置时由 doctor 报错 */ }
  }
  cfg.runtimeDir = runtimeDir;
  cfg.voices = listVoices(cfg);
  return Object.freeze(cfg);
}

/** 混音/验收脚本的绝对路径 */
export function mixScriptPath(cfg, key) {
  const name = MIX_SCRIPTS[key];
  if (!name) throw new Error(`未知混音脚本键: ${key}`);
  return `${runtimeDir}/${name}`;
}

/** 演示资产（来自 materials/manifest.json 的 demo 段） */
export function demoAsset() {
  try {
    const m = JSON.parse(readFileSync(join(BUNDLED.materials, 'manifest.json'), 'utf8'));
    return m && typeof m.demo === 'object' ? m.demo : null;
  } catch { return null; }
}

/** 核心脚本是否齐全：5 adapter + shift + mix_master + verify_mix。 */
export function bundledScripts() {
  const list = [
    ...['convert.py', 'long_audio.py', 'guided_core.py', 'mix.py', 'validate_model.py']
      .map((f) => ({ kind: 'runtime', file: f, path: runtimePath(f) })),
    { kind: 'runtime', file: 'shift.py', path: runtimePath('shift.py') },
    ...Object.entries(MIX_SCRIPTS).map(([, f]) => ({ kind: 'mix', file: f, path: join(runtimeDir, f) })),
  ];
  return list.map((x) => ({ ...x, ok: isFile(x.path) }));
}
