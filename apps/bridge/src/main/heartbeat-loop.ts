// Heartbeats must keep running while serialized command/report work is busy.
// Coalesce overlapping timer, reconnect and command-loop checks.
export function createHeartbeatLoop(send: () => Promise<boolean>, intervalMs = 20_000) {
  let inFlight: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  function check() {
    if (!inFlight) {
      inFlight = send().finally(() => { inFlight = null; });
    }
    return inFlight;
  }
  return {
    check,
    start() {
      if (!timer) timer = setInterval(() => { void check().catch(() => undefined); }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
