export type BrowserSaveStorage = Pick<Storage, 'setItem'>;

export function persistBrowserSave(
  storage: BrowserSaveStorage,
  key: string,
  serializedProject: string,
): boolean {
  try {
    storage.setItem(key, serializedProject);
    return true;
  } catch {
    return false;
  }
}
