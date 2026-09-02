import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const appSource = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
const cancellationSource = await readFile(
  new URL('./aceStepVocalCancellation.ts', import.meta.url),
  'utf8',
);

describe('ACE Vocals cancellation visible contract', () => {
  it('wires the selected ACE PatchTab action to exact cancellation ownership', () => {
    expect(appSource).toContain('onCancelAceStepVocal={handleCancelAceStepVocal}');
    expect(appSource).toContain("operation.patchTabId !== patchTabId");
    expect(appSource).toContain("status: 'CANCEL_REQUESTED'");
    expect(appSource).toContain("onClick={action.action === 'CANCEL' ? onCancel : onGenerate}");
    expect(appSource).toContain('aria-label={`${action.action} ACE Vocals`}');
  });

  it('shows CANCEL only for queued/loading/processing and WAIT for unsafe phases', () => {
    expect(cancellationSource).toContain("'QUEUED'");
    expect(cancellationSource).toContain("'LOADING_MODEL'");
    expect(cancellationSource).toContain("'PROCESSING'");
    expect(cancellationSource).toContain("action: canCancel ? ('CANCEL' as const) : ('WAIT' as const)");
    expect(appSource).toContain('FINALIZING / COMPLETION WINS');
    expect(appSource).toContain('CANCEL PENDING / WAIT FOR ENGINE');
  });

  it('presents CANCELED as a non-error terminal state and retires unsupported copy', () => {
    expect(appSource).toContain("label: 'CANCELED'");
    expect(appSource).toContain("tone: 'warning'");
    expect(appSource).not.toContain('Cancellation is not supported.');
    expect(appSource).not.toContain('NO CANCEL / PROJECT EDITS REMAIN AVAILABLE');
  });
});
