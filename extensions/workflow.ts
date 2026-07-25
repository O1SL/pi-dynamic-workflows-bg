import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createBackgroundWorkflowManager, createWorkflowTool } from "../src/index.js";

type BackgroundWorkDisposer = () => void;

type BackgroundWorkProvider = {
  name: string;
  listActiveWork(): Array<{ id: string; sessionId: string }>;
  wakeChannels?: string[];
};

type BackgroundWorkRegistry = {
  version: 1;
  providers: Map<string, BackgroundWorkProvider>;
};

const BACKGROUND_WORK_REGISTRY_KEY = "pi-subagents.background-work.v1";

function registerBackgroundWorkProviderCompat(provider: BackgroundWorkProvider): BackgroundWorkDisposer {
  const key = Symbol.for(BACKGROUND_WORK_REGISTRY_KEY);
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  let registry = globalObject[key] as BackgroundWorkRegistry | undefined;
  if (!registry) {
    registry = { version: 1, providers: new Map() };
    globalObject[key] = registry;
  }
  if (registry.version !== 1 || !(registry.providers instanceof Map)) return () => undefined;
  registry.providers.set(provider.name, provider);
  return () => {
    if (registry?.providers.get(provider.name) === provider) registry.providers.delete(provider.name);
  };
}

function registerBackgroundWorkProvider(manager: ReturnType<typeof createBackgroundWorkflowManager>) {
  return registerBackgroundWorkProviderCompat({
    name: "pi-dynamic-workflows-bg",
    wakeChannels: ["background-workflow-result"],
    listActiveWork() {
      return manager.listActiveWork();
    },
  });
}

function resolveWorkflowSessionId(sessionManager: unknown): string | undefined {
  const manager = sessionManager as { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } | undefined;
  return manager?.getSessionFile?.() ?? manager?.getSessionId?.();
}

export default function extension(pi: ExtensionAPI) {
  const sendWorkflowMessage = (message: string, details: Record<string, unknown>) => {
    pi.sendMessage(
      {
        customType: "background-workflow-result",
        content: message,
        display: true,
        details,
      },
      { triggerTurn: true },
    );
  };

  const manager = createBackgroundWorkflowManager({
    notify(message, run) {
      sendWorkflowMessage(message, {
        id: run.id,
        name: run.name,
        status: run.status,
        artifactDir: run.artifactDir,
        outputPath: run.outputPath,
        resultPath: run.resultPath,
        completedAt: run.completedAt,
      });
      pi.events.emit("background-workflow-result", {
        id: run.id,
        sessionId: run.sessionId,
        status: run.status,
        name: run.name,
        artifactDir: run.artifactDir,
      });
    },
    notifyBatch(message, runs) {
      sendWorkflowMessage(message, {
        batch: true,
        ids: runs.map((run) => run.id),
        status: runs.every((run) => run.status === "completed") ? "completed" : "mixed",
        count: runs.length,
      });
      for (const run of runs) {
        pi.events.emit("background-workflow-result", {
          id: run.id,
          sessionId: run.sessionId,
          status: run.status,
          name: run.name,
          artifactDir: run.artifactDir,
        });
      }
    },
  });

  const disposeBackgroundWorkProvider = registerBackgroundWorkProvider(manager);

  const workflowTool = createWorkflowTool({ backgroundManager: manager });
  pi.registerTool(workflowTool);

  pi.registerTool(defineTool({
    name: "workflow_status",
    label: "Workflow Status",
    description: "List background workflows or inspect one background workflow by id/prefix.",
    parameters: Type.Object({ id: Type.Optional(Type.String({ description: "Optional run id or prefix." })) }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: manager.formatStatus(params.id) }], details: { action: "status", id: params.id } };
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_result",
    label: "Workflow Result",
    description: "Read the current or final result of a background workflow by id/prefix.",
    parameters: Type.Object({ id: Type.String({ description: "Run id or prefix." }) }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: manager.formatResult(params.id) }], details: { action: "result", id: params.id } };
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_transcript",
    label: "Workflow Transcript",
    description: "Read a persisted child agent transcript for a background workflow by run id/prefix.",
    parameters: Type.Object({
      id: Type.String({ description: "Run id or prefix." }),
      agent: Type.Optional(Type.String({ description: "Optional agent label substring or 1-based index." })),
      lines: Type.Optional(Type.Number({ description: "Maximum rendered transcript lines. Default 80, max 500." })),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: manager.formatTranscript(params.id, params.agent, params.lines) }], details: { action: "transcript", id: params.id, agent: params.agent, lines: params.lines } };
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_summary",
    label: "Workflow Summary",
    description: "Summarize a background workflow run with status, artifacts, result preview, child sessions, worktrees, model attempts, and suggested next actions.",
    parameters: Type.Object({ id: Type.String({ description: "Run id or prefix." }) }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: manager.formatSummary(params.id) }], details: { action: "summary", id: params.id } };
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_events",
    label: "Workflow Events",
    description: "Read lifecycle events for a background workflow by run id/prefix.",
    parameters: Type.Object({
      id: Type.String({ description: "Run id or prefix." }),
      lines: Type.Optional(Type.Number({ description: "Maximum event lines. Default 120, max 1000." })),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: manager.formatEvents(params.id, params.lines) }], details: { action: "events", id: params.id, lines: params.lines } };
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_worktrees",
    label: "Workflow Worktrees",
    description: "List git worktrees created by workflow child agents.",
    parameters: Type.Object({ id: Type.Optional(Type.String({ description: "Optional run id or prefix." })) }),
    async execute(_id, params) {
      const items = manager.listWorktrees(params.id);
      const text = items.length === 0
        ? "No workflow worktrees found."
        : ["Workflow worktrees:", ...items.map((item) => `- ${item.runId} #${item.agentId} ${item.label}: ${item.path} (${item.exists ? "exists" : "missing"})`)].join("\n");
      return { content: [{ type: "text", text }], details: { action: "worktrees", id: params.id, items } };
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_worktree_cleanup",
    label: "Workflow Worktree Cleanup",
    description: "Remove git worktrees created by workflow child agents. Refuses dirty worktrees unless force:true is passed.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Optional run id or prefix." })),
      force: Type.Optional(Type.Boolean({ description: "If true, remove dirty worktrees too." })),
    }),
    async execute(_id, params) {
      const result = await manager.cleanupWorktrees(params.id, params.force === true);
      const text = [
        `Removed ${result.removed.length} workflow worktree(s).`,
        ...result.removed.map((path) => `- removed: ${path}`),
        ...result.failed.map((failure) => `- failed: ${failure.path}: ${failure.error}`),
      ].join("\n");
      return { content: [{ type: "text", text }], details: { action: "worktree_cleanup", id: params.id, ...result } };
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_prune",
    label: "Workflow Prune",
    description: "Dry-run or remove old terminal workflow artifact directories. Defaults to dryRun:true and keepLast:100; running workflows are never pruned.",
    parameters: Type.Object({
      olderThanDays: Type.Optional(Type.Number({ description: "Only prune terminal runs older than this many days." })),
      keepLast: Type.Optional(Type.Number({ description: "Always keep this many newest terminal runs. Default 100." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview only when true. Default true; pass false to delete candidate artifact directories." })),
    }),
    async execute(_id, params) {
      let result: Awaited<ReturnType<typeof manager.pruneRuns>>;
      try {
        result = await manager.pruneRuns({ olderThanDays: params.olderThanDays, keepLast: params.keepLast, dryRun: params.dryRun });
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { action: "prune", error: error instanceof Error ? error.message : String(error) } as any };
      }
      const lines = [
        `Workflow prune ${result.dryRun ? "dry run" : "completed"}.`,
        `Candidates: ${result.candidates.length}`,
        `Removed: ${result.removed.length}`,
        `Failed: ${result.failed.length}`,
        ...(result.candidates.length ? ["", "Candidate run ids:", ...result.candidates.slice(0, 50).map((id) => `- ${id}`)] : []),
        ...(result.candidates.length > 50 ? [`... ${result.candidates.length - 50} more`] : []),
        ...(result.failed.length ? ["", "Failures:", ...result.failed.map((item) => `- ${item.id}: ${item.error}`)] : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { action: "prune", ...result } as any };
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_steer",
    label: "Workflow Steer",
    description: "Send a steering message to a currently running child agent in a background workflow. Experimental live-steer capability.",
    parameters: Type.Object({
      id: Type.String({ description: "Run id or prefix." }),
      prompt: Type.String({ description: "Steering message for the live child." }),
      agent: Type.Optional(Type.String({ description: "Optional agent label substring or 1-based index." })),
    }),
    async execute(_id, params) {
      try {
        const text = await manager.steerChild(params.id, params.prompt, params.agent);
        return { content: [{ type: "text", text }], details: { action: "steer", id: params.id, agent: params.agent } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { action: "steer", id: params.id, agent: params.agent } };
      }
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_resume",
    label: "Workflow Resume",
    description: "Resume a persisted child agent session from a background workflow with a follow-up prompt. Experimental revive-style capability.",
    parameters: Type.Object({
      id: Type.String({ description: "Run id or prefix." }),
      prompt: Type.String({ description: "Follow-up prompt to send to the child session." }),
      agent: Type.Optional(Type.String({ description: "Optional agent label substring or 1-based index." })),
    }),
    async execute(_id, params, signal) {
      try {
        const text = await manager.resumeChild(params.id, params.prompt, params.agent);
        return { content: [{ type: "text", text }], details: { action: "resume", id: params.id, agent: params.agent } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { action: "resume", id: params.id, agent: params.agent } };
      }
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_cancel",
    label: "Workflow Cancel",
    description: "Cancel a running background workflow by id/prefix.",
    parameters: Type.Object({ id: Type.String({ description: "Run id or prefix." }) }),
    async execute(_id, params) {
      const ok = manager.cancel(params.id);
      const text = ok ? `Cancelled background workflow ${params.id}` : manager.formatStatus(params.id);
      return { content: [{ type: "text", text }], isError: !ok, details: { action: "cancel", id: params.id, cancelled: ok, status: ok ? "cancelled" : text.startsWith("Ambiguous ") ? "ambiguous" : "not_running_or_not_found" } };
    },
  }));

  pi.registerTool(defineTool({
    name: "workflow_wait",
    label: "Workflow Wait",
    description: "Wait for a background workflow by id/prefix, or pass all:true / omit id to wait until current-session workflows are idle. Use when the current turn must consume workflow results.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Run id or prefix. Omit with all:true to wait for current-session workflows to become idle." })),
      all: Type.Optional(Type.Boolean({ description: "Wait for all active workflows in this Pi session instead of one id. Also used when id is omitted." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Default 30 minutes." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.all === true || !params.id?.trim()) {
        const sessionId = resolveWorkflowSessionId(ctx.sessionManager);
        await manager.waitForIdle(sessionId, params.timeoutMs);
        return { content: [{ type: "text", text: manager.formatStatus() }], details: { action: "wait", all: true, sessionId, status: "idle" } as any };
      }
      const run = await manager.waitForRun(params.id, params.timeoutMs);
      if (!run) {
        const text = manager.formatStatus(params.id);
        return { content: [{ type: "text", text }], isError: true, details: { action: "wait", id: params.id, found: false, status: text.startsWith("Ambiguous ") ? "ambiguous" : "not_found" } };
      }
      return { content: [{ type: "text", text: manager.formatResult(run.id) }], details: { action: "wait", id: run.id, found: true, status: run.status } };
    },
  }));

  pi.registerMessageRenderer("background-workflow-result", (message, options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const details = message.details as { name?: string; status?: string; outputPath?: string } | undefined;
    const icon = details?.status === "completed"
      ? theme.fg("success", "✓")
      : details?.status === "cancelled"
        ? theme.fg("warning", "■")
        : theme.fg("error", "✗");
    const firstLine = content.split("\n", 1)[0] || "Background workflow result";
    const body = options.expanded ? content : firstLine;
    const output = details?.outputPath ? `\n  ${theme.fg("muted", `output: ${details.outputPath}`)}` : "";
    return new Text(`${icon} ${theme.bold(details?.name ?? "workflow")} ${theme.fg("dim", details?.status ?? "done")}\n${body}${output}`, 0, 0);
  });

  pi.registerCommand("workflow-status", {
    description: "Show background workflow status. Usage: /workflow-status [run-id-prefix]",
    handler: async (args, ctx) => {
      ctx.ui.notify(manager.formatStatus(args.trim() || undefined), "info");
    },
  });

  pi.registerCommand("workflow-result", {
    description: "Show a background workflow result. Usage: /workflow-result <run-id-prefix>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /workflow-result <run-id-prefix>", "error");
        return;
      }
      ctx.ui.notify(manager.formatResult(id), "info");
    },
  });

  pi.registerCommand("workflow-transcript", {
    description: "Show a child transcript for a background workflow. Usage: /workflow-transcript <run-id-prefix> [agent-label-or-index]",
    handler: async (args, ctx) => {
      const [id, ...selectorParts] = args.trim().split(/\s+/).filter(Boolean);
      if (!id) {
        ctx.ui.notify("Usage: /workflow-transcript <run-id-prefix> [agent-label-or-index]", "error");
        return;
      }
      ctx.ui.notify(manager.formatTranscript(id, selectorParts.join(" ") || undefined), "info");
    },
  });

  pi.registerCommand("workflow-summary", {
    description: "Summarize a background workflow run. Usage: /workflow-summary <run-id-prefix>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /workflow-summary <run-id-prefix>", "error");
        return;
      }
      ctx.ui.notify(manager.formatSummary(id), "info");
    },
  });

  pi.registerCommand("workflow-events", {
    description: "Show lifecycle events for a background workflow. Usage: /workflow-events <run-id-prefix>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /workflow-events <run-id-prefix>", "error");
        return;
      }
      ctx.ui.notify(manager.formatEvents(id), "info");
    },
  });

  pi.registerCommand("workflow-worktrees", {
    description: "List workflow-created git worktrees. Usage: /workflow-worktrees [run-id-prefix]",
    handler: async (args, ctx) => {
      const items = manager.listWorktrees(args.trim() || undefined);
      ctx.ui.notify(items.length === 0
        ? "No workflow worktrees found."
        : ["Workflow worktrees:", ...items.map((item) => `- ${item.runId} #${item.agentId} ${item.label}: ${item.path} (${item.exists ? "exists" : "missing"})`)].join("\n"), "info");
    },
  });

  pi.registerCommand("workflow-worktree-cleanup", {
    description: "Remove clean workflow-created git worktrees. Usage: /workflow-worktree-cleanup [run-id-prefix]",
    handler: async (args, ctx) => {
      const result = await manager.cleanupWorktrees(args.trim() || undefined);
      ctx.ui.notify(`Removed ${result.removed.length} workflow worktree(s).${result.failed.length ? ` Failed: ${result.failed.length}` : ""}`, result.failed.length ? "warning" : "info");
    },
  });

  pi.registerCommand("workflow-prune", {
    description: "Dry-run or remove old terminal workflow artifacts. Usage: /workflow-prune [--delete] [--older-than-days N] [--keep-last N]",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const dryRun = !tokens.includes("--delete");
      const olderIndex = tokens.indexOf("--older-than-days");
      const keepIndex = tokens.indexOf("--keep-last");
      const olderThanDays = olderIndex >= 0 ? Number(tokens[olderIndex + 1]) : undefined;
      const keepLast = keepIndex >= 0 ? Number(tokens[keepIndex + 1]) : undefined;
      try {
        const result = await manager.pruneRuns({ olderThanDays, keepLast, dryRun });
        ctx.ui.notify(`Workflow prune ${result.dryRun ? "dry run" : "completed"}: ${result.candidates.length} candidate(s), ${result.removed.length} removed, ${result.failed.length} failed.`, result.failed.length ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("workflow-steer", {
    description: "Steer a live child session. Usage: /workflow-steer <run-id-prefix> -- <steering prompt>",
    handler: async (args, ctx) => {
      const [idPart, ...rest] = args.split(/\s+--\s+/);
      const id = idPart.trim();
      const prompt = rest.join(" -- ").trim();
      if (!id || !prompt) {
        ctx.ui.notify("Usage: /workflow-steer <run-id-prefix> -- <steering prompt>", "error");
        return;
      }
      try {
        ctx.ui.notify(await manager.steerChild(id, prompt), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("workflow-resume", {
    description: "Resume a child session. Usage: /workflow-resume <run-id-prefix> -- <follow-up prompt>",
    handler: async (args, ctx) => {
      const [idPart, ...rest] = args.split(/\s+--\s+/);
      const id = idPart.trim();
      const prompt = rest.join(" -- ").trim();
      if (!id || !prompt) {
        ctx.ui.notify("Usage: /workflow-resume <run-id-prefix> -- <follow-up prompt>", "error");
        return;
      }
      try {
        ctx.ui.notify(await manager.resumeChild(id, prompt), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("workflow-cancel", {
    description: "Cancel a running background workflow. Usage: /workflow-cancel <run-id-prefix>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /workflow-cancel <run-id-prefix>", "error");
        return;
      }
      const ok = manager.cancel(id);
      ctx.ui.notify(ok ? `Cancelled background workflow ${id}` : manager.formatStatus(id), ok ? "info" : "warning");
    },
  });

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const requiredTools = ["workflow", "workflow_status", "workflow_result", "workflow_summary", "workflow_transcript", "workflow_events", "workflow_worktrees", "workflow_worktree_cleanup", "workflow_prune", "workflow_steer", "workflow_resume", "workflow_cancel", "workflow_wait"];
    const next = [...active];
    for (const tool of requiredTools) {
      if (!next.includes(tool)) next.push(tool);
    }
    if (next.length !== active.length) pi.setActiveTools(next);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.hasUI) return;
    await manager.waitForIdle(resolveWorkflowSessionId(ctx.sessionManager));
  });

  pi.on("session_shutdown", () => {
    disposeBackgroundWorkProvider?.();
  });
}
