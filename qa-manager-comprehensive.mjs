import { mkdtemp, readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackgroundWorkflowManager } from './dist/src/index.js';
import { writeFileAtomic } from './dist/src/background.js';

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
const successGraph = success.snapshot.graph;
assert(successGraph?.runId === success.id, 'workflow graph runId mismatch');
assert(successGraph.nodes.some((node) => node.id === 'a1' && node.kind === 'agent' && node.status === 'done'), 'workflow graph missing first agent node');
const formattedEvents = manager.formatEvents(success.id, 10);
assert(formattedEvents.includes('workflow.started') && formattedEvents.includes('workflow.completed'), 'formatEvents missing lifecycle entries');
const listStatus = manager.formatStatus();
assert(listStatus.includes('Background workflows (') && listStatus.includes('completed 1'), `formatStatus list missing counts: ${listStatus}`);
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

// 1b. Extend starts an independent linked workflow with read-only parent context.
const extendScript = `export const meta = { name: 'extend_case', description: 'extend case' }
const frozen = Object.isFrozen(continuation) && Object.isFrozen(continuation.parent)
const result = await agent('parent=' + continuation.parent.runId + ';status=' + continuation.parent.status, { label: 'extended child' })
return { parent: continuation.parent.runId, status: continuation.parent.status, frozen, result }
`;
const extended = await manager.extend(success.id, {
  script: extendScript,
  agent: { async run(prompt) { return prompt; } },
});
await manager.waitForRun(extended.id, 2000);
assert(extended.status === 'completed', `extend status ${extended.status}`);
assert(extended.continuation?.kind === 'extend' && extended.continuation.parent.runId === success.id, 'extend continuation metadata mismatch');
const extendedStatus = JSON.parse(await readFile(extended.statusPath, 'utf8'));
assert(extendedStatus.continuation?.kind === 'extend' && extendedStatus.continuation?.parent?.runId === success.id, 'extend continuation was not persisted');
assert(extended.result?.result?.parent === success.id && extended.result?.result?.status === 'completed' && extended.result?.result?.frozen === true, 'extend continuation global mismatch');
assert((await readFile(success.eventsPath, 'utf8')).includes('workflow.continuation.created'), 'extend parent event missing');

const replaceParentScript = `export const meta = { name: 'replace_parent_case', description: 'replace parent case' }
const result = await agent('hold', { label: 'replace parent child' })
return { result }
`;
let replaceParentAborted = false;
const replaceParent = await manager.start({
  script: replaceParentScript,
  sessionId: 'session-replace-parent',
  agent: {
    async run(_prompt, opts) {
      await new Promise((resolve, reject) => opts.signal?.addEventListener('abort', () => { replaceParentAborted = true; reject(new Error('replace parent aborted')); }, { once: true }));
    },
  },
});
await waitUntil(() => replaceParent.snapshot.agents.length === 1, 'replace parent child start');
const replaced = await manager.replaceTail(replaceParent.id, {
  script: `export const meta = { name: 'replace_child_case', description: 'replace child case' }
const result = await agent('replaced=' + continuation.parent.runId + ';status=' + continuation.parent.status, { label: 'replace follow-up child' })
return { parent: continuation.parent.runId, status: continuation.parent.status, result }
`,
  agent: { async run(prompt) { return prompt; } },
});
await manager.waitForRun(replaced.id, 2000);
assert(replaceParentAborted && replaceParent.status === 'cancelled', `replace parent was not cancelled: ${replaceParent.status}`);
assert(replaced.status === 'completed' && replaced.continuation?.kind === 'replace_tail', 'replace child did not complete as linked workflow');
assert(replaced.result?.result?.parent === replaceParent.id && replaced.result?.result?.status === 'cancelled', 'replace continuation context mismatch');
await manager.replaceTail(success.id, { script: extendScript, agent: { async run() { return 'no'; } } })
  .then(() => { throw new Error('replaceTail should reject terminal parent'); }, (error) => {
    assert(String(error).includes('requires a running parent'), `replace terminal error mismatch: ${error}`);
  });
const invalidReplaceParent = await manager.start({
  script: replaceParentScript,
  sessionId: 'session-invalid-replace',
  agent: { async run(_prompt, opts) { await new Promise((resolve, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('invalid replace abort')), { once: true })); } },
});
await waitUntil(() => invalidReplaceParent.snapshot.agents.length === 1, 'invalid replace parent start');
await manager.replaceTail(invalidReplaceParent.id, { script: 'invalid workflow body', agent: { async run() { return 'no'; } } })
  .then(() => { throw new Error('replaceTail should reject invalid replacement script'); }, (error) => {
    assert(/SyntaxError|must start with/.test(String(error)), `invalid replacement error mismatch: ${error}`);
  });
assert(invalidReplaceParent.status === 'running', 'invalid replacement should not cancel running parent');
assert(manager.cancel(invalidReplaceParent.id), 'failed to cancel invalid replace parent');
await manager.waitForRun(invalidReplaceParent.id, 2000);

const graphParallelScript = `export const meta = { name: 'graph_parallel_case', description: 'graph parallel case' }
phase('Graph')
await agent('first', { label: 'first graph' })
await parallel([
  () => agent('second', { label: 'second graph' }),
  () => agent('third', { label: 'third graph' }),
])
return { ok: true }
`;
const graphParallel = await manager.start({
  script: graphParallelScript,
  sessionId: 'session-graph-parallel',
  agent: { async run(prompt, opts) { return `${opts.label}:${prompt}`; } },
});
await manager.waitForRun(graphParallel.id, 2000);
const graph = graphParallel.snapshot.graph;
const parallelGroup = graph?.nodes.find((node) => node.kind === 'parallel');
assert(parallelGroup?.status === 'done', 'workflow graph missing completed parallel group');
assert(graph.nodes.some((node) => node.parentId === parallelGroup.id && node.label === 'second graph'), 'workflow graph missing parallel child parentId');
assert(graph.edges.some((edge) => edge.from === 'a1' && edge.to === parallelGroup.id && edge.kind === 'seq'), 'workflow graph missing seq edge into parallel group');
const graphParallelStatus = JSON.parse(await readFile(graphParallel.statusPath, 'utf8'));
assert(graphParallelStatus.snapshot.graph.nodes.some((node) => node.parentId === parallelGroup.id && node.label === 'second graph'), 'serialized graph missing parallel parentId');

const graphPipelineScript = `export const meta = { name: 'graph_pipeline_case', description: 'graph pipeline case' }
phase('Pipe')
await pipeline(['one', 'two'],
  (value) => agent('stage 1 ' + value, { label: 'stage1-' + value }),
  (value, original, index) => agent('stage 2 ' + original, { label: 'stage2-' + original })
)
return { ok: true }
`;
const graphPipeline = await manager.start({
  script: graphPipelineScript,
  sessionId: 'session-graph-pipeline',
  agent: { async run(prompt, opts) { return `${opts.label}:${prompt}`; } },
});
await manager.waitForRun(graphPipeline.id, 2000);
const pipelineGroup = graphPipeline.snapshot.graph?.nodes.find((node) => node.kind === 'pipeline');
assert(pipelineGroup?.status === 'done', 'workflow graph missing completed pipeline group');
assert(graphPipeline.snapshot.graph.nodes.some((node) => node.parentId === pipelineGroup.id && node.pipelineCell?.stageIndex === 1 && node.pipelineCell?.itemLabel === 'one'), 'workflow graph missing pipeline cell metadata');
const graphPipelineStatus = JSON.parse(await readFile(graphPipeline.statusPath, 'utf8'));
assert(graphPipelineStatus.snapshot.graph.nodes.some((node) => node.parentId === pipelineGroup.id && node.pipelineCell?.stageIndex === 1 && node.pipelineCell?.itemLabel === 'one'), 'serialized graph missing pipelineCell metadata');

const nestedGraphScript = `export const meta = { name: 'nested_graph_case', description: 'nested graph case' }
phase('Nested')
await parallel([
  () => pipeline(['nested'], (value) => agent('inner ' + value, { label: 'inner duplicate' })),
  () => agent('outer', { label: 'inner duplicate' }),
])
return { ok: true }
`;
const nestedGraphRun = await manager.start({
  script: nestedGraphScript,
  sessionId: 'session-nested-graph',
  agent: { async run(prompt, opts) { return `${opts.label}:${prompt}`; } },
});
await manager.waitForRun(nestedGraphRun.id, 2000);
const nestedParallel = nestedGraphRun.snapshot.graph?.nodes.find((node) => node.kind === 'parallel');
const nestedPipeline = nestedGraphRun.snapshot.graph?.nodes.find((node) => node.kind === 'pipeline');
assert(nestedParallel && nestedPipeline?.parentId === nestedParallel.id, 'nested graph group parentId missing');
assert(nestedGraphRun.snapshot.graph.nodes.filter((node) => node.kind === 'agent' && node.label === 'inner duplicate').length === 2, 'duplicate-label graph agents missing');
assert(nestedGraphRun.snapshot.agents.every((agent) => agent.agentRunId), 'agentRunId missing from duplicate-label run');

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

const nondeterminismAliasScript = `export const meta = { name: 'nondeterminism_alias_case', description: 'nondeterminism alias case' }
const random = Math.random
await agent(String(random()), { label: 'should-not-run' })
return { ok: true }
`;
const nondeterminismAlias = await manager.start({ script: nondeterminismAliasScript, sessionId: 'session-nondeterminism-alias', agent: { async run() { return 'should-not-run'; } } });
await manager.waitForRun(nondeterminismAlias.id, 2000);
assert(nondeterminismAlias.status === 'failed' && String(nondeterminismAlias.error).includes('random'), `nondeterminism alias not blocked: ${nondeterminismAlias.error}`);
const nondeterminismGlobalScript = `export const meta = { name: 'nondeterminism_global_case', description: 'nondeterminism global case' }
await agent(String(globalThis.Date.now()), { label: 'should-not-run' })
return { ok: true }
`;
const nondeterminismGlobal = await manager.start({ script: nondeterminismGlobalScript, sessionId: 'session-nondeterminism-global', agent: { async run() { return 'should-not-run'; } } });
await manager.waitForRun(nondeterminismGlobal.id, 2000);
assert(nondeterminismGlobal.status === 'failed' && /Date|undefined|now/.test(String(nondeterminismGlobal.error)), `global Date not blocked: ${nondeterminismGlobal.error}`);
const codegenScript = `export const meta = { name: 'codegen_case', description: 'codegen case' }
await agent(String(this.constructor.constructor('return 1')()), { label: 'should-not-run' })
return { ok: true }
`;
const codegenRun = await manager.start({ script: codegenScript, sessionId: 'session-codegen', agent: { async run() { return 'should-not-run'; } } });
await manager.waitForRun(codegenRun.id, 2000);
assert(codegenRun.status === 'failed' && /code generation|Code generation|not allowed|constructor/i.test(String(codegenRun.error)), `dynamic code generation not blocked: ${codegenRun.error}`);

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

const cancelGraphScript = `export const meta = { name: 'cancel_graph_case', description: 'cancel graph case' }
phase('Cancel Graph')
await parallel([
  () => agent('long a', { label: 'long a' }),
  () => agent('long b', { label: 'long b' }),
])
return { ok: true }
`;
const cancelGraphRun = await manager.start({
  script: cancelGraphScript,
  sessionId: 'session-cancel-graph',
  agent: {
    async run(_prompt, opts) {
      await new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('cancel graph aborted')), { once: true });
      });
    },
  },
});
await waitUntil(() => cancelGraphRun.snapshot.graph?.nodes.some((node) => node.kind === 'parallel' && node.status === 'running'), 'cancel graph group running');
assert(manager.cancel(cancelGraphRun.id), 'cancel graph returned false');
await manager.waitForRun(cancelGraphRun.id, 2000);
assert(cancelGraphRun.snapshot.graph?.nodes.every((node) => node.status !== 'running'), 'cancelled graph left running nodes');

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

// 6. Session-scoped waitForIdle waits target-session runs without waiting for unrelated sessions.
const waitScopedScript = `export const meta = { name: 'wait_scoped_case', description: 'wait scoped case' }
const result = await agent('wait', { label: 'wait child' })
return { result }
`;
const scopedTarget = await manager.start({
  script: waitScopedScript,
  sessionId: 'session-wait-target',
  agent: { async run() { await new Promise((resolve) => setTimeout(resolve, 80)); return 'target-done'; } },
});
let unrelatedAbortObserved = false;
const scopedOther = await manager.start({
  script: waitScopedScript,
  sessionId: 'session-wait-other',
  agent: {
    async run(_prompt, opts) {
      await new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          unrelatedAbortObserved = true;
          reject(new Error('unrelated aborted'));
        }, { once: true });
      });
    },
  },
});
await manager.waitForIdle('session-wait-target', 2000);
assert(scopedTarget.status === 'completed', `target scoped wait status ${scopedTarget.status}`);
assert(scopedOther.status === 'running', 'session-scoped wait should not wait unrelated session');
assert(manager.cancel(scopedOther.id), 'failed to cancel unrelated scoped run');
await manager.waitForRun(scopedOther.id, 2000);
assert(unrelatedAbortObserved && scopedOther.status === 'cancelled', 'unrelated scoped run did not cancel cleanly');
const waitTimeoutRun = await manager.start({
  script: waitScopedScript,
  sessionId: 'session-wait-timeout',
  agent: {
    async run(_prompt, opts) {
      await new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('wait timeout run aborted')), { once: true });
      });
    },
  },
});
await manager.waitForRun(waitTimeoutRun.id, 10)
  .then(() => { throw new Error('waitForRun timeout should fail'); }, (error) => {
    assert(String(error).includes('Timed out waiting'), `waitForRun timeout error mismatch: ${error}`);
  });
assert(manager.cancel(waitTimeoutRun.id), 'failed to cancel wait timeout run');
await manager.waitForRun(waitTimeoutRun.id, 2000);

// 7. Notification coverage: success/fail/no-agent/cancel/concurrent x2 with batching.
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
const fallbackGraphNode = fallbackRun.snapshot.graph?.nodes.find((node) => node.label === 'fallback child');
assert(fallbackGraphNode?.attempts?.length === 2 && fallbackGraphNode.usage?.model === 'fallback/model', 'fallback graph attempt metadata missing');

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
assert(worktreeRun.snapshot.graph?.nodes.some((node) => node.worktreePath === worktreePath), 'worktree path missing from workflow graph');
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
const restoreDisabledManager = createBackgroundWorkflowManager({ runsRoot: tmp, restore: false });
assert(restoreDisabledManager.get(success.id) === undefined && restoreDisabledManager.list().length === 0, 'restore:false manager should not hydrate disk runs');
const malformedDir = join(tmp, '20990101000006-malformed-case');
await mkdir(malformedDir, { recursive: true });
await writeFile(join(malformedDir, 'status.json'), '{not valid json');
const restoredWithMalformed = makeManager(tmp, []);
assert(restoredWithMalformed.get('20990101000006-malformed-case') === undefined, 'malformed status should be ignored');
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

const aliveDir = join(tmp, '20990101000002-owned-running-case');
await mkdir(aliveDir, { recursive: true });
await writeFile(join(aliveDir, 'status.json'), JSON.stringify({
  id: '20990101000002-owned-running-case',
  name: 'owned_running_case',
  description: 'running run owned by a live process',
  status: 'running',
  ownerPid: process.ppid,
  cwd: process.cwd(),
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  artifactDir: aliveDir,
  outputPath: join(aliveDir, 'output.md'),
  resultPath: join(aliveDir, 'result.json'),
  statusPath: join(aliveDir, 'status.json'),
  eventsPath: join(aliveDir, 'events.jsonl'),
  snapshot: { name: 'owned_running_case', description: 'running run owned by a live process', phases: [], logs: [], agents: [], agentCount: 0, runningCount: 0, doneCount: 0, errorCount: 0 },
}, null, 2));
const restoredWithLiveOwner = makeManager(tmp, []);
assert(restoredWithLiveOwner.get('20990101000002-owned-running') === undefined, 'live owned running run should not be marked interrupted by another manager');
assert(!existsSync(join(aliveDir, 'events.jsonl')), 'live owned running run should not receive interrupted events');

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

// 19. Restored artifact paths are constrained to the real artifact directory.
const unsafeDir = join(tmp, '20990101000004-unsafe-paths');
await mkdir(unsafeDir, { recursive: true });
await writeFile(join(unsafeDir, 'status.json'), JSON.stringify({
  id: '20990101000004-unsafe-paths',
  name: 'unsafe_paths',
  description: 'unsafe restored paths case',
  status: 'completed',
  cwd: process.cwd(),
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  artifactDir: '/tmp/should-not-be-trusted',
  outputPath: '/tmp/unsafe-output.md',
  resultPath: '/tmp/unsafe-result.json',
  statusPath: '/tmp/unsafe-status.json',
  eventsPath: '/tmp/unsafe-events.jsonl',
  snapshot: {
    name: 'unsafe_paths',
    description: 'unsafe restored paths case',
    phases: [],
    logs: [],
    agents: [{ id: 1, label: 'unsafe child', prompt: 'x', status: 'done', sessionFile: '/tmp/unsafe-session.jsonl' }],
    agentCount: 1,
    runningCount: 0,
    doneCount: 1,
    errorCount: 0,
  },
}, null, 2));
const unsafeRun = lazyManager.get('20990101000004-unsafe-paths');
assert(unsafeRun?.artifactDir === unsafeDir, `unsafe artifactDir was trusted: ${unsafeRun?.artifactDir}`);
assert(unsafeRun.outputPath === join(unsafeDir, 'output.md'), `unsafe outputPath was trusted: ${unsafeRun.outputPath}`);
assert(unsafeRun.resultPath === join(unsafeDir, 'result.json'), `unsafe resultPath was trusted: ${unsafeRun.resultPath}`);
assert(unsafeRun.statusPath === join(unsafeDir, 'status.json'), `unsafe statusPath was trusted: ${unsafeRun.statusPath}`);
assert(unsafeRun.eventsPath === join(unsafeDir, 'events.jsonl'), `unsafe eventsPath was trusted: ${unsafeRun.eventsPath}`);
assert(lazyManager.formatTranscript('20990101000004-unsafe-paths').includes('outside workflow artifact directory'), 'unsafe transcript path was not rejected');

// 20. Ambiguous prefixes report candidate run ids instead of looking like a missing run.
for (const id of ['20990101000003-ambiguous-a', '20990101000003-ambiguous-b']) {
  const dir = join(tmp, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'status.json'), JSON.stringify({
    id,
    name: id.replace('20990101000003-', ''),
    description: 'ambiguous prefix case',
    status: 'completed',
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    artifactDir: dir,
    outputPath: join(dir, 'output.md'),
    resultPath: join(dir, 'result.json'),
    statusPath: join(dir, 'status.json'),
    eventsPath: join(dir, 'events.jsonl'),
    snapshot: { name: id, description: 'ambiguous prefix case', phases: [], logs: [], agents: [], agentCount: 0, runningCount: 0, doneCount: 0, errorCount: 0 },
  }, null, 2));
}
const ambiguousText = lazyManager.formatResult('20990101000003');
assert(ambiguousText.includes('Ambiguous background workflow id/prefix'), 'ambiguous prefix did not report ambiguity');
assert(ambiguousText.includes('20990101000003-ambiguous-a') && ambiguousText.includes('20990101000003-ambiguous-b'), 'ambiguous prefix did not list candidates');

// 21. Prune is dry-run by default, only targets terminal runs, honors keepLast, and removes candidates when explicitly requested.
const pruneActiveRun = await lazyManager.start({
  script: waitScopedScript,
  sessionId: 'session-prune-active',
  agent: { async run(_prompt, opts) { await new Promise((resolve, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('prune active abort')), { once: true })); } },
});
const pruneActive = await lazyManager.pruneRuns({ keepLast: 0, dryRun: false });
assert(!pruneActive.removed.includes(pruneActiveRun.id) && existsSync(pruneActiveRun.artifactDir), 'prune removed a running workflow');
assert(lazyManager.cancel(pruneActiveRun.id), 'failed to cancel prune active run');
await lazyManager.waitForRun(pruneActiveRun.id, 2000);
const recentDir = join(tmp, '20990101000005-recent-prune-case');
const oldDir = join(tmp, '20000101000000-old-prune-case');
for (const [id, dir, iso] of [
  ['20990101000005-recent-prune-case', recentDir, new Date().toISOString()],
  ['20000101000000-old-prune-case', oldDir, '2000-01-01T00:00:00.000Z'],
]) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'status.json'), JSON.stringify({
    id, name: id, description: 'olderThan prune case', status: 'completed', cwd: process.cwd(), startedAt: iso, updatedAt: iso, completedAt: iso,
    artifactDir: dir, outputPath: join(dir, 'output.md'), resultPath: join(dir, 'result.json'), statusPath: join(dir, 'status.json'), eventsPath: join(dir, 'events.jsonl'),
    snapshot: { name: id, description: 'olderThan prune case', phases: [], logs: [], agents: [], agentCount: 0, runningCount: 0, doneCount: 0, errorCount: 0 },
  }, null, 2));
}
const olderPreview = await lazyManager.pruneRuns({ keepLast: 0, olderThanDays: 1 });
assert(olderPreview.candidates.includes('20000101000000-old-prune-case') && !olderPreview.candidates.includes('20990101000005-recent-prune-case'), `olderThan prune mismatch: ${JSON.stringify(olderPreview)}`);
const prunePreview = await lazyManager.pruneRuns({ keepLast: 1 });
assert(prunePreview.dryRun === true && prunePreview.candidates.length >= 1 && prunePreview.removed.length === 0, `unexpected prune preview: ${JSON.stringify(prunePreview)}`);
assert(existsSync(join(tmp, prunePreview.candidates[0], 'status.json')), 'dry-run prune removed artifacts unexpectedly');
const pruneDelete = await lazyManager.pruneRuns({ keepLast: 1, dryRun: false });
assert(pruneDelete.dryRun === false && pruneDelete.removed.length === pruneDelete.candidates.length, `unexpected prune delete: ${JSON.stringify(pruneDelete)}`);
for (const id of pruneDelete.removed) assert(!existsSync(join(tmp, id)), `pruned artifact directory still exists: ${id}`);
await lazyManager.pruneRuns({ keepLast: Number.NaN })
  .then(() => { throw new Error('invalid prune keepLast should fail'); }, (error) => {
    assert(String(error).includes('keepLast'), `invalid prune keepLast error mismatch: ${error}`);
  });

// 22. Atomic artifact writes clean up temporary files if final rename fails.
const atomicDir = join(tmp, 'atomic-write-case');
await mkdir(atomicDir, { recursive: true });
await writeFileAtomic(atomicDir, 'cannot replace directory')
  .then(() => { throw new Error('atomic write to a directory should fail'); }, () => undefined);
const atomicEntries = await readdir(tmp);
assert(!atomicEntries.some((entry) => entry.includes('atomic-write-case.') && entry.endsWith('.tmp')), `atomic write left temporary files: ${atomicEntries.join(',')}`);

// 23. Status listing limits output while preserving counts.
const limitedStatus = manager.formatStatus(undefined, 2);
assert(limitedStatus.includes('Showing 2/') && limitedStatus.split('\n').filter((line) => line.startsWith('- ')).length === 2, `limited status output mismatch: ${limitedStatus}`);

console.log(JSON.stringify({
  ok: true,
  tmp,
  runs: manager.list().map((run) => ({ id: run.id, status: run.status, sessionId: run.sessionId })),
  notifications: notifications.length,
  notifiedRunCount,
}, null, 2));
