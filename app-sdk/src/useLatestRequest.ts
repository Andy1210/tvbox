import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

// An answer is only worth showing if it answers the latest question.
//
// A remote moves the cursor faster than a server answers, and every move can
// start a fetch (the focused item's details, a search as it is typed, a list for
// the account just switched to). Answers then arrive in any order, and the last
// one to ARRIVE is not the last one ASKED: without a guard an old answer lands on
// top of the new state and the screen describes something the cursor has left.
//
// Two shapes. useLatestRequest runs a request whenever its inputs change and
// keeps only the newest answer. useLatest is the same guard for an event handler:
// each start() aborts the previous request and says whether an answer is still
// current.

/** Handle for one request started by useLatest(). */
export interface LatestToken {
  signal: AbortSignal;
  /** True while this is the newest request and the component is mounted. */
  current: () => boolean;
}

/**
 * For requests started from handlers (a focus move, a key press). Every start()
 * aborts the one before it; check `current()` before using an answer.
 */
export function useLatest(): { start: () => LatestToken; cancel: () => void } {
  const seq = useRef(0);
  const ctl = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // The ref objects themselves, not a value read out of them: the cleanup has to
    // abort whatever request is in flight when it runs.
    const s = seq;
    const c = ctl;
    return () => {
      mounted.current = false;
      s.current++;
      c.current?.abort();
      c.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    seq.current++;
    ctl.current?.abort();
    ctl.current = null;
  }, []);

  const start = useCallback((): LatestToken => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    const mine = ++seq.current;
    return { signal: c.signal, current: () => mounted.current && seq.current === mine };
  }, []);

  return { start, cancel };
}

export interface LatestRequest<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Run the request again with the same inputs. */
  reload: () => void;
}

/**
 * Run `fn` when `deps` change (and on mount), keep the newest answer only.
 *
 * `fn` receives an AbortSignal that is aborted when a newer request starts or the
 * component unmounts; passing it to fetch() also stops the older download. An
 * error from an aborted or superseded request is dropped, not reported.
 * `enabled: false` runs nothing and keeps the last answer.
 */
export function useLatestRequest<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  opts: { enabled?: boolean } = {},
): LatestRequest<T> {
  const enabled = opts.enabled !== false;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const { start, cancel } = useLatest();
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const tok = start();
    setLoading(true);
    setError(undefined);
    let p: Promise<T>;
    try {
      p = Promise.resolve(fnRef.current(tok.signal));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (v) => {
        if (!tok.current()) return;
        setData(v);
        setLoading(false);
      },
      (e) => {
        if (!tok.current() || tok.signal.aborted) return;
        setError(e);
        setLoading(false);
      },
    );
    return cancel;
    // `deps` is the caller's list, exactly as for useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
