import { describe, expect, it, vi } from 'vitest';

import {
  downloadFinalFilerFilesInBrowser,
  type FinalFilerBrowserAnchor,
  type FinalFilerBrowserEnvironment,
} from './finalFilerBrowserDownload';

describe('downloadFinalFilerFilesInBrowser', () => {
  it('prepares all files before clicking and cleans every anchor and Blob URL', () => {
    const events: string[] = [];
    const cleanups: Array<() => void> = [];
    const anchors = [createAnchor('wav', events), createAnchor('report', events)];
    let anchorIndex = 0;
    const environment: FinalFilerBrowserEnvironment = {
      appendAnchor: (anchor) => events.push(`append:${anchor.download}`),
      createAnchor: () => anchors[anchorIndex++],
      createObjectUrl: vi
        .fn()
        .mockImplementationOnce(() => 'blob:wav')
        .mockImplementationOnce(() => 'blob:report'),
      revokeObjectUrl: vi.fn((url) => events.push(`revoke:${url}`)),
      scheduleCleanup: (cleanup) => cleanups.push(cleanup),
    };

    downloadFinalFilerFilesInBrowser(
      [
        { blob: new Blob(['wav']), fileName: 'delivery.wav', kind: 'wav' },
        {
          blob: new Blob(['report']),
          fileName: 'delivery-source-report.txt',
          kind: 'source-report',
        },
      ],
      environment,
    );

    expect(events).toEqual([
      'append:delivery.wav',
      'append:delivery-source-report.txt',
      'click:wav',
      'click:report',
      'remove:wav',
      'remove:report',
    ]);
    expect(anchors[0]).toMatchObject({
      download: 'delivery.wav',
      hidden: true,
      href: 'blob:wav',
    });
    expect(anchors[1]).toMatchObject({
      download: 'delivery-source-report.txt',
      hidden: true,
      href: 'blob:report',
    });
    cleanups.forEach((cleanup) => cleanup());
    expect(events.slice(-2)).toEqual(['revoke:blob:wav', 'revoke:blob:report']);
  });

  it('cleans prepared resources when anchor preparation or clicking fails', () => {
    const cleanups: Array<() => void> = [];
    const first = createAnchor('wav', []);
    vi.mocked(first.click).mockImplementation(() => {
      throw new Error('Blocked.');
    });
    const environment: FinalFilerBrowserEnvironment = {
      appendAnchor: vi.fn(),
      createAnchor: () => first,
      createObjectUrl: () => 'blob:wav',
      revokeObjectUrl: vi.fn(),
      scheduleCleanup: (cleanup) => cleanups.push(cleanup),
    };

    expect(() =>
      downloadFinalFilerFilesInBrowser(
        [{ blob: new Blob(['wav']), fileName: 'delivery.wav', kind: 'wav' }],
        environment,
      ),
    ).toThrow('Blocked.');
    expect(first.remove).toHaveBeenCalledOnce();
    cleanups.forEach((cleanup) => cleanup());
    expect(environment.revokeObjectUrl).toHaveBeenCalledWith('blob:wav');
  });

  it('revokes an object URL when creating its temporary anchor fails', () => {
    const cleanups: Array<() => void> = [];
    const environment: FinalFilerBrowserEnvironment = {
      appendAnchor: vi.fn(),
      createAnchor: () => {
        throw new Error('Anchor unavailable.');
      },
      createObjectUrl: () => 'blob:orphan',
      revokeObjectUrl: vi.fn(),
      scheduleCleanup: (cleanup) => cleanups.push(cleanup),
    };

    expect(() =>
      downloadFinalFilerFilesInBrowser(
        [{ blob: new Blob(['wav']), fileName: 'delivery.wav', kind: 'wav' }],
        environment,
      ),
    ).toThrow('Anchor unavailable.');
    cleanups.forEach((cleanup) => cleanup());
    expect(environment.revokeObjectUrl).toHaveBeenCalledWith('blob:orphan');
  });
});

function createAnchor(
  label: string,
  events: string[],
): FinalFilerBrowserAnchor {
  return {
    click: vi.fn(() => events.push(`click:${label}`)),
    download: '',
    hidden: false,
    href: '',
    remove: vi.fn(() => events.push(`remove:${label}`)),
  };
}
