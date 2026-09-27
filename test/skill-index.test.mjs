#!/usr/bin/env node
/**
 * skill-index 的行为测试。刻意不依赖任何测试框架：node --test 或直接 node 跑都行。
 *
 *   node plugins/skill-index.test.mjs
 *
 * 每个用例自带临时目录，跑完自清。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { apply, parseFrontmatter, shortHint } from '../lib/index.js';

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
function tmp(prefix = 'skill-index-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}
function writeSkill(dir, name, { description = 'D', body = '# body\n', extra = '' } = {}) {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\n${extra}---\n${body}`);
  return d;
}

/** 用假 ctx 挂载插件，拿到它注册的 provider。 */
function mount(groups) {
  let provider;
  const warnings = [];
  const ctx = {
    skills: { registerProvider: (create) => { provider = create({ signal: undefined, invalidate: () => {} }); return () => {}; } },
    logger: { warn: (m) => warnings.push(String(m)), info: () => {} },
  };
  apply(ctx, { groups });
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
  const homeStore = join(homedir(), `.skill-index-test-${process.pid}`);
  rmSync(homeStore, { recursive: true, force: true });
  try {
    writeSkill(homeStore, 'grp-alpha', { description: 'A' });
    const tilde = '~/' + homeStore.slice(homedir().length + 1);
    const { provider } = mount([{ name: 'grp', title: '组', description: '组入口', dir: tilde, members: 'grp-*' }]);
    const router = (await provider.list({})).find((c) => c.name === 'grp');
    ok(router, '配置里的 ~ 能被解析（因此有候选）');
    const def = await provider.get(router, {});
    ok(def.content.includes(homeStore), '正文提示应是绝对路径', def.content.match(/\`[^\`]*\`/)?.[0] ?? '');
    ok(!def.content.includes('~/.skill-index-test'), '正文里不应残留 ~');
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

await testAsync('未配置 groups 时保持安静（只有 info，不刷 warn）', async () => {
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
  eq(provider, undefined, '未配置时不注册 provider');
  eq(warnings.length, 0, '未配置不应产生 warn', JSON.stringify(warnings));
  ok(infos.some((m) => m.includes('尚未配置')), '应给出 info 提示', JSON.stringify(infos));
});

await testAsync('显式写了 groups 但全无效时要 warn', async () => {
  const warnings = [];
  apply(
    { skills: { registerProvider: () => () => {} }, logger: { warn: (m) => warnings.push(String(m)), info: () => {} } },
    { groups: [{ name: 'bad_name', dir: '/tmp' }] },
  );
  ok(warnings.some((m) => m.includes('没有有效条目')), '配置错误应有 warn', JSON.stringify(warnings));
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
