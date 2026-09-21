import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * 仓库卫生检查。
 *
 * 这里守的是两条不靠「记得」的不变量：
 *  1. 抓取产物/隐私数据绝不进 git —— 本仓库是公开的，而 `element.txt` / `*.har` /
 *     `*-report.json` 里有使用者自己的课程与账号数据。`.gitignore` 只挡普通 `git add`，
 *     挡不住 `git add -f`，所以这里直接检查 git 索引。
 *  2. 反馈入口与打包配方不能被误删 —— issue 模板是外部用户唯一的提意见入口，
 *     打包清单只有 tools/package-extension.mjs 一份（CI 与发版都依赖它）。
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

// 与 .gitignore 末尾那段「Local diagnostic dumps」对应
const FORBIDDEN_TRACKED = [
  /(^|\/)element\.txt$/i,
  /\.har$/i,
  /(^|\/)dto[^/]*\.json$/i,
  /-report\.json$/i,
  /(^|\/)settings\.local\.json$/i
];

test('隐私产物既被 .gitignore 忽略，也不在 git 索引里', { skip: !gitAvailable() && 'git 不可用' }, () => {
  for (const path of [
    'element.txt',
    'network.har',
    'dto1.json',
    'mooc-dto-report.json',
    '.claude/settings.local.json',
    'mooc-reminder-v1.0.0.zip' // 本地打包产物，别误提交
  ]) {
    assert.ok(isIgnored(path), path + ' 必须被 .gitignore 忽略');
  }

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
