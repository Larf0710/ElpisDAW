import type { PatchTab } from './types';

export type PatchTabTemplateAvailability = {
  canCreate: boolean;
  label: string;
  message?: string;
};

export function resolvePatchTabTemplateAvailability(
  template: Pick<PatchTab, 'name' | 'nodeTypeId'>,
): PatchTabTemplateAvailability {
  return {
    canCreate: true,
    label: template.name,
  };
}
