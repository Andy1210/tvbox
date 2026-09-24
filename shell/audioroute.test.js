"use strict";
const test = require("node:test");
const assert = require("node:assert");
const audioroute = require("./audioroute");

function harness() {
  let stops = 0;
  const pending = [];
  const route = audioroute.create({
    stopCount: () => stops,
    preferredSink: () => "",
    log: () => {},
    run: (_pref, cb) => pending.push(cb),
  });
  return { route, pending, stop: () => stops++ };
}

test("a callback that is not a launch always runs, even after a stop", () => {
  const h = harness();
  let ran = 0;
  h.route.ensure(() => ran++);
  h.stop();
  h.route.ensure(() => {}, { launch: true });
  h.pending[0]("sink-a\n");
  assert.strictEqual(ran, 1);
  assert.strictEqual(h.route.sink(), "sink-a");
});

test("a launch overtaken by a newer launch is dropped", () => {
  const h = harness();
  const ran = [];
  h.route.ensure(() => ran.push(1), { launch: true });
  h.route.ensure(() => ran.push(2), { launch: true });
  h.pending[0]("");
  h.pending[1]("");
  assert.deepStrictEqual(ran, [2]);
});

test("a launch overtaken by a stop is dropped", () => {
  const h = harness();
  let ran = 0;
  h.route.ensure(() => ran++, { launch: true });
  h.stop();
  h.pending[0]("");
  assert.strictEqual(ran, 0);
});

test("a non-launch call does not supersede a launch", () => {
  const h = harness();
  let ran = 0;
  h.route.ensure(() => ran++, { launch: true });
  h.route.ensure(() => {});
  h.pending[0]("");
  h.pending[1]("");
  assert.strictEqual(ran, 1);
});
