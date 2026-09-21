/**
 * 打一个「解压即可加载」的扩展包 —— 本地与两个 workflow 共用同一份配方。
 *
 * 背景：发布包的清单曾经只写在 `.github/workflows/release.yml` 里。CI 也需要一个
 * 可下载的 zip（审查浏览器扩展的代码门槛高，装上试最快），如果把清单抄一份过去，
 * 就又制造了一对必然漂移的副本 —— 这个项目已经被「两份拷贝漂移」坑过一次
 * （见 CLAUDE.md 不变量 12）。所以清单只留在这里。
 *
 * 用法：
 *   npm run package             # 产出 <repo>/mooc-reminder-v{version}.zip
 *   asset="$(npm run package --silent | tail -n 1)"   # workflow 取产物名
 *
 * 约定：**人类可读的过程日志走 stderr**，stdout 只输出最后一行产物文件名，
 * 这样 `--silent` 时调用方拿到的就是干净的一个值。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...args) => console.error('[package]', ...args);

const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;
const stage = join(root, 'dist', 'MOOC_reminder');
const assetName = `mooc-reminder-v${version}.zip`;
const assetPath = join(root, assetName);

// 幂等：dist/ 是 gitignored 的构建产物，每次从零重建
rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 显式清单：运行期只需要这些，tests/.dsh/.github/tools 一律不进包
for (const file of ['manifest.json', 'README.md', 'LICENSE']) {
  cpSync(join(root, file), join(stage, file));
}
cpSync(join(root, 'src'), join(stage, 'src'), { recursive: true });

// 防御：入口文件必须真的在包里，否则打出来的包装不上
const required = ['manifest.json', 'src/background/service-worker.js', 'src/popup/popup.html'];
for (const file of required) {
  if (!existsSync(join(stage, file))) {
    throw new Error(`打包清单漏了 ${file} —— 这个包加载不到扩展`);
  }
}

rmSync(assetPath, { force: true });
// 归档写成绝对路径（落在仓库根目录），但包内条目是相对 cwd 的 MOOC_reminder/...
execFileSync('zip', ['-r', '-q', assetPath, 'MOOC_reminder'], { cwd: join(root, 'dist') });

log('version:', version);
log('staged:', required.length, 'entry file(s) verified');
log('asset:', assetName);

// stdout 只留产物名（相对仓库根目录）
console.log(assetName);
