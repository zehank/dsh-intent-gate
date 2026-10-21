# dsh-intent-gate

DeepSeek Harness 插件：**写操作前的意图闸门**。

模型每次要写文件（`write` / `edit` / 会改盘的 `bash`）之前，必须先调用 `intent_declare`
声明这一轮是「命令 / 征询 / 评价 / 提问 / 情绪」；没声明、或声明成非 EXEC，写操作会被拦下。

它自己不判断——判断规则在配套的 `skill/` 里（`SKILL.md` + `rules.md`）。
**只装插件不装 skill 会把写操作无理由拦住**，两个要一起用。

## 它拦什么

| 情况 | 结果 |
|---|---|
| `write` / `edit` 写任何文件 | 要 EXEC 声明 |
| `bash` 里有重定向 `> f` `>> f` `2> f` `&> f` | 要 EXEC 声明（`2>&1`、`a >= b` 不算） |
| `bash` 的命令位是 `rm` `mv` `cp` `tee` `dd` `mkdir` `sed -i` `git commit` 等 | 要 EXEC 声明 |
| 往 `skills/intent/log.tsv` **追加**记账（`>>` / `tee -a`） | 放行，不需要声明 |
| 覆盖 / 删除 `log.tsv` | 仍然拦 |

判据是「宁可漏不可误伤」：`python3 x.py`、`npm install` 这类间接写盘不拦。

## 记账是自动的（v1.1.0）

每次 `intent_declare` 插件自己往 `.dsh/skills/intent/log.tsv` 追加一行
`时间 / 用户原话 / 判定 / note / 待定`，**不需要模型手写**——否则非 EXEC 轮会被闸门自己拦掉，
规则永远蒸馏不出来。log 路径解析顺序：`INTENT_GATE_LOG` 环境变量 → 插件目录旁
`../../skills/intent/log.tsv`（link 安装时即工作区） → `$PWD/.dsh/skills/intent/log.tsv`；
目录不存在就静默跳过，不影响工具调用。

每收到一条新用户消息，插件清空全部旧声明——避免上一轮的 EXEC 一直放行。

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
