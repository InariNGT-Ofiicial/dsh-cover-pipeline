# dsh-cover-pipeline

兼容维护：同时支持 **DSH 0.2.1-rc.2 / rc.3**，保留旧版用法与设置。验证范围与复现见 [DSH 兼容说明](docs/DSH_COMPATIBILITY.md)。

面向 DeepSeek Harness（DSH）的本地 AI 翻唱插件，版本 **1.1.2**。通过 **9 个工具**组织分离、移调、换声、混音和验收。JavaScript 无运行时 npm 依赖；音频处理依赖外部 Python 工程与模型。

> 把「分离 → 换声 →（条件）移调 → 混音 → 验收 → 听审」做成 DSH 里可直接调用的工具。
> **零运行时依赖**（只用 `node:` 内置模块）；重活交给 MSST / DDSP 两套既有 Python 环境。

**安装前先读：[依赖清单与上游下载入口](docs/dependencies.md)**。

**本仓库自带 8 个核心脚本**（全在 `runtime/`）：5 个 adapter（`convert.py`、`long_audio.py`、`guided_core.py`、`mix.py`、`validate_model.py`）+ `shift.py` + `mix_master.py` + `verify_mix.py`。
**不含任何旧歌工程的 QC / 裁剪 / 封装脚本**；MSST / DDSP 两个大工程与音色权重不放进 git，见 [materials/README.md](materials/README.md)。

> 第一次用、只想知道「下完仓库还缺什么」→ 看 [小白接入](docs/quickstart.md)。

## 快速开始（小白版）

1. **拿材料**（三样大文件，网盘链接、提取码、目录布局全在 [materials/README.md](materials/README.md)）：
   MSST 整合包、DDSP 6.2 整合包、8 人音色模型包。
2. **一条命令接入**：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Root D:\AI-Song -Voice 祥子
```

3. **重启 DSH**，然后直接说：**「用祥子的声音翻唱《歌名》」**。

> 只想先看看缺什么：加 `-DryRun`。
> 只验材料：`node scripts/verify-materials.mjs --root D:\AI-Song --voice 祥子`。

## 安装与配置

需要 Node.js 18+、DSH，以及能独立运行的 MSST、DDSP-SVC。混音/验收脚本已随包。

```powershell
dsh plugin --profile desktop add <本仓库绝对路径>
```

`cordis.patch.yml` 是安装配置，`cordis.dev.yml` 是开发覆盖层。
**路径默认全留空**：`src/config.js` 会依次尝试 `DSH_COVER_ROOT` → `D:/AI-Song` → `C:/AudioWork` → 当前目录，
并在根目录里自动找 `01_*`（MSST）、`02_*/DDSP-barbara-*`（DDSP）、`03_*`（音色库）与 `env/python.exe`。
工程数据统一落在 `<songRoot>/cover_runs`，不再引用任何旧歌的 `_probe` / `_pipeline_bqll`。
发现不到时，`cover_setup` 会输出可直接粘的配置片段；`cover.local.json`（git 忽略）可做本机覆盖。

| 配置 | 应指向 |
| --- | --- |
| `msstDir` / `msstEnv` | MSST 工程及 Python，包含 kim/karaoke 模型与配置，支持 `--extract_instrumental` |
| `ddspDir` / `ddspEnv` | DDSP 工程及 Python，包含 batch_infer、RMVPE、编码器、声码器 |
| `voiceModel` | 有权使用的音色权重；同目录有 `config.yaml`，引用资产必须存在 |
| `mixDir` / `probeDir` | 工程数据目录，默认 `<songRoot>/cover_runs`；混音脚本在 `runtime/` |
| `ffmpeg` | 验证可用的 ffmpeg（可选） |
| `pipelineRoot` / `songRoot` | 本地项目数据目录 |
| `targetLufs` | 默认 −14；mix、verify 共用，可显式覆盖 |

安装后用 `cover_doctor` 检查；缺少核心依赖时不要宣称端到端可用。

## 工具与工作流

工具：`cover_doctor`、`cover_setup`、`cover_plan`、`cover_status`、`cover_separate`、`cover_shift`、`cover_convert`、`cover_mix`、`cover_verify`。
`cover_setup` 是自动发现与选音色的入口；`cover_shift` 只在非八度 key 时使用；`cover_verify` 只做技术检查，听审单独记录。

baseline：**kim → karaoke → 只换主唱 → 保留原和声 → standard 混音 → 单次母带归一化/限制 → 技术验收 → 用户试听**。

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
npm run test:workflow           # 6 项核心流程契约
npm run test:setup              # 8 项：8 脚本齐全 + cover_setup + 按名字选音色
npm run test:contract           # 28 项：工具定义/输出契约 + 核心工具 dry-run（自造夹具）
python -B test/adapter-cpu.py   # 6 项
python -B test/long-audio-cpu.py # 6 项
python -B test/mix-cpu.py --mix-dir runtime   # 3 项，用随包混音实现
npm run test:package            # 打包边界：8 脚本 + 清单，无权重/音频
node scripts/verify-materials.mjs --root D:\AI-Song --voice 祥子
```

Python CPU 测试需要 numpy/scipy/soundfile；混音测试直接用 `runtime/`。`test:contract` 里的 doctor 会读本机环境，不能冒充新歌全链路验证。

## 输入源经验

**Vocaloid 可以作为输入，不因旧失败案例而排除**；尽量不用已经换声/翻唱处理过的录音作为输入源。这是实践建议，不是普遍技术定律；应按歌曲、模型先试听。

## 许可与发布边界

插件代码采用 MIT，不涵盖外部工程、模型权重、音色、词曲或录音使用权。插件不解密 DRM、不上传歌曲到第三方、不自动发布视频。

`scripts/publish.ps1` 是手动发布辅助脚本，运行前必须检查目标分支。公开仓库和 npm 包不应包含歌曲、权重、凭据或用户日志。

## 1.1.2 说明

保留 1.1.1 的长音频分块推理与根因错误传播修复；不改模型、key、采样器或标准混音配方。非八度移调仍是条件必需步骤。保留输入/模型、时长、新鲜产物、有限值、真峰值、错误传播与用户听审；不承诺商业质量，不自动循环调音。

安装包不包含外部混音/分离/推理工程及权重；配置依赖后才可运行。验证边界见 [1.1.2 说明](docs/validation-1.1.2.md)。
