import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackgroundWorkflowManager } from './dist/src/index.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitUntil(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeManager(tmp, notifications = []) {
  return createBackgroundWorkflowManager({
    runsRoot: tmp,
    notify(message, run) {
      notifications.push({ message, id: run.id, status: run.status, sessionId: run.sessionId });
    },
  });
}

const tmp = await mkdtemp(join(tmpdir(), 'dwf-bg-comprehensive-'));
const notifications = [];
const manager = makeManager(tmp, notifications);

// 1. Success path + provider active visibility.
const successScript = `export const meta = { name: 'success_case', description: 'success case' }
phase('One')
const result = await agent('hello', { label: 'mock success' })
return { result }
`;
const success = await manager.start({
  script: successScript,
  sessionId: 'session-a',
  agent: { async run(prompt, opts) { return `${opts.label}:${prompt}`; } },
});
assert(manager.listActiveWork().some((item) => item.id === success.id && item.sessionId === 'session-a'), 'active work missing success run');
const waitedSuccess = await manager.waitForRun(success.id, 2000);
assert(waitedSuccess === success, 'waitForRun did not return the success run');
await manager.waitForIdle('session-a', 2000);
assert(success.status === 'completed', `success status ${success.status}`);
assert(manager.listActiveWork().every((item) => item.id !== success.id), 'completed run still active');
const successResult = JSON.parse(await readFile(success.resultPath, 'utf8'));
assert(successResult.result === 'mock success:hello', 'success result artifact mismatch');

// 2. Script failure path preserves artifacts and notifies model-visible layer.
const failScript = `export const meta = { name: 'failure_case', description: 'failure case' }
phase('Fail')
await agent('before fail', { label: 'mock before fail' })
throw new Error('BOOM_EXPECTED')
`;
const failed = await manager.start({
  script: failScript,
  sessionId: 'session-b',
  agent: { async run() { return 'before'; } },
});
await manager.waitForIdle('session-b', 2000);
assert(failed.status === 'failed', `failure status ${failed.status}`);
assert(String(failed.error).includes('BOOM_EXPECTED'), `failure error mismatch: ${failed.error}`);
const failOutput = await readFile(failed.outputPath, 'utf8');
assert(failOutput.includes('Background workflow failed: failure_case'), 'failure output heading missing');
assert(failOutput.includes('BOOM_EXPECTED'), 'failure output error missing');

// 3. No-agent workflow is rejected as failed.
const noAgentScript = `export const meta = { name: 'no_agent_case', description: 'no agent case' }
return { ok: true }
`;
const noAgent = await manager.start({ script: noAgentScript, sessionId: 'session-c' });
await manager.waitForIdle('session-c', 2000);
assert(noAgent.status === 'failed', `no-agent status ${noAgent.status}`);
assert(String(noAgent.error).includes('must call agent() at least once'), `no-agent error mismatch: ${noAgent.error}`);

// 4. Cancellation propagates to running agents and artifacts.
const cancelScript = `export const meta = { name: 'cancel_case', description: 'cancel case' }
phase('Long')
const result = await agent('long', { label: 'long mock' })
return { result }
`;
let abortObserved = false;
const cancelRun = await manager.start({
  script: cancelScript,
  sessionId: 'session-d',
  agent: {
    async run(_prompt, opts) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        opts.signal?.addEventListener('abort', () => {
          abortObserved = true;
          clearTimeout(timer);
          reject(new Error('mock aborted'));
        }, { once: true });
      });
      return 'should-not-complete';
    },
  },
});
assert(manager.cancel(cancelRun.id), 'cancel returned false');
await manager.waitForRun(cancelRun.id, 2000);
await waitUntil(() => cancelRun.status !== 'running', 'cancel terminal');
assert(cancelRun.status === 'cancelled', `cancel status ${cancelRun.status}`);
assert(abortObserved, 'agent did not observe abort');
const cancelOutput = await readFile(cancelRun.outputPath, 'utf8');
assert(cancelOutput.includes('Background workflow cancelled: cancel_case'), 'cancel output heading missing');

// 5. Concurrent runs get distinct ids and can be waited as a session group.
const concurrentScript = `export const meta = { name: 'concurrent_case', description: 'concurrent case' }
const result = await agent('x', { label: 'x' })
return { result }
`;
const c1 = await manager.start({ script: concurrentScript, sessionId: 'session-e', agent: { async run() { return '1'; } } });
const c2 = await manager.start({ script: concurrentScript, sessionId: 'session-e', agent: { async run() { return '2'; } } });
assert(c1.id !== c2.id, 'concurrent ids collided');
await manager.waitForIdle('session-e', 2000);
assert(c1.status === 'completed' && c2.status === 'completed', 'concurrent wait did not complete both');

// 6. Notification coverage: success/fail/no-agent/cancel/concurrent x2.
assert(notifications.length >= 6, `expected >=6 notifications, got ${notifications.length}`);
assert(notifications.some((n) => n.status === 'failed'), 'no failed notification');
assert(notifications.some((n) => n.status === 'cancelled'), 'no cancelled notification');

console.log(JSON.stringify({
  ok: true,
  tmp,
  runs: manager.list().map((run) => ({ id: run.id, status: run.status, sessionId: run.sessionId })),
  notifications: notifications.length,
}, null, 2));
