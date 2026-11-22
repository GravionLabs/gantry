import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";

import { SettingsService } from "../core/settings/settings.service";
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
}
