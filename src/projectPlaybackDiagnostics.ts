export type ProjectPlaybackDiagnosticRecord = Readonly<{
  at: string;
  details: Readonly<Record<string, unknown>>;
  stage: string;
}>;

declare global {
  interface Window {
    __HUMSTUDIO_PLAYBACK_DIAGNOSTICS__?: readonly ProjectPlaybackDiagnosticRecord[];
  }
}

const MAX_DIAGNOSTIC_RECORDS = 200;
const CONSOLE_PREFIX = '[ElpisDAW Playback Diagnostic]';

export type ProjectPlaybackDiagnosticDownloadResult = Readonly<{
  fileName?: string;
  ok: boolean;
  recordCount: number;
}>;

export function resetProjectPlaybackDiagnostics(
  details: Readonly<Record<string, unknown>>,
): void {
  if (!isPlaybackDiagnosticsAvailable()) {
    return;
  }

  window.__HUMSTUDIO_PLAYBACK_DIAGNOSTICS__ = Object.freeze([]);
  recordProjectPlaybackDiagnostic('play-request', details);
}

export function recordProjectPlaybackDiagnostic(
  stage: string,
  details: Readonly<Record<string, unknown>>,
): void {
  if (!isPlaybackDiagnosticsAvailable()) {
    return;
  }

  const entry = Object.freeze({
    at: new Date().toISOString(),
    details: Object.freeze({ ...details }),
    stage,
  });
  const records = [
    ...(window.__HUMSTUDIO_PLAYBACK_DIAGNOSTICS__ ?? []),
    entry,
  ].slice(-MAX_DIAGNOSTIC_RECORDS);

  window.__HUMSTUDIO_PLAYBACK_DIAGNOSTICS__ = Object.freeze(records);
  console.info(CONSOLE_PREFIX, entry);
}

export function downloadProjectPlaybackDiagnostics(): ProjectPlaybackDiagnosticDownloadResult {
  if (!isPlaybackDiagnosticsAvailable()) {
    return { ok: false, recordCount: 0 };
  }

  const createdAt = new Date().toISOString();
  const currentRecords = window.__HUMSTUDIO_PLAYBACK_DIAGNOSTICS__ ?? [];
  const records = currentRecords.length > 0
    ? currentRecords
    : [Object.freeze({
        at: createdAt,
        details: Object.freeze({
          documentVisibilityState: document.visibilityState,
          origin: window.location.origin,
        }),
        stage: 'trace-download-without-playback-events',
      })];
  const fileName = `ElpisDAW_Playback_Diagnostics_${createdAt
    .slice(0, 19)
    .replace(/[:T]/g, '-')}.json`;
  const blob = new Blob([
    JSON.stringify({
      createdAt,
      records,
      schemaVersion: 1,
    }, null, 2),
  ], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.download = fileName;
  anchor.href = objectUrl;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }

  return {
    fileName,
    ok: true,
    recordCount: records.length,
  };
}

function isPlaybackDiagnosticsAvailable(): boolean {
  return (
    import.meta.env.MODE !== 'test' &&
    typeof window !== 'undefined'
  );
}
