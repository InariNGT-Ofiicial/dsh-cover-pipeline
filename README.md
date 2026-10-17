# dsh-cover-pipeline

面向 DeepSeek Harness（DSH）的本地 AI 翻唱插件，版本 **1.1.2**。通过 12 个工具组织分离、换声、移调、混音和验收。JavaScript 无运行时 npm 依赖；音频处理依赖外部 Python 工程与模型。

> 把「分离 → 换声 → 移调 → 混音 → 验收 → 裁剪 → 发布」整条链，做成 DSH 里可直接调用的 12 个工具。
> **零运行时依赖**（只用 `node:` 内置模块）；重活全部交给两套既有 Python 环境。

**安装前先读：[依赖清单与上游下载入口](docs/dependencies.md)** — 组件层级、上游链接与 1.1.2 审计边界。

**本仓库自带 15 个流水线脚本**：5 个 runtime adapter（`runtime/`）+ 8 个 probe（`pipeline/probe/`，移调/QC/裁剪/封装）+ 2 个混音验收（`pipeline/mix/`）。**不再需要另找 p51–p97 原工程目录。** 只有 MSST / DDSP 两个大工程与音色权重不放进 git，获取方式见 [materials/README.md](materials/README.md)。

> 第一次用、只想知道「下完仓库还缺什么」→ 直接看 [小白接入](docs/quickstart.md)。

## 1.1.0 修复

- karaoke 二级分离只接收一级 vocals，默认启用；空输入和缺少分轨均失败。
- 通用 `pilot` 支持 `start/duration`（默认 0/25 秒）、短输入截到末尾、明确 key；`full` 使用同一参数，不再读取旧歌试听时间表。
- 默认 `baseline` 调用原 `batch_infer.py`，只换主唱、保留原和声；`guided` 是未独立验收的实验后端。
- 输出路径绑定 mode/key，拒绝覆盖旧文件；验证 WAV、时长、源/模型 provenance，并保存唯一阶段 manifest。
- 验收读取 JSON `checks[].pass`，WARN/false 即失败，不再仅看退出码；技术通过与听感批准分开。
- 转换实际接收配置的模型或显式覆盖，doctor 检查有效模型、相邻配置及其引用资产。
- 混音使用独立 trace 和单次归一化/限制，要求三轨时长匹配；移调必须提供 `harmSrc`。

## 快速开始（小白版）

1. **拿材料**（三样大文件，网盘链接 + 提取码 + 目录布局全在 [materials/README.md](materials/README.md)）：
   MSST 整合包、DDSP 6.2 整合包、8 人音色模型包。
2. **一条命令接入**（自动发现路径、校验 sha256、写本机配置、安装插件）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Root D:\AI-Song -Voice 祥子
```

3. **重启 DSH**，然后直接说：**「用祥子的声音翻唱《歌名》」**。

> 只想先看看缺什么：加 `-DryRun`。
> 已经装过、只想验材料：`node scripts/verify-materials.mjs --root D:\AI-Song --voice 祥子`。

## 安装与配置

需要 Node.js 18+、DSH，以及能独立运行的 MSST、DDSP-SVC。混音脚本已随包。

```powershell
dsh plugin --profile desktop add <本仓库绝对路径>
```

`cordis.patch.yml` 是安装配置，`cordis.dev.yml` 是开发覆盖层。
**路径默认全留空**：`src/config.js` 会依次尝试 `DSH_COVER_ROOT` → `D:/AI-Song` → `C:/AudioWork` → 当前目录，
并在根目录里自动找 `01_*`（MSST）、`02_*/DDSP-barbara-*`（DDSP）、`03_*`（音色库）与 `env/python.exe`。
发现不到时，`cover_setup` 会输出可直接粘的配置片段；`cover.local.json`（git 忽略）可做本机覆盖。

| 配置 | 应指向 |
| --- | --- |
| `msstDir` / `msstEnv` | MSST 工程及 Python，包含 kim/karaoke 模型与配置，支持 `--extract_instrumental` |
| `ddspDir` / `ddspEnv` | DDSP 工程及 Python，包含 batch_infer、RMVPE、编码器、声码器 |
| `voiceModel` | 有权使用的音色权重；同目录有 `config.yaml`，引用资产必须存在 |
| `mixDir` | 含兼容 `mix_master.py`、`verify_mix.py` 的工程；需要 numpy/scipy/soundfile/pyloudnorm/pedalboard |
| `probeDir` / `qualityLibDir` | 工程数据目录与可选音质库（mosqito/mutagen）；**脚本已随包**，见 `pipeline/` |
| `ffmpeg` | 验证可用的 ffmpeg |
| `pipelineRoot` / `songRoot` | 本地项目数据目录 |
| `targetLufs` | 默认 −14；mix、verify、cut 共用，可显式覆盖 |

环境变量 `DSH_COVER_ROOT`/`DSH_COVER_PROBE` 只覆盖配置中明确引用它们的字段，不能代替检查全部路径。外部混音接口必须兼容 `runtime/mix.py` 的 `run`、`normalize_to_lufs` 调用；插件不自动安装或修改外部工程。缺少依赖时不能宣称端到端可用。安装后用 `cover_doctor` 检查，并确认 DSH 加载新配置，不中断运行中的任务。

## 工具与工作流

工具：`cover_doctor`、`cover_setup`、`cover_plan`、`cover_status`、`cover_separate`、`cover_shift`、`cover_convert`、`cover_mix`、`cover_verify`、`cover_qc`、`cover_cut`、`cover_release`。`cover_setup` 负责自动发现与选音色（一句话接入的入口）；`cover_release` 只做本地编码和标签包装，不执行公开发布。

baseline：**kim → karaoke → 只换主唱 → 保留原和声残差 → standard 混音 → 单次母带归一化/限制 → 技术验收 → 用户试听**。

先从有权使用的原始录音裁同一时间段，例如 55–80 秒，44.1 kHz 双声道浮点 WAV，不预降增益，命名为 `pilot.wav`。以下 `C:/AudioWork/run-001` 是新建目录示例：

```json
{"tool":"cover_separate","args":{"inputFolder":"C:/AudioWork/run-001/input","outDir":"C:/AudioWork/run-001/sep","karaoke":true}}
{"tool":"cover_convert","args":{"src":"C:/AudioWork/run-001/sep/kara/pilot/Vocals.wav","outDir":"C:/AudioWork/run-001/conv","mode":"pilot","backend":"baseline","start":0,"duration":25,"key":0,"step":50,"method":"euler","tStart":0.7}}
{"tool":"cover_mix","args":{"inst":"C:/AudioWork/run-001/sep/pilot/instrumental.wav","lead":"C:/AudioWork/run-001/conv/lead_pilot_k+0.wav","harm":"C:/AudioWork/run-001/sep/kara/pilot/instrumental.wav","out":"C:/AudioWork/run-001/master.wav","profile":"standard"}}
{"tool":"cover_verify","args":{"wav":"C:/AudioWork/run-001/master.wav","json":"C:/AudioWork/run-001/master.verify.json"}}
```

不要把短主唱与全长伴奏混合；先裁源再分离可保持窗口一致。`key:0` 是示例，不适用所有音源；变调需同步处理伴奏和和声。先试听，再以新目录、完整源和 `mode:"full"` 制作整曲。已有目标会被拒绝。

`dryRun:true` 只返回命令与预期产物，不代表输出通过。manifest 和转换 provenance 含本机路径，仅作本地追溯，不应提交用户素材或私有日志。

## 测试和验证

```powershell
npm test                        # 15 项回归
npm run test:workflow           # 7 项流程契约
npm run test:setup              # 8 项：15 脚本齐全 + cover_setup + 按名字选音色
npm run test:contract           # 37 项：工具定义/输出契约 + 全工具 dry-run（自造夹具）
python -B test/adapter-cpu.py   # 6 项
python -B test/long-audio-cpu.py # 6 项
python -B test/mix-cpu.py --mix-dir pipeline\mix   # 3 项，用随包混音实现
npm run test:package            # 打包边界：17 个脚本 + 清单，无权重/音频
node scripts/verify-materials.mjs --root D:\AI-Song --voice 祥子
```

Python CPU 测试需要 numpy/scipy/soundfile；混音测试现在直接用随包 `pipeline/mix`。CI 跑前四项 JS + 打包边界（Windows/Linux，无 GPU）。`test:contract` 里的 doctor 会读本机环境，不能冒充新歌全链路验证；已移除硬编码旧歌产物的 `test:e2e`。已完成的 CPU、真实插件 GPU 集成及用户听审见 [验证说明](docs/validation-1.1.0.md)。

## 输入源经验（2026-10-15 修正）

用户听新版《千本樱》后认为：少量 Vocaloid 唱法是特色，且无上一版瑕疵。撤回此前把 Vocaloid 与已有 AI 翻唱输入混为一谈的负面判断。**Vocaloid 可以作为输入，不因旧失败案例而排除**；旧失败不足以证明源类型不适用。

新旧流程变化是重要混杂因素；没有受控对照，不能声称输入源或某项处理的精确因果已验证。

保留用户要求的经验建议：**尽量不用已有 AI 翻唱作为输入源**。这里指已被换声/翻唱处理过的录音，与 Vocaloid 原始合成歌声区分。这是实践建议，不是普遍技术定律；应按歌曲、模型和流程先试听，客观指标不能代替听审。

## 许可与发布边界

插件代码采用 MIT，不涵盖外部工程、模型权重、音色、词曲或录音使用权。公开宣传前需分别确认许可。插件不解密 DRM、不上传歌曲到第三方、不自动发布视频。

更新使用修复分支和 PR 审查；`scripts/publish.ps1` 是旧手动发布辅助脚本，运行前必须检查目标分支。公开仓库和 npm 包不应包含歌曲、权重、凭据或用户日志。

## 1.1.2 默认流程精简与长音频修复

包含 1.1.1 的长音频分块推理与根因错误传播修复；不改模型、key、采样器或标准混音配方。参考曲等响度 A/B、专项 QC、人工修音/自动化、裁剪与本地封装均为按需步骤，不是默认验收条件。**15 个流水线脚本已随包**（此前需要外部 probe 目录的 p51–p97 脚本，是「下了仓库却跑不起来」的主因）；可选脚本缺失只影响对应工具。非八度移调仍是条件必需步骤。保留输入/模型、时长、新鲜产物、有限值、真峰值、错误传播与用户听审；不承诺商业质量，不自动循环调音。

安装包不包含外部混音/分离/推理工程及权重；配置依赖后才可运行。具体删留理由与验证边界见 [1.1.2 说明](docs/validation-1.1.2.md)。
