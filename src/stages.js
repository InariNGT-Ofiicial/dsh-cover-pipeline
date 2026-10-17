/**
 * 阶段命令构造器 + 流程方法论。
 *
 * 核心只有：分离 → 主唱/和声 → 换声 → （条件）移调 → 混音 → 验收 → 听审。
 * 不再包含任何旧歌工程的 QC/裁剪/封装脚本。
 */
import { DDSP_ASSETS, MSST_ASSETS, join, mixScriptPath, runtimePath } from './config.js';

function push(args, pairs) {
  for (const [flag, val] of pairs) {
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val)) {
      for (const v of val) args.push(flag, String(v));
    } else if (val === true) {
      args.push(flag);
    } else {
      args.push(flag, String(val));
    }
  }
  return args;
}

export function keyTag(k) {
  const n = Math.round(Number(k));
  return `${n >= 0 ? '+' : ''}${n}`;
}

export const STAGES = {
  separate: (cfg, a) => ({
    label: 'S1 人声/伴奏分离',
    cmd: cfg.msstEnv,
    cwd: cfg.msstDir,
    args: push([
      'inference.py',
      '--model_type', 'mel_band_roformer',
      '--config_path', MSST_ASSETS.vocalConfig,
      '--start_check_point', MSST_ASSETS.vocalModel,
      '--input_folder', a.inputFolder,
      '--store_dir', a.outDir,
    ], [['--extract_instrumental', true], ['--disable_detailed_pbar', true]]),
    expects: [],
  }),

  karaoke: (cfg, a) => ({
    label: 'S2 主唱/和声分离',
    cmd: cfg.msstEnv,
    cwd: cfg.msstDir,
    args: push([
      'inference.py',
      '--model_type', 'bs_roformer',
      '--config_path', MSST_ASSETS.karaConfig,
      '--start_check_point', MSST_ASSETS.karaModel,
      '--input_folder', a.inputFolder,
      '--store_dir', a.outDir,
    ], [['--extract_instrumental', true], ['--disable_detailed_pbar', true]]),
    expects: [],
  }),

  shift: (cfg, a) => ({
    label: `S3 伴奏+和声统一移调 k=${keyTag(a.key)}`,
    cmd: cfg.msstEnv,
    cwd: cfg.probeDir,
    args: push([runtimePath('shift.py'), String(a.key)], [
      ['--outdir', a.outDir],
      ['--inst-src', a.instSrc],
      ['--harm-src', a.harmSrc],
      ['--subtype', a.subtype ?? 'FLOAT'],
    ]),
    expects: [join(a.outDir, 'inst.wav'), join(a.outDir, 'harm.wav')],
  }),

  convert: (cfg, a) => {
    const output = join(a.outDir, `lead_${a.mode ?? 'pilot'}_k${keyTag(a.key)}.wav`);
    return {
      label: `S4 ${a.backend ?? 'baseline'} ${a.mode ?? 'pilot'} k=${keyTag(a.key)}`,
      cmd: cfg.ddspEnv, cwd: cfg.ddspDir,
      args: push([runtimePath('convert.py'), '--src', a.src, '--out', output,
        '--model', a.model ?? cfg.voiceModel, '--ddsp-dir', cfg.ddspDir,
        '--backend', a.backend ?? 'baseline', '--mode', a.mode ?? 'pilot', '--key', String(a.key)], [
        ['--start', a.start ?? 0], ['--duration', a.duration ?? 25],
        ['--step', a.step ?? 50], ['--method', a.method ?? 'euler'], ['--t-start', a.tStart ?? 0.7],
        ['--amp', a.amp ?? 0.5], ['--nsfuv', a.nsfuv ?? 1], ['--conf-hi', a.confHi ?? 0.4],
        ['--conf-lo', a.confLo ?? 0.15], ['--nsf-thred', a.nsfThred ?? 0.4],
        ['--crepe-uv', a.crepeUv ?? 1], ['--crepe-th', a.crepeTh ?? 0.35],
      ]),
      expects: [output, output + '.conversion.json'],
    };
  },

  mix: (cfg, a) => ({
    label: 'S5 混音 + 母带',
    cmd: cfg.msstEnv,
    cwd: cfg.mixDir,
    args: push([runtimePath('mix.py'), '--mix-dir', cfg.runtimeDir], [
      ['--out', a.out],
      ['--profile', a.profile ?? 'standard'],
      ['--target', a.targetLufs ?? cfg.targetLufs],
      ['--p', a.overrides ?? []],
      ['--set', [`inst=${a.inst}`, `lead=${a.lead}`, `harm=${a.harm}`]],
    ]),
    expects: [a.out, a.out + '.mix.json'],
  }),

  verify: (cfg, a) => ({
    label: 'S6 五门验收',
    cmd: cfg.msstEnv,
    cwd: cfg.runtimeDir,
    args: push([mixScriptPath(cfg, 'verify'), a.wav], [
      ['--ref', a.ref],
      ['--target-lufs', a.targetLufs ?? cfg.targetLufs],
      ['--json', a.json ?? `${a.wav}.verify.json`],
    ]),
    expects: [a.json ?? `${a.wav}.verify.json`],
  }),
};

export const GATES = [
  ['整合响度', '−14.0 ±0.5 LUFS'],
  ['真峰值', '≤ −1.0 dBTP'],
  ['波峰因数 crest', '≥ 12.0 dB'],
  ['动态范围 LRA', '报告项'],
  ['立体声相关', '0.20 ~ 0.95'],
];

export const DECISIONS = [
  { id: 'D1', name: '目标模型与 key', why: '明确实际模型和全曲调性。',
    how: '核对模型配置；按源音区与试听选择 key。',
    rule: '不从谱质心推断目标音色身份；音区调查只作辅助。' },
  { id: 'D2', name: '和声', why: '保留原和声并与主唱同调。',
    how: '默认二级分离，只转换主唱。', rule: '跳过二级分离需要显式选择。' },
  { id: 'D3', name: '伴奏与和声移调', why: '保持与主唱的调性关系。',
    how: '非八度 key 必须同步移调；零或整八度可保持伴奏。',
    rule: '移调后核对时长和听感。' },
  { id: 'D4', name: '输入源', why: '输入源决定上限。',
    how: '优先原唱 / Vocaloid 原始合成；尽量不用已经换声的 AI 翻唱作为源。',
    rule: '输入源类型不是普遍技术定律；按歌曲、模型先试听。' },
  { id: 'D5', name: '交付形态', why: '整曲与片段的验收条件不同。',
    how: '默认整曲 WAV；只做片段时在外部裁剪后重新归一响度。',
    rule: '裁剪/编码后必须重测时长、真峰值与响度。' },
];

export const FLOW = [
  { stage: 'S0', name: '意图与环境', tool: 'cover_plan / cover_doctor', detail: '明确输入、模型、key 和交付格式；仅询问仍缺少的必要信息。' },
  { stage: 'S1', name: '人声分离', tool: 'cover_separate', detail: 'kim → vocals / instrumental。' },
  { stage: 'S2', name: '主唱/和声分离', tool: 'cover_separate(karaoke=true)', detail: '默认启用；保留原和声，只转换主唱。' },
  { stage: 'S3', name: '伴奏/和声移调（条件步骤）', optional: true, tool: 'cover_shift', detail: '非八度 key 必须同步移调；key=0 无需执行。' },
  { stage: 'S4', name: '换声', tool: 'cover_convert', detail: 'baseline；先同段 pilot 试听，full 沿用确认参数。' },
  { stage: 'S5', name: '混音与母带', tool: 'cover_mix', detail: '完整处理链，单次归一化；不自动循环调音。' },
  { stage: 'S6', name: '技术检查', tool: 'cover_verify', detail: '响度、真峰值、波峰因数、LRA、立体声相关。' },
  { stage: 'S7', name: '用户听审', tool: '（人工）', detail: '技术指标通过不等于听感通过。' },
  { stage: 'S8', name: '交付', tool: '（本地文件）', detail: '整曲 WAV；片段/编码按需在外部处理。' },
];

export const WORKFLOW_RULES = [
  '先 doctor；核心依赖缺失应停止。',
  '成功必须同时满足进程成功、新鲜产物、输入/模型 provenance、时长与有效数值检查。',
  '固定 recipe：二级分离→仅主唱 baseline→原和声→完整混音母带；不能静默退化为两轨相加。',
  '同一窗口 pilot 试听后再 full；先裁源再分离，禁止短主唱混整曲伴奏。',
  '技术检查与用户听审分别记录；不依据 LUFS、谱质心或其他单一指标承诺商业质量。',
  '发现问题先报告，不自动反复调整。',
  '插件不可用须明确报告；手工流程不能冒充插件路径验证。',
];
