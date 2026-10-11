import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MIN_MACOS, README_NAME, TARGETS, checkSha256, isMain, layoutOf, macosNeededByTags, packFiles, packageName, parseRuntimes, readmeText, sha256Of, sourceFiles, targetOf } from "../../scripts/portable/build.mts";
import { REQUIRED_CHECKS, cleanPath, failedChecks, pageProblem, samePath, writeShims } from "../../scripts/portable/smoke.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const portable = path.join(root, "scripts", "portable");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vr-portable-"));

test("免安装包:运行时清单只认官方地址、写死 SHA256、版本和地址一致;三个平台都有", () => {
  const raw = JSON.parse(read("scripts/portable/runtimes.json"));
  const r = parseRuntimes(raw);
  for (const t of TARGETS) {
    assert.match(r.node.targets[t].url, /^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\//);
    assert.match(r.python.targets[t].url, /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\//);
  }
  assert.ok(Number(r.node.version.split(".")[0]) >= 22, "Node 要 ≥ 22.18(直接运行 .ts)");
  assert.ok(Number(r.python.version.split(".")[1]) >= 11, "Python 要 ≥ 3.11");
  const bad = (patch: (x: typeof raw) => void, why: RegExp) => {
    const x = JSON.parse(JSON.stringify(raw));
    patch(x);
    assert.throws(() => parseRuntimes(x), why);
  };
  bad((x) => { x.node.targets["win-x64"].url = "https://example.com/node-v24.21.0-win-x64.zip"; }, /不是官方发布地址/);
  bad((x) => { x.python.targets["mac-arm64"].url = "http://github.com/astral-sh/python-build-standalone/releases/download/x/cpython-3.12.15.tar.gz"; }, /不是官方发布地址/);
  bad((x) => { x.node.targets["mac-x64"].sha256 = "ABC"; }, /SHA256/);
  bad((x) => { x.node.targets["mac-x64"].sha256 = x.node.targets["mac-x64"].sha256.toUpperCase(); }, /SHA256/);
  bad((x) => { x.node.version = "24.22.0"; }, /对不上/);
  bad((x) => { delete x.python.targets["win-x64"]; }, /不是官方发布地址/);
  bad((x) => { delete x.node.version; }, /缺版本号/);
});

test("免安装包:只在对应平台构建;SHA256 对不上就报错;包名带版本和平台", () => {
  assert.equal(targetOf("darwin", "arm64"), "mac-arm64");
  assert.equal(targetOf("darwin", "x64"), "mac-x64");
  assert.equal(targetOf("win32", "x64"), "win-x64");
  assert.equal(targetOf("linux", "x64"), null, "Linux 继续用源码安装");
  assert.equal(targetOf("win32", "arm64"), null);
  const dir = tmp();
  const f = path.join(dir, "a.bin");
  fs.writeFileSync(f, "hello");
  const h = sha256Of(f);
  assert.equal(h, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  checkSha256(f, h);
  assert.throws(() => checkSha256(f, "0".repeat(64)), /SHA256 对不上.*这个文件不用/);
  assert.equal(packageName("2.0.0", "win-x64"), "VibeResearch-2.0.0-win-x64");
});

test("免安装包:构建脚本放运行时的位置和两个启动脚本找的位置一致", () => {
  const sh = read("scripts/portable/start-portable.sh");
  const ps = read("scripts/portable/start-portable.ps1");
  const mac = layoutOf("mac-arm64");
  assert.ok(sh.includes(`"$ROOT/${path.posix.dirname(mac.node)}"`), mac.node);
  assert.ok(sh.includes(`"$ROOT/${mac.python}"`), mac.python);
  const win = layoutOf("win-x64");
  assert.ok(ps.includes(`"${path.posix.dirname(win.node).replace(/\//g, "\\")}"`), win.node);
  assert.ok(ps.includes(`"${win.python.replace(/\//g, "\\")}"`), win.python);
  assert.ok(ps.includes(`"${path.posix.basename(win.node)}"`));
  for (const t of TARGETS) assert.ok(fs.existsSync(path.join(portable, layoutOf(t).launcher)), layoutOf(t).launcher);
  // 双击启动文件:Windows 批处理在 chcp 之前按本地代码页读,只能是 ASCII
  assert.ok(/^[\x00-\x7f]*$/.test(read("scripts/portable/Start-VibeResearch.cmd")), "Start-VibeResearch.cmd 只能有 ASCII");
  assert.ok((fs.statSync(path.join(portable, "Start-VibeResearch.command")).mode & 0o111) !== 0, ".command 要可执行");
  // PowerShell 5.1 认中文要带 BOM
  for (const f of ["scripts/start.ps1", "scripts/portable/start-portable.ps1"]) assert.equal(fs.readFileSync(path.join(root, f)).subarray(0, 3).toString("hex"), "efbbbf", f);
  assert.match(ps, /^\ufeff(?:#[^\n]*\n)*param\(\[switch\]\$NoOpen, \[int\]\$Port = 0, \[int\]\$ApiPort = 0\)\n/, "param 必须是第一条语句(前面只能有注释)");
  // 两边都只用包里的数据目录,用打包好的页面;不开浏览器的开关一路传到底
  assert.match(sh, /unset VRA_DATA_ROOT/);
  assert.match(sh, /exec sh "\$ROOT\/scripts\/start" --prebuilt "\$@"/);
  assert.match(ps, /Remove-Item Env:VRA_DATA_ROOT/);
  assert.match(ps, /start\.ps1"\) -Prebuilt -NoOpen:\$NoOpen -Port \$Port -ApiPort \$ApiPort/);
  assert.match(read("scripts/start.ps1"), /param\(\[switch\]\$Prebuilt, \[switch\]\$NoOpen, \[int\]\$Port = 0, \[int\]\$ApiPort = 0\)/);
  assert.match(read("scripts/start.ps1"), /if \(-not \$NoOpen\) \{ Start-Process \$uiUrl \}/);
});

test("免安装包:包里的说明写清楚启动、未签名怎么放行、数据位置和升级;Windows 用 CRLF", () => {
  const mac = readmeText("2.1.0", "mac-arm64");
  assert.match(mac, /双击 Start-VibeResearch\.command/);
  assert.match(mac, /xattr -dr com\.apple\.quarantine/);
  assert.match(mac, /\.local/);
  assert.match(mac, /旧文件夹里的 \.local 整个复制过去/);
  assert.match(mac, /新版提示：每天联网查一次.*只发送版本号.*没查成隔一小时再试.*关掉/);
  assert.match(mac, /Update notice: once a day .*only the version number.*retries an hour later/);
  assert.ok(!/最多|at most/.test(mac), "失败后每小时重试,不能写「每天最多一次」");
  assert.match(mac, new RegExp(`系统要求：macOS ${MIN_MACOS} 或更新版本`));
  assert.match(mac, new RegExp(`Requires macOS ${MIN_MACOS} or later`));
  assert.match(mac, /访达默认不显示以点开头的文件夹，按 Command\+Shift\+\./);
  assert.match(mac, /Finder hides folders .*Command\+Shift\+\./);
  assert.ok(!mac.includes("\r\n"));
  const win = readmeText("2.1.0", "win-x64");
  assert.match(win, /双击 Start-VibeResearch\.cmd/);
  assert.match(win, /更多信息.*仍要运行/);
  assert.match(win, /More info.*Run anyway/);
  assert.match(win, /64 位 Windows 10 或更新版本/);
  assert.match(win, /Requires 64-bit Windows 10 or later/);
  assert.ok(!/Command\+Shift|访达/.test(win));
  assert.ok(/^[\x20-\x7e]+$/.test(README_NAME), "包里说明的文件名要 ASCII(Windows 的 zip 不标 UTF-8)");
  assert.ok(win.includes("\r\n") && !/[^\r]\n/.test(win), "Windows 说明全用 CRLF");
});

test("免安装包:源码只取 git 记录的文件(本机数据、没进仓库的、删掉的都不进)", () => {
  const dir = tmp();
  const git = (...a: string[]) => assert.equal(spawnSync("git", a, { cwd: dir, encoding: "utf8" }).status, 0, a.join(" "));
  git("init", "-q");
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, ".local"));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "a");
  fs.writeFileSync(path.join(dir, "gone.ts"), "g");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".local/\n");
  git("add", "-A");
  fs.writeFileSync(path.join(dir, ".local", "config.json"), "{}");
  fs.writeFileSync(path.join(dir, "draft.md"), "没进仓库");
  fs.rmSync(path.join(dir, "gone.ts"));
  assert.deepEqual(sourceFiles(dir).sort(), [".gitignore", "src/a.ts"]);
  assert.throws(() => sourceFiles(tmp()), /git ls-files 失败/);
});

test("免安装包冒烟:PATH 只留系统目录、假命令在最前;体检缺项或没过都报出来", () => {
  const mac = cleanPath("darwin", "/tmp/shim");
  assert.equal(mac, "/tmp/shim:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.ok(!/homebrew|\/usr\/local/.test(mac));
  const win = cleanPath("win32", "C:\\shim", "C:\\Windows");
  assert.equal(win.split(";")[0], "C:\\shim");
  assert.ok(win.includes("C:\\Windows\\System32\\WindowsPowerShell\\v1.0"), "启动脚本要用 PowerShell");
  assert.ok(!/nodejs|Python/i.test(win));
  const ok = { checks: REQUIRED_CHECKS.map((id) => ({ id, status: "ok" })) };
  assert.deepEqual(failedChecks(ok), []);
  const bad = { checks: [...ok.checks.filter((c) => c.id !== "calc"), { id: "ai_default", status: "fail" }].map((c) => (c.id === "python" ? { ...c, status: "fail", detail: "缺 pandas" } : c)) };
  assert.deepEqual(failedChecks(bad), ["python：fail 缺 pandas", "calc：体检里没有这一项"], "AI 登录这类与包无关的项不算");
  if (process.platform !== "win32") {
    const d = tmp();
    writeShims(d, "darwin");
    const r = spawnSync(path.join(d, "python3"), [], { encoding: "utf8" });
    assert.equal(r.status, 97);
    assert.match(r.stderr, /用到了系统的 python3/);
  }
});

test("免安装包:macOS 最低版本——构建按轮子核对,启动脚本拦旧系统,README 写同一个数", () => {
  assert.deepEqual(macosNeededByTags(["py3-none-any", "cp312-cp312-macosx_11_0_arm64", "cp312-cp312-macosx_14_0_arm64", "cp312-cp312-macosx_10_13_universal2"]), [14, 0]);
  assert.deepEqual(macosNeededByTags(["cp312-cp312-macosx_14_0_arm64", "cp312-cp312-macosx_14_2_arm64", "cp312-cp312-macosx_13_9_arm64"]), [14, 2], "小版本也要比");
  assert.deepEqual(macosNeededByTags(["cp39-abi3-macosx_10_9_x86_64.macosx_11_0_arm64"]), [11, 0], "一行里有多个标签取最高");
  assert.deepEqual(macosNeededByTags(["py3-none-any", "cp312-cp312-win_amd64"]), [0, 0]);
  const sh = read("scripts/portable/start-portable.sh");
  assert.match(sh, new RegExp(`^MIN_MACOS=${MIN_MACOS}$`, "m"), "启动脚本和 build.mts 的最低版本要一致");
  assert.ok(read("README.md").includes(`macOS ${MIN_MACOS} 及以上`));
  assert.ok(read("README_en.md").includes(`macOS ${MIN_MACOS} or later`));
  assert.match(read("scripts/portable/build.mts"), /need\[0\] > MIN_MACOS \|\| \(need\[0\] === MIN_MACOS && need\[1\] > 0\)/);
  if (process.platform === "win32") return;
  // 行为:假的 sw_vers 报旧版本 → 当场说明并退出;新版本 → 过了这一关(往下才报缺运行时)
  const pkg = tmp();
  fs.mkdirSync(path.join(pkg, "scripts", "portable"), { recursive: true });
  fs.copyFileSync(path.join(portable, "start-portable.sh"), path.join(pkg, "scripts", "portable", "start-portable.sh"));
  const runWith = (ver: string | null) => {
    const shim = tmp();
    if (ver !== null) {
      fs.writeFileSync(path.join(shim, "sw_vers"), `#!/bin/sh\necho "${ver}"\n`);
      fs.chmodSync(path.join(shim, "sw_vers"), 0o755);
    }
    return spawnSync("/bin/sh", [path.join(pkg, "scripts", "portable", "start-portable.sh")], { encoding: "utf8", env: { PATH: `${shim}:/bin` } });
  };
  for (const old of ["13.6.1", "12.7", `${MIN_MACOS - 1}.9`]) {
    const r = runWith(old);
    assert.equal(r.status, 1, old);
    assert.match(r.stderr, new RegExp(`需要 macOS ${MIN_MACOS} 或更新版本，这台电脑是 macOS ${old.replace(/\./g, "\\.")}`), old);
  }
  for (const ok of [`${MIN_MACOS}.0`, "15.5", "26.0.1", "", null]) {
    const r = runWith(ok);
    assert.equal(r.status, 1, String(ok));
    assert.ok(!r.stderr.includes("或更新版本"), `${ok} 不该被拦`);
    assert.match(r.stderr, /不是完整的免安装包/, String(ok));
  }
});

test("免安装包:启动脚本只用包里的依赖;没解压完整就双击时说清楚;换行符按 .gitattributes 固定", () => {
  const sh = read("scripts/portable/start-portable.sh");
  assert.match(sh, /^PYTHONNOUSERSITE=1$/m);
  assert.match(sh, /^export [^\n]*PYTHONNOUSERSITE/m);
  assert.match(sh, /^unset PYTHONHOME PYTHONPATH PYTHONUSERBASE$/m);
  const ps = read("scripts/portable/start-portable.ps1");
  assert.match(ps, /\$env:PYTHONNOUSERSITE = "1"/);
  assert.match(ps, /Remove-Item Env:PYTHONHOME, Env:PYTHONPATH, Env:PYTHONUSERBASE/);
  assert.match(read("orchestrator/src/config.ts"), /"PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE"/);
  const b = read("scripts/portable/build.mts");
  assert.match(b, /PYTHONNOUSERSITE: "1",\n\s*PIP_USER: "0"/);
  assert.match(b, /"PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "VIRTUAL_ENV", "PIP_TARGET", "PIP_PREFIX", "PIP_REQUIRE_VIRTUALENV"\]\) delete env\[k\]/);
  const cmd = fs.readFileSync(path.join(portable, "Start-VibeResearch.cmd"), "utf8");
  assert.match(cmd, /if not exist "%~dp0scripts\\portable\\start-portable\.ps1" \(\r\n\s+echo [^()\r\n]*Extract All[^()\r\n]*\r\n\s+pause\r\n\s+exit \/b 1\r\n\)/,
    "解压检查在调用 PowerShell 之前;块里的 echo 不能有括号(会提前结束 if 块)");
  assert.ok(cmd.indexOf("if not exist") < cmd.indexOf("powershell.exe"));
  const command = read("scripts/portable/Start-VibeResearch.command");
  assert.match(command, /if \[ ! -f scripts\/portable\/start-portable\.sh \]; then\n\s+echo "[^"]*先把整个压缩包解压/);
  if (process.platform !== "win32") {
    // 行为:只有 .command 一个文件(没解压完整)→ 说明后退出 1,不去找不存在的脚本
    const lone = tmp();
    fs.copyFileSync(path.join(portable, "Start-VibeResearch.command"), path.join(lone, "Start-VibeResearch.command"));
    const r = spawnSync("/bin/sh", [path.join(lone, "Start-VibeResearch.command")], { encoding: "utf8", input: "\n" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /先把整个压缩包解压/);
  }
  const attrs = read(".gitattributes");
  for (const line of ["*.cmd text eol=crlf", "*.sh text eol=lf", "*.command text eol=lf", "scripts/start text eol=lf", "scripts/setup text eol=lf"]) {
    assert.ok(attrs.split("\n").includes(line), line);
  }
  for (const f of ["scripts/start.cmd", "scripts/setup-windows.cmd", "scripts/portable/Start-VibeResearch.cmd"]) {
    const t = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(t.includes("\r\n") && !/[^\r]\n/.test(t), `${f} 要全是 CRLF`);
  }
  for (const f of ["scripts/start", "scripts/setup", "scripts/portable/start-portable.sh", "scripts/portable/Start-VibeResearch.command"]) {
    assert.ok(!read(f).includes("\r"), `${f} 要是 LF`);
  }
});

test("免安装包:进包的文件名都是 ASCII;docs/ 下中文名的历史记录不进包,别处出现就停", () => {
  const { keep, skipped } = packFiles(["README.md", "docs/model-access.md", "docs/发布验收_M40.md", "orchestrator/src/a.ts"]);
  assert.deepEqual(keep, ["README.md", "docs/model-access.md", "orchestrator/src/a.ts"]);
  assert.deepEqual(skipped, ["docs/发布验收_M40.md"]);
  assert.throws(() => packFiles(["README.md", ".agents/skills/中文.md"]), /不是 ASCII.*\.agents\/skills\/中文\.md/);
  assert.throws(() => packFiles(["a\tb.ts"]), /不是 ASCII/, "控制字符也不行");
  const b = read("scripts/portable/build.mts");
  assert.match(b, /packFiles\(sourceFiles\(repoRoot\)\)/);
  assert.match(b, /path\.join\(dir, README_NAME\)/);
});

test("免安装包:直接运行的判断要解开符号链接(macOS 的 /tmp 就是链接);CI 必须看到「通过」", () => {
  const buildFile = path.join(portable, "build.mts");
  const url = pathToFileURL(buildFile).href;
  assert.equal(isMain(url, buildFile), true);
  assert.equal(isMain(url, path.join(portable, "smoke.mts")), false);
  assert.equal(isMain(url, undefined), false);
  assert.equal(isMain(url, path.join(tmp(), "missing.mts")), false);
  assert.match(read(".github/workflows/portable.yml"), /smoke\.mts "\$\{\{ steps\.unzip\.outputs\.dir \}\}" \| tee "\$\{RUNNER_TEMP\}\/smoke\.log"\n\s+#[^\n]*\n\s+grep -qx '\\\[smoke\\\] 通过' "\$\{RUNNER_TEMP\}\/smoke\.log"/);
  if (process.platform === "win32") return;   // Windows 建符号链接要管理员权限
  const link = path.join(tmp(), "linked-build.mts");
  fs.symlinkSync(buildFile, link);
  assert.equal(isMain(url, link), true);
  // 行为:经符号链接目录运行,也要真的跑起来(冒烟不带参数 → 用法 + 退出码 2;构建带未知参数 → 报错 + 退出码 1)
  const dirLink = path.join(tmp(), "portable-link");
  fs.symlinkSync(portable, dirLink);
  const smokeRun = spawnSync(process.execPath, [path.join(dirLink, "smoke.mts")], { encoding: "utf8" });
  assert.equal(smokeRun.status, 2, smokeRun.stderr);
  assert.match(smokeRun.stderr, /用法：node scripts\/portable\/smoke\.mts/);
  const buildRun = spawnSync(process.execPath, [path.join(dirLink, "build.mts"), "--bogus"], { encoding: "utf8" });
  assert.equal(buildRun.status, 1, buildRun.stderr);
  assert.match(buildRun.stderr, /未知参数：--bogus/);
});

test("免安装包冒烟:页面要是打包好的那份;后端用的 Python / 数据目录按真实路径比", () => {
  const html = '<html><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>';
  assert.equal(pageProblem("/", 200, html), null);
  assert.match(pageProblem("/", 404, html) ?? "", /HTTP 404/);
  assert.match(pageProblem("/portfolio", 200, "<html></html>") ?? "", /打开 \/portfolio 不对/);
  assert.match(pageProblem("/", 200, html.replace("<body>", '<body><script type="module" src="/@vite/client"></script>')) ?? "", /开发服务器/);
  const s = read("scripts/portable/smoke.mts");
  assert.match(s, /samePath\(paths\?\.python, path\.join\(pkgDir, L\.python\)\)/);
  assert.match(s, /samePath\(paths\?\.data_root, path\.join\(pkgDir, "\.local"\)\)/);
  // 冒烟先占住 5930(只回 404,不是本产品),启动脚本必须自动换到后面的空闲端口:在后面 20 个里挨个问健康检查,停后检查按实际换到的端口
  assert.match(s, /blocker\.listen\(DEFAULT_UI_PORT, "127\.0\.0\.1"/);
  assert.match(s, /for \(const p of candidates\) \{\n\s+try \{\n\s+const r = await get\(`http:\/\/127\.0\.0\.1:\$\{p\}\/api\/health`\);/);
  assert.match(s, /if \(uiPort\) \{ UI = `http:\/\/127\.0\.0\.1:\$\{uiPort\}`; PORTS = \[uiPort, API_PORT\]; \}/);
  const d = tmp();
  const real = path.join(d, "python3.12");
  fs.writeFileSync(real, "");
  assert.equal(samePath(real, real), true);
  assert.equal(samePath(undefined, real), false);
  assert.equal(samePath(path.join(d, "nope"), path.join(d, "nope")), false, "不存在的不算同一个");
  if (process.platform === "win32") return;
  fs.symlinkSync(real, path.join(d, "python3"));
  assert.equal(samePath(path.join(d, "python3"), real), true, "python3 是指向 python3.12 的链接");
  assert.equal(samePath("/usr/bin/python3", real), false);
});

test("免安装包:每次构建先删旧成品;zip 不带构建机的扩展属性;包信息记下实际装的依赖和工作区是否干净", () => {
  const b = read("scripts/portable/build.mts");
  const clean = b.indexOf("fs.rmSync(`${zip}.sha256`, { force: true });");
  assert.ok(clean > 0 && clean < b.indexOf("// 1. 源码"), "旧 zip / .sha256 要在复制源码之前删");
  assert.match(b, /"\/usr\/bin\/ditto", \["-c", "-k", "--norsrc", "--noextattr", "--noacl", "--keepParent"/);
  assert.match(b, /\["status", "--porcelain", "--untracked-files=no"\]/);
  assert.match(b, /dirty: status\.status === 0 \? status\.stdout\.trim\(\) !== "" : null/);
  assert.match(b, /python_packages: pythonPackages/);
  assert.match(b, /\["-m", "pip", "list", "--format=json"\]/);
});

test("免安装包:构建产物放在已忽略的 dist/ 下;体检不扫包根的 runtime/", () => {
  assert.match(read(".gitignore"), /^dist\/$/m);
  const b = read("scripts/portable/build.mts");
  assert.match(b, /path\.join\(repoRoot, "dist", "portable"\)/);
  assert.match(read("orchestrator/src/doctor.ts"), /SCAN_SKIP_ROOT_DIRS = new Set\(\["runtime"\]\)/);
});
