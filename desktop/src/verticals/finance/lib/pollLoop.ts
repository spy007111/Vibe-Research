/**
 * 递归 setTimeout 的轮询循环,整个「取一次 → 排下一拍」上一把锁:
 * 一拍还在取的时候再叫它(页面切回来、手动催一下)什么都不做,由这一拍回来后照常排下一拍;
 * 空闲时叫它就掐掉等着的定时器、马上取。所以无论切多少次页面,永远只有一条循环、一个定时器。
 * (以前可见性回调直接再起一条 loop:请求在路上时切回来,两条循环都会排定时器,越切越多。)
 */
export interface PollTimers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export interface PollLoopOptions {
  /** 这一拍该不该取(页面可见、开盘、名单不空);不该取时隔 idleMs 再看 */
  shouldRun(): boolean;
  /** 取一次,返回下一拍等多久(毫秒) */
  tick(): Promise<number>;
  idleMs: number;
  /** 真在取 / 在等开盘或切回页面 */
  onState(polling: boolean): void;
  timers?: PollTimers;
}

const windowTimers: PollTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

export function startPollLoop(o: PollLoopOptions): { kick(): void; stop(): void } {
  const t = o.timers ?? windowTimers;
  let stopped = false;
  let running = false;
  let timer: number | null = null;
  const clear = () => { if (timer !== null) { t.clear(timer); timer = null; } };

  const loop = async () => {
    if (stopped || running) return;
    clear();
    if (!o.shouldRun()) {
      o.onState(false);
      timer = t.set(loop, o.idleMs);
      return;
    }
    o.onState(true);
    running = true;
    let wait: number;
    try {
      wait = await o.tick();
    } catch {
      wait = o.idleMs;
    } finally {
      running = false;
    }
    // 取的途中被停掉(卸载 / 关掉开关):到此为止,别再排下一拍
    if (stopped) return;
    timer = t.set(loop, wait);
  };

  void loop();
  return {
    kick: () => { void loop(); },
    stop: () => { stopped = true; clear(); },
  };
}
