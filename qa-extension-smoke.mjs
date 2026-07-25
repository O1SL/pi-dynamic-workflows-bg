import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from './dist/extensions/workflow.js';

const registryKey = Symbol.for('pi-subagents.background-work.v1');
delete globalThis[registryKey];

const tmp = await mkdtemp(join(tmpdir(), 'dwf-bg-ext-qa-'));
const tools = new Map();
const commands = new Map();
const renderers = new Map();
const sentMessages = [];
const appendedEntries = [];
const emitter = new EventEmitter();

const pi = {
  registerTool(tool) { tools.set(tool.name, tool); },
  getActiveTools() { return []; },
  setActiveTools(names) { this.activeTools = names; },
  registerCommand(name, command) { commands.set(name, command); },
  registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
  appendEntry(type, data) { appendedEntries.push({ type, data }); },
  sendMessage(message, options) { sentMessages.push({ message, options }); },
  events: {
    on(channel, handler) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
    emit(channel, payload) { emitter.emit(channel, payload); },
  },
  on(event, handler) { this[`on_${event}`] = handler; },
};

extension(pi);

if (!tools.has('workflow')) throw new Error('workflow tool was not registered');
for (const name of ['workflow-status', 'workflow-result', 'workflow-cancel']) {
  if (!commands.has(name)) throw new Error(`${name} command was not registered`);
}
if (!renderers.has('background-workflow-result')) throw new Error('message renderer was not registered');
if (appendedEntries.length !== 0) throw new Error('extension should not use appendEntry for model-visible completion');

const registry = globalThis[registryKey];
if (!registry?.providers?.has('pi-dynamic-workflows-bg')) throw new Error('background-work provider not registered');

const script = `export const meta = { name: 'extension_smoke', description: 'Extension smoke workflow' }
phase('Mock')
const result = await agent('hello', { label: 'mock child' })
return { result }
`;

const tool = tools.get('workflow');
const result = await tool.execute('call-1', { script }, undefined, undefined, {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => 'session-qa' },
  modelRegistry: undefined,
  model: undefined,
});
const text = result.content[0].text;
if (!text.includes('Started background workflow extension_smoke')) throw new Error(`unexpected start result: ${text}`);
const active = registry.providers.get('pi-dynamic-workflows-bg').listActiveWork();
if (active.length !== 1 || active[0].sessionId !== 'session-qa') throw new Error(`bad active provider items: ${JSON.stringify(active)}`);

// Cancel the real background run quickly; the completion path should still send a model-visible message.
const runId = result.details.id;
const cancelCommand = commands.get('workflow-cancel');
await cancelCommand.handler(runId, { ui: { notify() {} } });

for (let i = 0; i < 100 && sentMessages.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (sentMessages.length !== 1) throw new Error(`expected one sendMessage completion, got ${sentMessages.length}`);
const sent = sentMessages[0];
if (sent.message.customType !== 'background-workflow-result') throw new Error('completion customType mismatch');
if (sent.options?.triggerTurn !== true) throw new Error('completion did not request triggerTurn');
if (!String(sent.message.content).includes('Background workflow')) throw new Error('completion content missing heading');

const activeAfter = registry.providers.get('pi-dynamic-workflows-bg').listActiveWork();
if (activeAfter.length !== 0) throw new Error(`provider should have no active items after completion: ${JSON.stringify(activeAfter)}`);

console.log(JSON.stringify({ ok: true, runId, sent: { customType: sent.message.customType, triggerTurn: sent.options.triggerTurn } }, null, 2));
