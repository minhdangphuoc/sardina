import { Output } from './output';
import { ContextKeys } from './contextKeys';
import { Settings } from '../settings/index';
import { SdkLocator } from '../sfdk/discovery';
import { SfdkRunner } from '../sfdk/runner';
import { ProjectRegistry } from '../project/detect';
import { prompts } from '../ui/prompts';

/**
 * The shared, singleton service container passed to every module's
 * activateX(ctx, services). Constructed once in extension.ts#activate.
 */
export interface Services {
  output: Output;
  settings: Settings;
  sdk: SdkLocator;
  runner: SfdkRunner;
  projects: ProjectRegistry;
  contextKeys: ContextKeys;
  prompts: typeof prompts;
}

export function createServices(): Services {
  const output = new Output();
  const settings = new Settings();
  const contextKeys = new ContextKeys();

  const services: Services = {
    output,
    settings,
    contextKeys,
    prompts,
    // sdk/runner/projects need `services` itself (for output/settings access),
    // so they are constructed after the object exists and attached below.
    sdk: undefined as unknown as SdkLocator,
    runner: undefined as unknown as SfdkRunner,
    projects: undefined as unknown as ProjectRegistry,
  };

  services.sdk = new SdkLocator(services);
  services.runner = new SfdkRunner(services);
  services.projects = new ProjectRegistry(services);

  return services;
}
