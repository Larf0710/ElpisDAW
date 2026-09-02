import { describe, expect, it, vi } from 'vitest';

import { consumeLocalEngineBootstrap, parseLocalEngineBootstrap } from './localEngineBootstrap';

const baseUrl = 'http://127.0.0.1:43120';
const token = 'test-launch-token-that-is-at-least-32-characters';

describe('Local Engine bootstrap', () => {
  it('reads the loopback address and launch token from a URL fragment', () => {
    expect(
      parseLocalEngineBootstrap(
        `#engineBaseUrl=${encodeURIComponent(baseUrl)}&engineToken=${encodeURIComponent(token)}`,
      ),
    ).toEqual({ baseUrl, token });
  });

  it('requires both bootstrap values', () => {
    expect(parseLocalEngineBootstrap(`#engineBaseUrl=${encodeURIComponent(baseUrl)}`)).toBeUndefined();
    expect(parseLocalEngineBootstrap(`#engineToken=${encodeURIComponent(token)}`)).toBeUndefined();
  });

  it('removes bootstrap data immediately while preserving the rest of the URL', () => {
    const replaceState = vi.fn();
    const location = {
      hash: `#panel=mixer&engineBaseUrl=${encodeURIComponent(baseUrl)}&engineToken=${encodeURIComponent(token)}`,
      pathname: '/studio',
      search: '?demo=1',
    };
    const history = { replaceState, state: { retained: true } };

    expect(consumeLocalEngineBootstrap(location, history)).toEqual({ baseUrl, token });
    const persistedState = replaceState.mock.calls[0]?.[0];

    expect(replaceState).toHaveBeenCalledWith(
      expect.objectContaining({ retained: true }),
      '',
      '/studio?demo=1#panel=mixer',
    );
    expect(JSON.stringify(persistedState)).toContain(baseUrl);
    expect(JSON.stringify(persistedState)).toContain(token);
  });

  it('restores the Local Engine bootstrap after a page reload without exposing it in the URL', () => {
    const initialReplaceState = vi.fn();
    const initialHistory = { replaceState: initialReplaceState, state: { retained: true } };

    expect(
      consumeLocalEngineBootstrap(
        {
          hash: `#engineBaseUrl=${encodeURIComponent(baseUrl)}&engineToken=${encodeURIComponent(token)}`,
          pathname: '/',
          search: '',
        },
        initialHistory,
      ),
    ).toEqual({ baseUrl, token });

    const reloadReplaceState = vi.fn();
    const persistedState = initialReplaceState.mock.calls[0]?.[0];

    expect(
      consumeLocalEngineBootstrap(
        { hash: '', pathname: '/', search: '' },
        { replaceState: reloadReplaceState, state: persistedState },
      ),
    ).toEqual({ baseUrl, token });
    expect(reloadReplaceState).not.toHaveBeenCalled();
  });

  it('clears incomplete bootstrap data and any retained credentials', () => {
    const replaceState = vi.fn();
    const retainedCredentials = {
      humstudioLocalEngineBootstrap: { baseUrl, token },
      retained: true,
    };

    expect(
      consumeLocalEngineBootstrap(
        { hash: `#engineToken=${encodeURIComponent(token)}`, pathname: '/', search: '' },
        { replaceState, state: retainedCredentials },
      ),
    ).toBeUndefined();
    expect(replaceState).toHaveBeenCalledWith({ retained: true }, '', '/');
  });

  it('ignores malformed retained credentials', () => {
    expect(
      consumeLocalEngineBootstrap(
        { hash: '', pathname: '/', search: '' },
        {
          replaceState: vi.fn(),
          state: { humstudioLocalEngineBootstrap: { baseUrl, token: 42 } },
        },
      ),
    ).toBeUndefined();
  });
});
