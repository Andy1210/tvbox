import { describe, it, expect } from "vitest";
import { act, render } from "@testing-library/react";
import { useLatest, useLatestRequest, type LatestToken } from "@sdk/useLatestRequest";

// An answer that arrives after a newer question must never reach the screen.

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useLatestRequest", () => {
  it("keeps the newest answer when an older one arrives last", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<string>>>();
    const signals = new Map<string, AbortSignal>();
    let seen: string | undefined;
    function Probe({ id }: { id: string }) {
      const r = useLatestRequest(
        (signal) => {
          const d = deferred<string>();
          pending.set(id, d);
          signals.set(id, signal);
          return d.promise;
        },
        [id],
      );
      seen = r.data;
      return null;
    }
    const { rerender } = render(<Probe id="a" />);
    rerender(<Probe id="b" />);
    expect(signals.get("a")!.aborted).toBe(true);
    await act(async () => pending.get("b")!.resolve("B"));
    await act(async () => pending.get("a")!.resolve("A"));
    expect(seen).toBe("B");
  });

  it("drops the error of a superseded request and reports the current one's", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<string>>>();
    let state: { error: unknown; loading: boolean } = { error: undefined, loading: false };
    function Probe({ id }: { id: string }) {
      const r = useLatestRequest(() => {
        const d = deferred<string>();
        pending.set(id, d);
        return d.promise;
      }, [id]);
      state = r;
      return null;
    }
    const { rerender } = render(<Probe id="a" />);
    rerender(<Probe id="b" />);
    await act(async () => pending.get("a")!.reject(new Error("old")));
    expect(state.error).toBeUndefined();
    expect(state.loading).toBe(true);
    await act(async () => pending.get("b")!.reject(new Error("new")));
    expect((state.error as Error).message).toBe("new");
    expect(state.loading).toBe(false);
  });

  it("an answer after unmount is ignored and the request is aborted", async () => {
    const d = deferred<string>();
    let signal: AbortSignal | null = null;
    function Probe() {
      useLatestRequest((s) => {
        signal = s;
        return d.promise;
      }, []);
      return null;
    }
    const { unmount } = render(<Probe />);
    unmount();
    expect(signal!.aborted).toBe(true);
    await act(async () => d.resolve("late"));
  });

  it("disabled runs nothing, reload runs again", async () => {
    let calls = 0;
    let reload: () => void = () => {};
    function Probe({ on }: { on: boolean }) {
      const r = useLatestRequest(
        async () => {
          calls++;
          return calls;
        },
        [],
        { enabled: on },
      );
      reload = r.reload;
      return null;
    }
    const { rerender } = render(<Probe on={false} />);
    expect(calls).toBe(0);
    rerender(<Probe on />);
    await act(async () => {});
    expect(calls).toBe(1);
    await act(async () => reload());
    expect(calls).toBe(2);
  });
});

describe("useLatest", () => {
  it("each start aborts the previous one and only the newest is current", () => {
    let api: ReturnType<typeof useLatest> | null = null;
    function Probe() {
      api = useLatest();
      return null;
    }
    const { unmount } = render(<Probe />);
    const a: LatestToken = api!.start();
    const b: LatestToken = api!.start();
    expect(a.signal.aborted).toBe(true);
    expect(a.current()).toBe(false);
    expect(b.current()).toBe(true);
    unmount();
    expect(b.current()).toBe(false);
    expect(b.signal.aborted).toBe(true);
  });
});
