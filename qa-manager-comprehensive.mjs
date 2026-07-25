import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
      notifications.push({ message, id: run.id, status: run.status, sessionId: run.sessionId, count: 1 });
    },
    notifyBatch(message, runs) {
      notifications.push({ message, id: runs.map((run) => run.id).join(','), status: 'batch', count: runs.length });
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
const successEvents = await readFile(success.eventsPath, 'utf8');
if (!successEvents.includes('workflow.started') || !successEvents.includes('workflow.completed') || !successEvents.includes('workflow.agent.started')) {
  throw new Error(`events artifact missing lifecycle events: ${successEvents}`);
}

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

// 6. Notification coverage: success/fail/no-agent/cancel/concurrent x2 with batching.
const notifiedRunCount = notifications.reduce((total, n) => total + (n.count ?? 1), 0);
assert(notifiedRunCount >= 6, `expected >=6 notified runs, got ${notifiedRunCount} across ${notifications.length} notification(s)`);
assert(notifications.some((n) => n.status === 'failed'), 'no failed notification');
assert(notifications.some((n) => n.status === 'cancelled'), 'no cancelled notification');
assert(notifications.some((n) => n.status === 'batch' && n.count >= 2), 'no batched completion notification');

// 7. Notification size limit keeps model-visible content compact while preserving full artifacts.
const smallNotifications = [];
const smallManager = createBackgroundWorkflowManager({
  runsRoot: tmp,
  maxNotificationChars: 600,
  notificationBatchMs: 0,
  notify(message, run) {
    smallNotifications.push({ message, id: run.id, status: run.status });
  },
});
const hugeScript = `export const meta = { name: 'huge_result_case', description: 'huge result case' }
const result = await agent('huge', { label: 'huge' })
return { result }
`;
const hugeRun = await smallManager.start({
  script: hugeScript,
  sessionId: 'session-huge',
  agent: { async run() { return 'X'.repeat(5000); } },
});
await smallManager.waitForRun(hugeRun.id, 2000);
assert(smallNotifications.length === 1, `expected one small notification, got ${smallNotifications.length}`);
assert(smallNotifications[0].message.includes('Notification truncated'), 'large notification was not truncated');
const hugeOutput = await readFile(hugeRun.outputPath, 'utf8');
assert(hugeOutput.includes('X'.repeat(1000)), 'full huge output artifact was not preserved');

// 8. Restore historical runs and convert stale running records to interrupted.
const restoredManager = makeManager(tmp, []);
assert(restoredManager.get(success.id)?.status === 'completed', 'completed run not restored');
const staleDir = join(tmp, '20990101000000-stale-case');
await mkdir(staleDir, { recursive: true });
await writeFile(join(staleDir, 'status.json'), JSON.stringify({
  id: '20990101000000-stale-case',
  name: 'stale_case',
  description: 'stale running case',
  status: 'running',
  cwd: process.cwd(),
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  artifactDir: staleDir,
  outputPath: join(staleDir, 'output.md'),
  resultPath: join(staleDir, 'result.json'),
  statusPath: join(staleDir, 'status.json'),
  eventsPath: join(staleDir, 'events.jsonl'),
  snapshot: { name: 'stale_case', description: 'stale running case', phases: [], logs: [], agents: [], agentCount: 0, runningCount: 0, doneCount: 0, errorCount: 0 },
}, null, 2));
const restoredWithStale = makeManager(tmp, []);
assert(restoredWithStale.get('20990101000000-stale-case')?.status === 'interrupted', 'stale running run not marked interrupted');
assert(existsSync(join(staleDir, 'events.jsonl')), 'interrupted restore did not write events.jsonl');

console.log(JSON.stringify({
  ok: true,
  tmp,
  runs: manager.list().map((run) => ({ id: run.id, status: run.status, sessionId: run.sessionId })),
  notifications: notifications.length,
  notifiedRunCount,
}, null, 2));
