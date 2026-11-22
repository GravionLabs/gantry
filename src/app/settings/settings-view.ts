import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";

import { THEMES, type Theme } from "../core/settings/settings-core";
import { SettingsService } from "../core/settings/settings.service";
import { ThemeService } from "../core/settings/theme";
import { UpdateSettings } from "../core/settings/updates";
import {
  SETTINGS_CATEGORIES,
  readSelectedCategory,
  resolveCategory,
  writeSelectedCategory,
} from "./settings-categories";

/** The Settings view: a category list with one page per category. */
@Component({
  selector: "app-settings-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./settings-view.html",
  styleUrl: "./settings-view.css",
})
export class SettingsView {
  protected readonly settings = inject(SettingsService);
  protected readonly updates = inject(UpdateSettings);
  private readonly themes = inject(ThemeService);
  protected readonly themeChoices = THEMES.map((id) => ({
    id,
    label: id[0].toUpperCase() + id.slice(1),
  }));
  protected readonly categories = SETTINGS_CATEGORIES;
  protected readonly selectedId = signal(readSelectedCategory(localStorage));
  protected readonly selected = computed(
    () => this.categories.find((c) => c.id === this.selectedId()) ?? this.categories[0],
  );

  protected select(id: string): void {
    const resolved = resolveCategory(id);
    this.selectedId.set(resolved);
    writeSelectedCategory(localStorage, resolved);
  }

  protected setAutoCheck(event: Event): void {
    void this.updates.setAutoCheck((event.target as HTMLInputElement).checked);
  }

  protected setContainerDefault(key: "showStats" | "groupByStack", event: Event): void {
    const value = (event.target as HTMLInputElement).checked;
    void this.settings.update((current) => ({
      ...current,
      containers: { ...current.containers, [key]: value },
    }));
  }

  protected chooseTheme(theme: Theme): void {
    void this.themes.setTheme(theme);
  }
}
