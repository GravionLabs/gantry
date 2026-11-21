import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  OnInit,
  TemplateRef,
  computed,
  inject,
  signal,
  input,
  viewChildren,
} from "@angular/core";
import {
  HxActivityBar,
  HxActivityBarItem,
  HxAppShell,
  HxStatusBar,
  HxStatusItem,
  HxStatusPopover,
  HxStatusVersion,
} from "@gravionlabs/helix-desktop";

import { HxButton } from "@gravionlabs/helix-ui";

import { EndpointStore } from "./core/endpoint-store";
import { HxStatusAppVersion, ShellService } from "./core/shell/shell.service";
import { requiresEndpoint } from "./core/shell/views";
import { ContainerDetailsView } from "./containers/container-details";
import { ContainersView } from "./containers/containers-view";
import { EndpointsView } from "./endpoints/endpoints-view";

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
    HxStatusPopover,
    HxStatusVersion,
    HxStatusAppVersion,
    NavIconDirective,
    HxButton,
    EndpointsView,
    ContainersView,
    ContainerDetailsView,
  ],
  templateUrl: "./app.html",
  styleUrl: "./app.css",
})
export class App implements OnInit {
  protected readonly shell = inject(ShellService);
  protected readonly endpoints = inject(EndpointStore);
  protected readonly switcherOpen = signal(false);
  protected readonly needsEndpoint = computed(() => requiresEndpoint(this.shell.activeId()));
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
    switch (this.endpoints.connection()) {
      case "connected":
        return "Connected";
      case "unreachable":
        return "Unreachable";
      default:
        return "Connecting…";
    }
  });

  ngOnInit(): void {
    void this.endpoints.init();
  }

  protected switchTo(id: string): void {
    this.endpoints.select(id);
    this.switcherOpen.set(false);
  }

  protected manage(): void {
    this.shell.activeId.set("endpoints");
    this.shell.collapsed.set(false);
    this.switcherOpen.set(false);
  }
}
