/**
 * 配置：内置默认值 + 自动发现 + 合并/归一化。
 *
 * 设计原则：
 *   1. **默认值是空的**，不再把某一台机器的 `D:/AI-Song` 写死。
 *      安装后先按 `songRoot` 自动发现 MSST / DDSP / 音色库；发现不到才要求手配。
 *   2. **随包脚本优先**：`pipeline/probe`（8 个）与 `pipeline/mix`（mix_master/verify）
 *      随仓库分发，`scriptsDir` / `mixScriptDir` 默认就指向它们，用户不必再准备 15 个脚本。
 *   3. 所有路径统一成**正斜杠绝对路径**，避免 Windows 反斜杠在 JSON/日志里的转义问题。
 *   4. 可选 `cover.local.json`（仓库根，git 忽略）作为**本机覆盖层**，优先级最高。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const runtimePath = name => fileURLToPath(new URL('../runtime/' + name, import.meta.url));

const repoPath = rel => fileURLToPath(new URL('../' + rel, import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');

/** 仓库根与随包目录（不依赖用户配置） */
export const repoRoot = repoPath('.');
export const BUNDLED = {
  probe: repoPath('pipeline/probe'),
  mix: repoPath('pipeline/mix'),
  materials: repoPath('materials'),
};
/** 本机覆盖层（由 cover_setup / scripts/verify-materials.mjs 写入） */
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
  qualityLibDir: '',

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

/** 随包的可选/条件脚本（pipeline/probe） */
export const SCRIPTS = {
  shiftUniform: 'p55_shift_uniform.py',
  crackScan: 'p74_scan_crack.py',
  convCheck: 'p87_conv_check.py',
  sectionCentroid: 'p89_section_centroid.py',
  sourceSurvey: 'p91_source_survey.py',
  chorusCut: 'p93_chorus_cut.py',
  brightness: 'p95_brightness.py',
  releaseCut: 'p97_release_cut.py',
};

/** 随包的混音/验收实现（pipeline/mix） */
export const MIX_SCRIPTS = {
  mix: 'mix_master.py',
  verify: 'verify_mix.py',
};

const PATH_KEYS = [
  'songRoot', 'pipelineRoot', 'probeDir', 'mixDir',
  'msstDir', 'msstEnv', 'ddspDir', 'ddspEnv',
  'ffmpeg', 'voiceModel', 'voiceLibDir', 'qualityLibDir',
  'scriptsDir', 'mixScriptDir',
];

/** 统一正斜杠；相对路径按 cwd 解析成绝对路径。 */
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

/** 读取本机覆盖层；坏 JSON 不阻塞启动，按没有处理。 */
export function loadLocalConfig() {
  try {
    if (!isFile(LOCAL_CONFIG)) return {};
    const o = JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

/** 找一个像 AI-Song 根目录的路径（有 01_/02_/03_ 子目录或 pipeline/）。 */
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
    if (kids.some((n) => /^0[123][_-]/.test(n))) {
      return p;
    }
  }
  return cfg.songRoot || 'D:/AI-Song';
}

/** 在 root 下按前缀找目录（01_人声分离_MSST-GUI / 02_模型推理... / 03_音色模型...） */
function childByPrefix(root, re) {
  return children(root).find((d) => re.test(basename(d))) || '';
}

/** 找 DDSP 工程：<02_*>/DDSP-barbara-*，或任意含 batch_infer.py 的两层目录。 */
function findDdsp(root) {
  const parent = childByPrefix(root, /^02[_-]/);
  const pools = parent ? [parent, ...children(parent)] : [root, ...children(root)];
  for (const p of pools) if (hasFile(p, 'batch_infer.py')) return p;
  const two = parent ? children(parent) : [];
  for (const p of two) {
    const hit = children(p).find((d) => hasFile(d, 'batch_infer.py'));
    if (hit) return hit;
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

/** 按名字找音色；支持「祥子」「祥子_步数20000」；同名取步数最高。 */
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

/** 自动发现：只在「配置值不存在」时补，绝不覆盖用户明确配置且有效的路径。 */
function discover(cfg) {
  const out = {};
  const root = pickSongRoot(cfg);
  if (!isDir(cfg.songRoot) || cfg.songRoot !== root) out.songRoot = root;

  // MSST
  if (!hasFile(cfg.msstDir, 'inference.py')) {
    const d = childByPrefix(root, /^01[_-]/) || children(root).find((p) => hasFile(p, 'inference.py'));
    if (d) out.msstDir = d;
  }
  // DDSP
  if (!hasFile(cfg.ddspDir, 'batch_infer.py')) {
    const d = findDdsp(root);
    if (d) out.ddspDir = d;
  }
  // Python 解释器
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
  // probeDir（工程数据目录）
  if (!isDir(cfg.probeDir)) {
    const cands = [join(root, '_pipeline_bqll/_probe'), join(root, '_probe'), join(root, 'pipeline')];
    out.probeDir = cands.find(isDir) || join(root, '_pipeline_bqll/_probe');
  }
  // mixDir：没有用户自己的 mix_master 就用随包实现
  if (!hasFile(cfg.mixDir, MIX_SCRIPTS.mix)) {
    if (hasFile(BUNDLED.mix, MIX_SCRIPTS.mix)) out.mixDir = BUNDLED.mix;
  }
  // 音色库 + 默认音色
  if (!isDir(cfg.voiceLibDir)) {
    const lib = childByPrefix(root, /^03[_-]/);
    if (lib) out.voiceLibDir = lib;
  }
  if (!isFile(cfg.voiceModel)) {
    const vs = listVoices({ ...cfg, ...out });
    const pick = vs.find((v) => v.name.includes('祥子')) || vs[0];
    if (pick) out.voiceModel = pick.model;
  }
  // 音质库
  if (!isDir(cfg.qualityLibDir)) {
    const base = out.probeDir || cfg.probeDir || out.scriptsDir || cfg.scriptsDir;
    const cand = join(base || root, '_sq');
    if (isDir(cand)) out.qualityLibDir = cand;
    else if (base) out.qualityLibDir = cand;
  }
  // ffmpeg（MSST env 里那份完整版）
  if (!isFile(cfg.ffmpeg)) {
    const p = join(msst, 'env/ffmpeg.exe');
    if (isFile(p)) out.ffmpeg = p;
  }
  return out;
}

/**
 * 合并配置并归一化。返回一个**冻结的普通对象**，可直接用。
 * 优先级：DEFAULTS < cordis config < cover.local.json。
 */
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

  // 随包脚本优先：用户没有显式 scriptsDir 时，直接用仓库里的那份。
  if (!isDir(cfg.scriptsDir)) {
    cfg.scriptsDir = hasFile(BUNDLED.probe, SCRIPTS.shiftUniform) ? BUNDLED.probe : cfg.probeDir;
  }
  if (!isDir(cfg.mixScriptDir)) {
    cfg.mixScriptDir = hasFile(BUNDLED.mix, MIX_SCRIPTS.mix) ? BUNDLED.mix : cfg.mixDir;
  }
  if (!cfg.pipelineRoot) cfg.pipelineRoot = join(cfg.songRoot, '_pipeline_bqll');
  cfg.voices = listVoices(cfg);
  return Object.freeze(cfg);
}

/** 把脚本名解析成绝对路径（随包目录） */
export function scriptPath(cfg, key) {
  const name = SCRIPTS[key];
  if (!name) throw new Error(`未知脚本键: ${key}`);
  return `${cfg.scriptsDir}/${name}`;
}

/** 混音/验收脚本的绝对路径（随包目录） */
export function mixScriptPath(cfg, key) {
  const name = MIX_SCRIPTS[key];
  if (!name) throw new Error(`未知混音脚本键: ${key}`);
  return `${cfg.mixScriptDir}/${name}`;
}

/** 随包 15 个脚本是否齐全（5 runtime + 8 probe + 2 mix）。 */
export function bundledScripts() {
  const list = [
    ...['convert.py', 'long_audio.py', 'guided_core.py', 'mix.py', 'validate_model.py']
      .map((f) => ({ kind: 'runtime', file: f, path: runtimePath(f) })),
    ...Object.entries(SCRIPTS).map(([, f]) => ({ kind: 'probe', file: f, path: join(BUNDLED.probe, f) })),
    ...Object.entries(MIX_SCRIPTS).map(([, f]) => ({ kind: 'mix', file: f, path: join(BUNDLED.mix, f) })),
  ];
  return list.map((x) => ({ ...x, ok: isFile(x.path) }));
}
