/**
 * 免安装包构建：同一份源码 + 官方 Node / 独立 Python 运行时 + 装好的依赖 + 打包好的页面 → 一个 zip。
 *
 * 🔴 只在目标平台上构建：依赖里有按平台区分的二进制（esbuild / rollup 的原生包，pandas / lxml 的轮子），
 *    在 macOS 上装出来的依赖拿到 Windows 用不了。CI 在各平台各跑一次。
 * 🔴 运行时只从 runtimes.json 写死的官方地址下载，下载后核对 SHA256，对不上就停。
 * 源码只取 git 记录的文件：本机数据（.local）、密钥、没进仓库的草稿都不会进包。
 *
 * 用法：node scripts/portable/build.mts [--out <目录>] [--cache <目录>]
 *   默认输出到 dist/portable/（已被 .gitignore 的 dist/ 覆盖），下载缓存在 <输出目录>/cache/。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export type Target = "mac-arm64" | "mac-x64" | "win-x64";
export const TARGETS: readonly Target[] = ["mac-arm64", "mac-x64", "win-x64"];
export interface RuntimeSpec { url: string; sha256: string }
export interface RuntimeEntry { version: string; targets: Record<Target, RuntimeSpec> }
export interface Runtimes { node: RuntimeEntry; python: RuntimeEntry }

/** 只认这两个官方发布地址（Node 官网、python-build-standalone 的 GitHub Release） */
const OFFICIAL: Record<keyof Runtimes, string> = {
  node: "https://nodejs.org/dist/",
  python: "https://github.com/astral-sh/python-build-standalone/releases/download/",
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** macOS 包的最低系统版本：取数依赖 numpy 的轮子要 macOS 14（Node 24 要 13.5）。
 *  构建时按装好的轮子核对，超过就停；启动脚本 start-portable.sh 用同一个数拦旧系统，README 也写这个数 */
export const MIN_MACOS = 14;
/** 包里的使用说明文件名：用 ASCII，Windows 自带的 tar 打 zip 不标 UTF-8，中文名在别的电脑上解出来会乱码 */
export const README_NAME = "README-portable.txt";

/** 是不是被直接运行（node build.mts …）。先解开符号链接再比：macOS 的 /tmp 是 /private/tmp 的链接，import.meta.url 给的是解开后的路径 */
export function isMain(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}

/** 轮子标签里要求的最高 macOS 版本（macosx_14_0_arm64 → [14, 0]）；没有按 macOS 区分的轮子是 [0, 0] */
export function macosNeededByTags(tags: readonly string[]): [number, number] {
  let best: [number, number] = [0, 0];
  for (const t of tags) {
    for (const m of t.matchAll(/macosx_(\d+)_(\d+)/g)) {
      const v: [number, number] = [Number(m[1]), Number(m[2])];
      if (v[0] > best[0] || (v[0] === best[0] && v[1] > best[1])) best = v;
    }
  }
  return best;
}

/** 包里 Python 装好的每个包的 WHEEL 标签（runtime/python/lib/python3.x/site-packages/*.dist-info/WHEEL 的 Tag 行） */
function wheelTags(pkgDir: string): string[] {
  const lib = path.join(pkgDir, "runtime", "python", "lib");
  const tags: string[] = [];
  for (const py of fs.readdirSync(lib).filter((n) => /^python3\.\d+$/.test(n))) {
    const site = path.join(lib, py, "site-packages");
    if (!fs.existsSync(site)) continue;
    for (const d of fs.readdirSync(site).filter((n) => n.endsWith(".dist-info"))) {
      const wheel = path.join(site, d, "WHEEL");
      if (!fs.existsSync(wheel)) continue;
      for (const line of fs.readFileSync(wheel, "utf8").split(/\r?\n/)) if (line.startsWith("Tag:")) tags.push(line.slice(4).trim());
    }
  }
  return tags;
}

/** 进包的源码文件名一律 ASCII（理由同 README_NAME）。docs/ 下中文名的历史验收记录不进包（运行用不到）；
 *  别处出现非 ASCII 文件名就停下，免得包里悄悄少了文件或在 Windows 上变成乱码 */
export function packFiles(files: readonly string[]): { keep: string[]; skipped: string[] } {
  const ascii = (f: string) => /^[\x20-\x7e]+$/.test(f);
  const bad = files.filter((f) => !ascii(f) && !f.startsWith("docs/"));
  if (bad.length) throw new Error(`这些文件名不是 ASCII，进包后在 Windows 上会乱码：${bad.slice(0, 5).join("、")}${bad.length > 5 ? " 等" : ""}。改成英文名再构建`);
  return { keep: files.filter(ascii), skipped: files.filter((f) => !ascii(f)) };
}

export function targetOf(platform: string, arch: string): Target | null {
  if (platform === "darwin" && arch === "arm64") return "mac-arm64";
  if (platform === "darwin" && arch === "x64") return "mac-x64";
  if (platform === "win32" && arch === "x64") return "win-x64";
  return null;
}

/** 读运行时清单并逐项检查：每个平台都要有官方地址和 64 位十六进制 SHA256，版本号要出现在地址里；不合规直接报错，不下载 */
export function parseRuntimes(raw: unknown): Runtimes {
  const obj = raw as Record<string, unknown> | null;
  const out = {} as Runtimes;
  for (const kind of ["node", "python"] as const) {
    const entry = obj?.[kind] as { version?: unknown; targets?: Record<string, { url?: unknown; sha256?: unknown }> } | undefined;
    if (!entry || typeof entry.version !== "string" || !/^\d+\.\d+\.\d+$/.test(entry.version)) throw new Error(`runtimes.json:${kind} 缺版本号`);
    const targets = {} as Record<Target, RuntimeSpec>;
    for (const t of TARGETS) {
      const spec = entry.targets?.[t];
      const url = typeof spec?.url === "string" ? spec.url : "";
      const sha = typeof spec?.sha256 === "string" ? spec.sha256 : "";
      if (!url.startsWith(OFFICIAL[kind])) throw new Error(`runtimes.json:${kind} ${t} 的地址不是官方发布地址（要以 ${OFFICIAL[kind]} 开头）`);
      if (!decodeURIComponent(url).includes(entry.version)) throw new Error(`runtimes.json:${kind} ${t} 的地址和版本 ${entry.version} 对不上`);
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`runtimes.json:${kind} ${t} 的 SHA256 不是 64 位十六进制`);
      targets[t] = { url, sha256: sha };
    }
    out[kind] = { version: entry.version, targets };
  }
  return out;
}

export function sha256Of(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function checkSha256(file: string, expected: string): void {
  const got = sha256Of(file);
  if (got !== expected) throw new Error(`${path.basename(file)} 的 SHA256 对不上：应为 ${expected}，实际 ${got}。这个文件不用`);
}

/** 包里各样东西的位置（启动脚本 start-portable.sh / .ps1 按同样的位置找） */
export function layoutOf(target: Target) {
  const win = target === "win-x64";
  return {
    node: win ? "runtime/node/node.exe" : "runtime/node/bin/node",
    npmCli: win ? "runtime/node/node_modules/npm/bin/npm-cli.js" : "runtime/node/lib/node_modules/npm/bin/npm-cli.js",
    python: win ? "runtime/python/python.exe" : "runtime/python/bin/python3",
    launcher: win ? "Start-VibeResearch.cmd" : "Start-VibeResearch.command",
  };
}

export const packageName = (version: string, target: Target) => `VibeResearch-${version}-${target}`;

/** 要进包的源码：git 记录的文件（删了还没提交的跳过，符号链接不进） */
export function sourceFiles(root: string): string[] {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files 失败：${r.stderr || r.error?.message || r.status}。要在仓库的 git 检出里构建`);
  return r.stdout.split("\0").filter((f) => {
    if (!f) return false;
    try { return fs.lstatSync(path.join(root, f)).isFile(); } catch { return false; }
  });
}

/** 包里的使用说明（中英两段）；数据位置、升级、未签名提示与 README 一致 */
export function readmeText(version: string, target: Target): string {
  const win = target === "win-x64";
  const launcher = layoutOf(target).launcher;
  return [
    `Vibe Research ${version} 免安装版（${win ? "Windows x64" : target === "mac-arm64" ? "macOS Apple 芯片" : "macOS Intel"}）`,
    "",
    win ? "系统要求：64 位 Windows 10 或更新版本。" : `系统要求：macOS ${MIN_MACOS} 或更新版本。`,
    `启动：双击 ${launcher}。会开一个${win ? "命令行" : "终端"}窗口，浏览器自动打开 http://127.0.0.1:5930；关掉那个窗口就退出。`,
    "端口：5930 被别的程序占用或被系统保留时，会自动换一个空闲端口，以窗口里显示的地址为准。已经开着一个 Vibe Research 时会提示直接打开它。换了端口后，「接入 AI」里的模型 API 设置和对话记录要在新地址重新设置（存在浏览器里、按地址分开）；5930 空出来后重启就回到原来的。",
    win
      ? "第一次双击如果弹出「Windows 已保护你的电脑」：这个包没有代码签名，点「更多信息」→「仍要运行」。"
      : "第一次如果提示「无法验证开发者」：这个包没有代码签名。在终端运行 xattr -dr com.apple.quarantine 加上这个文件夹的路径，再双击启动。",
    win
      ? "数据：放在这个文件夹的 .local 里（交易流水、研究记录、设置都在这里）。"
      : "数据：放在这个文件夹的 .local 里（交易流水、研究记录、设置都在这里）。访达默认不显示以点开头的文件夹，按 Command+Shift+.（句点）就能看到。",
    "升级：下载新版本的包解压到新文件夹，把旧文件夹里的 .local 整个复制过去，再双击新文件夹里的启动文件。旧文件夹确认没问题后再删。",
    "AI：沿用你电脑上已登录的 Claude Code / Codex / WorkBuddy，或在设置页填模型 API。",
    "新版提示：每天联网查一次 GitHub 上有没有新版本（只发送版本号；没查成隔一小时再试），可在「接入 AI」页最下面关掉。",
    "",
    `Vibe Research ${version} portable (${target})`,
    "",
    win ? "Requires 64-bit Windows 10 or later." : `Requires macOS ${MIN_MACOS} or later.`,
    `Start: double-click ${launcher}. A ${win ? "console" : "Terminal"} window opens and your browser goes to http://127.0.0.1:5930; close that window to quit.`,
    "Port: if 5930 is taken by another program or reserved by the system, a free port is picked automatically; use the address shown in that window. If Vibe Research is already running, you are told to open that one instead. After a switch, the model API settings and chat history on the \"接入 AI\" page need to be set up again at the new address (they live in the browser and are kept per address); once 5930 is free again, a restart brings back the original ones.",
    win
      ? "If Windows SmartScreen blocks it the first time: the package is not code-signed. Click \"More info\" -> \"Run anyway\"."
      : "If macOS says the developer cannot be verified: the package is not code-signed. In Terminal run xattr -dr com.apple.quarantine followed by this folder's path, then double-click again.",
    win
      ? "Data: kept in this folder's .local directory."
      : "Data: kept in this folder's .local directory. Finder hides folders whose names start with a dot; press Command+Shift+. (period) to show them.",
    "Upgrade: unzip the new package into a new folder, copy the old folder's .local into it, then start from the new folder. Delete the old folder once everything looks right.",
    "Update notice: once a day the app asks GitHub whether a newer version exists (only the version number is sent; after a failed check it retries an hour later). Turn it off at the bottom of the \"接入 AI\" page.",
    "",
  ].join(win ? "\r\n" : "\n");
}

function run(cmd: string, args: readonly string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): void {
  console.log(`[build] ${path.basename(cmd)} ${args.join(" ")}  (${path.relative(repoRoot, opts.cwd) || "."})`);
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: "inherit" });
  if (r.error) throw new Error(`${cmd} 没能运行：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0] ?? ""} 失败（退出码 ${r.status}）`);
}

/** 系统自带的 tar（macOS 和 Windows 10 起都是 bsdtar，zip 和 tar.gz 都能解）；不用 PATH 里的，免得撞上 Git 带的 GNU tar */
function systemTar(): string {
  return process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
}

async function download(spec: RuntimeSpec, cacheDir: string): Promise<string> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, decodeURIComponent(path.basename(new URL(spec.url).pathname)));
  if (fs.existsSync(file)) {
    try { checkSha256(file, spec.sha256); console.log(`[build] 用缓存 ${path.basename(file)}`); return file; } catch { fs.rmSync(file); }
  }
  console.log(`[build] 下载 ${spec.url}`);
  const res = await fetch(spec.url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）：${spec.url}`);
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(part));
  try { checkSha256(part, spec.sha256); } catch (e) { fs.rmSync(part, { force: true }); throw e; }
  fs.renameSync(part, file);
  return file;
}

/** 解开压缩包，把里面唯一的顶层目录放到 dest */
function extractInto(archive: string, dest: string): void {
  const tmp = fs.mkdtempSync(path.join(path.dirname(dest), ".x-"));
  try {
    run(systemTar(), ["-xf", archive, "-C", tmp], { cwd: path.dirname(dest) });
    const top = fs.readdirSync(tmp);
    if (top.length !== 1) throw new Error(`${path.basename(archive)} 解开后应只有一个顶层目录，实际是：${top.join("、")}`);
    fs.renameSync(path.join(tmp, top[0]!), dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function zipDir(dir: string, zip: string): void {
  fs.rmSync(zip, { force: true });
  // macOS 用 ditto：保留可执行位和符号链接（Node 运行时里的 npm、npx 是符号链接）
  // 不带资源分叉、扩展属性和 ACL：构建机上的隔离标记、访达信息之类不该跟进包里
  if (process.platform === "darwin") run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noacl", "--keepParent", dir, zip], { cwd: path.dirname(dir) });
  else run(systemTar(), ["-a", "-c", "-f", zip, "-C", path.dirname(dir), path.basename(dir)], { cwd: path.dirname(dir) });
}

function argValue(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} 后面要跟目录`);
  return path.resolve(v);
}

export async function build(argv: readonly string[]): Promise<{ dir: string; zip: string }> {
  const unknown = argv.filter((a, i) => a.startsWith("--") && !["--out", "--cache"].includes(a) && !["--out", "--cache"].includes(argv[i - 1] ?? ""));
  if (unknown.length) throw new Error(`未知参数：${unknown.join(" ")}（可用：--out <目录>、--cache <目录>）`);
  const target = targetOf(process.platform, process.arch);
  if (!target) throw new Error(`只能在 macOS（Apple 芯片 / Intel）或 Windows x64 上构建，当前是 ${process.platform}-${process.arch}。依赖里有按平台区分的二进制，不能交叉构建`);
  const version = String(JSON.parse(fs.readFileSync(path.join(repoRoot, "orchestrator", "package.json"), "utf8")).version);
  const runtimes = parseRuntimes(JSON.parse(fs.readFileSync(path.join(here, "runtimes.json"), "utf8")));
  const out = argValue(argv, "--out") ?? path.join(repoRoot, "dist", "portable");
  const cache = argValue(argv, "--cache") ?? path.join(out, "cache");
  const name = packageName(version, target);
  const dir = path.join(out, name);
  const L = layoutOf(target);

  const zip = path.join(out, `${name}.zip`);

  fs.mkdirSync(out, { recursive: true });
  // 先删上一次的成品：这次中途失败时，不会留下一个旧 zip 被当成这次的
  fs.rmSync(zip, { force: true });
  fs.rmSync(`${zip}.sha256`, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);

  // 1. 源码
  const { keep: files, skipped } = packFiles(sourceFiles(repoRoot));
  if (skipped.length) console.log(`[build] docs/ 下 ${skipped.length} 个中文名的历史记录不进包`);
  for (const f of files) {
    const to = path.join(dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, f), to);
    fs.chmodSync(to, fs.statSync(path.join(repoRoot, f)).mode & 0o777);
  }
  console.log(`[build] 复制源码 ${files.length} 个文件`);

  // 2. 运行时（下载后核对 SHA256）
  const [nodeArchive, pyArchive] = await Promise.all([
    download(runtimes.node.targets[target], cache),
    download(runtimes.python.targets[target], cache),
  ]);
  fs.mkdirSync(path.join(dir, "runtime"));
  extractInto(nodeArchive, path.join(dir, "runtime", "node"));
  extractInto(pyArchive, path.join(dir, "runtime", "python"));
  for (const rel of [L.node, L.npmCli, L.python]) {
    if (!fs.existsSync(path.join(dir, rel))) throw new Error(`运行时解开后找不到 ${rel}`);
  }
  const node = path.join(dir, L.node);
  const npmCli = path.join(dir, L.npmCli);
  const python = path.join(dir, L.python);

  // 3. 依赖：全部用包里的运行时装（PATH 里先放包里的 Node，依赖的安装脚本也用它）
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`,
    npm_config_update_notifier: "false",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    // 依赖只装进包里的 Python：不看用户目录的 site-packages，用户的 pip 配置也不能改成装到别处
    PYTHONNOUSERSITE: "1",
    PIP_USER: "0",
  };
  for (const k of ["VRA_DATA_ROOT", "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "VIRTUAL_ENV", "PIP_TARGET", "PIP_PREFIX", "PIP_REQUIRE_VIRTUALENV"]) delete env[k];
  run(node, [npmCli, "ci", "--no-audit", "--no-fund"], { cwd: path.join(dir, "orchestrator"), env });
  run(node, [npmCli, "ci", "--no-audit", "--no-fund"], { cwd: path.join(dir, "desktop"), env });
  run(python, ["-m", "pip", "install", "--no-warn-script-location", "-r", path.join(dir, ".agents", "skills", "data-access", "scripts", "requirements.txt")], { cwd: dir, env });
  // 依赖没有逐个锁版本：把这次实际装上的版本记进包信息，出问题时能对上
  const freeze = spawnSync(python, ["-m", "pip", "list", "--format=json"], { cwd: dir, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (freeze.status !== 0) throw new Error(`pip list 失败：${freeze.stderr || freeze.status}`);
  const pythonPackages = Object.fromEntries((JSON.parse(freeze.stdout) as { name: string; version: string }[])
    .map((p) => [p.name, p.version] as const).sort(([a], [b]) => a.localeCompare(b)));
  if (target !== "win-x64") {
    const need = macosNeededByTags(wheelTags(dir));
    if (need[0] > MIN_MACOS || (need[0] === MIN_MACOS && need[1] > 0)) {
      throw new Error(`装上的依赖要 macOS ${need.join(".")}，比写明的最低版本 ${MIN_MACOS} 高。先把 MIN_MACOS、start-portable.sh 和 README 一起改了再构建`);
    }
  }

  // 4. 页面
  run(node, [npmCli, "run", "build"], { cwd: path.join(dir, "desktop"), env });
  if (!fs.existsSync(path.join(dir, "desktop", "dist", "index.html"))) throw new Error("页面打包后找不到 desktop/dist/index.html");

  // 5. 启动文件、包信息、说明
  const launcher = path.join(dir, L.launcher);
  fs.copyFileSync(path.join(here, L.launcher), launcher);
  if (target !== "win-x64") fs.chmodSync(launcher, 0o755);
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  // 源码是从工作区复制的：有没提交的改动就记下来，这个包对不上 commit
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot, encoding: "utf8" });
  const info = {
    kind: "portable",
    version,
    target,
    built_at: new Date().toISOString(),
    commit: commit.status === 0 ? commit.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim() !== "" : null,
    node: runtimes.node.version,
    python: runtimes.python.version,
    min_macos: target === "win-x64" ? null : MIN_MACOS,
    python_packages: pythonPackages,
  };
  fs.writeFileSync(path.join(dir, "package-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, README_NAME), readmeText(version, target));

  // 6. 压缩，附 SHA256
  zipDir(dir, zip);
  fs.writeFileSync(`${zip}.sha256`, `${sha256Of(zip)}  ${path.basename(zip)}\n`);
  console.log(`[build] 完成：${zip}（${(fs.statSync(zip).size / 1024 / 1024).toFixed(0)} MB）`);
  return { dir, zip };
}

if (isMain(import.meta.url)) {
  build(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`[build] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
