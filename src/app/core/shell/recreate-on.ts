import { Directive, Input, TemplateRef, ViewContainerRef, inject } from "@angular/core";

const NONE = Symbol("none");

/**
 * Renders its template and renders it anew whenever the key changes, so that the views inside start
 * fresh (e.g. on another endpoint):
 *
 * ```html
 * <ng-container *appRecreateOn="endpoints.generation()">…</ng-container>
 * ```
 *
 * It replaces a `@for` over a one-item array, which Angular reports as NG0956 on every change.
 * The setter recreates the view synchronously, in the same change detection as the new key.
 */
@Directive({ selector: "[appRecreateOn]" })
export class RecreateOn {
  private readonly template = inject(TemplateRef);
  private readonly container = inject(ViewContainerRef);
  private key: unknown = NONE;

  @Input({ required: true }) set appRecreateOn(key: unknown) {
    if (Object.is(key, this.key)) return;
    this.key = key;
    this.container.clear();
    this.container.createEmbeddedView(this.template);
  }
}
