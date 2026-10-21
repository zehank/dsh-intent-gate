# dsh-intent-gate

DeepSeek Harness 插件：**写操作前的意图闸门**。

模型每次要写文件（`write` / `edit` / 会改盘的 `bash`）之前，必须先调用 `intent_declare`
声明这一轮是「命令 / 征询 / 评价 / 提问 / 情绪」；没声明、或声明成非 EXEC，写操作会被拦下。

它自己不判断——判断规则在配套的 `skill/` 里（`SKILL.md` + `rules.md`）。
**只装插件不装 skill 会把写操作无理由拦住**，两个要一起用。

## 安装

```bash
git clone https://github.com/zehank/dsh-intent-gate.git
dsh plugin --profile desktop add "$(pwd)/dsh-intent-gate"     # Windows: (Get-Location).Path
mkdir -p .dsh/skills && cp -R dsh-intent-gate/skill .dsh/skills/intent
```

skill 要放进**你当前工作区**的 `.dsh/skills/intent/`（Windows：`.dsh\skills\intent\`），
然后重启 DSH。

## 文件

```
index.js            # 插件本体（不依赖任何 @deepseek-ai 包）
package.json
cordis.patch.yml    # 插入 intent-gate 行
skill/SKILL.md      # 判断规则
skill/rules.md      # 蒸馏出来的规则（可自行修改）
```

`skill/log.tsv`（记账流水，含对话原话）**不在仓库里**，它属于本地运行数据。

## License

MIT
