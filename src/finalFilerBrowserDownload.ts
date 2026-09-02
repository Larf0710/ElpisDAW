export type FinalFilerDownloadFile = Readonly<{
  blob: Blob;
  fileName: string;
  kind: 'source-report' | 'wav';
}>;

export type FinalFilerBrowserAnchor = {
  click: () => void;
  download: string;
  hidden: boolean;
  href: string;
  remove: () => void;
};

export type FinalFilerBrowserEnvironment = Readonly<{
  appendAnchor: (anchor: FinalFilerBrowserAnchor) => void;
  createAnchor: () => FinalFilerBrowserAnchor;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  scheduleCleanup: (cleanup: () => void) => void;
}>;

type PreparedBrowserDownload = Readonly<{
  anchor: FinalFilerBrowserAnchor;
  objectUrl: string;
}>;

export function downloadFinalFilerFilesInBrowser(
  files: readonly FinalFilerDownloadFile[],
  environment: FinalFilerBrowserEnvironment = createBrowserEnvironment(),
): void {
  if (files.length < 1 || files.length > 2) {
    throw new Error('FINAL FILER requires one WAV and at most one Source Report.');
  }

  const prepared: PreparedBrowserDownload[] = [];

  try {
    for (const file of files) {
      const objectUrl = environment.createObjectUrl(file.blob);
      let anchor: FinalFilerBrowserAnchor;

      try {
        anchor = environment.createAnchor();
      } catch (error) {
        environment.scheduleCleanup(() => environment.revokeObjectUrl(objectUrl));
        throw error;
      }

      anchor.download = file.fileName;
      anchor.hidden = true;
      anchor.href = objectUrl;
      prepared.push(Object.freeze({ anchor, objectUrl }));
      environment.appendAnchor(anchor);
    }

    for (const item of prepared) {
      item.anchor.click();
    }
  } finally {
    for (const item of prepared) {
      item.anchor.remove();
      environment.scheduleCleanup(() =>
        environment.revokeObjectUrl(item.objectUrl),
      );
    }
  }
}

function createBrowserEnvironment(): FinalFilerBrowserEnvironment {
  return Object.freeze({
    appendAnchor: (anchor) => document.body.append(anchor as HTMLAnchorElement),
    createAnchor: () => document.createElement('a'),
    createObjectUrl: (blob) => window.URL.createObjectURL(blob),
    revokeObjectUrl: (url) => window.URL.revokeObjectURL(url),
    scheduleCleanup: (cleanup) => window.setTimeout(cleanup, 0),
  });
}
