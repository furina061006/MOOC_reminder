import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { INDEX_FILE, renderIndex } from '../../tools/gen-log-index.mjs';

/**
 * 仓库卫生检查。
 *
 * 这里守的是三条不靠「记得」的不变量：
 *  1. 抓取产物/隐私数据绝不进 git —— 本仓库是公开的，而 `element.txt` / `*.har` /
 *     `*-report.json` 里有使用者自己的课程与账号数据。`.gitignore` 只挡普通 `git add`，
 *     挡不住 `git add -f`，所以这里直接检查 git 索引。
 *  2. 反馈入口与打包配方不能被误删 —— issue 模板是外部用户唯一的提意见入口，
 *     打包清单只有 tools/package-extension.mjs 一份（CI 与发版都依赖它）。
 *  3. 日志索引不能过期 —— 它是生成物（tools/gen-log-index.mjs），手写或漏跑生成器都会腐烂。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gitLines(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function isIgnored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 与 .gitignore 末尾两段对应：抓取产物 + Claude Code 的本机脚手架
const FORBIDDEN_TRACKED = [
  /(^|\/)element\.txt$/i,
  /\.har$/i,
  /(^|\/)dto[^/]*\.json$/i,
  /-report\.json$/i,
  // settings.json 含本机绝对路径；scheduled_tasks.json / settings.local.json 是本机的
  /(^|\/)settings(\.local)?\.json$/i,
  /(^|\/)scheduled_tasks\.json$/i
];

test('隐私产物既被 .gitignore 忽略，也不在 git 索引里', { skip: !gitAvailable() && 'git 不可用' }, () => {
  for (const path of [
    'element.txt',
    'network.har',
    'dto1.json',
    'mooc-dto-report.json',
    // AI/工具的本机配置：.claude/ 已整目录忽略，.dsh/ 只放行 logs/ 与 agents/
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.dsh/settings.json',
    'mooc-reminder-v1.0.0.zip', // 本地打包产物，别误提交
    'npm-debug.log', 'debug.log' // 运行时输出
  ]) {
    assert.ok(isIgnored(path), path + ' 必须被 .gitignore 忽略');
  }

  // 反向守卫：日志目录不是「运行时输出」。本项目要共享的开发日志就在 .dsh/logs/，
  // 早先那条「忽略任何叫 logs 的目录」的规则曾把它整个吞掉（2026-09-21 丢过一批），
  // 所以现在只按文件类型挡 *.log ——任何叫 logs 的目录都必须能正常跟踪。
  assert.equal(isIgnored('.dsh/logs/changelog.md'), false, '.dsh/logs/ 是要共享的开发日志，不能被忽略');
  assert.equal(isIgnored('src/logs/notes.md'), false, '不要按目录名 logs 一刀切忽略');

  const tracked = gitLines(['ls-files']);
  const leaked = tracked.filter(path => FORBIDDEN_TRACKED.some(re => re.test(path)));
  assert.deepEqual(leaked, [], 'git 索引里出现了抓取产物/隐私数据（不要用 git add -f 绕过 .gitignore）');
});

test('社区入口文件都在（issue 表单 / PR 模板 / 贡献指南）', () => {
  for (const path of [
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/pull_request_template.md',
    'CONTRIBUTING.md'
  ]) {
    assert.ok(existsSync(join(root, path)), path + ' 不见了 —— 外部用户提意见的入口');
  }
});

test('issue 表单具备 GitHub Issue Forms 必需字段', () => {
  for (const file of ['bug_report.yml', 'feature_request.yml']) {
    const text = readFileSync(join(root, '.github/ISSUE_TEMPLATE', file), 'utf8');
    for (const key of ['name:', 'description:', 'body:', 'labels:']) {
      assert.match(text, new RegExp('^' + key, 'm'), file + ' 缺少顶层字段 ' + key);
    }
    assert.match(text, /^\s+validations:\s*$/m, file + ' 没有 validations —— 必填项不会被强制');
  }

  const config = readFileSync(join(root, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8');
  assert.match(config, /^blank_issues_enabled:\s*false$/m, '空白 issue 应为关闭：模板才是排查分流器');
  assert.match(config, /^contact_links:/m, '至少要留一个邮件/README 兜底入口');
});

test('根 AGENTS.md 是索引，细节在 .dsh/agents/（且都在 DSH 找得到的位置）', { skip: !gitAvailable() && 'git 不可用' }, () => {
  // DSH 只自动加载 AGENTS.md / CLAUDE.md 这两个文件名，位置决定作用域：
  // 仓库根目录 = 项目级指令（每轮都在上下文里），子目录 = 只对该目录生效。
  // 所以根目录的 AGENTS.md 只做「索引 + 红线 + 路由表」，细节在 .dsh/agents/。
  const index = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(existsSync(join(root, 'AGENTS.md')), '项目索引必须在仓库根目录，否则不再是项目级指令');
  assert.ok(Buffer.byteLength(index) < 16_000,
    'AGENTS.md 膨胀到 ' + Buffer.byteLength(index) + ' 字节了 —— 它是索引，细节应写进 .dsh/agents/');
  assert.match(index, /\.dsh\/agents\//, '索引必须给出 .dsh/agents/ 的路由');

  const agentDocs = [
    'architecture', 'platform', 'spoc', 'extraction', 'troubleshooting',
    'scheduling', 'invariants', 'data-model', 'operations'
  ];
  for (const name of agentDocs) {
    const rel = '.dsh/agents/' + name + '.md';
    assert.ok(existsSync(join(root, rel)), rel + ' 不见了 —— 索引的路由表指着它');
    // .dsh/* 会忽略一切，只靠否定规则放行 logs/ 与 agents/
    assert.equal(isIgnored(rel), false, rel + ' 必须被 .gitignore 否定规则放行');
  }
  assert.ok(existsSync(join(root, '.dsh/logs/changelog.md')), '更新日志应在 .dsh/logs/');
  assert.equal(isIgnored('.dsh/logs/changelog.md'), false, '.dsh/logs/ 必须被 .gitignore 否定规则放行');

  // 旧位置不得复活；.claude/ 已整个删除（只留一条忽略规则当安全带）
  assert.equal(existsSync(join(root, '.claude')), false, '.claude/ 已删除，不该再出现');
  assert.equal(existsSync(join(root, '.claude/CLAUDE.md')), false, '旧路径不该再存在');
  assert.equal(existsSync(join(root, '.claude/logs')), false, '旧日志目录不该再存在');
});

test('README 是精简入口，细节在 docs/（且外部锚点没被改掉）', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  // README 会被打进发布 zip（zip 里没有 docs/、.dsh/、CONTRIBUTING.md），
  // 所以它必须能独立阅读：指向仓库文件的链接一律绝对 URL，不能出现相对链接。
  const size = Buffer.byteLength(readme);
  assert.ok(size < 9_000, 'README 又长到 ' + size + ' 字节了 —— 细节应该放进 docs/');
  for (const bad of ['](docs/', '](.dsh/', '](CONTRIBUTING.md', '](./']) {
    assert.equal(readme.includes(bad), false, 'README 里不能出现相对链接 ' + bad + '（zip 里会变死链）');
  }

  // 外部锚点：.github/ISSUE_TEMPLATE/config.yml 与 CONTRIBUTING.md 正在用这两个标题
  assert.match(readme, /^## 局限性$/m, '外部链接 README.md#局限性 依赖这个标题');
  assert.match(readme, /^## 反馈建议$/m, '外部链接 README.md#反馈建议 依赖这个标题');

  // 细节文档必须在，且 README 用绝对链接指到每一个（拆分后仍然可发现）
  const base = 'https://github.com/furina061006/MOOC_reminder/blob/main/docs/';
  for (const name of ['features', 'faq', 'privacy', 'contributors']) {
    assert.ok(existsSync(join(root, 'docs', name + '.md')), 'docs/' + name + '.md 不见了');
    assert.ok(readme.includes(base + name + '.md'), 'README 必须链到 docs/' + name + '.md');
  }

  // 使用者文档面向的是「不会读源码的人」：每个文件都要能回到 README
  for (const name of ['features', 'faq', 'privacy', 'contributors']) {
    const doc = readFileSync(join(root, 'docs', name + '.md'), 'utf8');
    assert.match(doc, /\]\(\.\.\/README\.md\)/, 'docs/' + name + '.md 应该有返回 README 的链接');
  }
});

test('日志索引是生成物，且与 .dsh/logs/ 的实际内容一致', () => {
  // 索引的价值全在「不过期」上，而它最容易过期的方式是「有人忘了跑生成器」或
  // 「有人直接手改」。逐字节比对生成结果，两种都会当场失败（修法就是跑 npm run logs:index）。
  const committed = readFileSync(join(root, INDEX_FILE), 'utf8');
  assert.equal(committed, renderIndex(root),
    INDEX_FILE + ' 与生成结果不一致 —— 它是生成物，请跑 `npm run logs:index`（不要手改）');

  // 逐字节一致之外再确认一遍覆盖面：生成器若因正则/命名变化漏扫日志，这里会先说清楚
  const logs = readdirSync(join(root, '.dsh/logs'))
    .filter(name => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(name));
  assert.ok(logs.length >= 10, '.dsh/logs/ 里应该有按日期命名的开发日志');
  for (const name of logs) {
    assert.ok(committed.includes('](' + name + ')'), name + ' 没有出现在日志索引里');
  }
});

test('打包配方只有一处，两个 workflow 都调它', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.package || '', /tools\/package-extension\.mjs/);
  assert.ok(existsSync(join(root, 'tools/package-extension.mjs')));

  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm run package/);
  assert.match(ci, /upload-artifact/, 'PR 需要产出可下载的 zip，否则审查扩展的成本太高');

  const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(release, /npm run package/, '发版也必须复用同一份打包配方');
  assert.doesNotMatch(release, /zip -r "\.\.\/mooc-reminder/, '别再往 workflow 里抄一份文件清单');
});
