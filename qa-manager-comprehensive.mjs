import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const formattedEvents = manager.formatEvents(success.id, 10);
assert(formattedEvents.includes('workflow.started') && formattedEvents.includes('workflow.completed'), 'formatEvents missing lifecycle entries');
const summary = manager.formatSummary(success.id);
assert(summary.includes('Workflow summary') && summary.includes('Suggested next actions') && summary.includes(success.outputPath), 'formatSummary missing expected content');
const fakeSessionFile = join(success.artifactDir, 'fake-child-session.jsonl');
await writeFile(fakeSessionFile, [
  JSON.stringify({ type: 'session', id: 'fake', version: 3, timestamp: new Date().toISOString(), cwd: process.cwd() }),
  JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'hello child' }] } }),
  JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'child transcript ok' }] } }),
].join('\n') + '\n');
success.snapshot.agents[0].sessionFile = fakeSessionFile;
const transcript = manager.formatTranscript(success.id, 'mock success', 10);
assert(transcript.includes('child transcript ok'), 'workflow transcript did not include child assistant text');

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

// 8. Token budget exhaustion fails before additional agent calls.
const budgetScript = `export const meta = { name: 'budget_case', description: 'budget case' }
await agent('first', { label: 'first' })
await agent('second', { label: 'second' })
return { ok: true }
`;
const budgetRun = await manager.start({
  script: budgetScript,
  sessionId: 'session-budget',
  tokenBudget: 1,
  agent: { async run(prompt) { return `large-result-${prompt}-${'Y'.repeat(100)}`; } },
});
await manager.waitForRun(budgetRun.id, 2000);
assert(budgetRun.status === 'failed', `budget run status ${budgetRun.status}`);
assert(String(budgetRun.error).includes('token budget exhausted'), `budget error mismatch: ${budgetRun.error}`);

// 9. Per-child timeout aborts a slow agent and returns null for that branch.
const timeoutScript = `export const meta = { name: 'timeout_case', description: 'timeout case' }
const result = await agent('slow', { label: 'slow child', timeoutMs: 50 })
return { result }
`;
let timeoutAbortObserved = false;
const timeoutRun = await manager.start({
  script: timeoutScript,
  sessionId: 'session-timeout',
  agent: {
    async run(_prompt, opts) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        opts.signal?.addEventListener('abort', () => {
          timeoutAbortObserved = true;
          clearTimeout(timer);
          reject(new Error('timeout abort observed'));
        }, { once: true });
      });
      return 'should-not-finish';
    },
  },
});
await manager.waitForRun(timeoutRun.id, 2000);
assert(timeoutAbortObserved, 'per-child timeout did not abort slow agent');
assert(timeoutRun.status === 'completed', `timeout workflow status ${timeoutRun.status}`);
assert(timeoutRun.result?.result?.result === null, 'timed-out child branch should return null');

// 10. agent({ model }) is passed through to the child runner.
let observedModel;
const modelScript = `export const meta = { name: 'model_option_case', description: 'model option case' }
const result = await agent('model-check', { label: 'model child', model: 'provider/model-id' })
return { result }
`;
const modelRun = await manager.start({
  script: modelScript,
  sessionId: 'session-model',
  agent: { async run(_prompt, opts) { observedModel = opts.model; return 'model-ok'; } },
});
await manager.waitForRun(modelRun.id, 2000);
assert(observedModel === 'provider/model-id', `agent model option was not passed through: ${observedModel}`);

// 11. Retry with fallbackModels on retryable provider/model failures.
const fallbackScript = `export const meta = { name: 'fallback_case', description: 'fallback case' }
const result = await agent('fallback-check', { label: 'fallback child', model: 'primary/model', fallbackModels: ['fallback/model'], retry: 0 })
return { result }
`;
const attemptedModels = [];
const fallbackRun = await manager.start({
  script: fallbackScript,
  sessionId: 'session-fallback',
  agent: {
    async run(_prompt, opts) {
      attemptedModels.push(opts.model ?? 'default');
      if (opts.model === 'primary/model') throw new Error('429 provider resource unavailable');
      return `fallback-ok:${opts.model}`;
    },
  },
});
await manager.waitForRun(fallbackRun.id, 2000);
assert(fallbackRun.status === 'completed', `fallback run status ${fallbackRun.status}`);
assert(attemptedModels.join(',') === 'primary/model,fallback/model', `fallback attempts mismatch: ${attemptedModels.join(',')}`);
assert(fallbackRun.result?.result?.result === 'fallback-ok:fallback/model', 'fallback result mismatch');
const fallbackAttempts = fallbackRun.snapshot.agents[0]?.attempts ?? [];
assert(fallbackAttempts.length === 2, `expected 2 fallback attempts, got ${fallbackAttempts.length}`);
assert(fallbackAttempts[0].status === 'failed' && fallbackAttempts[1].status === 'succeeded', 'fallback attempt ledger statuses mismatch');
const fallbackEvents = await readFile(fallbackRun.eventsPath, 'utf8');
assert(fallbackEvents.includes('workflow.agent.attempt') && fallbackEvents.includes('fallback/model'), 'fallback attempt events missing');

// 12. Retryable provider/model failures retry the same agent branch before returning null.
const retryScript = `export const meta = { name: 'retry_case', description: 'retry case' }
const result = await agent('retry-check', { label: 'retry child', retry: 2, retryDelayMs: 1 })
return { result }
`;
let retryAttempts = 0;
const retryRun = await manager.start({
  script: retryScript,
  sessionId: 'session-retry',
  agent: {
    async run() {
      retryAttempts++;
      if (retryAttempts < 3) throw new Error('429 transient provider resource unavailable');
      return 'retry-ok';
    },
  },
});
await manager.waitForRun(retryRun.id, 2000);
assert(retryRun.status === 'completed', `retry run status ${retryRun.status}`);
assert(retryAttempts === 3, `retry attempts mismatch: ${retryAttempts}`);
assert(retryRun.result?.result?.result === 'retry-ok', 'retry result mismatch');
const retryLedger = retryRun.snapshot.agents[0]?.attempts ?? [];
assert(retryLedger.length === 3 && retryLedger[2].status === 'succeeded', `retry ledger mismatch: ${JSON.stringify(retryLedger)}`);
const retryEvents = await readFile(retryRun.eventsPath, 'utf8');
assert(retryEvents.includes('"attempt":1') && retryEvents.includes('"attempt":3'), 'retry attempt events missing attempt numbers');

// 13. Non-retryable failures do not use fallbackModels.
const nonRetryScript = `export const meta = { name: 'no_fallback_case', description: 'no fallback case' }
const result = await agent('no-fallback-check', { label: 'no fallback child', model: 'primary/model', fallbackModels: ['fallback/model'] })
return { result }
`;
const nonRetryModels = [];
const nonRetryRun = await manager.start({
  script: nonRetryScript,
  sessionId: 'session-no-fallback',
  agent: {
    async run(_prompt, opts) {
      nonRetryModels.push(opts.model ?? 'default');
      throw new Error('deterministic validation failed');
    },
  },
});
await manager.waitForRun(nonRetryRun.id, 2000);
assert(nonRetryRun.status === 'completed', `non-retry workflow status ${nonRetryRun.status}`);
assert(nonRetryModels.join(',') === 'primary/model', `non-retry attempted fallback unexpectedly: ${nonRetryModels.join(',')}`);
assert(nonRetryRun.result?.result?.result === null, 'non-retry failed branch should return null');

// 14. Worktree isolation creates a real git worktree and records it in snapshot/events.
const repoDir = join(tmp, 'repo');
await mkdir(repoDir, { recursive: true });
execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'qa@example.com'], { cwd: repoDir });
execFileSync('git', ['config', 'user.name', 'QA'], { cwd: repoDir });
await writeFile(join(repoDir, 'README.md'), 'qa\n');
execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
const worktreeScript = `export const meta = { name: 'worktree_case', description: 'worktree case' }
const result = await agent('isolated', { label: 'isolated child', isolation: 'worktree' })
return { result }
`;
const worktreeRun = await manager.start({
  script: worktreeScript,
  cwd: repoDir,
  sessionId: 'session-worktree',
  agent: { async run() { return 'isolated-ok'; } },
});
await manager.waitForRun(worktreeRun.id, 2000);
const worktreePath = worktreeRun.snapshot.agents[0]?.worktreePath;
assert(worktreePath && existsSync(worktreePath), `worktree path missing: ${worktreePath}`);
const worktreeEvents = await readFile(worktreeRun.eventsPath, 'utf8');
assert(worktreeEvents.includes('workflow.agent.worktree'), 'worktree event missing');
const listedWorktrees = manager.listWorktrees(worktreeRun.id);
assert(listedWorktrees.length === 1 && listedWorktrees[0].exists, 'listWorktrees did not report created worktree');
await writeFile(join(worktreePath, 'dirty.txt'), 'dirty change\n');
const refusedCleanup = await manager.cleanupWorktrees(worktreeRun.id);
assert(refusedCleanup.removed.length === 0 && refusedCleanup.failed.length === 1, `dirty cleanup should be refused: ${JSON.stringify(refusedCleanup)}`);
assert(existsSync(worktreePath), 'dirty worktree should still exist after refused cleanup');
const cleanup = await manager.cleanupWorktrees(worktreeRun.id, true);
assert(cleanup.removed.length === 1 && cleanup.failed.length === 0, `force cleanup failed: ${JSON.stringify(cleanup)}`);
assert(!existsSync(worktreePath), 'worktree still exists after force cleanup');

// 15. agent({ toolBudget }) is passed through to the child runner.
let observedToolBudget;
const toolBudgetScript = `export const meta = { name: 'tool_budget_case', description: 'tool budget case' }
const result = await agent('tool-budget-check', { label: 'tool budget child', toolBudget: { hard: 2, block: '*' } })
return { result }
`;
const toolBudgetRun = await manager.start({
  script: toolBudgetScript,
  sessionId: 'session-tool-budget',
  agent: { async run(_prompt, opts) { observedToolBudget = opts.toolBudget; return 'tool-budget-ok'; } },
});
await manager.waitForRun(toolBudgetRun.id, 2000);
assert(observedToolBudget?.hard === 2 && observedToolBudget?.block === '*', `toolBudget not passed through: ${JSON.stringify(observedToolBudget)}`);

// 16. agent({ turnBudget }) is passed through to the child runner.
let observedTurnBudget;
const turnBudgetScript = `export const meta = { name: 'turn_budget_case', description: 'turn budget case' }
const result = await agent('turn-budget-check', { label: 'turn budget child', turnBudget: { maxTurns: 1, graceTurns: 1 } })
return { result }
`;
const turnBudgetRun = await manager.start({
  script: turnBudgetScript,
  sessionId: 'session-turn-budget',
  agent: { async run(_prompt, opts) { observedTurnBudget = opts.turnBudget; return 'turn-budget-ok'; } },
});
await manager.waitForRun(turnBudgetRun.id, 2000);
assert(observedTurnBudget?.maxTurns === 1 && observedTurnBudget?.graceTurns === 1, `turnBudget not passed through: ${JSON.stringify(observedTurnBudget)}`);

// 17. Restore historical runs and convert stale running records to interrupted.
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

// 18. Runs written after manager construction are lazily restored from disk by id/prefix lookups.
const lazyManager = makeManager(tmp, []);
const lazyDir = join(tmp, '20990101000001-lazy-case');
await mkdir(lazyDir, { recursive: true });
await writeFile(join(lazyDir, 'events.jsonl'), JSON.stringify({ type: 'workflow.completed', id: '20990101000001-lazy-case', ts: new Date().toISOString() }) + '\n');
await writeFile(join(lazyDir, 'status.json'), JSON.stringify({
  id: '20990101000001-lazy-case',
  name: 'lazy_case',
  description: 'lazy disk restore case',
  status: 'completed',
  cwd: process.cwd(),
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  artifactDir: lazyDir,
  outputPath: join(lazyDir, 'output.md'),
  resultPath: join(lazyDir, 'result.json'),
  statusPath: join(lazyDir, 'status.json'),
  eventsPath: join(lazyDir, 'events.jsonl'),
  snapshot: { name: 'lazy_case', description: 'lazy disk restore case', phases: [], logs: [], agents: [], agentCount: 0, runningCount: 0, doneCount: 0, errorCount: 0 },
  result: { meta: { name: 'lazy_case', description: 'lazy disk restore case' }, result: { lazy: true }, logs: [], phases: [], agentCount: 1, durationMs: 1 },
}, null, 2));
assert(lazyManager.get('20990101000001-lazy')?.status === 'completed', 'lazy run not restored by prefix lookup');
assert(lazyManager.formatResult('20990101000001-lazy').includes('"lazy": true'), 'lazy restored result not formatted');
assert(lazyManager.formatEvents('20990101000001-lazy').includes('workflow.completed'), 'lazy restored events not formatted');

console.log(JSON.stringify({
  ok: true,
  tmp,
  runs: manager.list().map((run) => ({ id: run.id, status: run.status, sessionId: run.sessionId })),
  notifications: notifications.length,
  notifiedRunCount,
}, null, 2));
