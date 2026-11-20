import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  OnInit,
  TemplateRef,
  computed,
  inject,
  input,
  viewChildren,
} from "@angular/core";
import {
  HxActivityBar,
  HxActivityBarItem,
  HxAppShell,
  HxStatusBar,
  HxStatusItem,
  HxStatusVersion,
} from "@gravionlabs/helix-desktop";
import { HxStatusAppVersion } from "@gravionlabs/helix-desktop/tauri";

import { ShellService } from "./core/shell/shell.service";

/** Marks the template of an activity bar icon with the icon name of the views registry. */
@Directive({ selector: "ng-template[appNavIcon]" })
export class NavIconDirective {
  readonly name = input.required<string>({ alias: "appNavIcon" });
  readonly template = inject(TemplateRef);
}

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HxActivityBar,
    HxAppShell,
    HxStatusBar,
    HxStatusItem,
    HxStatusVersion,
    HxStatusAppVersion,
    NavIconDirective,
  ],
  templateUrl: "./app.html",
  styleUrl: "./app.css",
})
export class App implements OnInit {
  protected readonly shell = inject(ShellService);
  private readonly icons = viewChildren(NavIconDirective);

  /** The items of the activity bar with the icon names resolved to the inline SVG templates. */
  protected readonly barItems = computed<HxActivityBarItem[]>(() => {
    const byName = new Map(this.icons().map((i) => [i.name(), i.template]));
    return this.shell.items.map((item) => ({
      ...item,
      icon: byName.get(item.icon as string) ?? item.icon,
    }));
  });

  protected readonly connectionLabel = computed(() => {
    switch (this.shell.connection()) {
      case "connected":
        return "Connected";
      case "unreachable":
        return "Unreachable";
      default:
        return "Connecting…";
    }
  });

  ngOnInit(): void {
    void this.shell.refreshEngine();
  }
}
