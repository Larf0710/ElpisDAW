import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const catalogSource = readFileSync(
  new URL('./stableAudio3PatchTab.ts', import.meta.url),
  'utf8',
);

describe('visible PRINT MIX App contract', () => {
  it('publishes PRINT MIX while filtering Clip Filer from new creation', () => {
    expect(catalogSource).toMatch(/createPrintMixPatchTab\(\s*'print-mix'/);
    expect(catalogSource).toMatch(
      /patchTab\.nodeTypeId\s*!==\s*BUILTIN_PATCH_TAB_TYPE_IDS\.clipFiler/,
    );
    expect(catalogSource).toMatch(
      /patchTab\.inputType\s*===\s*'Selected Clip'[\s\S]*patchTab\.outputType\s*===\s*'Export File'/,
    );
    expect(catalogSource).toMatch(
      /\.\.\.creatableBaseTemplates,[\s\S]*aceStepTemplate,[\s\S]*printMixTemplate/,
    );
  });

  it('delegates execution to one controller and commits only returned registration projects', () => {
    expect(appSource).toMatch(
      /printMixUiControllerRef\s*=\s*useRef\(new PrintMixUiController\(\)\)/,
    );
    expect(appSource).toMatch(/controller\.(?:run|recover)\(request\)/);
    expect(appSource).toMatch(/settlePrintMixUiRegistration\(result\)/);
    expect(appSource).toMatch(/project:\s*\{\s*\.\.\.result\.project,/);
    expect(appSource).toMatch(/acknowledgeRegistration\(\s*result\.operationId/);
    expect(appSource).not.toMatch(/createCompletedPrintMixMidiOperation/);
    expect(appSource).not.toMatch(/createPrintMixTrackRegistration/);
  });

  it('renders NORMALIZE only through Audio presentation and exposes busy accessibility', () => {
    expect(appSource).toMatch(
      /presentation\.showNormalize\s*&&\s*normalizeParameter/,
    );
    expect(appSource).toMatch(/<span>NORMALIZE<\/span>/);
    expect(appSource).toMatch(/aria-label="Audio PRINT MIX controls"/);
    expect(appSource).toMatch(/aria-label="PRINT MIX NORMALIZE"/);
    expect(appSource).toMatch(
      /disabled=\{[\s\S]*presentation\.ariaBusy[\s\S]*presentation\.buttonLabel === 'RECOVER'/,
    );
    expect(appSource).toMatch(/aria-busy=\{ariaBusy\}/);
    expect(appSource).toMatch(/aria-label=\{`\$\{buttonLabel\}: \$\{title\}`\}/);
  });

  it('provides one node-local run, cancel, and exact recovery action path', () => {
    expect(appSource).toMatch(/<PrintMixControls/);
    expect(appSource).toMatch(/onCancel=\{onCancelPrintMix\}/);
    expect(appSource).toMatch(/onRecover=\{\(\) => onRecoverPrintMix\(patchTab\.id\)\}/);
    expect(appSource).toMatch(/onRun=\{\(\) => onRunPrintMix\(patchTab\.id\)\}/);
    expect(appSource).toMatch(/presentation\.buttonLabel === 'CANCEL'/);
    expect(appSource).toMatch(/presentation\.buttonLabel === 'RECOVER'/);
    expect(appSource).toMatch(
      /Settle or recover this exact PRINT MIX operation before deleting its PatchTab/,
    );
  });
});
