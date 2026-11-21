import { Injector, TemplateRef, ViewContainerRef, runInInjectionContext } from "@angular/core";
import { describe, expect, it, vi } from "vitest";

import { RecreateOn } from "./recreate-on";

function directive() {
  const container = { clear: vi.fn(), createEmbeddedView: vi.fn() };
  const template = {};
  const injector = Injector.create({
    providers: [
      { provide: TemplateRef, useValue: template },
      { provide: ViewContainerRef, useValue: container },
    ],
  });
  const recreate = runInInjectionContext(injector, () => new RecreateOn());
  return { recreate, container, template };
}

describe("RecreateOn", () => {
  it("renders the template once for the first key", () => {
    const { recreate, container, template } = directive();
    recreate.appRecreateOn = 0;
    expect(container.createEmbeddedView).toHaveBeenCalledOnce();
    expect(container.createEmbeddedView).toHaveBeenCalledWith(template);
  });

  it("keeps the view while the key stays the same", () => {
    const { recreate, container } = directive();
    recreate.appRecreateOn = 0;
    recreate.appRecreateOn = 0;
    expect(container.createEmbeddedView).toHaveBeenCalledOnce();
  });

  it("replaces the view when the key changes", () => {
    const { recreate, container } = directive();
    recreate.appRecreateOn = 0;
    recreate.appRecreateOn = 1;
    expect(container.clear).toHaveBeenCalledTimes(2);
    expect(container.createEmbeddedView).toHaveBeenCalledTimes(2);
  });
});
