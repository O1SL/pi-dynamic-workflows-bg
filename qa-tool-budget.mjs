import { applyToolBudgetToTools } from './dist/src/index.js';

const calls = [];
const baseTool = {
  name: 'read',
  label: 'Read',
  description: 'mock read',
  parameters: { type: 'object', properties: {} },
  async execute() {
    calls.push('read');
    return { content: [{ type: 'text', text: 'ok' }], details: { ok: true } };
  },
};

const state = { count: 0, softNotified: false };
const [tool] = applyToolBudgetToTools([baseTool], { soft: 2, hard: 3, block: '*' }, state);

const r1 = await tool.execute('1', {}, undefined, undefined, {});
if (r1.isError) throw new Error('first call unexpectedly failed');
if (r1.content.some((part) => part.text?.includes('soft limit'))) throw new Error('soft nudge too early');

const r2 = await tool.execute('2', {}, undefined, undefined, {});
if (!r2.content.some((part) => part.text?.includes('soft limit reached'))) throw new Error('soft nudge missing at soft limit');
if (!r2.details?.toolBudgetSoftReached) throw new Error('soft details missing');

const r3 = await tool.execute('3', {}, undefined, undefined, {});
if (r3.isError) throw new Error('hard limit should allow third call when hard=3');

const r4 = await tool.execute('4', {}, undefined, undefined, {});
if (!r4.isError || !r4.details?.toolBudgetExceeded) throw new Error('hard budget block missing');
if (calls.length !== 3) throw new Error(`base tool should have run three times, ran ${calls.length}`);

const [bashTool] = applyToolBudgetToTools([{ ...baseTool, name: 'bash' }], { hard: 1, block: ['read'] });
await bashTool.execute('a', {}, undefined, undefined, {});
const bashSecond = await bashTool.execute('b', {}, undefined, undefined, {});
if (bashSecond.isError) throw new Error('block list should not block bash when only read is configured');

console.log(JSON.stringify({ ok: true, calls, state }, null, 2));
