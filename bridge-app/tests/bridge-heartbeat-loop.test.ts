import assert from "node:assert/strict";
import { test } from "node:test";
import { createHeartbeatLoop } from "../../apps/bridge/src/main/heartbeat-loop";

test("heartbeat stays live through long command work and stops on shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const loop = createHeartbeatLoop(async () => { calls++; return true; });
  let finishCommand!: () => void;
  const busyCommand = new Promise<void>((resolve) => { finishCommand = resolve; });
  loop.start();
  loop.start();
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(20_000);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(calls, 8, "a command lasting longer than the 90-second online window does not stop heartbeat");
  loop.stop();
  t.mock.timers.tick(60_000);
  assert.equal(calls, 8);
  finishCommand();
  await busyCommand;
});

test("overlapping timer/reconnect heartbeats share one request and recover after failure", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let complete!: (value: boolean) => void;
  let calls = 0;
  const loop = createHeartbeatLoop(() => {
    calls++;
    return new Promise<boolean>((resolve) => { complete = resolve; });
  });
  loop.start();
  const first = loop.check();
  t.mock.timers.tick(60_000);
  assert.equal(loop.check(), first);
  assert.equal(calls, 1);
  complete(false);
  assert.equal(await first, false);
  const next = loop.check();
  assert.equal(calls, 2);
  complete(true);
  assert.equal(await next, true);
  loop.stop();
});
