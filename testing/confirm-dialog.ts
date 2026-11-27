import { type ComponentFixture, TestBed } from "@angular/core/testing";
import { HxConfirmDialog } from "@gravionlabs/helix-ui";

/**
 * Puts the `<hx-confirm-dialog />` of the app beside the view under test, so that a spec answers
 * the questions the view asks. Call it after the view is created; both are removed with
 * `TestBed.resetTestingModule()` and an empty `document.body`.
 */
export function confirmDialog(view: ComponentFixture<unknown>) {
  document.body.append(view.nativeElement);
  const host = TestBed.createComponent(HxConfirmDialog);
  document.body.append(host.nativeElement);
  // Two rounds: what opens or closes after a render needs one more render.
  const render = async () => {
    for (let round = 0; round < 2; round++) {
      await new Promise((resolve) => setTimeout(resolve));
      host.detectChanges();
      view.detectChanges();
      TestBed.tick();
    }
  };
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const button = (label: string, root: ParentNode) => {
    const found = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    if (!found) throw new Error(`No button "${label}"`);
    return found;
  };
  /** Clicks a button of the view. */
  const click = async (label: string) => {
    await render();
    button(label, view.nativeElement as HTMLElement).click();
    await render();
  };
  /** Clicks a button of the open question. */
  const answer = async (label: string) => {
    button(label, dialog()!).click();
    await render();
  };
  /** The checkbox of the open question. */
  const option = () => dialog()!.querySelector<HTMLInputElement>("input[hx-checkbox]")!;
  return { render, dialog, click, answer, option };
}
