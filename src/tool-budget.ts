import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface AgentToolBudget {
  soft?: number;
  hard: number;
  block?: string[] | "*";
}

export interface ToolBudgetState {
  count: number;
  softNotified: boolean;
}

export function applyToolBudgetToTools(
  tools: ToolDefinition[],
  budget: AgentToolBudget | undefined,
  state: ToolBudgetState = { count: 0, softNotified: false },
): ToolDefinition[] {
  if (!budget) return tools;
  const block = budget.block ?? "*";
  const shouldBlock = (name: string) => block === "*" || block.includes(name);
  return tools.map((tool) => ({
    ...tool,
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      state.count++;
      if (state.count > budget.hard && shouldBlock(tool.name)) {
        return {
          content: [{ type: "text", text: `Tool budget exceeded after ${budget.hard} tool call(s); blocked ${tool.name}.` }],
          isError: true,
          details: { toolBudgetExceeded: true, tool: tool.name, count: state.count, hard: budget.hard },
        };
      }
      const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
      if (budget.soft !== undefined && !state.softNotified && state.count >= budget.soft) {
        state.softNotified = true;
        return {
          ...result,
          content: [
            ...result.content,
            {
              type: "text",
              text: `Tool budget soft limit reached (${state.count}/${budget.hard}). Wrap up soon and avoid unnecessary tool calls.`,
            },
          ],
          details: { ...(typeof result.details === "object" && result.details ? result.details : {}), toolBudgetSoftReached: true, count: state.count, hard: budget.hard, soft: budget.soft },
        };
      }
      return result;
    },
  })) as ToolDefinition[];
}
