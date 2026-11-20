import { ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";
import { provideHxTheme } from "@gravionlabs/helix-ui";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Light and dark follow the system; the primary scale is amber, the Gantry tokens refine it in styles.scss.
    provideHxTheme({ storageKey: null, primary: "amber" }),
  ],
};
