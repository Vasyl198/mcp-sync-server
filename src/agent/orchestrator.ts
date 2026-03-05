// src/agent/orchestrator.ts

export type AgentStep = {
  name?: string;
  tool: string;
  args: any;
};

export type AgentRunInput = {
  id?: string;
  stopOnError?: boolean;
  steps: AgentStep[];
};

export type AgentRunResult = {
  jobId: string;
  status: "ok" | "error";
  steps: any[];
};

export class AgentOrchestrator {
  private tools: Record<string, Function>;

  constructor(tools: Record<string, Function>) {
    this.tools = tools;
  }

  async run(plan: AgentRunInput): Promise<AgentRunResult> {
    const jobId = plan.id || `job-${Date.now()}`;
    const report: any[] = [];

    const stopOnError = plan.stopOnError ?? true;

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const start = Date.now();

      if (!this.tools[step.tool]) {
        const err = `Unknown tool: ${step.tool}`;

        report.push({
          index: i,
          name: step.name,
          tool: step.tool,
          status: "error",
          error: err,
        });

        return {
          jobId,
          status: "error",
          steps: report,
        };
      }

      try {
        const result = await this.tools[step.tool](step.args);

        report.push({
          index: i,
          name: step.name,
          tool: step.tool,
          status: "ok",
          durationMs: Date.now() - start,
          result,
        });
      } catch (e: any) {
        const err = e?.message || String(e);

        report.push({
          index: i,
          name: step.name,
          tool: step.tool,
          status: "error",
          durationMs: Date.now() - start,
          error: err,
        });

        if (stopOnError) {
          return {
            jobId,
            status: "error",
            steps: report,
          };
        }
      }
    }

    return {
      jobId,
      status: "ok",
      steps: report,
    };
  }
}