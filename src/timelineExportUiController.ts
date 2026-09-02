import type { ProjectState } from './types';
import {
  createTimelineExportDownload,
  type TimelineExportDownloadDescriptor,
  type TimelineExportGeneratedAudioReader,
} from './timelineExportDownload';
import {
  createCanonicalTimelineExportPlanJson,
  createTimelineExportPlan,
} from './timelineExportPlan';

export type TimelineExportBrowserAnchor = {
  click: () => void;
  download: string;
  hidden: boolean;
  href: string;
  remove: () => void;
};

export type TimelineExportBrowserEnvironment = Readonly<{
  appendAnchor: (anchor: TimelineExportBrowserAnchor) => void;
  createAnchor: () => TimelineExportBrowserAnchor;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  scheduleCleanup: (callback: () => void) => void;
}>;

export type TimelineExportUiResult = Readonly<{
  download?: TimelineExportDownloadDescriptor;
  helpText: string;
  message: string;
  reason:
    | 'browser-failed'
    | 'busy'
    | 'downloaded'
    | 'interrupted'
    | 'preparation-failed'
    | 'selection-blocked';
  tone: 'error' | 'success' | 'warning';
}>;

export type TimelineExportUiRequest = Readonly<{
  getProject: () => ProjectState;
  readGeneratedAudio?: TimelineExportGeneratedAudioReader;
}>;

export type TimelineExportBrowserDownload = (
  download: TimelineExportDownloadDescriptor,
) => void;

export class TimelineExportUiController {
  readonly #downloadToBrowser: TimelineExportBrowserDownload;
  #isPreparing = false;

  constructor(downloadToBrowser: TimelineExportBrowserDownload = downloadTimelineExportInBrowser) {
    this.#downloadToBrowser = downloadToBrowser;
  }

  get isPreparing(): boolean {
    return this.#isPreparing;
  }

  async run(request: TimelineExportUiRequest): Promise<TimelineExportUiResult> {
    if (this.#isPreparing) {
      return result({
        helpText: 'One Timeline EXPORT is already preparing a selected target.',
        message: 'EXPORT BUSY',
        reason: 'busy',
        tone: 'warning',
      });
    }

    this.#isPreparing = true;

    try {
      const project = request.getProject();
      const selectionCount = project.selection.items.length;
      const planning = createTimelineExportPlan(project);

      if (!planning.canExport) {
        return result({
          helpText:
            selectionCount > 1
              ? 'Timeline EXPORT accepts exactly one Clip or Track. Use PRINT MIX or another explicit workflow for multiple selections.'
              : planning.message,
          message: 'EXPORT BLOCKED',
          reason: 'selection-blocked',
          tone: 'warning',
        });
      }

      const canonicalPlan = createCanonicalTimelineExportPlanJson(planning.plan);
      const resolution = await createTimelineExportDownload(
        project,
        planning.plan,
        request.readGeneratedAudio,
      );

      if (!resolution.canDownload) {
        return result({
          helpText: createPreparationFailureMessage(resolution.reason),
          message: 'EXPORT FAILED',
          reason: 'preparation-failed',
          tone: 'error',
        });
      }

      const currentPlanning = createTimelineExportPlan(request.getProject());

      if (
        !canonicalPlan ||
        !currentPlanning.canExport ||
        createCanonicalTimelineExportPlanJson(currentPlanning.plan) !== canonicalPlan
      ) {
        return result({
          helpText: 'Timeline EXPORT stopped because the Project, selection, target, or Active Take changed during preparation.',
          message: 'EXPORT INTERRUPTED',
          reason: 'interrupted',
          tone: 'warning',
        });
      }

      try {
        this.#downloadToBrowser(resolution.download);
      } catch {
        return result({
          helpText: 'The browser could not start the Timeline EXPORT download. Project data was unchanged.',
          message: 'EXPORT FAILED',
          reason: 'browser-failed',
          tone: 'error',
        });
      }

      if (resolution.download.warning?.clipping) {
        return result({
          download: resolution.download,
          helpText: `${resolution.download.fileName} was sent to the browser. Pre-encoding peak ${formatPeakDbfs(
            resolution.download.warning.peak,
          )} indicates clipping risk; no normalization or limiting was applied.`,
          message: 'CLIPPING WARNING',
          reason: 'downloaded',
          tone: 'warning',
        });
      }

      return result({
        download: resolution.download,
        helpText: `${resolution.download.fileName} was sent to the browser as the exact selected ${
          resolution.download.target.kind === 'clip' ? 'Clip' : 'Track'
        }. Project data was unchanged.`,
        message: `${resolution.download.format} SAVED`,
        reason: 'downloaded',
        tone: 'success',
      });
    } catch {
      return result({
        helpText: 'Timeline EXPORT could not prepare a download. Project data was unchanged.',
        message: 'EXPORT FAILED',
        reason: 'preparation-failed',
        tone: 'error',
      });
    } finally {
      this.#isPreparing = false;
    }
  }
}

export function downloadTimelineExportInBrowser(
  download: TimelineExportDownloadDescriptor,
  environment: TimelineExportBrowserEnvironment = createBrowserEnvironment(),
): void {
  assertDownloadDescriptor(download);

  const objectUrl = environment.createObjectUrl(download.blob);
  let anchor: TimelineExportBrowserAnchor | undefined;

  try {
    anchor = environment.createAnchor();
    anchor.href = objectUrl;
    anchor.download = download.fileName;
    anchor.hidden = true;
    environment.appendAnchor(anchor);
    anchor.click();
  } finally {
    anchor?.remove();

    try {
      environment.scheduleCleanup(() => environment.revokeObjectUrl(objectUrl));
    } catch {
      environment.revokeObjectUrl(objectUrl);
    }
  }
}

function createBrowserEnvironment(): TimelineExportBrowserEnvironment {
  return Object.freeze({
    appendAnchor: (anchor) => document.body.append(anchor as HTMLAnchorElement),
    createAnchor: () => document.createElement('a'),
    createObjectUrl: (blob) => window.URL.createObjectURL(blob),
    revokeObjectUrl: (url) => window.URL.revokeObjectURL(url),
    scheduleCleanup: (callback) => {
      window.setTimeout(callback, 0);
    },
  });
}

function assertDownloadDescriptor(download: TimelineExportDownloadDescriptor): void {
  const expectedExtension = download.mediaType === 'audio' ? '.wav' : '.mid';

  if (
    download.kind !== 'timeline-export' ||
    !Object.isFrozen(download) ||
    !Object.isFrozen(download.timeline) ||
    !Object.isFrozen(download.blob) ||
    download.blob.size !== download.byteLength ||
    download.blob.type !== download.mimeType ||
    !download.fileName.toLowerCase().endsWith(expectedExtension) ||
    /[\\/\0]/.test(download.fileName)
  ) {
    throw new Error('Timeline EXPORT download descriptor is invalid.');
  }
}

function createPreparationFailureMessage(
  reason:
    | 'audio-reader-required'
    | 'encoding-failed'
    | 'plan-invalid'
    | 'plan-stale'
    | 'source-read-failed',
): string {
  switch (reason) {
    case 'audio-reader-required':
      return 'Timeline Audio EXPORT requires the authenticated Local Engine source reader.';
    case 'source-read-failed':
      return 'Timeline Audio EXPORT could not read one complete authenticated source.';
    case 'plan-stale':
      return 'Timeline EXPORT stopped because the Project, selection, target, or Active Take changed.';
    case 'plan-invalid':
      return 'Timeline EXPORT rejected a malformed preparation plan.';
    case 'encoding-failed':
      return 'Timeline EXPORT could not encode the selected target safely.';
  }
}

function formatPeakDbfs(peak: number): string {
  const dbfs = 20 * Math.log10(peak);
  return `${dbfs >= 0 ? '+' : ''}${dbfs.toFixed(1)} dBFS`;
}

function result(value: TimelineExportUiResult): TimelineExportUiResult {
  return Object.freeze(value);
}
