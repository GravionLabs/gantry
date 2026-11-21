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
} from "@gravionlabs/helix-desktop";

import { HxButton } from "@gravionlabs/helix-ui";

import { EndpointStore } from "./core/endpoint-store";
import { HxStatusAppVersion, ShellService } from "./core/shell/shell.service";
import { RecreateOn } from "./core/shell/recreate-on";
import { engineVersionLabel, requiresEndpoint } from "./core/shell/views";
import { ContainerDetailsView } from "./containers/container-details";
import { ContainersView } from "./containers/containers-view";
import { UpdateService } from "./core/updater/update.service";
import { ImagesView } from "./images/images-view";
import { StacksView } from "./stacks/stacks-view";
import { NetworksView } from "./networks/networks-view";
import { SystemView } from "./system/system-view";
import { VolumesView } from "./volumes/volumes-view";
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
    HxStatusAppVersion,
    NavIconDirective,
    RecreateOn,
    HxButton,
    EndpointsView,
    ContainersView,
    StacksView,
    ImagesView,
    VolumesView,
    NetworksView,
    SystemView,
    ContainerDetailsView,
  ],
  templateUrl: "./app.html",
  styleUrl: "./app.css",
})
export class App implements OnInit {
  protected readonly shell = inject(ShellService);
  protected readonly endpoints = inject(EndpointStore);
  protected readonly updater = inject(UpdateService);
  protected readonly updateOpen = signal(false);
  protected readonly switcherOpen = signal(false);
  protected readonly engineLabel = engineVersionLabel;
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
    void this.updater.init();
  }

  protected updateLabel(): string {
    switch (this.updater.phase()) {
      case "checking":
        return "Checking for updates…";
      case "installing":
        return this.updater.percent() === null
          ? "Installing update…"
          : `Installing update… ${this.updater.percent()}%`;
      case "available":
        return `Update ${this.updater.update()?.version}`;
      case "error":
        return this.updater.update() ? "Update failed, retry" : "Check for updates failed";
      default:
        return this.updater.upToDate() ? "Up to date" : "Check for Updates…";
    }
  }

  protected switchTo(id: string): void {
    this.endpoints.select(id);
    this.switcherOpen.set(false);
  }

  protected manage(): void {
    this.shell.activeId.set("endpoints");
    this.switcherOpen.set(false);
  }
}
