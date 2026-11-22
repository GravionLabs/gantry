import { ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";
import { provideHxTheme } from "@gravionlabs/helix-ui";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // ThemeService applies the Appearance choice (System by default); the primary scale is amber, the Gantry tokens refine it in styles.scss.
    provideHxTheme({ storageKey: null, primary: "amber" }),
  ],
};
