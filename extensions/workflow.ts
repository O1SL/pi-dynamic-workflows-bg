import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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

export default function extension(pi: ExtensionAPI) {
  const manager = createBackgroundWorkflowManager({
    notify(message, run) {
      pi.sendMessage(
        {
          customType: "background-workflow-result",
          content: message,
          display: true,
          details: {
            id: run.id,
            name: run.name,
            status: run.status,
            artifactDir: run.artifactDir,
            outputPath: run.outputPath,
            resultPath: run.resultPath,
            completedAt: run.completedAt,
          },
        },
        { triggerTurn: true },
      );
      pi.events.emit("background-workflow-result", {
        id: run.id,
        sessionId: run.sessionId,
        status: run.status,
        name: run.name,
        artifactDir: run.artifactDir,
      });
    },
  });

  const disposeBackgroundWorkProvider = registerBackgroundWorkProvider(manager);

  const workflowTool = createWorkflowTool({ backgroundManager: manager });
  pi.registerTool(workflowTool);

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

  pi.registerCommand("workflow-cancel", {
    description: "Cancel a running background workflow. Usage: /workflow-cancel <run-id-prefix>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /workflow-cancel <run-id-prefix>", "error");
        return;
      }
      ctx.ui.notify(manager.cancel(id) ? `Cancelled background workflow ${id}` : `No running workflow found for ${id}`, "info");
    },
  });

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
  });

  pi.on("session_shutdown", () => {
    disposeBackgroundWorkProvider?.();
  });
}
