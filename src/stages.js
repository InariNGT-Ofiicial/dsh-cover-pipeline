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

  /** 逐段「像不像目标音色」：谱质心判据 */
  qcSection: (cfg, a) => ({
    label: 'QC 逐段质心（像不像目标音色）',
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

  /** 候选源音区体检（挑源用：判 P5 是否 ≳290 Hz） */
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
  {
    id: 'D1', name: '目标音色的可用音区',
    why: '决定了能不能整曲一个调；这是后面所有决策的前提。',
    how: '量源干声逐段 F0（`qcSource` / p91 / p89），与其"已被认可的输出"的谱质心锚点比较。',
    rule: '锚点来自实际验收过的成品，不要用感觉定阈值。',
  },
  {
    id: 'D2', name: '和声是否换声',
    why: '和声换声会与主唱抢音色；不换声则要保证与主唱同调。',
    how: '默认 D 档：和声**不换声**，只跟随主唱的移调量。',
    rule: '若源素材没有独立和声轨（卡啦分离出的和声通道低于 −40 LUFS），此决策无意义。',
  },
  {
    id: 'D3', name: '移调量 K',
    why: 'K 决定了人声落点，也决定了伴奏要不要跟着移调。',
    how: '整曲统一 K（比例精确保持）。**八度（±12）保持调性 ⇒ 伴奏可零移调**；非八度必须连伴奏一起移调。',
    rule: '★ 非八度移调只用在人声上 = 跑调。这条没有例外。',
  },
  {
    id: 'D4', name: '伴奏移调的代价',
    why: '移调器（pedalboard PhaseVocoder 类）会吃掉低频：实测 +8 时 sub(20–60Hz) 从 41.4% 掉到 5.1%，RMS 掉 2.5 dB。',
    how: '量 `qcSrcProfile`（p85 频段画像）在"同段对照"下的 sub/bass 占比。',
    rule: '**频段占比不能跨段比较**（占比之和恒为 100%，加低频必然压低其他段）——必须用同一段做对照。',
  },
  {
    id: 'D5', name: '缺陷窗口（破音 / 浊化）',
    why: '换声会引入两类局部缺陷，位置不可预测。',
    how: '破音：`qcCrack`（逐帧 vs 自身 ±0.5 s 邻域，用 z 分数而非绝对阈值）；浊化：p56（源无周期 & 输出强周期的帧占比）。',
    rule: '用**自身邻域**做基准 —— 鼓点每 0.32 s 重复一次，绝对阈值会把鼓点全判成缺陷。',
  },
];

export const FLOW = [
  { stage: 'S0', name: '意图解析', tool: 'cover_plan',
    detail: '自然语言 → {歌曲源, 目标音色, 偏好(保人声/保伴奏/保时长), 交付形态}；不确定的项**必须问**，不要猜。' },
  { stage: 'S1', name: '人声分离', tool: 'cover_separate', detail: 'MSST MelBandRoformer-kim → vocals / instrumental。' },
  { stage: 'S2', name: '主唱/和声分离', tool: 'cover_separate(karaoke=true)', detail: '默认执行；保留原和声，不送入换声器。显式false才跳过。' },
  { stage: 'S3', name: '音区体检与 K 决策', tool: 'cover_qc(qcSource/qcSection)', detail: 'D1 + D3。' },
  { stage: 'S4', name: '换声推理', tool: 'cover_convert', detail: '默认baseline batch；pilot显式起点/时长/key，guided为需单独听审的实验选项。' },
  { stage: 'S5', name: '伴奏移调', tool: 'cover_shift', detail: 'D4；非八度 K 必须做，八度 K 可跳过。' },
  { stage: 'S6', name: '混音 + 母带', tool: 'cover_mix', detail: '标准档 / 低频补偿档；★ 低频档会顺手削清亮（见 README）。' },
  { stage: 'S7', name: '五门验收', tool: 'cover_verify', detail: '技术门只报告对应指标；还必须由用户确认听感，不能等同音质通过。' },
  { stage: 'S8', name: '缺陷修复（可选）', tool: 'cover_qc(qcCrack) + p78', detail: 'D5；只修落在交付段落内的。' },
  { stage: 'S9', name: '裁剪 / 发布', tool: 'cover_cut → cover_release', detail: '裁剪可消掉"伴奏移调"的必要性（副歌自带高音区）。' },
];

export const WORKFLOW_RULES = [
  '★ **先 doctor 再动手**：环境不过就明确报告，不要带着坏环境跑几小时。',
  '★ **每个决策点都要量，不许猜**：量不出来的（如"唱法合不合适"）必须交给主人用耳朵判，并明确说"我量不了"。',
  '★ **成功以产物为准**：命令退出码为 0 不等于成功 —— 必须检查 expects 里的文件确实生成了。',
  '★ **固定recipe**：二级分离→仅主唱baseline换声→原和声→cover_mix完整母带；不能静默退化为两轨相加+loudnorm。',
  '★ **先跑 pilot 再跑 full**：同一key/backend/参数试听并取得用户确认；先裁完整混音输入到同一时间段再分离，避免pilot主唱与整曲伴奏错位。',
  '★ 插件不可用时明确报告fallback；手工执行必须逐项保留recipe与provenance，不能冒充插件已验证。',
  '★ **响度对齐后才做听感对比**：等响（同一 LUFS）是 A/B 的前提，否则比的是音量不是音质。',
  '★ **凡是"变薄/变闷/变亮"这类结论，必须给同一段的数值对照**，不能给跨段的比例。',
];
