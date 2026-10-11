/**
 * 把一个 Blob 存成文件：临时地址 + 隐藏链接点一下。
 *
 * 临时地址过一会儿再释放，不在点完的同一刻释放：部分浏览器的下载是异步开始的，地址先被释放就下不来
 * （常用的下载库 FileSaver.js 也是隔 40 秒才释放）。第四轮审计 D 范围待核实项。
 */
export const REVOKE_AFTER_MS = 40_000;

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}
