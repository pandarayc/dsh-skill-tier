#!/usr/bin/env node
/**
 * skill-tier 的行为测试。刻意不依赖任何测试框架：node --test 或直接 node 跑都行。
 *
 *   node test/skill-tier.test.mjs
 *
 * 每个用例自带临时目录，跑完自清。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  apply,
  parseFrontmatter,
  normalizeGroups,
  explainRegistrationFailure,
  DEFAULT_PROVIDER_NAME,
  DEFAULT_RANK,
} from '../lib/index.js';

// ── 极小测试框架 ──────────────────────────────────────────────────────
const results = [];
let current = null;
function test(name, fn) {
  current = { name, checks: [] };
  results.push(current);
  try {
    fn();
  } catch (e) {
    current.checks.push({ ok: false, label: `抛异常: ${e.message}` });
  }
  current = null;
}
function ok(cond, label, detail = '') {
  current.checks.push({ ok: !!cond, label, detail });
}
function eq(actual, expected, label) {
  current.checks.push({
    ok: actual === expected,
    label,
    detail: actual === expected ? '' : `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`,
  });
}

// ── 工具 ──────────────────────────────────────────────────────────────
function tmp(prefix = 'skill-tier-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}
function writeSkill(dir, name, { description = 'D', body = '# body\n', extra = '' } = {}) {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\n${extra}---\n${body}`);
  return d;
}

/** 用假 ctx 挂载插件，拿到它注册的 provider。 */
function mount(groups, extra = {}) {
  let provider;
  const warnings = [];
  const ctx = {
    skills: {
      registerProvider: (create) => {
        provider = create({ signal: undefined, invalidate: () => {} });
        return () => {};
      },
    },
    logger: { warn: (m) => warnings.push(String(m)), info: () => {} },
  };
  apply(ctx, { groups, ...extra });
  return { provider, warnings };
}

/** 模仿注册表对 skill 名的校验（kebab-case）。 */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ═══════════════════════════════════════════════════════════════════════

test('frontmatter: 引号 / 冒号 / 块标量 / BOM', () => {
  eq(parseFrontmatter('name: a\ndescription: "x: y"').description, 'x: y', '双引号内冒号');
  eq(parseFrontmatter("name: a\ndescription: 'q'").description, 'q', '单引号');
  eq(parseFrontmatter('name: a\ndescription: 飞书审批：查询处理').description, '飞书审批：查询处理', '未加引号的中文冒号');
  eq(
    parseFrontmatter('name: a\ndescription: >-\n  第一行\n  第二行').description,
    '第一行 第二行',
    '折叠块标量 >-',
  );
  eq(
    parseFrontmatter('name: a\ndescription: |\n  甲\n  乙').description,
    '甲\n乙',
    '字面块标量 |',
  );
});

test('frontmatter: 多行普通标量（YAML 允许，插件当前不支持）', () => {
  const fm = 'name: a\ndescription: 第一行\n  续行内容\n';
  eq(parseFrontmatter(fm).description, '第一行 续行内容', '普通标量续行应被拼上');
});

// ── 异步用例单独跑 ────────────────────────────────────────────────────
const asyncResults = [];
async function testAsync(name, fn) {
  const rec = { name, checks: [] };
  asyncResults.push(rec);
  const prev = current;
  current = rec;
  try {
    await fn();
  } catch (e) {
    rec.checks.push({ ok: false, label: `抛异常: ${e.message}` });
  }
  current = prev;
}

await testAsync('成员被列为 modelInvocable=false / userInvocable=true，索引相反', async () => {
  const store = tmp();
  try {
    writeSkill(store, 'grp-alpha', { description: '甲能力' });
    const { provider } = mount([{ name: 'grp', title: '组', description: '组入口', dir: store, members: 'grp-*' }]);
    const cands = await provider.list({});
    const router = cands.find((c) => c.name === 'grp');
    const member = cands.find((c) => c.name === 'grp-alpha');
    ok(router, '索引条目存在');
    ok(member, '成员条目存在');
    eq(router?.invocation.modelInvocable, true, '索引 modelInvocable=true');
    eq(member?.invocation.modelInvocable, false, '成员 modelInvocable=false');
    eq(member?.invocation.userInvocable, true, '成员 userInvocable=true');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('索引正文反映成员描述', async () => {
  const store = tmp();
  try {
    writeSkill(store, 'grp-alpha', { description: '甲能力：做甲事' });
    const { provider } = mount([{ name: 'grp', title: '组', description: '组入口', dir: store, members: 'grp-*' }]);
    const cands = await provider.list({});
    const router = cands.find((c) => c.name === 'grp');
    const def = await provider.get(router, {});
    ok(def.content.includes('grp-alpha'), '正文含成员名');
    ok(def.content.includes('做甲事'), '正文含成员用途');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('原地编辑成员描述后，索引必须跟着变（缓存失效）', async () => {
  const store = tmp();
  try {
    writeSkill(store, 'grp-alpha', { description: '旧描述AAAA' });
    const { provider } = mount([{ name: 'grp', title: '组', description: '组入口', dir: store, members: 'grp-*' }]);
    const c1 = (await provider.list({})).find((c) => c.name === 'grp');
    const body1 = (await provider.get(c1, {})).content;
    ok(body1.includes('旧描述AAAA'), '第一次是旧描述');

    // 只改内容，不改文件名（这正是 sync-lark-skills.mjs 重写磁盘时的形态）
    writeSkill(store, 'grp-alpha', { description: '新描述BBBB' });

    const c2 = (await provider.list({})).find((c) => c.name === 'grp');
    const body2 = (await provider.get(c2, {})).content;
    ok(body2.includes('新描述BBBB'), '索引应刷新为新描述', body2.includes('旧描述AAAA') ? '仍是旧描述 → 缓存未失效' : '');
    ok(!body2.includes('旧描述AAAA'), '不应残留旧描述');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('新增/删除成员能刷新（名字变化）', async () => {
  const store = tmp();
  try {
    writeSkill(store, 'grp-alpha', { description: 'A' });
    const { provider } = mount([{ name: 'grp', title: '组', description: '组入口', dir: store, members: 'grp-*' }]);
    await provider.list({});
    writeSkill(store, 'grp-beta', { description: 'B' });
    const cands = await provider.list({});
    ok(cands.some((c) => c.name === 'grp-beta'), '新成员被发现');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('group.name 不是 kebab-case 时必须被拦住（否则注册表整体报错）', async () => {
  const store = tmp();
  try {
    writeSkill(store, 'grp-alpha', { description: 'A' });
    const { provider, warnings } = mount([{ name: 'my_group', title: '组', description: '组入口', dir: store, members: 'grp-*' }]);
    ok(warnings.some((w) => w.includes('kebab-case')), '非法集合名有告警', JSON.stringify(warnings));
    // 全部集合都非法时不注册 provider（这是预期行为）
    if (provider) {
      const cands = await provider.list({});
      const bad = cands.filter((c) => !NAME_RE.test(c.name));
      eq(bad.length, 0, '不应产出非法 skill 名', bad.map((c) => c.name).join(','));
    }
    // 混一个合法集合时，非法的仍被挡住、合法的照常工作
    const mixed = mount([
      { name: 'my_group', title: '坏', description: 'x', dir: store, members: 'grp-*' },
      { name: 'grp', title: '好', description: 'y', dir: store, members: 'grp-*' },
    ]);
    const cands2 = await mixed.provider.list({});
    eq(cands2.filter((c) => !NAME_RE.test(c.name)).length, 0, '混合配置下也不产出非法名');
    ok(cands2.some((c) => c.name === 'grp'), '合法集合照常注册');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('成员名不是 kebab-case 时被跳过（已实现）', async () => {
  const store = tmp();
  try {
    writeSkill(store, 'grp-good', { description: 'A' });
    writeSkill(store, 'grp-bad', { description: 'B', extra: '' });
    // 直接把 name 改成带下划线的
    writeFileSync(join(store, 'grp-bad', 'SKILL.md'), '---\nname: grp_bad\ndescription: "B"\n---\nx\n');
    const { provider } = mount([{ name: 'grp', title: '组', description: '组入口', dir: store, members: 'grp-*' }]);
    const cands = await provider.list({});
    ok(!cands.some((c) => c.name === 'grp_bad'), '坏名字被跳过');
    ok(cands.some((c) => c.name === 'grp-good'), '好名字保留');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('目录不存在时应给出可观察的告警，而不是静默空组', async () => {
  const { provider, warnings } = mount([
    { name: 'grp', title: '组', description: '组入口', dir: '/nonexistent/definitely/not/here', members: 'grp-*' },
  ]);
  const cands = await provider.list({});
  eq(cands.length, 0, '没有候选');
  ok(warnings.some((w) => w.includes('不可读') || w.includes('不存在')), '应有告警', JSON.stringify(warnings));
});

await testAsync('索引正文里的取用提示应使用展开后的绝对路径（不是 ~）', async () => {
  const homeStore = join(homedir(), `.skill-tier-test-${process.pid}`);
  rmSync(homeStore, { recursive: true, force: true });
  try {
    writeSkill(homeStore, 'grp-alpha', { description: 'A' });
    const tilde = '~/' + homeStore.slice(homedir().length + 1);
    const { provider } = mount([{ name: 'grp', title: '组', description: '组入口', dir: tilde, members: 'grp-*' }]);
    const router = (await provider.list({})).find((c) => c.name === 'grp');
    ok(router, '配置里的 ~ 能被解析（因此有候选）');
    const def = await provider.get(router, {});
    ok(def.content.includes(homeStore), '正文提示应是绝对路径', def.content.match(/\`[^\`]*\`/)?.[0] ?? '');
    ok(!def.content.includes('~/.skill-tier-test'), '正文里不应残留 ~');
  } finally {
    rmSync(homeStore, { recursive: true, force: true });
  }
});

await testAsync('group.name 非法 / 重复时给出告警并跳过', async () => {
  const store = tmp();
  try {
    writeSkill(store, 'grp-alpha', { description: 'A' });
    const { provider, warnings } = mount([
      { name: 'bad_name', title: '坏', description: 'x', dir: store, members: 'grp-*' },
      { name: 'grp', title: '组', description: '组入口', dir: store, members: 'grp-*' },
      { name: 'grp', title: '重复', description: 'y', dir: store, members: 'grp-*' },
    ]);
    const cands = await provider.list({});
    eq(cands.filter((c) => c.name === 'grp').length, 1, '重复的集合只注册一次');
    ok(warnings.some((w) => w.includes('kebab-case')), '非法名有告警');
    ok(warnings.some((w) => w.includes('重名')), '重名有告警');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('description 超长时提醒会被截断', async () => {
  const store = tmp();
  try {
    writeSkill(store, 'grp-alpha', { description: 'A' });
    const { warnings } = mount([{ name: 'grp', title: '组', description: 'x'.repeat(600), dir: store }]);
    ok(warnings.some((w) => w.includes('截断')), '超长描述有告警', JSON.stringify(warnings));
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('members 支持 !排除', async () => {
  const store = tmp();
  try {
    writeSkill(store, 'grp-keep', { description: 'A' });
    writeSkill(store, 'grp-drop', { description: 'B' });
    const { provider } = mount([{ name: 'grp', title: '组', description: 'g', dir: store, members: 'grp-*,!grp-drop' }]);
    const cands = await provider.list({});
    ok(cands.some((c) => c.name === 'grp-keep'), '保留项在');
    ok(!cands.some((c) => c.name === 'grp-drop'), '排除项不在');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('目录恢复可读后应自动重新出现', async () => {
  const store = tmp();
  try {
    const missing = join(store, 'later');
    const { provider } = mount([{ name: 'grp', title: '组', description: 'g', dir: missing }]);
    eq((await provider.list({})).length, 0, '目录不存在时无候选');
    writeSkill(missing, 'grp-alpha', { description: 'A' });
    const cands = await provider.list({});
    ok(cands.some((c) => c.name === 'grp-alpha'), '目录出现后被自动发现');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('超过上限的成员数应触发索引再分层提示（当前无此能力）', async () => {
  const store = tmp();
  try {
    for (let i = 0; i < 120; i++) writeSkill(store, `grp-s${String(i).padStart(3, '0')}`, { description: `能力 ${i}` });
    const { provider } = mount([{ name: 'grp', title: '组', description: '组入口', dir: store, members: 'grp-*' }]);
    const cands = await provider.list({});
    const router = cands.find((c) => c.name === 'grp');
    const def = await provider.get(router, {});
    ok(def.content.length < 60_000, `120 个成员的索引正文 ${def.content.length} 字符（应可控）`);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('插件卸载（control.signal 中止）后不再产出候选', async () => {
  const store = tmp();
  try {
    writeSkill(store, 'grp-alpha', { description: 'A' });
    let provider;
    const ac = new AbortController();
    apply(
      { skills: { registerProvider: (create) => { provider = create({ signal: ac.signal, invalidate: () => {} }); } }, logger: { warn: () => {}, info: () => {} } },
      { groups: [{ name: 'grp', title: '组', description: 'g', dir: store, members: 'grp-*' }] },
    );
    ok((await provider.list({})).length > 0, '中止前有候选');
    ac.abort();
    eq((await provider.list({})).length, 0, '中止后不再产出候选');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

await testAsync('未配置 groups 时仍然注册 provider（工作区层可能提供），且不刷 warn', async () => {
  let provider;
  const warnings = [];
  const infos = [];
  apply(
    {
      skills: { registerProvider: (create) => { provider = create({ signal: undefined, invalidate: () => {} }); } },
      logger: { warn: (m) => warnings.push(String(m)), info: (m) => infos.push(String(m)) },
    },
    { revalidateMs: 0 },
  );
  ok(provider, '未配置也要注册 provider（否则工作区配置永远不生效）');
  eq((await provider.list({})).length, 0, '没有集合时不产出候选');
  eq(warnings.length, 0, '未配置不应产生 warn', JSON.stringify(warnings));
  ok(infos.some((m) => m.includes('工作区层')), 'info 里应提到工作区层', JSON.stringify(infos));
});

await testAsync('显式写了 groups 但全无效时要 warn', async () => {
  const warnings = [];
  apply(
    { skills: { registerProvider: () => () => {} }, logger: { warn: (m) => warnings.push(String(m)), info: () => {} } },
    { groups: [{ name: 'bad_name', dir: '/tmp' }] },
  );
  ok(warnings.some((m) => m.includes('没有有效条目')), '配置错误应有 warn', JSON.stringify(warnings));
});

// ─────────────── provider 名与默认档位（同层重名 / rank 平手） ───────────────

test('默认 rank 是 350 —— 避开与 customSkillDirs 的 300 平手', () => {
  eq(DEFAULT_RANK, 350, 'DEFAULT_RANK 常量');
  const def = normalizeGroups({ groups: [{ name: 'g', dir: '/tmp' }] }, () => {});
  eq(def[0].rank, DEFAULT_RANK, '未指定时用默认档位');
  const explicit = normalizeGroups({ groups: [{ name: 'g', dir: '/tmp', rank: 700 }] }, () => {});
  eq(explicit[0].rank, 700, '显式 rank 生效');
  const zero = normalizeGroups({ groups: [{ name: 'g', dir: '/tmp', rank: 0 }] }, () => {});
  eq(zero[0].rank, 0, 'rank 允许 0（最高优先级）');
});

test('providerName：默认值 / 显式值 / 非法值回退 / 保留名回退', () => {
  const store = tmp();
  try {
    const g = [{ name: 'grp', title: 'g', description: 'g', dir: store }];
    eq(mount(g).provider.name, DEFAULT_PROVIDER_NAME, '默认 provider 名');

    const named = mount(g, { providerName: 'skill-tier-lark' });
    eq(named.provider.name, 'skill-tier-lark', '显式 provider 名生效');
    ok(named.provider.list, '仍然产出 provider');

    const badName = mount(g, { providerName: 'Bad_Name' });
    eq(badName.provider.name, DEFAULT_PROVIDER_NAME, '非 kebab-case 回退默认名');
    ok(badName.warnings.some((w) => w.includes('providerName') && w.includes('kebab-case')), '非法名有告警', JSON.stringify(badName.warnings));

    const reserved = mount(g, { providerName: 'runtime' });
    eq(reserved.provider.name, DEFAULT_PROVIDER_NAME, '保留名 runtime 回退默认名');
    ok(reserved.warnings.some((w) => w.includes('保留名')), '保留名有告警', JSON.stringify(reserved.warnings));

    const empty = mount(g, { providerName: '' });
    eq(empty.provider.name, DEFAULT_PROVIDER_NAME, '空串回退默认名');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test('注册表报「已注册」时翻译成可操作的提示（保留原因）', () => {
  const raw = new Error('a skill provider named "skill-tier" is already registered in this scope');
  const translated = explainRegistrationFailure(raw, 'skill-tier');
  ok(translated !== raw, '应换成一个新错误而不是原样抛出');
  ok(translated.message.includes('只应挂一行'), '要说清正确写法', translated.message);
  ok(translated.message.includes('providerName'), '要给出多行场景的替代方案');
  ok(translated.message.includes('原始错误'), '要保留原始信息');
  eq(translated.cause, raw, '保留原始错误对象');

  const unrelated = new Error('boom');
  eq(explainRegistrationFailure(unrelated, 'x'), unrelated, '无关错误原样返回');
});

test('同一 profile 挂两行 → apply 抛出可操作的报错，而不是裸的注册表错误', () => {
  const warnings = [];
  const ctx = {
    skills: {
      registerProvider: () => {
        throw new Error('a skill provider named "skill-tier" is already registered');
      },
    },
    logger: { warn: (m) => warnings.push(String(m)), info: () => {} },
  };
  let caught;
  try {
    apply(ctx, { providerName: 'skill-tier' });
  } catch (e) {
    caught = e;
  }
  ok(caught, '应抛出');
  ok(caught?.message.includes('只应挂一行'), '报错要给出修法', caught?.message);
  ok(caught?.message.includes('skill-tier'), '报错要点出冲突的名字');
  ok(caught?.cause, '保留原始错误');
});

test('与 provider 名无关的注册失败应原样抛出，不被改写', () => {
  const boom = new Error('磁盘炸了');
  const ctx = {
    skills: {
      registerProvider: () => {
        throw boom;
      },
    },
    logger: { warn: () => {}, info: () => {} },
  };
  let caught;
  try {
    apply(ctx, {});
  } catch (e) {
    caught = e;
  }
  eq(caught, boom, '无关错误应原样抛出');
});

// ───────────────────────── 工作区层（.dsh/skill-tier.json） ─────────────────────────

/** 在 cwd 下写一个工作区配置文件。 */
function writeWorkspace(cwd, content) {
  mkdirSync(join(cwd, '.dsh'), { recursive: true });
  writeFileSync(join(cwd, '.dsh', 'skill-tier.json'), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

await testAsync('工作区配置能新增集合', async () => {
  const store = tmp();
  const ws = tmp();
  try {
    writeSkill(store, 'lark-doc', { description: '云文档' });
    writeWorkspace(ws, { groups: [{ name: 'lark', title: '飞书', description: '飞书入口', dir: store, members: 'lark-*' }] });
    const { provider } = mount([]);                       // entry 层为空
    eq((await provider.list({})).length, 0, '不带 cwd 时看不到工作区集合');
    const cands = await provider.list({ cwd: ws });
    ok(cands.some((c) => c.name === 'lark'), '带 cwd 时应出现工作区集合');
    ok(cands.some((c) => c.name === 'lark-doc'), '成员也应在');
  } finally {
    rmSync(store, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

await testAsync('工作区配置按 cwd 隔离，互不影响', async () => {
  const storeA = tmp();
  const storeB = tmp();
  const wsA = tmp();
  const wsB = tmp();
  try {
    writeSkill(storeA, 'sa-one', { description: 'A 集合成员' });
    writeSkill(storeB, 'sb-one', { description: 'B 集合成员' });
    writeWorkspace(wsA, { groups: [{ name: 'sa', title: 'A', description: 'A 入口', dir: storeA, members: 'sa-*' }] });
    writeWorkspace(wsB, { groups: [{ name: 'sb', title: 'B', description: 'B 入口', dir: storeB, members: 'sb-*' }] });
    const { provider } = mount([]);
    const a = await provider.list({ cwd: wsA });
    const b = await provider.list({ cwd: wsB });
    ok(a.some((c) => c.name === 'sa') && !a.some((c) => c.name === 'sb'), 'cwd A 只看到 A 的集合');
    ok(b.some((c) => c.name === 'sb') && !b.some((c) => c.name === 'sa'), 'cwd B 只看到 B 的集合');
  } finally {
    for (const d of [storeA, storeB, wsA, wsB]) rmSync(d, { recursive: true, force: true });
  }
});

await testAsync('同名集合以工作区层为准（覆盖 entry 层）', async () => {
  const storeEntry = tmp();
  const storeWs = tmp();
  const ws = tmp();
  try {
    writeSkill(storeEntry, 'e-one', { description: '来自 entry 层' });
    writeSkill(storeWs, 'w-one', { description: '来自工作区层' });
    const { provider } = mount([
      { name: 'grp', title: 'E', description: 'entry 入口', dir: storeEntry, members: '*' },
    ]);
    const before = await provider.get((await provider.list({ cwd: ws })).find((c) => c.name === 'grp'), {});
    ok(before.content.includes('来自 entry 层'), '没有工作区配置时用 entry 层');

    writeWorkspace(ws, { groups: [{ name: 'grp', title: 'W', description: '工作区入口', dir: storeWs, members: '*' }] });
    const c = (await provider.list({ cwd: ws })).find((x) => x.name === 'grp');
    const after = await provider.get(c, { cwd: ws });
    ok(after.content.includes('来自工作区层'), '同名时工作区层覆盖 entry 层');
    ok(!after.content.includes('来自 entry 层'), '不应残留 entry 层的成员');
  } finally {
    for (const d of [storeEntry, storeWs, ws]) rmSync(d, { recursive: true, force: true });
  }
});

await testAsync('工作区配置 JSON 坏掉时只告警一次并忽略，不影响 entry 层', async () => {
  const store = tmp();
  const ws = tmp();
  try {
    writeSkill(store, 'grp-a', { description: 'A' });
    writeWorkspace(ws, '{ 这不是 JSON');
    const { provider, warnings } = mount([
      { name: 'entry-grp', title: 'E', description: 'entry', dir: store, members: 'grp-*' },
    ]);
    const cands = await provider.list({ cwd: ws });
    ok(cands.some((c) => c.name === 'entry-grp'), '坏掉的工作区配置不该影响 entry 层');
    await provider.list({ cwd: ws });
    const hits = warnings.filter((w) => w.includes('不是合法 JSON'));
    eq(hits.length, 1, '同一个坏文件只告警一次', JSON.stringify(warnings));
  } finally {
    rmSync(store, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

await testAsync('工作区配置顶层不是对象时告警并忽略', async () => {
  const ws = tmp();
  try {
    writeWorkspace(ws, '[1,2,3]');
    const { provider, warnings } = mount([]);
    eq((await provider.list({ cwd: ws })).length, 0, '不该产出候选');
    ok(warnings.some((w) => w.includes('顶层必须是对象')), '应告警', JSON.stringify(warnings));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

await testAsync('工作区可以覆盖 revalidateMs', async () => {
  const store = tmp();
  const ws = tmp();
  try {
    writeSkill(store, 'grp-a', { description: '旧描述AAAA' });
    writeWorkspace(ws, {
      revalidateMs: 60000,
      groups: [{ name: 'grp', title: 'G', description: 'g', dir: store, members: 'grp-*' }],
    });
    const { provider } = mount([]);
    const c1 = (await provider.list({ cwd: ws })).find((c) => c.name === 'grp');
    await provider.get(c1, { cwd: ws });
    writeSkill(store, 'grp-a', { description: '新描述BBBB' });
    const c2 = (await provider.list({ cwd: ws })).find((c) => c.name === 'grp');
    const body = (await provider.get(c2, { cwd: ws })).content;
    ok(body.includes('旧描述AAAA'), 'TTL 内应命中缓存（这正是 revalidateMs>0 的语义）');
  } finally {
    rmSync(store, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── 汇总 ──────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const all = [...results, ...asyncResults];
for (const rec of all) {
  const bad = rec.checks.filter((c) => !c.ok);
  if (bad.length === 0 && rec.checks.length) {
    pass++;
    console.log(`\x1b[32m✓\x1b[0m ${rec.name}`);
  } else {
    fail++;
    console.log(`\x1b[31m✗\x1b[0m ${rec.name}`);
    for (const c of (bad.length ? bad : [{ label: '没有任何断言' }])) {
      console.log(`    - ${c.label}${c.detail ? `  [${c.detail}]` : ''}`);
    }
  }
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
