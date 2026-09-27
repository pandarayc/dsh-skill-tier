# @pandarayc/dsh-skill-index

> 让成千上万个 skill 不再每轮都躺在上下文里。**零依赖、单文件、不改源文件。**

DSH 的 skill 目录（catalog）是**每个会话每一轮都携带**的常驻消息：每个 model-invocable 的 skill 贡献一条 `- \`name\`: <description>`。一个域只要有几十个 skill，代价就很可观：

| 技能集合 | 成员数 | 常驻开销 |
|---|---|---|
| lark-*（飞书 CLI 内嵌） | 28 | **+2,901 tokens**（基础 prompt 的 51%） |
| gsd-*（`~/.claude/skills`） | 83 | **+2,047 tokens** |

本插件把一个技能集合折成三层：

```
Tier 0  catalog         只列 1 条索引（+78 ~ +121 tokens）      ← 常驻
Tier 1  模型加载索引     拿到该集合全部成员的路由表（4 KB 上下）   ← 判断相关时才付
Tier 2  按路由取正文     只读真正要用的那 1–2 个成员全文          ← 精确命中才付
```

**实测削减 96.7%**（28 个成员：**2,901 → 95 tokens**），且**保留模型自主发现能力** —— 成员仍然可以被你 `/成员名` 直接点名加载。

## 安装

```bash
# 装进 profile（bundle 形式，装完自动挂一行）
dsh plugin --profile web add /data/project/dsh-plugin/packages/skill-index

# 验证
dsh --profile web --dump-config | grep -A3 skill-index
```

**装完是惰性的**：没有配置任何集合时不产出候选、不占上下文。集合可以来自两层（见下）。

不想装包、只想先试：

```bash
dsh --profile web --patch examples/lark.yml --json "只回复 OK"
```

工作区用法（装完包之后）：

```bash
mkdir -p ~/work/feishu/.dsh
cat > ~/work/feishu/.dsh/skill-index.json <<'JSON'
{ "groups": [{ "name": "lark", "title": "飞书/Lark 全能力入口",
  "description": "飞书/Lark 全能力入口（28 个子技能）…",
  "dir": "~/.dsh/lark-skills", "members": "lark-*",
  "detailHint": "lark-cli skills read <成员名>" }] }
JSON
cd ~/work/feishu && dsh --profile web    # 这个目录带索引；别的目录不带
```

## 配置

```yaml
- insert:
    - id: skill-index
      name: /data/project/dsh-plugin/packages/skill-index/lib/index.js
      config:
        revalidateMs: 0                 # 可选，见下
        groups:
          - name: lark                  # 索引 skill 名，必须 kebab-case
            title: 飞书/Lark 全能力入口   # 索引正文的标题
            description: "…进 catalog 的那句话，说明什么时候该加载它…"
            dir: "~/.dsh/lark-skills"   # 成员目录（**不必**是 DSH 扫描根）
            members: "lark-*"           # glob，见下
            detailHint: "lark-cli skills read <成员名>"   # 可选：正文里教模型怎么取全文
            rules:                      # 可选：追加到正文的规则
              - "任何飞书操作前先读 lark-shared"
            rank: 300                   # 可选，同名冲突优先级，越小越优先（默认 300）
            source: custom              # 可选，默认 custom
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `groups[].name` | ✅ | 索引 skill 的名字；同时是**目录名之外**的唯一标识，必须 kebab-case |
| `groups[].dir` | ✅ | 成员所在目录；支持 `~`。**不要**同时把它设成 DSH 扫描根，否则 `dsh-skill-filesystem` 也会发现成员，成本就回来了 |
| `groups[].description` | ✅ | 进 catalog 的一句话。超过 500 字符会被 DSH 截断，插件会在配置阶段 warn |
| `groups[].title` | | 索引正文标题，默认取 `name` |
| `groups[].members` | | 默认 `*`。支持 `*`、前缀 `foo-*`、精确名，逗号分隔，`!` 前缀排除（如 `lark-*,!lark-mindnotes`） |
| `groups[].detailHint` | | 正文里"怎么取成员全文"的提示。默认给一个读文件路径的写法 |
| `groups[].rules` | | 正文末尾的规则列表，默认两条（一次只读 1–2 个、正文是权威） |
| `revalidateMs` | | 默认 `0` = 每次 `list()` 都按**内容哈希**校验一遍。见下 |

成员文件格式与 `dsh-skill-filesystem` 一致：`<dir>/<name>/SKILL.md`，或平铺的 `<dir>/<name>.md`。

### 两层配置

配置有两个来源，**工作区层在同一名字上覆盖 entry 层**：

| 层 | 位置 | 作用范围 | 典型用途 |
|---|---|---|---|
| **entry 层** | profile 的 `cordis.patch.yml` 里 `skill-index` 那行的 `config.groups` | 该 profile 的所有会话 | 全局都想带的集合 |
| **工作区层** | `<cwd>/.dsh/skill-index.json` | **只对在这个目录开的会话** | 「只有我打开飞书工作目录时才带飞书索引」 |

工作区层的文件形状和 entry 层一样：

```json
{
  "groups": [
    {
      "name": "lark",
      "title": "飞书/Lark 全能力入口",
      "description": "飞书/Lark 全能力入口（28 个子技能）…",
      "dir": "~/.dsh/lark-skills",
      "members": "lark-*",
      "detailHint": "lark-cli skills read <成员名>"
    }
  ]
}
```

也可以覆盖 `revalidateMs`。

**这就是「装一次、按工作区生效」**：

```
~/code/my-project/          没有 .dsh/skill-index.json → 0 开销
~/work/feishu/              .dsh/skill-index.json 声明 lark → +95 tokens
```

工作区层**刻意不缓存**：`list()` 每个会话只调一两次，重读一个小 JSON 的成本可以忽略，而缓存会带来「改了配置不生效」的坑 —— 正是本插件在成员扫描上极力避免的那类问题。

> 只认 `<cwd>/.dsh/skill-index.json`，**不向上查找**。要在子目录也生效，把文件放在你实际打开的那个目录。

## 它到底改了什么

**什么都不改。** 它在 **provider 层**合成可见性：

| | 模型 catalog | `skill` 工具 | 用户 `/成员名` |
|---|---|---|---|
| 索引 skill | ✅ 1 条 | ✅ | ✅ |
| 成员 skill | ❌ | ❌ | ✅ |

对比"给成员文件注入 `disable-model-invocation: true`"那种做法：

| | 改文件 | 本插件 |
|---|---|---|
| 来源文件 | 被污染，回滚要重跑同步 | **保持原样** |
| 成员目录 | **必须**是 DSH 扫描根 | **不必**，不会和 `dsh-skill-filesystem` 抢 |
| 索引同步 | 要重跑脚本 | 每次 `list()` 现算 |
| 适用范围 | 只能用于有同步脚本的集合 | 任意目录、任意来源 |

## 设计要点

- **失效判断用内容哈希，不用 mtime。** 踩过坑：同步脚本按目录名原地重写内容、且新旧等长时，文件系统时间戳可能**完全不变**（实测同 tick 内 `mtimeNs` 相等），于是索引永远停在旧版本。内容哈希没有这个窗口。
- **每次调用都读一遍成员文件。** 担心太贵？先量了频率：DSH 注册表有 catalog 缓存，一个 4 步会话里 `list()` **只被调用 1 次**。实测 28 个成员 `list()` 8.6 ms、`get(router)` 6.2 ms。用这点 I/O 换"失效判断绝对正确"很划算。`revalidateMs` 只作为数百成员时的逃生阀。
- **不挂 `fs.watch`。** 成员内容是原地改写，`fs.watch` 在深度 1 上看不到子目录内的文件变更；为 80+ 个成员各挂一个 watcher 不划算。
- **不调 `control.invalidate()`。** 会把注册表缓存全部作废，在 `list()` 内部调用会形成"发现 → 作废 → 再发现"的自激。惰性校验已经满足正确性。
- **成员名必须 kebab-case。** 一个坏名字（如 `gsd-extract_learnings` 含下划线）会让注册表**整体**报错。插件会跳过并 warn。
- **零依赖。** 只用 `node:fs/promises`、`node:crypto`、`node:path`、`node:os`。

## 验证过的数字

指标 = `inputTokens + cacheReadTokens`（**不要**只看 `inputTokens`，那只是未命中缓存的部分）。同一个 trivial prompt，`dsh --profile <p> --json "只回复 OK"`：

| 场景 | prompt tokens | Δ |
|---|---|---|
| 纯 headless 基线（无该技能集合） | 5,695 | — |
| **装本插件**，28 个成员折成 1 条索引 | **5,790** | **+95** |
| 不装插件，28 个成员直接放项目扫描根 | 8,596 | +2,901 |

复现（成员目录必须**不是** DSH 扫描根）：

```bash
mkdir -p /tmp/larktest/.dsh && ln -s ~/.dsh/lark-skills /tmp/larktest/.dsh/skills   # ← 这是"旧做法"的对照组
dsh --profile <装了插件的> --json "只回复 OK"    # 期望 ≈ 基线 + 95
dsh --profile <没装插件的> --json "只回复 OK"    # 对照组 ≈ 基线 + 2900
```

⚠️ **验证时最常见的错误**：把同一个目录既设成项目扫描根、又配给插件。那样 `dsh-skill-filesystem` 会照常列出全部成员（rank 100 赢过插件的 rank 300），插件看起来"没生效"。成员目录要么给插件读，要么作扫描根，**不能两头都占**。

## 测试

```bash
node test/skill-index.test.mjs     # 24 个用例，无框架依赖
```

覆盖：frontmatter 解析（引号/冒号/块标量/BOM/多行普通标量）、可见性合成、索引正文生成、**原地内容改写后缓存失效**、成员增删、非法集合名/成员名、目录不可读、`~` 展开、超长描述告警、`!` 排除、目录恢复、卸载后停止产出、未配置时的行为、**工作区层新增/覆盖/按 cwd 隔离/坏 JSON 只告警一次/覆盖 revalidateMs**。

## 边界

| 限制 | 说明 |
|---|---|
| 索引表随成员数线性增长 | 成员 > 100 时正文会自动加一句"建议拆集合"。多层索引（索引的索引）没做 |
| glob 只支持 `*` 和 `!` | 没有 `?` / `{}` / `**` |
| 每个 dsh 进程一份内存缓存 | 多进程各扫一遍（8 ms），不值得为此引入共享缓存 |
| `SkillProvider` 接口是 0.1.x | DSH 还在 rc。插件只依赖 `registerProvider` + `SkillCandidate` 两个概念 |

## 与 capability-menu 的关系

[`PKUfudawei/dsh-capability-menu`](https://github.com/PKUfudawei/dsh-capability-menu) 是更全的能力分层插件（tool + skill 三档 + Web UI）。两者不是竞品而是**上下游**：

```
skill-index（provider 层）   让一个不在扫描根里的目录变成 ctx.skills 里的技能
        ↓
capability-menu（policy 层）     决定这些技能在 catalog 里露多少
```

⚠️ 实测（2026-09-27，DSH 0.1.7-rc.2 + capability-menu 0.1.4）：**capability-menu 的技能侧在 0.1.7 上不工作** —— 它用 `ctx.skills.list({})` 枚举（缺 `cwd`，项目级技能全部不可见），且 `agent/pre-step` 的 catalog 过滤对已可见的技能也不生效（`on-demand:['*']` 下条目数不变）。工具侧正常。版本错配导致，不是设计问题。

## License

MIT
