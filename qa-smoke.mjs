import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackgroundWorkflowManager, createWorkflowTool } from './dist/src/index.js';

const tmp = await mkdtemp(join(tmpdir(), 'dwf-bg-qa-'));
const notifications = [];
const manager = createBackgroundWorkflowManager({
  runsRoot: tmp,
  notify(message, run) {
    notifications.push({ message, id: run.id, status: run.status });
  },
});

const script = `export const meta = { name: 'qa_smoke', description: 'QA smoke workflow' }
phase('Mock')
const a = await agent('first prompt', { label: 'first mock' })
const b = await parallel([
  () => agent('second prompt', { label: 'second mock' }),
  () => agent('third prompt', { label: 'third mock' }),
])
return { a, b }
`;

const run = await manager.start({
  script,
  cwd: process.cwd(),
  agent: {
    async run(prompt, opts) {
      return `mock:${opts?.label}:${prompt}`;
    },
  },
});

if (run.status !== 'running') throw new Error(`expected running immediately, got ${run.status}`);

for (let i = 0; i < 100 && run.status === 'running'; i++) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

if (run.status !== 'completed') throw new Error(`expected completed, got ${run.status}: ${run.error}`);
if (run.snapshot.agentCount !== 3) throw new Error(`expected 3 agents, got ${run.snapshot.agentCount}`);
if (notifications.length !== 1) throw new Error(`expected 1 notification, got ${notifications.length}`);

const statusJson = JSON.parse(await readFile(run.statusPath, 'utf8'));
if (statusJson.status !== 'completed') throw new Error('status artifact not completed');
const resultJson = JSON.parse(await readFile(run.resultPath, 'utf8'));
if (resultJson.a !== 'mock:first mock:first prompt') throw new Error('unexpected result artifact');
const output = await readFile(run.outputPath, 'utf8');
if (!output.includes('Background workflow completed: qa_smoke')) throw new Error('unexpected output artifact');

const tool = createWorkflowTool({ backgroundManager: manager });
const toolResult = await tool.execute?.('call-1', { script }, undefined, undefined, {
  cwd: process.cwd(),
  modelRegistry: undefined,
  model: undefined,
});
const text = toolResult?.content?.[0]?.text ?? '';
if (!text.includes('Started background workflow qa_smoke')) throw new Error(`tool did not start background: ${text}`);

console.log(JSON.stringify({ ok: true, tmp, runId: run.id, notification: notifications[0] }, null, 2));
