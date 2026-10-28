"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Exercise the production queue without starting the app or making API calls.
const source = fs.readFileSync(path.join(__dirname, "..", "renderer.js"), "utf8");
const functions = source.slice(0, source.indexOf('startBtn.addEventListener("click"'));

function setup({ failFirstSpeech = false, ready = Promise.resolve(), available = false } = {}) {
  const elements = new Map();
  const requests = [];
  const spoken = [];
  const checks = [];
  const context = vm.createContext({
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: "" });
      return elements.get(id);
    } },
    localStorage: { getItem: () => null },
    window: { chatApi: { async openaiRespond(...args) {
      requests.push(args);
      return { ok: true, text: "こんにちは" };
    } } },
    console: { error() {} },
    AbortController, setTimeout, clearTimeout,
    ready, available,
    async fetch() { checks.push(true); return { ok: true }; },
    async synthesize(text) {
      spoken.push(text);
      if (failFirstSpeech && spoken.length === 1) throw new Error("cold engine timeout");
      return new ArrayBuffer(0);
    },
  });
  vm.runInContext(functions + `
    state.appStartedAt = 100;
    state.openaiApiKey = "test-key";
    state.chatgptTriggerKeywords = ["こもち"];
    state.voicevoxSpeakersReady = ready;
    state.voicevoxAvailable = available;
    voicevoxSynthesizeWav = synthesize;
    playWavArrayBuffer = async () => {};
  `, context);
  const run = (code) => vm.runInContext(code, context);
  const selectSpeakers = (id = 1) => {
    elements.get("voicevoxSpeakerTts").value = `speaker:${id}`;
    elements.get("voicevoxSpeakerChatgpt").value = `speaker:${id}`;
  };
  const enqueue = (id = "first", text = "こもち", timestamp = 200) => {
    context.comment = { id, text, timestamp_ms: timestamp };
    run("enqueueSpeakComment(comment, 200)");
    return run("state.ttsChain");
  };
  return { requests, spoken, checks, run, enqueue, selectSpeakers };
}

test("first trigger waits for the initial speaker list and checks engine availability", async () => {
  let resolveReady;
  const app = setup({ ready: new Promise((resolve) => { resolveReady = resolve; }) });
  const pending = app.enqueue();
  await Promise.resolve();
  assert.equal(app.requests.length, 0);
  assert.equal(app.checks.length, 0);
  app.selectSpeakers();
  resolveReady();
  await pending;
  assert.equal(app.checks.length, 1);
  assert.equal(app.requests.length, 1);
  assert(app.requests[0][1].includes("こもち"));
});

test("a cold-engine comment speech failure does not discard the GPT reply", async () => {
  const app = setup({ failFirstSpeech: true });
  app.selectSpeakers();
  await app.enqueue();
  assert.equal(app.requests.length, 1);
  assert.equal(app.spoken.length, 2);
});

test("speaker style zero can read the first comment and reply", async () => {
  const app = setup();
  app.selectSpeakers(0);
  await app.enqueue();
  assert.equal(app.requests.length, 1);
  assert.equal(app.spoken.length, 2);
});

test("stop while waiting for speakers cancels the pending response", async () => {
  let resolveReady;
  const app = setup({ ready: new Promise((resolve) => { resolveReady = resolve; }) });
  app.selectSpeakers();
  const pending = app.enqueue();
  app.run("clearTtsQueue()");
  resolveReady();
  await pending;
  assert.equal(app.requests.length, 0);
  assert.equal(app.spoken.length, 0);
});

test("duplicate comments produce only one GPT response", async () => {
  const app = setup();
  app.selectSpeakers();
  await app.enqueue();
  await app.enqueue();
  assert.equal(app.requests.length, 1);
});

test("old, blocked, NG and non-trigger comments do not call GPT", async () => {
  const app = setup();
  app.selectSpeakers();
  await app.enqueue("old", "こもち", 50);
  app.run('state.ttsNgWords = ["こもち"]');
  await app.enqueue("ng");
  app.run('state.ttsNgWords = []; state.blockedAuthors.add("blocked")');
  await app.run('enqueueSpeakComment({id: "blocked", text: "こもち", author: "blocked", timestamp_ms: 200}, 200); state.ttsChain');
  await app.enqueue("other", "こんにちは");
  assert.equal(app.requests.length, 0);
});
