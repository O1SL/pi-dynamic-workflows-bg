import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createBackgroundWorkflowManager, createWorkflowTool } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  const manager = createBackgroundWorkflowManager({
    notify(message, run) {
      pi.appendEntry("background-workflow-result", {
        id: run.id,
        name: run.name,
        status: run.status,
        message,
        artifactDir: run.artifactDir,
        outputPath: run.outputPath,
        resultPath: run.resultPath,
        completedAt: run.completedAt,
      });
    },
  });

  const workflowTool = createWorkflowTool({ backgroundManager: manager });
  pi.registerTool(workflowTool);

  const api = pi as typeof pi & {
    registerEntryRenderer?: (customType: string, renderer: (entry: any, options: any, theme: any) => Text) => void;
  };
  api.registerEntryRenderer?.("background-workflow-result", (entry: any, _options: any, theme: any) => {
    const data = entry.data as { message?: string } | undefined;
    return new Text(data?.message ?? theme.fg("muted", "background workflow result"), 0, 0);
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
}
