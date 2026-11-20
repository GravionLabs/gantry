import { ChangeDetectionStrategy, Component, OnInit, signal } from "@angular/core";
import { describeEngine, pingEngine } from "./core/engine";

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <img src="favicon.svg" alt="" width="96" height="96" />
      <h1>Gantry</h1>
      <p class="status" role="status">{{ status() }}</p>
    </main>
  `,
  styles: `
    main {
      display: grid;
      place-content: center;
      justify-items: center;
      height: 100vh;
      gap: 0.5rem;
    }
    h1 {
      margin: 0;
    }
    .status {
      color: var(--muted);
    }
  `,
})
export class App implements OnInit {
  protected readonly status = signal("Connecting to the local Docker engine…");

  async ngOnInit(): Promise<void> {
    try {
      this.status.set(describeEngine(await pingEngine()));
    } catch (error) {
      const message = (error as { message?: string }).message ?? String(error);
      this.status.set(`No engine reachable: ${message}`);
    }
  }
}
