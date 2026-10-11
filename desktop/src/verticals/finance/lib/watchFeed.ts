/**
 * 关注股的公告 / 新闻：逐只取，各自成败分开记。
 *
 * 🔴 取失败的不能当「这只没有资讯」：原来一律 catch 成空数组，全部 500 时页面写「近期暂无」，
 *    部分失败时总条数看着也正常（Codex 审计 2026-10-09 C8）。⇒ 返回没取到的是哪几只，
 *    全部没取到由调用方当错误处理（有存档就保留存档）。
 */
export interface FeedGather<T> { got: { code: string; items: T[] }[]; failed: string[]; errors: unknown[] }

export async function gatherWatchFeed<T>(codes: readonly string[], fetchOne: (code: string) => Promise<T[]>): Promise<FeedGather<T>> {
  const res = await Promise.all(codes.map((code) =>
    fetchOne(code).then((items) => ({ code, items, err: undefined as unknown, ok: true }), (err: unknown) => ({ code, items: [] as T[], err, ok: false }))));
  const bad = res.filter((r) => !r.ok);
  return { got: res.filter((r) => r.ok).map(({ code, items }) => ({ code, items })), failed: bad.map((r) => r.code), errors: bad.map((r) => r.err) };
}

/** 全部没取到时的错误文字（带第一条原因） */
export function allFailedMessage(n: number, what: string, errors: readonly unknown[]): string {
  const first = errors[0];
  const why = first instanceof Error ? first.message : first === undefined ? "" : String(first);
  return `关注的 ${n} 只股票${what}都没取到${why ? `（${why}）` : ""}`;
}
