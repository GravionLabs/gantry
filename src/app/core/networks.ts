import type { Container, Endpoint, Network, NetworkPruneOutcome, NetworkSpec } from "./bindings";
import { invoke } from "./invoke";

export type { Network, NetworkPruneOutcome, NetworkSpec } from "./bindings";

/** Lists the networks of an endpoint through the Tauri command `networks_list`. */
export function listNetworks(endpoint: Endpoint): Promise<Network[]> {
  return invoke<Network[]>("networks_list", { endpoint });
}

/** Creates a bridge network through `networks_create`. */
export function createNetwork(endpoint: Endpoint, spec: NetworkSpec): Promise<void> {
  return invoke<void>("networks_create", { endpoint, spec });
}

/** Removes a network by name through `networks_remove`. */
export function removeNetwork(endpoint: Endpoint, name: string): Promise<void> {
  return invoke<void>("networks_remove", { endpoint, name });
}

/** Removes every network no container uses through `networks_prune`. */
export function pruneNetworks(endpoint: Endpoint): Promise<NetworkPruneOutcome> {
  return invoke<NetworkPruneOutcome>("networks_prune", { endpoint });
}

/** Connects a container to a network through `networks_connect`. */
export function connectNetwork(
  endpoint: Endpoint,
  network: string,
  container: string,
): Promise<void> {
  return invoke<void>("networks_connect", { endpoint, network, container });
}

/** Disconnects a container from a network through `networks_disconnect`. */
export function disconnectNetwork(
  endpoint: Endpoint,
  network: string,
  container: string,
  force: boolean,
): Promise<void> {
  return invoke<void>("networks_disconnect", { endpoint, network, container, force });
}

/** The subnets as the table shows them; a dash for a network without an address pool. */
export function subnetLabel(network: Pick<Network, "subnets">): string {
  return network.subnets.length === 0 ? "–" : network.subnets.join(", ");
}

/** `web, db`, or a dash when no container is connected. */
export function connectedLabel(containers: readonly string[]): string {
  return containers.length === 0 ? "–" : containers.join(", ");
}

/** The networks a prune removes: those no container uses, except the built-in ones. */
export function pruneCandidates(networks: readonly Network[]): Network[] {
  return networks.filter((n) => !n.builtin && n.containers.length === 0);
}

/** `Removed 3 networks.` */
export function pruneSummary(outcome: NetworkPruneOutcome): string {
  const count = `${outcome.removed.length} ${outcome.removed.length === 1 ? "network" : "networks"}`;
  return `Removed ${count}.`;
}

/** The containers that can still be connected to the network, ordered by name. */
export function connectable(network: Network, containers: readonly Container[]): Container[] {
  return containers
    .filter((c) => !network.containers.includes(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
