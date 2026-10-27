import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const path = join(process.cwd(), "..", ".github", "workflows", "worker.yml");
const raw = readFileSync(path, "utf8");
const wf = parse(raw) as any;
const steps: any[] = wf.jobs.run.steps;

describe(".github/workflows/worker.yml (segurança)", () => {
  it("agenda a cada 15 min, evita o minuto :00, e permite disparo manual", () => {
    const [cron] = wf.on.schedule.map((s: any) => s.cron as string);
    expect(cron!.split(" ")[0]!.split(",").map(Number)).toEqual([7, 22, 37, 52]);
    expect(wf.on).toHaveProperty("workflow_dispatch");
  });

  it("nunca roda em pull_request / pull_request_target (segredos fora do alcance de forks)", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(raw.replace(/^\s*#.*$/gm, "")).not.toMatch(/pull_request/);
  });

  it("GITHUB_TOKEN mínimo (somente leitura do conteúdo) e checkout sem persistir credenciais", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(wf.jobs.run.permissions).toBeUndefined();
    const checkout = steps.find((s) => String(s.uses).startsWith("actions/checkout"));
    expect(checkout.with["persist-credentials"]).toBe(false);
  });

  it("uma execução por vez, sem cancelar a que está rodando, com tempo máximo", () => {
    expect(wf.concurrency).toEqual({ group: "pulse-worker", "cancel-in-progress": false });
    expect(wf.jobs.run["timeout-minutes"]).toBeLessThanOrEqual(10);
  });

  it("actions fixadas por SHA de commit", () => {
    for (const s of steps.filter((x) => x.uses)) expect(s.uses, s.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it("segredos só chegam ao passo do worker, via env — nunca em `run:` e nunca em passos de instalação/compilação", () => {
    for (const s of steps) {
      if (s.run) expect(s.run, s.name).not.toMatch(/\$\{\{/);
      if (!s.name?.includes("worker")) expect(JSON.stringify(s.env ?? {}), s.name).not.toMatch(/secrets\./);
    }
    const worker = steps.find((s) => String(s.run).includes("dist/worker/once.js"));
    expect(worker.env.DATABASE_URL).toBe("${{ secrets.DATABASE_URL }}");
    expect(worker.env.RESEND_API_KEY).toBe("${{ secrets.RESEND_API_KEY }}");
    expect(worker.env.ALERT_DELIVERY).toBe("${{ vars.ALERT_DELIVERY }}");
  });

  it("não há credencial literal, eco de variáveis nem modo de depuração", () => {
    const code = raw.replace(/^\s*#.*$/gm, "");
    expect(code).not.toMatch(/postgres(ql)?:\/\//i);
    expect(code).not.toMatch(/\bre_[A-Za-z0-9]{8,}/);
    expect(code).not.toMatch(/set -x|ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG|\benv\b\s*$|printenv|echo\s+\$/m);
  });

  it("não roda migrations nem cria administrador", () => {
    const cmds = steps.map((s) => s.run ?? "").join("\n");
    expect(cmds).not.toMatch(/migrate|db:deploy|prisma\s+migrate|admin/);
  });

  it("só roda por agendamento ou disparo manual", () => {
    expect(wf.jobs.run.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
  });
});
