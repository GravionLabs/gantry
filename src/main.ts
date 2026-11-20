import { bootstrapApplication } from "@angular/platform-browser";
import { App } from "./app/app";
import { appConfig } from "./app/app.config";
import { provideShell } from "./app/core/shell/shell.service";

provideShell()
  .then((shell) => bootstrapApplication(App, { providers: [...appConfig.providers, shell] }))
  .catch((err) => console.error(err));
