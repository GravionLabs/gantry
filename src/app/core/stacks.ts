import type {
  ComposeAction,
  Container,
  ComposeAvailability,
  ComposeEvent,
  ComposeProject,
  Endpoint,
  Stack,
} from "./bindings";
import { invoke, stream } from "./invoke";

export type {
  ComposeAction,
  ComposeAvailability,
  ComposeEvent,
  ComposeProject,
  Stack,
  StackService,
} from "./bindings";

/** Lists the Compose stacks of an endpoint through the Tauri command `stacks_list`. */
export function listStacks(endpoint: Endpoint): Promise<Stack[]> {
  return invoke<Stack[]>("stacks_list", { endpoint });
}

/** `2/3 running`: the containers that are up out of all containers of the stack. */
export function stackSummary(stack: Pick<Stack, "running" | "total">): string {
  return `${stack.running}/${stack.total} running`;
}

/** A row of the stack grid: a stack, or a container of an expanded stack right below it. */
export type StackRow =
  | {
      readonly kind: "stack";
      readonly id: string;
      readonly stack: Stack;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "container";
      readonly id: string;
      readonly stack: string;
      readonly service: string;
      readonly container: Container;
    };

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The rows of the stack grid: the stacks by name, each expanded one followed by its containers in
 * the order of its services. A stack name that is no longer listed is ignored.
 */
export function stackRows(stacks: readonly Stack[], expanded: ReadonlySet<string>): StackRow[] {
  const rows: StackRow[] = [];
  for (const stack of [...stacks].sort((a, b) => byName.compare(a.name, b.name))) {
    const open = expanded.has(stack.name);
    rows.push({ kind: "stack", id: `stack:${stack.name}`, stack, expanded: open });
    if (!open) continue;
    for (const service of stack.services) {
      for (const container of service.containers) {
        rows.push({
          kind: "container",
          id: `container:${container.id}`,
          stack: stack.name,
          service: service.name,
          container,
        });
      }
    }
  }
  return rows;
}

/** The expanded stacks with `name` opened or closed. */
export function toggleStack(expanded: ReadonlySet<string>, name: string): Set<string> {
  const next = new Set(expanded);
  if (!next.delete(name)) next.add(name);
  return next;
}

/** The number of services of a stack. */
export function serviceCount(stack: Pick<Stack, "services">): number {
  return stack.services.length;
}

/** What the CLI needs from a stack: its name, directory and Compose files. */
export function composeProject(stack: Pick<Stack, "name" | "workingDir" | "configFiles">) {
  return { name: stack.name, workingDir: stack.workingDir, configFiles: [...stack.configFiles] };
}

/** Whether `docker compose` can act on the stack, and if not, why. */
export function checkCompose(project: ComposeProject): Promise<ComposeAvailability> {
  return invoke<ComposeAvailability>("compose_check", { project });
}

/** A button of the stack view. `down` stays out of this list: it needs a confirmation. */
export const COMPOSE_ACTIONS: readonly { label: string; action: ComposeAction }[] = [
  { label: "Up", action: { type: "up" } },
  { label: "Restart", action: { type: "restart" } },
  { label: "Pull", action: { type: "pull" } },
];

/** The name of an action for messages, e.g. `docker compose down -v`. */
export function actionCommand(action: ComposeAction): string {
  switch (action.type) {
    case "up":
      return "docker compose up -d";
    case "down":
      return action.volumes ? "docker compose down -v" : "docker compose down";
    case "restart":
      return "docker compose restart";
    case "pull":
      return "docker compose pull";
  }
}

/** The line shown when an action ends. */
export function finishedMessage(
  action: ComposeAction,
  event: Extract<ComposeEvent, { type: "finished" }>,
): string {
  const command = actionCommand(action);
  if (event.success) return `${command} finished.`;
  if (event.code === null) return `${command} was stopped.`;
  return `${command} failed with exit code ${event.code}.`;
}

/**
 * Runs a Compose action and streams the CLI output. Resolves when the command ends; the returned
 * `stop` ends the run early (the CLI process is killed).
 */
export function runCompose(
  endpoint: Endpoint,
  project: ComposeProject,
  action: ComposeAction,
  onEvent: (event: ComposeEvent) => void,
): { done: Promise<void>; stop: () => void } {
  const watchId = crypto.randomUUID();
  const done = stream<ComposeEvent>("compose_run", onEvent, {
    endpoint,
    project,
    action,
    watchId,
  });
  return { done, stop: () => void invoke("containers_unwatch", { watchId }).catch(() => {}) };
}
