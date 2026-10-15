# dsh-cover-pipeline

面向 DeepSeek Harness（DSH）的本地 AI 翻唱插件，版本 **1.1.0**。通过 11 个工具组织分离、换声、移调、混音和验收。JavaScript 无运行时 npm 依赖；音频处理依赖用户配置的外部 Python 工程、模型和混音脚本。**本仓库不提供模型、歌曲或完整外部流水线。**

## 1.1.0 修复

- karaoke 二级分离只接收一级 vocals，默认启用；空输入和缺少分轨均失败。
- 通用 `pilot` 支持 `start/duration`（默认 0/25 秒）、短输入截到末尾、明确 key；`full` 使用同一参数，不再读取旧歌试听时间表。
- 默认 `baseline` 调用原 `batch_infer.py`，只换主唱、保留原和声；`guided` 是未独立验收的实验后端。
- 输出路径绑定 mode/key，拒绝覆盖旧文件；验证 WAV、时长、源/模型 provenance，并保存唯一阶段 manifest。
- 验收读取 JSON `checks[].pass`，WARN/false 即失败，不再仅看退出码；技术通过与听感批准分开。
- 转换实际接收配置的模型或显式覆盖，doctor 检查有效模型、相邻配置及其引用资产。
- 混音使用独立 trace 和单次归一化/限制，要求三轨时长匹配；移调必须提供 `harmSrc`。

## 安装与配置

需要 Node.js 18+、DSH，以及能独立运行的 MSST、DDSP-SVC 和兼容混音工程。先配置路径，再安装：

```powershell
dsh plugin --profile desktop add <本仓库绝对路径>
```

`cordis.patch.yml` 是安装配置，`cordis.dev.yml` 是开发覆盖层。所有路径都是需要替换的示例。`src/config.js` 保留原部署兼容默认值，**不是自动发现，也不保证适用其他机器**。

| 配置 | 应指向 |
| --- | --- |
| `msstDir` / `msstEnv` | MSST 工程及 Python，包含 kim/karaoke 模型与配置，支持 `--extract_instrumental` |
| `ddspDir` / `ddspEnv` | DDSP 工程及 Python，包含 batch_infer、RMVPE、编码器、声码器 |
| `voiceModel` | 有权使用的音色权重；同目录有 `config.yaml`，引用资产必须存在 |
| `mixDir` | 含兼容 `mix_master.py`、`verify_mix.py` 的工程；需要 numpy/scipy/soundfile/pyloudnorm/pedalboard |
| `probeDir` / `qualityLibDir` | 旧 QC/移调/裁剪/包装脚本及额外库；脚本清单见 `src/config.js` 的 `SCRIPTS` |
| `ffmpeg` | 验证可用的 ffmpeg |
| `pipelineRoot` / `songRoot` | 本地项目数据目录 |
| `targetLufs` | 默认 −14；mix、verify、cut 共用，可显式覆盖 |

环境变量 `DSH_COVER_ROOT`/`DSH_COVER_PROBE` 只覆盖配置中明确引用它们的字段，不能代替检查全部路径。外部混音接口必须兼容 `runtime/mix.py` 的 `run`、`normalize_to_lufs` 调用；插件不自动安装或修改外部工程。缺少依赖时不能宣称端到端可用。安装后用 `cover_doctor` 检查，并确认 DSH 加载新配置，不中断运行中的任务。

## 工具与工作流

工具：`cover_doctor`、`cover_plan`、`cover_status`、`cover_separate`、`cover_shift`、`cover_convert`、`cover_mix`、`cover_verify`、`cover_qc`、`cover_cut`、`cover_release`。最后一个只做本地编码和标签包装，不执行公开发布。

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
npm test
python -B test/adapter-cpu.py
python -B test/mix-cpu.py --mix-dir <兼容混音工程绝对路径>
npm run test:package
```

Python CPU 测试需要 numpy/scipy/soundfile；混音测试另需外部混音实现及依赖。`COVER_TEST_TMP` 可指定可写临时目录。CI 仅运行无 GPU 回归。`test:contract` 含本机 doctor，`test:e2e` 只检查指定旧产物，两者均不能冒充新歌全链路验证。已完成的 CPU、真实插件 GPU 集成、用户提供的 DSH 定义匹配及用户听审分别见 [验证说明](docs/validation-1.1.0.md)。

## 输入源经验（2026-10-15 修正）

用户听新版《千本樱》后认为：少量 Vocaloid 唱法是特色，且无上一版瑕疵。撤回此前把 Vocaloid 与已有 AI 翻唱输入混为一谈的负面判断。**Vocaloid 可以作为输入，不因旧失败案例而排除**；旧失败不足以证明源类型不适用。

新旧流程变化是重要混杂因素；没有受控对照，不能声称输入源或某项处理的精确因果已验证。

保留用户要求的经验建议：**尽量不用已有 AI 翻唱作为输入源**。这里指已被换声/翻唱处理过的录音，与 Vocaloid 原始合成歌声区分。这是实践建议，不是普遍技术定律；应按歌曲、模型和流程先试听，客观指标不能代替听审。

## 许可与发布边界

插件代码采用 MIT，不涵盖外部工程、模型权重、音色、词曲或录音使用权。公开宣传前需分别确认许可。插件不解密 DRM、不上传歌曲到第三方、不自动发布视频。

更新使用修复分支和 PR 审查；`scripts/publish.ps1` 是旧手动发布辅助脚本，运行前必须检查目标分支。公开仓库和 npm 包不应包含歌曲、权重、凭据或用户日志。
