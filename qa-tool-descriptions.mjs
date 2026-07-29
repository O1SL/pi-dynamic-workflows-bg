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
assertIncludes(workflowTool.description, 'Core lifecycle: background by default, foreground:true only for inline waits; use workflow_wait to consume results, workflow_status/result to inspect progress and outcomes, and workflow_cancel to stop a running run.', 'workflow description');
assertIncludes(workflowTool.description, 'workflow_extend starts a linked workflow', 'workflow description');
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


console.log(JSON.stringify({ ok: true }, null, 2));
