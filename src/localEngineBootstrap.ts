export type LocalEngineBootstrap = Readonly<{
  baseUrl: string;
  token: string;
}>;

type BootstrapLocation = Pick<Location, 'hash' | 'pathname' | 'search'>;
type BootstrapHistory = Pick<History, 'replaceState' | 'state'>;

const BASE_URL_PARAMETER = 'engineBaseUrl';
const TOKEN_PARAMETER = 'engineToken';
const HISTORY_STATE_PARAMETER = 'humstudioLocalEngineBootstrap';

export function parseLocalEngineBootstrap(hash: string): LocalEngineBootstrap | undefined {
  const parameters = createHashParameters(hash);
  return normalizeLocalEngineBootstrap({
    baseUrl: parameters.get(BASE_URL_PARAMETER),
    token: parameters.get(TOKEN_PARAMETER),
  });
}

export function consumeLocalEngineBootstrap(
  location: BootstrapLocation,
  history: BootstrapHistory,
): LocalEngineBootstrap | undefined {
  const parameters = createHashParameters(location.hash);
  const bootstrap = parseLocalEngineBootstrap(location.hash);
  const containedBootstrapData = parameters.has(BASE_URL_PARAMETER) || parameters.has(TOKEN_PARAMETER);

  if (containedBootstrapData) {
    parameters.delete(BASE_URL_PARAMETER);
    parameters.delete(TOKEN_PARAMETER);
    const remainingHash = parameters.toString();
    history.replaceState(
      createBootstrapHistoryState(history.state, bootstrap),
      '',
      `${location.pathname}${location.search}${remainingHash ? `#${remainingHash}` : ''}`,
    );

    return bootstrap;
  }

  return readBootstrapFromHistoryState(history.state);
}

function createHashParameters(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

function normalizeLocalEngineBootstrap(value: unknown): LocalEngineBootstrap | undefined {
  if (!isHistoryStateRecord(value)) {
    return undefined;
  }

  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const token = typeof value.token === 'string' ? value.token.trim() : '';

  if (!baseUrl || !token) {
    return undefined;
  }

  return Object.freeze({ baseUrl, token });
}

function readBootstrapFromHistoryState(state: unknown): LocalEngineBootstrap | undefined {
  if (!isHistoryStateRecord(state)) {
    return undefined;
  }

  return normalizeLocalEngineBootstrap(state[HISTORY_STATE_PARAMETER]);
}

function createBootstrapHistoryState(
  state: unknown,
  bootstrap: LocalEngineBootstrap | undefined,
): Record<string, unknown> | null {
  const nextState = isHistoryStateRecord(state) ? { ...state } : {};

  if (bootstrap) {
    nextState[HISTORY_STATE_PARAMETER] = bootstrap;
  } else {
    delete nextState[HISTORY_STATE_PARAMETER];
  }

  return Object.keys(nextState).length > 0 ? nextState : null;
}

function isHistoryStateRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
