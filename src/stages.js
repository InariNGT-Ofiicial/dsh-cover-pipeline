/**
 * 阶段命令构造器 + 流程方法论。
 *
 * ★ 这里承载的是**本项目的知识**，不只是命令拼装：
 *   `FLOW` 把九段流水线、五个"必须量不能猜"的决策点、五道验收门写进插件，
 *   于是「自然语言 → 全流程」才有可能 —— 否则模型只会乱试参数。
 *
 * 每个 builder 返回 {cmd, args, cwd, expects[], label}：
 *   · `expects` 是"跑完必须存在的产物"，工具据此判定成功（**不靠退出码**）；
 *   · 返回值可直接 dry-run（把命令行回给人看）。
 */
import { DDSP_ASSETS, MSST_ASSETS, join, scriptPath, runtimePath } from './config.js';

/** 只推入有值的参数（避免 `--ref ''` 这种空参数） */
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

/** 规范化的 `%+d` 半音标记，与 p51 的落盘命名一致（如 +5 / -3 / +0） */
export function keyTag(k) {
  const n = Math.round(Number(k));
  return `${n >= 0 ? '+' : ''}${n}`;
}

export const STAGES = {
  /** S1 人声分离（MSST MelBandRoformer-kim）→ <out>/<曲名>/{vocals,instrumental}.wav */
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
    expects: [],   // 具体产物名依赖输入文件名，由工具跑完再扫
  }),

  /** S2 主唱/和声分离（卡拉 OK 模型）→ 保住"和声不换声"这一档 */
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

  /** S3 伴奏/和声整曲统一移调（★ 必须与人声同一个 K，否则跑调） */
  shift: (cfg, a) => ({
    label: `S3 伴奏+和声统一移调 k=${keyTag(a.key)}`,
    cmd: cfg.msstEnv,
    cwd: cfg.probeDir,
    args: push([scriptPath(cfg, 'shiftUniform'), String(a.key)], [
      ['--outdir', a.outDir],
      ['--inst-src', a.instSrc],
      ['--harm-src', a.harmSrc],
      ['--subtype', a.subtype ?? 'FLOAT'],
    ]),
    expects: [join(a.outDir, 'inst.wav'), join(a.outDir, 'harm.wav')],
  }),

  /** S4 task-local generic pilot/full adapter; no song-specific windows. */
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

  /** S6 混音 + 母带（pedalboard 全链，输出 −14 LUFS） */
  mix: (cfg, a) => ({
    label: 'S6 混音 + 母带',
    cmd: cfg.msstEnv,
    cwd: cfg.mixDir,
    args: push([runtimePath('mix.py'), '--mix-dir', cfg.mixDir], [
      ['--out', a.out],
      ['--profile', a.profile ?? 'standard'],
      ['--target', a.targetLufs ?? cfg.targetLufs],
      ['--p', a.overrides ?? []],
      ['--set', [`inst=${a.inst}`, `lead=${a.lead}`, `harm=${a.harm}`]],
    ]),
    expects: [a.out, a.out + '.mix.json'],
  }),

  /** S7 五门验收（响度 / 真峰值 / 波峰因数 / LRA / 立体声） */
  verify: (cfg, a) => ({
    label: 'S7 五门验收',
    cmd: cfg.msstEnv,
    cwd: cfg.mixDir,
    args: push(['verify_mix.py', a.wav], [
      ['--ref', a.ref],
      ['--target-lufs', a.targetLufs ?? cfg.targetLufs],
      ['--json', a.json ?? `${a.wav}.verify.json`],
    ]),
    expects: [a.json ?? `${a.wav}.verify.json`],
  }),

  /** S8 副歌裁剪（能量极小切口 + 淡入淡出 + 重新定响度 + 接缝自证） */
  cut: (cfg, a) => ({
    label: 'S8 裁剪',
    cmd: cfg.msstEnv,
    cwd: cfg.probeDir,
    args: push([scriptPath(cfg, 'chorusCut')], [
      ['--src', a.src],
      ['--out', a.out],
      ['--segs', a.segs],
      ['--snap', a.snap],
      ['--fade', a.fade],
      ['--gap', a.gap],
      ['--target', a.targetLufs ?? cfg.targetLufs],
      ['--no-normalize', a.noNormalize === true],
    ]),
    expects: [a.out],
  }),

  /** S9 发布封装（mp3 320k + ID3v2.3 + ID3v1，并自证解码指标） */
  release: (cfg, a) => ({
    label: 'S9 发布封装',
    cmd: cfg.msstEnv,
    cwd: cfg.probeDir,
    args: push([scriptPath(cfg, 'releaseCut')], [
      ['--wav', a.wav],
      ['--outdir', a.outDir],
      ['--name', a.name],
      ['--title', a.title],
      ['--artist', a.artist],
      ['--album', a.album],
      ['--year', a.year],
      ['--genre', a.genre],
      ['--track', a.track],
      ['--comment', a.comment],
      ['--bitrate', a.bitrate],
    ]),
    expects: a.name && a.outDir ? [join(a.outDir, `${a.name}.mp3`)] : [],
  }),

  // ── 质检（QC）────────────────────────────────────────────────────────
  /** 破音扫描：逐帧相对 ±0.5 s 自身邻域的离群检测 */
  qcCrack: (cfg, a) => ({
    label: 'QC 破音扫描',
    cmd: cfg.msstEnv, cwd: cfg.probeDir,
    args: push([scriptPath(cfg, 'crackScan')], [
      ['--lead', a.lead], ['--ref', a.ref], ['--a', a.a], ['--b', a.b],
    ]),
    expects: [],
  }),

  /** 换声有效性：MFCC 距离 + 时长/F0/峰值 是否被动过 */
  qcConv: (cfg, a) => ({
    label: 'QC 换声有效性',
    cmd: cfg.msstEnv, cwd: cfg.probeDir,
    args: push([scriptPath(cfg, 'convCheck')], [['--dry', a.lead], ['--ref', a.ref]]),
    expects: [],
  }),

  /** 可选逐段频谱画像：不判断音色身份 */
  qcSection: (cfg, a) => ({
    label: 'QC 逐段频谱画像',
    cmd: cfg.msstEnv, cwd: cfg.probeDir,
    args: push([scriptPath(cfg, 'sectionCentroid')],
      [['--dry', a.lead], ['--ref', a.ref], ['--win', a.win ?? []]]),
    expects: [],
  }),

  /** 清亮画像：DIN 45692 尖锐度等（需 mosqito） */
  qcBright: (cfg, a) => ({
    label: 'QC 清亮画像',
    cmd: cfg.msstEnv, cwd: cfg.probeDir,
    args: push([scriptPath(cfg, 'brightness')], [
      ['--file', a.file ?? []], ['--win', a.win], ['--lufs', a.lufs],
    ]),
    expects: [],
  }),

  /** 候选源音区体检（可选辅助，不使用通用音域阈值） */
  qcSource: (cfg, a) => ({
    label: 'QC 候选源音区体检',
    cmd: cfg.msstEnv, cwd: cfg.probeDir,
    args: [scriptPath(cfg, 'sourceSurvey'), ...(a.files ?? [])],
    expects: [],
  }),
};

// ───────────────────────────────────────────────────────────────────────────
// 流程方法论：给模型看的"怎么做"，不是"能做什么"
// ───────────────────────────────────────────────────────────────────────────

export const GATES = [
  ['整合响度', '−14.0 ±0.5 LUFS'],
  ['真峰值', '≤ −1.0 dBTP'],
  ['波峰因数 crest', '≥ 12.0 dB'],
  ['动态范围 LRA', '报告项（原曲约 8 dB）'],
  ['立体声相关', '0.20 ~ 0.95'],
];

export const DECISIONS = [
  { id: 'D1', name: '目标模型与 key', why: '明确实际模型和全曲调性。',
    how: '核对模型配置；按源音区与试听选择 key，已有用户确认则沿用。',
    rule: '不从谱质心推断目标音色身份；音区调查仅在有疑问时使用。' },
  { id: 'D2', name: '和声', why: '保留原和声并与主唱同调。',
    how: '默认二级分离，只转换主唱。', rule: '跳过二级分离需要显式选择。' },
  { id: 'D3', name: '伴奏与和声移调', why: '保持与主唱的调性关系。',
    how: '非八度 key 必须同步移调；零或整八度可保持伴奏。',
    rule: '移调后核对时长和听感；有变薄疑问时才做同段频谱比较。' },
];

export const FLOW = [
  { stage: 'S0', name: '意图与环境', tool: 'cover_plan / cover_doctor', detail: '明确输入、模型、key和交付格式；仅询问仍缺少的必要信息。' },
  { stage: 'S1', name: '人声分离', tool: 'cover_separate', detail: 'kim → vocals / instrumental。' },
  { stage: 'S2', name: '主唱/和声分离', tool: 'cover_separate(karaoke=true)', detail: '默认启用；保留原和声，只转换主唱。' },
  { stage: 'S3', name: '音区诊断（可选）', optional: true, tool: 'cover_qc(kind=source/section)', detail: '只在选 key 或调查音区问题时使用；频谱不是音色身份判据。' },
  { stage: 'S4', name: '换声', tool: 'cover_convert', detail: 'baseline；先同段 pilot 试听，full 沿用确认参数。guided 是实验选项。' },
  { stage: 'S5', name: '伴奏/和声移调（条件步骤）', conditional: true, tool: 'cover_shift', detail: '非八度 key 必须同步移调；key=0 无需执行。' },
  { stage: 'S6', name: '混音与母带', tool: 'cover_mix', detail: 'standard 完整处理链，单次归一化；不自动循环调音。' },
  { stage: 'S7', name: '技术检查与用户听审', tool: 'cover_verify', detail: '保留时长、有限值、削波/真峰值和错误检查；指标不等同听感或商业质量保证。' },
  { stage: 'S8', name: '异常诊断（可选）', optional: true, tool: 'cover_qc', detail: '出现可定位问题时选择诊断工具；人工修音/自动化仅按具体问题另行授权，不自动执行。' },
  { stage: 'S9', name: '裁剪/本地封装（可选）', optional: true, tool: 'cover_cut / cover_release', detail: '仅在需要片段或 MP3/标签时使用；已有合格编码不重复封装，编码后仍需检查解码时长、有限值及真峰值。不会公开发布。' },
];

export const WORKFLOW_RULES = [
  '先 doctor；核心依赖缺失应停止，可选诊断/封装依赖缺失只影响对应工具。',
  '成功必须同时满足进程成功、新鲜产物、输入/模型 provenance、时长与有效数值检查；保留 WARN/错误传播。',
  '固定 recipe：二级分离→仅主唱 baseline→原和声→完整混音母带；不能静默退化为两轨相加。',
  '同一窗口 pilot 试听后再 full；先裁源再分离，禁止短主唱混整曲伴奏。',
  '技术检查与用户听审分别记录；不依据 LUFS、谱质心或其他单一指标承诺商业质量。',
  '参考曲 A/B 仅在比较候选或排查问题时使用；比较时匹配同段响度，避免音量偏差。',
  '专项 QC、人工逐句修音和自动化不属于默认完成条件；发现问题先报告，不自动反复调整。',
  '插件不可用须明确报告；手工流程不能冒充插件路径验证。',
];
