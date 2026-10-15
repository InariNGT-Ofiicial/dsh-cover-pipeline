/**
 * 配置：内置默认值 + 合并/归一化。
 *
 * 设计原则：**默认值直接对准本机真实布局**，开箱即用；
 * 任何一项都可以被 cordis config 覆盖（见 cordis.patch.yml）。
 * 所有路径统一成**正斜杠绝对路径**，避免 Windows 反斜杠在 JSON/日志里的转义问题。
 */
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const runtimePath = name => fileURLToPath(new URL('../runtime/' + name, import.meta.url));

/** 机器相关的默认值。换机器时改这里，或在 cordis.patch.yml 里覆盖。 */
export const DEFAULTS = {
  // ── 目录 ──────────────────────────────────────────────────────────────
  songRoot: 'D:/AI-Song',
  pipelineRoot: 'D:/AI-Song/_pipeline_bqll',
  probeDir: 'D:/AI-Song/_pipeline_bqll/_probe',
  mixDir: 'D:/AI-Song/_pipeline_mingyue',

  // ── 两套 Python 环境 ──────────────────────────────────────────────────
  msstDir: 'D:/AI-Song/01_人声分离_MSST-GUI',
  msstEnv: 'D:/AI-Song/01_人声分离_MSST-GUI/env/python.exe',
  ddspDir: 'D:/AI-Song/02_模型推理_DDSP-SVC-6.2/DDSP-barbara-6.2',
  ddspEnv: 'D:/AI-Song/02_模型推理_DDSP-SVC-6.2/DDSP-barbara-6.2/env/python.exe',

  // ── 其它外部件 ────────────────────────────────────────────────────────
  ffmpeg: 'D:/AI-Song/01_人声分离_MSST-GUI/env/ffmpeg.exe',
  voiceModel:
    'D:/AI-Song/03_音色模型_MYGO-AveMujica/祥子_步数20000/exp/reflow-test/model_20000.pt',
  qualityLibDir: 'D:/AI-Song/_pipeline_bqll/_probe/_sq',

  // ── 业务默认值 ────────────────────────────────────────────────────────
  targetLufs: -14.0,
  timeoutMs: 3_600_000,
  maxOutputChars: 6000,
};

/** MSST 分离用到的权重（相对 ddspDir 之外，位于 MSST 目录内） */
export const MSST_ASSETS = {
  vocalModel: 'pretrain/MelBandRoformer_kim.ckpt',
  vocalConfig: 'configs/config_vocals_mel_band_roformer_kim.yaml',
  karaModel: 'pretrain/bs_roformer_karaoke_frazer_becruily.ckpt',
  karaConfig: 'configs/config_karaoke_frazer_becruily.yaml',
};

/** DDSP 侧的预训练件 */
export const DDSP_ASSETS = {
  hifigan: 'pretrain/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02/model.ckpt',
  contentvec: 'pretrain/contentvec/checkpoint_best_legacy_500.pt',
};

/** 本插件依赖的流水线脚本（都在 probeDir 下） */
export const SCRIPTS = {
  shiftUniform: 'p55_shift_uniform.py',
  voicedCheck: 'p56_check_guided.py',
  crackScan: 'p74_scan_crack.py',
  crackFix: 'p78_lead_fix3.py',
  instProfile: 'p85_inst_profile.py',
  shiftVerify: 'p86_shift_verify.py',
  convCheck: 'p87_conv_check.py',
  sectionCentroid: 'p89_section_centroid.py',
  abGeneric: 'p90_ab_generic.py',
  sourceSurvey: 'p91_source_survey.py',
  chorusCut: 'p93_chorus_cut.py',
  brightness: 'p95_brightness.py',
  leadEqProbe: 'p96_lead_eq_probe.py',
  releaseCut: 'p97_release_cut.py',
};

const PATH_KEYS = [
  'songRoot', 'pipelineRoot', 'probeDir', 'mixDir',
  'msstDir', 'msstEnv', 'ddspDir', 'ddspEnv',
  'ffmpeg', 'voiceModel', 'qualityLibDir',
];

/** 统一正斜杠；相对路径按 cwd 解析成绝对路径。 */
export function toPosixPath(p) {
  if (typeof p !== 'string' || p === '') return p;
  const s = p.replace(/\\/g, '/');
  return isAbsolute(s) ? s : resolve(s).replace(/\\/g, '/');
}

/**
 * 合并配置并归一化。返回一个**冻结的普通对象**，可直接用。
 * 未知键原样保留（便于未来扩展 / 自定义占位）。
 */
export function resolveConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
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
  // 派生路径
  cfg.scriptsDir = cfg.probeDir;
  return Object.freeze(cfg);
}

/** 把脚本名解析成绝对路径 */
export function scriptPath(cfg, key) {
  const name = SCRIPTS[key];
  if (!name) throw new Error(`未知脚本键: ${key}`);
  return `${cfg.probeDir}/${name}`;
}

export function join(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p, i) => (i === 0 ? String(p).replace(/\/+$/, '') : String(p).replace(/^\/+|\/+$/g, '')))
    .join('/');
}
