import type { Endpoint, Stack } from "./bindings";
import { invoke } from "./invoke";

export type { Stack, StackService } from "./bindings";

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
