# 小白接入（从「文件不够」到「一句话开跑」）

## 先说清楚：以前为什么说文件不够

旧版仓库只有**插件 JS 源码**，而插件运行时要调用 15 个 Python 脚本：

| 类别 | 数量 | 旧版在哪 |
|---|---|---|
| runtime adapter（转写/长音频/guided/mix/模型校验） | 5 | 只在作者本机，**没进 git** |
| probe（移调、QC、裁剪、封装） | 8 | 要另找 p51–p97 原工程目录 |
| mixture（`mix_master.py` / `verify_mix.py`） | 2 | 作者本机 `_pipeline_mingyue`，**没进 git** |

所以别人 clone 下来后，DSH 一检查就会说「需要 15 个流水线脚本、2 个混音验收脚本、2 个模型」——
**不是下载姿势不对，是仓库当时确实缺这些文件。**

现在 **15 个脚本全部随仓库分发**，在 `runtime/`、`pipeline/probe/`、`pipeline/mix/`。
还差的只有模型/大工程（体积 + 授权原因不进 git）。

## 四步

### 1. 拿三样材料

| 材料 | 链接 | 提取码 | 解压到 |
|---|---|---|---|
| MSST 整合包 | <https://pan.baidu.com/s/1gLO9U5jcfrtO3WJmAAyo1Q?pwd=u3r2> | `u3r2` | `01_人声分离_MSST-GUI` |
| DDSP 6.2 整合包 | <https://pan.baidu.com/s/16LUHAc40KsCI449TbPQ29Q?pwd=j44k> | `j44k` | `02_模型推理_DDSP-SVC-6.2/DDSP-barbara-6.2` |
| 8 人音色模型包 | <https://pan.baidu.com/s/1GJBrq3287GA_KKwNudFDpw?pwd=2aj9> | `2aj9` | `03_音色模型_MYGO-AveMujica` |

> **演示默认音色是「祥子」**，就在第 3 个包里：`03_音色模型_MYGO-AveMujica/祥子_步数20000/exp/reflow-test/`（`model_20000.pt` + `config.yaml`）。只想跑演示，下第 1、2、3 个包即可；校验用 `--demo`。

默认根目录是 `D:\AI-Song`；放别处也行，下一步用 `-Root` 指过去。

### 2. 一条命令

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Root D:\AI-Song -Voice 祥子
```

它会：

1. 校验随包 15 个脚本；
2. 自动发现 MSST / DDSP / 音色库；
3. 核对 4 个预训练件 + 选中音色的 sha256；
4. 写 `cover.local.json`（本机覆盖，git 忽略）；
5. 调 `dsh plugin --profile desktop add` 安装。

只想预演，不写不装：加 `-DryRun`。

### 3. 重启 DSH

`cordis.patch.yml` 在启动时加载；改完配置必须重启一次。

### 4. 说一句话

> 用祥子的声音翻唱《歌名》

代理侧会：`cover_setup(voice="祥子")` → `cover_doctor` → `cover_plan` → `cover_separate` → `cover_convert(voice="祥子")` → `cover_mix` → `cover_verify`。
`cover_convert` 支持 `voice` 参数，不用手填 `.pt` 路径。

## 验证「到底缺什么」

```powershell
# 校验演示资产（祥子）
node scripts/verify-materials.mjs --root D:\AI-Song --demo
# 或指定任意音色
node scripts/verify-materials.mjs --root D:\AI-Song --voice 高松灯
```

输出逐项 ✅/❌，并直接打印演示资产的网盘地址、提取码和包内路径。想连 DSH 一起看：`cover_doctor`。

## 常见问题

**Q：根目录不是 D:\AI-Song？**
`install.ps1 -Root E:\Audio`，或设环境变量 `DSH_COVER_ROOT=E:\Audio`。
插件启动时也会自动尝试 `D:/AI-Song`、`C:/AudioWork`、当前目录。

**Q：8 个音色都想用？**
`cover_doctor` 会列出全部；`cover_convert` 的 `voice` 支持「高松灯 / 初华 / 祥子 / 立希 / 若叶睦 / 喵梦 / 素世 / 爱音」。

**Q：模型 267 MB，GitHub 为什么不收？**
单文件超 100 MB；且权重许可不在插件 MIT 范围内。仓库只放 `materials/manifest.json` 的哈希与落位，不放权重。

**Q：长歌会不会爆显存？**
1.1.1 起 full 模式按 ≤30 s 窗口重叠分块，渲染器只加载一次；不是靠加大显存。

**Q：能商用/公开发布吗？**
词曲著作权仍属原作者；音色模型是衍生权重，按原分享授权。插件不自动发布，`cover_release` 只做本地封装。
