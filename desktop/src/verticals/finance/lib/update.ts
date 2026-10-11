/**
 * 新版提示(后端 GET/POST /update)。后端每天去 GitHub 查一次最新正式发布(没查成隔一小时再试);
 * 这里只负责把「有新版」说成人话:免安装包和源码安装的升级做法不一样。
 */
export interface UpdateInfo {
  current: string;
  install: "portable" | "source";
  enabled: boolean;
  env_disabled: boolean;
  skip_version: string | null;
  checked_at: string | null;
  latest: { version: string; url: string; published_at: string | null } | null;
  error: string | null;
  update_available: boolean;
}

export type UpdateActionName = "disable" | "enable" | "skip" | "check";

/** 顶部提示条和设置页各拿一份状态:任一边改了开关就广播新状态,另一边跟着变,不用刷新页面 */
export const UPDATE_CHANGED = "vr:update-changed";
export function announceUpdate(u: UpdateInfo): UpdateInfo {
  window.dispatchEvent(new CustomEvent<UpdateInfo>(UPDATE_CHANGED, { detail: u }));
  return u;
}
export function onUpdateChanged(fn: (u: UpdateInfo) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<UpdateInfo>).detail);
  window.addEventListener(UPDATE_CHANGED, h);
  return () => window.removeEventListener(UPDATE_CHANGED, h);
}

/** 升级做法:免安装包 = 下载新包解压到新文件夹再搬 .local;源码 = git pull 后重跑 setup */
export function upgradeSteps(install: UpdateInfo["install"]): string {
  return install === "portable"
    ? "下载新的免安装包，解压到一个新文件夹，把旧文件夹里的 .local 整个复制过去，再双击新文件夹里的启动文件。你的设置和记录都在 .local 里（Mac 的访达默认不显示以点开头的文件夹，按 Command+Shift+. 就能看到）。"
    : "先备份 .local，在仓库目录运行 git pull，再重新运行一次 setup（scripts/setup，Windows 用 scripts\\setup-windows.cmd）。";
}

/** 设置页的状态一句话:关着 / 没查过 / 查失败 / 已是最新 / 有新版 / 这一版已跳过 */
export function updateStatusText(u: UpdateInfo): string {
  if (u.env_disabled) return "已用环境变量 VRA_UPDATE_CHECK=0 关掉，不会联网检查。";
  if (!u.enabled) return "已关掉，不会联网检查。";
  if (u.error) return `上次检查没成功：${u.error}`;
  if (!u.checked_at || !u.latest) return "还没检查过。";
  if (u.update_available) return `有新版本 v${u.latest.version}。`;
  if (u.skip_version && u.latest.version === u.skip_version) return `v${u.latest.version} 已设为不再提示。`;
  return "已是最新版本。";
}
