import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Provider, Type } from "@angular/core";
import { TestBed } from "@angular/core/testing";

/**
 * Lets a component render in a Vitest spec: the JIT compiler of the tests cannot load
 * `templateUrl` and `styleUrl`, so the template is read from `src/app` and the styles are left out.
 * `providers` replaces the providers of the component.
 */
export function renderTemplateOf(
  component: Type<unknown>,
  template: string,
  providers: Provider[] = [],
): void {
  TestBed.overrideComponent(component, {
    set: {
      template: readFileSync(resolve(process.cwd(), "src/app", template), "utf8"),
      templateUrl: undefined,
      styleUrl: undefined,
      providers,
    },
  });
}
