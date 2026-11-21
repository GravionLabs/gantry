import type {
  ComposeAction,
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
