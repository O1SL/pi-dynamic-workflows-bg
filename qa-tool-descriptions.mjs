import extension from './dist/extensions/workflow.js';
import { createWorkflowTool } from './dist/src/index.js';

function assertIncludes(haystack, needle, label) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${label} missing expected text: ${needle}`);
  }
}

const workflowTool = createWorkflowTool();
const guidelines = workflowTool.promptGuidelines?.join('\n') ?? '';
assertIncludes(guidelines, 'pi-dynamic-workflows-bg` skill before advanced authoring', 'workflow guidance');
assertIncludes(guidelines, 'pi-dynamic-workflows-bg` skill before deeper diagnostics', 'workflow guidance');
assertIncludes(workflowTool.description, 'workflow_wait to consume results', 'workflow description');
assertIncludes(workflowTool.description, 'workflow_extend starts a linked workflow', 'workflow description');
assertIncludes(workflowTool.description, 'workflow_resume continues one child session', 'workflow description');
assertIncludes(workflowTool.description, 'workflow_summary/events/transcript inspect state', 'workflow description');
assertIncludes(workflowTool.description, 'workflow_steer sends experimental live guidance', 'workflow description');
assertIncludes(workflowTool.description, 'read the `pi-dynamic-workflows-bg` skill', 'workflow description');
assertIncludes(guidelines, 'continuation.parent.runId/result/outputPath/snapshot', 'workflow guidance');
assertIncludes(guidelines, 'not continuation.id/result', 'workflow guidance');

const tools = new Map();
extension({
  registerTool(tool) { tools.set(tool.name, tool); },
  getActiveTools() { return []; },
  setActiveTools() {},
  registerCommand() {},
  registerMessageRenderer() {},
  appendEntry() {},
  sendMessage() {},
  events: { on() { return () => {}; }, emit() {} },
  on() {},
});

const extendDescription = tools.get('workflow_extend')?.description ?? '';
assertIncludes(extendDescription, 'Parent remains unchanged', 'workflow_extend description');
assertIncludes(extendDescription, 'Use after workflow_result/summary', 'workflow_extend description');
assertIncludes(extendDescription, 'continuation.parent.runId/result/outputPath/snapshot', 'workflow_extend description');

const replaceDescription = tools.get('workflow_replace_tail')?.description ?? '';
assertIncludes(replaceDescription, 'Cancel a running parent', 'workflow_replace_tail description');
assertIncludes(replaceDescription, 'Use only when the current parent direction is wrong', 'workflow_replace_tail description');
assertIncludes(replaceDescription, 'validated before cancellation', 'workflow_replace_tail description');
assertIncludes(replaceDescription, 'never modified or resumed', 'workflow_replace_tail description');

console.log(JSON.stringify({ ok: true }, null, 2));
