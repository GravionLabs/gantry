import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { HxButton, HxCheckbox, HxInput, HxMessage, HxTable } from "@gravionlabs/helix-ui";

import type { TlsFiles } from "../core/bindings";
import { EndpointEntry, EndpointStore, kindLabel, stateLabel } from "../core/endpoint-store";
import { describeEngine } from "../core/engine";
import { toGantryError } from "../core/invoke";

const ORIGIN_LABEL = { detected: "Detected", context: "Docker context", manual: "Manual" } as const;

/** The Endpoints view: every endpoint with its status, and the form for manual ones. */
@Component({
  selector: "app-endpoints-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HxButton, HxCheckbox, HxInput, HxMessage, HxTable],
  templateUrl: "./endpoints-view.html",
  styleUrl: "./endpoints-view.css",
})
export class EndpointsView {
  protected readonly store = inject(EndpointStore);

  /** `null` hides the form, `"new"` adds, an id edits that manual endpoint. */
  protected readonly editing = signal<string | null>(null);
  protected readonly name = signal("");
  protected readonly address = signal("");
  protected readonly useTls = signal(false);
  protected readonly ca = signal("");
  protected readonly cert = signal("");
  protected readonly key = signal("");
  protected readonly busy = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly testResult = signal<string | null>(null);
  /** The id of the manual endpoint waiting for the removal to be confirmed. */
  protected readonly removing = signal<string | null>(null);

  protected readonly canUseTls = computed(() => /^(tcp|http):\/\//.test(this.address().trim()));
  protected readonly removingName = computed(
    () => this.store.entries().find((e) => e.id === this.removing())?.endpoint.name ?? "",
  );

  protected kind(entry: EndpointEntry): string {
    return kindLabel(entry.endpoint);
  }
  protected origin(entry: EndpointEntry): string {
    return ORIGIN_LABEL[entry.origin];
  }
  protected state(entry: EndpointEntry): string {
    return stateLabel(entry.status.state);
  }
  protected version(entry: EndpointEntry): string {
    const info = entry.status.info;
    return info ? (info.version ?? describeEngine(info)) : "–";
  }

  protected startAdd(): void {
    this.fill("new", "", "", null);
  }

  protected startEdit(entry: EndpointEntry): void {
    this.fill(entry.id, entry.endpoint.name, entry.endpoint.address, entry.endpoint.tls);
  }

  protected cancel(): void {
    this.editing.set(null);
    this.formError.set(null);
    this.testResult.set(null);
  }

  protected async test(): Promise<void> {
    await this.run(async () => {
      const info = await this.store.testDraft(this.name(), this.address(), this.tls());
      this.testResult.set(`Connected: ${describeEngine(info)}`);
    });
  }

  protected async save(): Promise<void> {
    const editing = this.editing();
    await this.run(async () => {
      if (editing === "new") await this.store.add(this.name(), this.address(), this.tls());
      else if (editing) await this.store.update(editing, this.name(), this.address(), this.tls());
      this.cancel();
    });
  }

  protected async confirmRemove(): Promise<void> {
    const id = this.removing();
    if (id) await this.store.remove(id);
    this.removing.set(null);
  }

  protected input(target: { set(value: string): void }, event: Event): void {
    target.set((event.target as HTMLInputElement).value);
  }

  private tls(): TlsFiles | null {
    return this.canUseTls() && this.useTls()
      ? { ca: this.ca(), cert: this.cert(), key: this.key() }
      : null;
  }

  private fill(id: string, name: string, address: string, tls: TlsFiles | null): void {
    this.editing.set(id);
    this.name.set(name);
    this.address.set(address);
    this.useTls.set(tls !== null);
    this.ca.set(tls?.ca ?? "");
    this.cert.set(tls?.cert ?? "");
    this.key.set(tls?.key ?? "");
    this.formError.set(null);
    this.testResult.set(null);
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.formError.set(null);
    this.testResult.set(null);
    try {
      await action();
    } catch (error) {
      this.formError.set(toGantryError(error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
