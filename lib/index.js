/**
 * skill-tier — 通用「技能集合分层」provider。
 *
 * 解决的问题
 * ----------
 * DSH 的 skill 目录（catalog）是**每个会话每一轮都携带**的常驻消息：
 * 每个 model-invocable 的 skill 贡献一条 `- \`name\`: <description>`。
 * 一个域只要有几十个 skill，常驻开销就很可观（实测 lark 的 28 个 ≈ +2,890 tokens，
 * 占基础 prompt 的 50%），而绝大多数会话根本用不到那个域。
 *
 * 做法
 * ----
 * 把一个技能集合折叠成两层：
 *
 *   Tier 0  一个「索引 skill」进 catalog —— 名字 + 一句话描述（几十 tokens）
 *   Tier 1  模型加载索引 → 拿到该集合全部成员的路由表（按需付费）
 *   Tier 2  模型按路由表去取真正要用的那个成员的正文（精确付费）
 *
 * 成员 skill 仍然存在、仍然**用户可以 `/名字` 直接调用**，只是
 * `modelInvocable: false` —— 不进 catalog，也不被 `skill` 工具加载。
 *
 * 配置（patch 里 insert 一行即可）
 * --------------------------------
 *   - insert:
 *       - id: skill-tier
 *         name: /abs/path/to/plugins/skill-tier.mjs
 *         config:
 *           revalidateMs: 0                    # 可选：跳过重新读取的最小间隔（默认 0）
 *           providerName: skill-tier          # 可选：同层唯一。见「设计取舍」
 *           groups:
 *             - name: lark                     # 索引 skill 名（必须 kebab-case）
 *               title: 飞书/Lark 全能力入口
 *               description: "…进 catalog 的那句话…"
 *               dir: "~/.dsh/lark-skills"      # 成员目录（不必是扫描根）
 *               members: "lark-*"              # glob：* / 前缀* / *后缀 / 精确
 *               detailHint: "lark-cli skills read <成员名>"
 *               rules: ["任何飞书操作前先读 lark-shared"]
 *               rank: 350                      # 越小越优先；见 DEFAULT_RANK
 *               source: custom
 *
 * **一个 profile 只挂一行。** 多个技能集合写在同一个 config.groups 下。用两个 entry id
 * 挂两遍本插件会让第二个实例注册失败（同层 provider 名必须唯一）。
 *
 * 成员格式与 dsh-skill-filesystem 一致：`<dir>/<name>/SKILL.md`，或 `<dir>/<name>.md`。
 *
 * 设计取舍
 * --------
 * - **不监听文件系统**：成员内容原地改写是最常见的变更形态（同步脚本按目录名原地替换），
 *   而 `fs.watch` 在成员目录深度 1 上收不到「子目录内文件被改」的事件。与其为 80+ 个成员
 *   各挂一个 watcher，不如用「目录签名 + 短 TTL 惰性重校验」：签名里包含每个 SKILL.md 的
 *   mtime/size，所以内容变化一定能被看见；TTL 只用来压掉同一批调用里的重复 stat。
 * - **不调用 control.invalidate()**：它会把注册表缓存全部作废并通知消费者。在 list() 内部
 *   调用会造成「发现 → 作废 → 再发现」的自激。惰性重校验已经满足正确性。
 * - **所有 I/O 走异步**：接口本身是 async，DSH 也明确要求 discovery 在 list() 内 await；
 *   几十上百个成员的扫描不应该阻塞事件循环。
 * - **provider 名同层唯一**：注册表在同一层遇到重名 provider 会直接抛错，让整个实例
 *   不激活。所以 apply() 把那个原始错误翻译成「一个 profile 只挂一行；多行请用
 *   config.providerName 区分」，避免使用者只看到一行 "did not activate"。
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const name = 'skill-tier';
export const inject = ['skills'];

/** DSH 的 skill 名语法：kebab-case。名字不合法的条目必须剔除，否则注册表会整体报错。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** catalog 会给 description 截断的默认长度；超过就提醒配置者。 */
const CATALOG_DESC_SOFT_MAX = 500;

/** 默认 provider 名。注册表要求同一层内唯一，重名会直接抛错（见 apply 里的处理）。 */
const DEFAULT_PROVIDER_NAME = 'skill-tier';

/** dsh-skill 保留给运行时技能的 provider 名，用它注册会抛错。 */
const RESERVED_PROVIDER_NAME = 'runtime';

/**
 * 索引 skill 与成员的默认优先级。DSH 的档位（**越小越优先**）：
 *
 *   100  <projectRoot>/.dsh/skills        项目级，最高
 *   200  <projectRoot>/.agents/skills
 *   250  运行时注册（ctx.skills.register）
 *   300  profile 的 customSkillDirs
 *   400  ~/.dsh/skills
 *   500  ~/.agents/skills
 *   600  DSH 内置
 *
 * 取 350 的理由：默认**不遮蔽**项目级与 customSkillDirs（100/200/300 都比我们优先），
 * 同时避开默认值 300 —— 与 customSkillDirs 同档时由 provider 注册顺序决定胜负，
 * 对使用者不可预期。想让本插件永远不遮蔽任何既有来源，显式设 `rank: 700`（> 600）。
 */
const DEFAULT_RANK = 350;

// ───────────────────────────── frontmatter ─────────────────────────────

/** 切出 `---` 包起来的 frontmatter；容忍 BOM 与 CRLF。 */
function splitFrontmatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : '';
}

/**
 * 极简 YAML frontmatter 解析：只取 skill 会用到的标量键。
 * 支持 `key: value`、`key: "quoted"`、`key: 'quoted'`、`key: |` / `key: >` 块标量，
 * 以及 YAML 的普通标量续行（更深的缩进行折成空格拼接）。
 * 不追求完整 YAML（嵌套映射/数组会被忽略），因为这里只需要 name / description / whenToUse。
 */
function parseFrontmatter(fm) {
  const out = {};
  const lines = fm.split(/\r?\n/);

  const takeIndented = (i) => {
    const buf = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) {
      if (!lines[++i].trim()) {
        buf.push('');
        continue;
      }
      buf.push(lines[i].replace(/^\s+/, ''));
    }
    return { buf, end: i };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s/.test(line)) continue; // 只认顶层键
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let raw = m[2].trim();

    if (/^[|>][+-]?$/.test(raw)) {
      const { buf, end } = takeIndented(i);
      i = end;
      out[key] = (raw.startsWith('>') ? buf.join(' ') : buf.join('\n')).trim();
      continue;
    }

    if (
      raw.length > 1 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ) {
      out[key] = raw.slice(1, -1);
      continue;
    }

    // 普通标量的续行：只有值非空时才可能续（`key:` 后面跟的是嵌套结构）
    if (raw !== '') {
      const { buf, end } = takeIndented(i);
      if (buf.length) {
        i = end;
        raw = [raw, ...buf].filter((s) => s !== '').join(' ');
      }
    }
    out[key] = raw;
  }
  return out;
}

/** 把 glob 里用到的语法（仅 `*`）转成正则；同时支持 `!pattern` 排除。 */
function compileMemberFilter(glob) {
  const parts = String(glob)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const includes = [];
  const excludes = [];
  for (const p of parts) {
    const target = p.startsWith('!') ? excludes : includes;
    const body = (p.startsWith('!') ? p.slice(1) : p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    target.push(new RegExp(`^${body}$`));
  }
  if (includes.length === 0) includes.push(/^.*$/);
  return (n) => includes.some((r) => r.test(n)) && !excludes.some((r) => r.test(n));
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** 从完整描述压出一句短提示，用于索引表。 */
function shortHint(desc, max = 46) {
  let d = String(desc ?? '').replace(/\s+/g, ' ').trim();
  const colon = d.search(/[：:]/);
  if (colon !== -1 && colon < 24) d = d.slice(colon + 1).trim();
  const stop = d.search(/[。；;]/);
  if (stop > 8) d = d.slice(0, stop);
  if (d.length > max) d = d.slice(0, max - 1) + '…';
  return d.replace(/\|/g, '\\|');
}

// ───────────────────────────── 成员扫描 ─────────────────────────────

/** 生成索引 skill 的正文。 */
function renderRouter(group, members, resolvedDir) {
  const rows = members.map((m) => `| \`${m.name}\` | ${shortHint(m.description)} |`).join('\n');
  const hint = group.detailHint || `读 \`${resolvedDir}/<成员名>/SKILL.md\``;
  const rules = group.rules?.length
    ? group.rules
    : [
        '**一次只取你真正需要的那 1–2 个成员**，读完再动手，不要一次全读。',
        '成员正文是权威内容，**不要凭记忆猜参数**。',
      ];

  const budget =
    members.length > 100
      ? `\n> ⚠️ 本集合有 ${members.length} 个成员，索引表本身已经不小；建议用 \`members\` 拆成多个更小的集合。\n`
      : '';

  return `# ${group.title}

> 本技能是**索引**，不含具体操作说明。成员正文按需取用。
> 由 \`skill-tier\` 从 \`${resolvedDir}\` 现算，共 ${members.length} 个成员。
${budget}
取用某个成员的完整说明：

    ${hint}

## 索引

| 成员 | 用途 |
|---|---|
${rows}

## 规则

${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
`;
}

// ───────────────────────────── 配置归一化 ─────────────────────────────

function normalizeGroups(config, warn) {
  const raw = config?.groups;
  if (!Array.isArray(raw)) return [];

  const out = [];
  const seen = new Set();

  raw.forEach((g, index) => {
    const label = g?.name ? `groups[${index}] "${g.name}"` : `groups[${index}]`;
    if (!g || typeof g !== 'object') {
      warn(`${label} 不是对象，已忽略`);
      return;
    }
    if (!g.name || !g.dir) {
      warn(`${label} 缺 name 或 dir，已忽略`);
      return;
    }
    const name = String(g.name);
    if (!SKILL_NAME_RE.test(name)) {
      warn(`${label} 的 name 不是 kebab-case，已忽略（否则注册表会整体报错）`);
      return;
    }
    if (seen.has(name)) {
      warn(`${label} 与前面的集合重名，已忽略（同一 provider 内索引名必须唯一）`);
      return;
    }
    seen.add(name);

    const description = String(g.description ?? g.title ?? name);
    if (description.length > CATALOG_DESC_SOFT_MAX) {
      warn(
        `${label} 的 description 有 ${description.length} 字符，` +
          `超过 catalog 上限 ${CATALOG_DESC_SOFT_MAX}，会被截断`,
      );
    }

    out.push({
      name,
      title: String(g.title ?? name),
      description,
      dir: String(g.dir),
      members: g.members ? String(g.members) : '*',
      detailHint: g.detailHint ? String(g.detailHint) : undefined,
      rules: Array.isArray(g.rules) ? g.rules.map(String) : undefined,
      rank: Number.isFinite(g.rank) ? Number(g.rank) : DEFAULT_RANK,
      source: g.source ? String(g.source) : 'custom',
    });
  });

  return out;
}

/**
 * 归一化 provider 名。
 *
 * 注册表要求同一层内 provider 名唯一，且保留名 `runtime` 不可占用 —— 两种情况都会让
 * 注册直接抛错、整个插件不激活。名字不合法时**回退到默认名**而不是报错：一个可选字段
 * 写错不该让插件整个挂掉，但必须留一条 warn。
 */
function normalizeProviderName(raw, warn) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PROVIDER_NAME;
  const name = String(raw);
  if (name === RESERVED_PROVIDER_NAME) {
    warn(`config.providerName 不能是保留名 "${RESERVED_PROVIDER_NAME}"，已回退为 "${DEFAULT_PROVIDER_NAME}"`);
    return DEFAULT_PROVIDER_NAME;
  }
  if (!SKILL_NAME_RE.test(name)) {
    warn(`config.providerName "${name}" 不是 kebab-case，已回退为 "${DEFAULT_PROVIDER_NAME}"`);
    return DEFAULT_PROVIDER_NAME;
  }
  return name;
}

/**
 * 把注册表的重名错误翻译成可操作的话。
 *
 * 最常见的成因：同一个 profile 用两个不同的 entry id 挂了两遍本插件（例如「lark 一行、
 * gsd 一行」）。此时**第二个实例整个不激活**，而 dsh 只打印一行
 * `warning: 1 entry did not activate` 加原始的 "already registered"，看不出该怎么办。
 */
function explainRegistrationFailure(error, providerName) {
  const message = String(error?.message ?? error);
  if (!/already registered/.test(message)) return error;
  const wrapped = new Error(
    `skill-tier: provider 名 "${providerName}" 在本层已被占用。` +
      `同一个 profile 只应挂一行本插件 —— 多个技能集合请写在同一个 config.groups 下；` +
      `若确实要挂多行，请给每一行不同的 config.providerName。` +
      `（原始错误：${message}）`,
  );
  wrapped.cause = error;
  return wrapped;
}

// ───────────────────────────── 工作区配置 ─────────────────────────────

/** 工作区级配置文件的相对路径（相对会话 cwd）。 */
const WORKSPACE_CONFIG_REL = join('.dsh', 'skill-tier.json');

/**
 * 读一个工作区的 `.dsh/skill-tier.json`。
 *
 * 返回解析后的对象，或 null（没有文件 / 读不动 / 格式不对）。
 * **没有文件不是错误** —— 绝大多数工作区都不该有，所以静默返回 null；
 * 只有文件存在但解析失败才 warn（按路径去重，不刷屏）。
 */
async function loadWorkspaceConfig(cwd, warnOnce) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  const file = join(cwd, WORKSPACE_CONFIG_REL);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warnOnce(`ws-json:${file}`, `skill-tier: 工作区配置 ${file} 不是合法 JSON（${error?.message ?? error}），已忽略`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnOnce(`ws-shape:${file}`, `skill-tier: 工作区配置 ${file} 顶层必须是对象，已忽略`);
    return null;
  }
  return parsed;
}

/** 合并 entry 层与工作区层的集合定义：**同名以工作区为准**。 */
function mergeGroups(base, extra) {
  const byName = new Map();
  for (const g of base) byName.set(g.name, g);
  for (const g of extra) byName.set(g.name, g);
  return [...byName.values()];
}

// ───────────────────────────── provider ─────────────────────────────

function createProvider(logger, options = {}) {
  const PROVIDER = options.providerName ?? DEFAULT_PROVIDER_NAME;
  // control.signal 在插件卸载 / 注册失败时中止。回收后不该再做 I/O。
  const teardown = options.teardownSignal;
  const alive = () => !teardown?.aborted;
  /** entry 层（profile patch 里的 config.groups）。工作区层在其上叠加。 */
  const baseGroups = options.baseGroups ?? [];
  // 默认 0 = 每次 list() 都按目录签名校验一次。签名包含内容哈希，所以变更立刻可见。
  // 成员数特别大（数百）且实测读取成本明显时，才考虑调大；代价是变更在 TTL 内不可见。
  const baseRevalidateMs = Number.isFinite(options.baseRevalidateMs) ? Number(options.baseRevalidateMs) : 0;

  /** 已解析的成员目录（绝对路径） -> { signature, members, checkedAt }。按目录而不是按集合名，因为不同工作区可以给同名集合指向不同目录。 */
  const cache = new Map();
  const warnedOnce = new Set();
  const warnOnce = (key, message) => {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    logger?.warn?.(message);
  };
  const warn = (m) => logger?.warn?.(`skill-tier: ${m}`);

  /**
   * 解析某个 cwd 的生效配置 = entry 层 ⊕ 工作区层。
   *
   * 刻意**不缓存**：`list()` 每个会话只调一两次（实测 4 步会话 1 次），重读一个小
   * JSON 的成本可以忽略，而缓存会带来「改了 .dsh/skill-tier.json 不生效」的坑 ——
   * 这正是本插件在成员扫描上极力避免的那类问题。
   */
  async function effective(cwd) {
    const ws = await loadWorkspaceConfig(cwd, warnOnce);
    const wsGroups = ws ? normalizeGroups(ws, warn) : [];
    return {
      groups: mergeGroups(baseGroups, wsGroups),
      revalidateMs: Number.isFinite(ws?.revalidateMs) ? Number(ws.revalidateMs) : baseRevalidateMs,
    };
  }

  /**
   * 读一遍成员目录，返回 { dir, signature, members, skipped }。
   *
   * 签名用**成员文件内容的哈希**，不用 mtime/size。原因是踩过坑：
   * 同步脚本按目录名原地重写内容、且新旧长度相同时，mtime 可能因为文件系统
   * 时间戳粒度（或同一时钟 tick 内的两次写入）**完全不变**，签名不变 → 缓存命中
   * → 索引永远停在旧版本。实测 ext4/overlay 上 `mtimeNs` 会在同 tick 内完全相同。
   *
   * 用内容哈希是可靠的；代价是每次调用都要把成员文件读一遍。这个代价可以接受：
   * 实测 `list()` 在 dsh 的注册表缓存下**每个会话只被调用 1 次**（4 步会话实测 1 次），
   * 不是每一步都调。83 个成员约 1.6MB，一次会话读一到两遍。
   */
  async function scanGroup(group) {
    const dir = resolve(expandHome(group.dir));
    if (!alive()) return { dir, signature: null, members: [], skipped: [] };
    const accept = compileMemberFilter(group.members || '*');

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      return { dir, error, signature: null, members: [], skipped: [] };
    }

    // 先定位候选文件，再并发读取（只读一遍，解析在签名未变时跳过）
    const slots = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (!accept(ent.name)) continue;
      if (ent.isDirectory() || ent.isSymbolicLink()) {
        slots.push({ name: ent.name, file: join(dir, ent.name, 'SKILL.md'), memberDir: join(dir, ent.name) });
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        slots.push({ name: ent.name, file: join(dir, ent.name), memberDir: dir });
      }
    }

    const texts = await Promise.all(slots.map((s) => readFile(s.file, 'utf8').catch(() => null)));
    const signature = createHash('sha1')
      .update(slots.map((s, i) => `${s.name}:${texts[i] === null ? '-' : createHash('sha1').update(texts[i]).digest('hex')}`).sort().join('\u0000'))
      .digest('hex');

    const hit = cache.get(dir);
    if (hit && hit.signature === signature) {
      hit.checkedAt = Date.now();
      return hit; // 内容没变：跳过解析与索引重建
    }

    const members = [];
    const skipped = [];
    slots.forEach((slot, i) => {
      const text = texts[i];
      if (text === null) return; // 目录在但没有 SKILL.md
      const fm = parseFrontmatter(splitFrontmatter(text));
      if (!fm.name || !fm.description) {
        skipped.push(`${slot.name}（缺 name/description）`);
        return;
      }
      if (!SKILL_NAME_RE.test(fm.name)) {
        skipped.push(`${slot.name}（name "${fm.name}" 不是 kebab-case）`);
        return;
      }
      members.push({
        name: fm.name,
        description: fm.description,
        whenToUse: fm.whenToUse,
        file: slot.file,
        dir: slot.memberDir,
      });
    });
    members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const record = { dir, signature, members, skipped, checkedAt: Date.now() };
    cache.set(dir, record);
    return record;
  }

  async function membersOf(group, signal, revalidateMs) {
    const dir = resolve(expandHome(group.dir));
    const hit = cache.get(dir);
    // TTL 只用于跳过重新读取；默认 0 = 每次都读，保证内容变更立刻可见
    if (hit && Date.now() - hit.checkedAt < revalidateMs) return hit.members;

    const scanned = await scanGroup(group);
    signal?.throwIfAborted?.();

    if (scanned.error) {
      warnOnce(
        `dir:${dir}`,
        `skill-tier: 集合 "${group.name}" 的目录不可读：${scanned.dir}（${scanned.error?.code ?? scanned.error}）` +
          ` —— 该集合不会出现在 catalog 里`,
      );
      return [];
    }
    if (scanned.skipped.length) {
      logger?.warn?.(
        `skill-tier: 集合 "${group.name}" 跳过 ${scanned.skipped.length} 个成员 —— ` +
          `${scanned.skipped.slice(0, 5).join('; ')}` +
          (scanned.skipped.length > 5 ? ` … 其余 ${scanned.skipped.length - 5} 个` : ''),
      );
    }
    return scanned.members;
  }

  function routerCandidate(group, members) {
    if (members.length === 0) return undefined;
    return {
      name: group.name,
      description: group.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: group.source,
      provider: PROVIDER,
      rank: group.rank,
      locator: { kind: 'router', groupName: group.name },
    };
  }

  function memberCandidates(group, members) {
    return members.map((m) => ({
      name: m.name,
      description: m.description,
      whenToUse: m.whenToUse,
      invocation: { modelInvocable: false, userInvocable: true },
      source: group.source,
      provider: PROVIDER,
      rank: group.rank,
      resourceBase: { kind: 'directory', path: m.dir },
      locator: { kind: 'member', groupName: group.name, file: m.file },
    }));
  }

  return {
    name: PROVIDER,

    async list(options = {}) {
      const out = [];
      if (!alive()) return out;
      const { groups, revalidateMs } = await effective(options.cwd);
      const owner = new Map(); // 成员名 -> 集合名，用于发现跨集合重名
      for (const group of groups) {
        options.signal?.throwIfAborted?.();
        const members = await membersOf(group, options.signal, revalidateMs);

        for (const m of members) {
          const prev = owner.get(m.name);
          if (prev && prev !== group.name) {
            logger?.warn?.(
              `skill-tier: 成员 "${m.name}" 同时出现在集合 "${prev}" 和 "${group.name}"，只有先注册的会生效`,
            );
          } else if (!prev) {
            owner.set(m.name, group.name);
          }
        }

        const router = routerCandidate(group, members);
        if (router) out.push(router);
        out.push(...memberCandidates(group, members));
      }
      return out;
    },

    async get(candidate, options = {}) {
      if (!alive()) return undefined;
      const locator = candidate.locator;
      const { groups, revalidateMs } = await effective(options.cwd);
      const group = groups.find((g) => g.name === locator?.groupName);
      if (!group) return undefined;
      options.signal?.throwIfAborted?.();

      if (locator.kind === 'router') {
        const members = await membersOf(group, options.signal, revalidateMs);
        if (members.length === 0) return undefined;
        return {
          name: group.name,
          description: group.description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: group.source,
          provider: PROVIDER,
          content: renderRouter(group, members, resolve(expandHome(group.dir))),
        };
      }

      // 每次 get() 现读文件，正文编辑立即生效
      let content;
      try {
        content = await readFile(locator.file, 'utf8');
      } catch {
        return undefined;
      }
      return {
        name: candidate.name,
        description: candidate.description,
        whenToUse: candidate.whenToUse,
        invocation: { modelInvocable: false, userInvocable: true },
        source: group.source,
        provider: PROVIDER,
        resourceBase: { kind: 'directory', path: dirname(locator.file) },
        content,
      };
    },
  };
}

export function apply(ctx, config) {
  const warn = (m) => ctx.logger?.warn?.(`skill-tier: ${m}`);
  const baseGroups = normalizeGroups(config, warn);
  // 写了 groups 却一条都没通过校验 = 配置错误，要人介入
  if (Array.isArray(config?.groups) && baseGroups.length === 0) {
    warn('config.groups 里没有有效条目');
  }
  const providerName = normalizeProviderName(config?.providerName, warn);

  // **总是注册。** 即使 entry 层一个集合都没有，工作区层仍可能提供 —— 这正是
  // 「装一次、按工作区生效」的前提。空 provider 的代价只是一次
  // <cwd>/.dsh/skill-tier.json 的读取，而它由注册表的 catalog 缓存挡住，
  // 每个会话只发生一两次。
  try {
    ctx.skills.registerProvider((control) =>
      createProvider(ctx.logger, {
        providerName,
        baseGroups,
        baseRevalidateMs: config?.revalidateMs,
        teardownSignal: control?.signal,
      }),
    );
  } catch (error) {
    throw explainRegistrationFailure(error, providerName);
  }
  ctx.logger?.info?.(
    `skill-tier: 已挂载（provider "${providerName}"；entry 层 ${baseGroups.length} 个集合` +
      `${baseGroups.length ? '：' + baseGroups.map((g) => g.name).join(', ') : ''}` +
      `；工作区层见 <cwd>/${WORKSPACE_CONFIG_REL}）`,
  );
}

export {
  parseFrontmatter,
  shortHint,
  renderRouter,
  compileMemberFilter,
  normalizeGroups,
  normalizeProviderName,
  explainRegistrationFailure,
  loadWorkspaceConfig,
  mergeGroups,
  WORKSPACE_CONFIG_REL,
  DEFAULT_PROVIDER_NAME,
  DEFAULT_RANK,
};
