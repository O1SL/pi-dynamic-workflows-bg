const pkg = await import('pi-dynamic-workflows-bg');

for (const name of ['createBackgroundWorkflowManager', 'createWorkflowTool', 'runWorkflow']) {
  if (typeof pkg[name] !== 'function') throw new Error(`package root export missing: ${name}`);
}

console.log(JSON.stringify({ ok: true, exports: ['createBackgroundWorkflowManager', 'createWorkflowTool', 'runWorkflow'] }, null, 2));
