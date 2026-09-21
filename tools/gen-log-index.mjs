/**
 * 生成 `.dsh/logs/README.md` —— 开发日志目录的索引。
 *
 * 为什么是生成而不是手写：手写索引要每次重新读日志、提炼主题、归类，漏一次就过期，
 * 而「过期」这种腐烂平时看不出来。这里让索引**完全由日志本身派生**：
 *   - 主题 = 各日志首行的 `# 标题`（写日志时本来就要写标题，不额外增加任何写作成本）
 *   - 日期、文件名、月份分组 = 文件本身
 *   - 常设文档（changelog / architecture 这类非日期文件）= 下面的 STANDING_DOCS，一条一行
 * 于是「维护索引」退化成「跑一条命令」。忘记跑也不会烂：`tests/unit/repo-hygiene.test.mjs`
 * 断言提交的 README.md 与重新生成的结果**逐字节一致**，`npm run validate` 会直接打回。
 *
 * 用法：
 *   npm run logs:index                    # 重新生成（唯一的写入方式）
 *   node tools/gen-log-index.mjs --check  # 只检查是否过期，不改文件（过期则退出码 1）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...args) => console.error('[logs:index]', ...args);

const DATED = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;

/**
 * 非日期文件的「常设文档」：`[文件名, 索引里的一句话说明]`。
 * 新增这类文件时往这里加一行即可；不在表里又不是日期文件的话，生成器会直接报错，
 * 以免某个日志悄悄从索引里消失。
 */
const STANDING_DOCS = [
  ['changelog.md', '面向用户的版本更新记录（可感知的新增 / 变更 / 修复）'],
  ['architecture.md', '2026-09-01 的完整架构快照 —— **历史存档**，现行事实见 [`../agents/`](../agents/)']
];

export const LOG_DIR = '.dsh/logs';
export const INDEX_FILE = '.dsh/logs/README.md';

export function indexPath(repoRoot = root) {
  return join(repoRoot, INDEX_FILE);
}

/** 首行 `# 标题`；缺标题就报错（索引的主题只能来自这里，不能让日志静默无名）。 */
function headingOf(file, text) {
  const line = text.split('\n').find(l => l.startsWith('# '));
  if (!line) {
    throw new Error(`${LOG_DIR}/${file} 缺少首行「# 标题」—— 它是索引里的主题，必须补上`);
  }
  return line.slice(2).trim();
}

/**
 * 标题里前导/结尾的日期是冗余的（日期已有独立列），去掉；中间出现的日期保留
 * （例如「backlog 2026-09-01 审查问题的修复」说的是历史日期，不是本篇的日期）。
 */
function tidyTitle(heading) {
  const tidied = heading
    .replace(/^\d{4}-\d{2}-\d{2}\s*[—–\-:：]?\s*/, '')
    .replace(/\s*[—–\-]\s*\d{4}-\d{2}-\d{2}\s*$/, '')
    .trim();
  return tidied || heading;
}

/** 表格单元格：竖线会截断列，必须转义。 */
function cell(text) {
  return text.replace(/\|/g, '\\|');
}

/**
 * 渲染索引全文（纯函数：只读 `.dsh/logs/`，不写盘）。测试直接调它做逐字节比对。
 * @param {string} [repoRoot] 仓库根目录，默认本文件所在仓库
 */
export function renderIndex(repoRoot = root) {
  const dir = join(repoRoot, LOG_DIR);
  const files = readdirSync(dir).filter(name => name.endsWith('.md') && name !== 'README.md').sort();

  const dated = [];
  const standing = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const match = DATED.exec(file);
    if (match) {
      dated.push({
        date: match[1],
        file,
        title: tidyTitle(headingOf(file, text))
      });
    } else if (STANDING_DOCS.some(([name]) => name === file)) {
      standing.push(file);
    } else {
      throw new Error(
        `${LOG_DIR}/${file} 既不是「YYYY-MM-DD-*.md」也不是常设文档 —— ` +
        '请改成日期文件名，或在 tools/gen-log-index.mjs 的 STANDING_DOCS 里登记一行'
      );
    }
  }

  // 新的在前；同一天按文件名稳定排序，保证 CI 比对可复现
  dated.sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file));

  const months = new Map();
  for (const entry of dated) {
    const month = entry.date.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(entry);
  }

  const out = [];
  out.push('# 开发日志索引');
  out.push('');
  out.push(
    '> **本文件由 `npm run logs:index` 生成，请勿手改。** 索引里的主题就是各日志的首行 `# 标题`，' +
    '日期与文件名取自文件本身；`npm run validate` 里有一条测试断言本文件与生成结果逐字节一致，' +
    '所以忘了跑生成器会被 CI 打回，索引不会悄悄过期。'
  );
  out.push('');
  out.push(
    '面向**使用者**的更新记录在 [`changelog.md`](changelog.md)。这里是面向**开发者**的过程记录：' +
    '为什么这么改、试过哪些死路、根因是什么，以及当时被否决的方案。现行技术事实在 ' +
    '[`.dsh/agents/`](../agents/)（入口见仓库根目录 [`AGENTS.md`](../../AGENTS.md)）——' +
    '日志是**历史快照**，与现行文档冲突时以 `.dsh/agents/` 为准。'
  );
  out.push('');
  out.push('## 常设文档');
  out.push('');
  out.push('| 文档 | 说明 |');
  out.push('| --- | --- |');
  // 按 STANDING_DOCS 的登记顺序排（changelog 是主入口，应排在历史存档前），不看文件名
  for (const [file, description] of STANDING_DOCS) {
    if (standing.includes(file)) out.push(`| [\`${file}\`](${file}) | ${description} |`);
  }
  out.push('');
  out.push(`## 按日期（共 ${dated.length} 篇）`);
  for (const [month, entries] of months) {
    out.push('');
    out.push(`### ${month}（${entries.length} 篇）`);
    out.push('');
    out.push('| 日期 | 主题 |');
    out.push('| --- | --- |');
    for (const entry of entries) {
      out.push(`| ${entry.date} | [${cell(entry.title)}](${entry.file}) |`);
    }
  }
  out.push('');
  return out.join('\n');
}

// 命令行入口：直接运行时才写盘/校验；被测试 import 时不产生副作用
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = indexPath(root);
  const expected = renderIndex(root);

  if (process.argv.includes('--check')) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (current !== expected) {
      log('索引已过期：', INDEX_FILE, '—— 跑 `npm run logs:index` 重新生成');
      process.exit(1);
    }
    log('索引是最新的：', INDEX_FILE);
  } else {
    writeFileSync(target, expected);
    log('已写入', INDEX_FILE, `(${Buffer.byteLength(expected)} 字节)`);
  }
}
