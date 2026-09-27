# dsh-plugin

DSH（DeepSeek Harness）插件集合。**每个插件是 `packages/` 下一个自包含的 bundle 包**，可以单独安装，互不依赖。

## 目录

| 插件 | 说明 | 状态 |
|---|---|---|
| [`packages/skill-index`](packages/skill-index/) | 技能集合渐进式加载：catalog 只留 1 条索引，成员保留用户可调用但不进模型 catalog。实测 28 个成员 2,901 → 95 tokens | 可用 |

## 加一个新插件

```bash
cp -r packages/skill-index packages/<新插件名>     # 起步骨架
# 改 packages/<新插件名>/package.json 的 name / description
# 改 packages/<新插件名>/cordis.patch.yml 的 entry id 与 name
```

一个插件包最少四个文件：

```
packages/<name>/
├── package.json          name + "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml      - insert: 一行挂载自己（name 写包名）
├── lib/index.js          ESM，导出 name / inject / apply(ctx, config)
└── README.md
```

`package.json` 里的 `dsh.bundle.patch` 是关键：有了它，`dsh plugin --profile <p> add <路径>` 装完会**自动挂载**，不用手写 patch 行。

### 约定

- **零运行时依赖优先。** 只用 node 内置模块的插件不需要 `pnpm install`，装起来最快，也最不容易因为宿主升级而碎。确有依赖时放 `dependencies`，别用 `peerDependencies` 去要宿主已经不再提供的包（DSH 还在 rc，客户端包名换过好几次）。
- **不假设自己是唯一插件。** 注册的服务名、工具名、skill 名都要带前缀。
- **配置缺失要能区分「还没配」和「配错了」**：前者 info，后者 warn。
- **导出可在测试里直接调的内部函数**（`parseX` / `scanX` / `renderX`），这样测试不需要起完整运行时。
- **测试不用框架。** `node test/<name>.test.mjs` 直接跑，退出码非 0 即失败。

## 验证一个插件

```bash
# 1) 落到隔离 profile 试装（不要直接装进在用的 web profile）
cp -r ~/.dsh/profiles/headless ~/.dsh/profiles/try
sed -i 's/dsh-profile-headless/dsh-profile-try/' ~/.dsh/profiles/try/package.json
dsh plugin --profile try add "$PWD/packages/<name>"

# 2) bundle 是否自动挂载
dsh --profile try --dump-config | grep -A3 "<entry-id>"

# 3) 跑
dsh --profile try --json "只回复 OK"

# 4) 验完删掉
rm -rf ~/.dsh/profiles/try
```

## 本仓

- 本地 git 仓库，**无远端、不推送**。
- 插件各自带 LICENSE；仓库根不统一授权。
