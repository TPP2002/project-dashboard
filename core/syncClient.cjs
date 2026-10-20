'use strict';
const { baseUrl, validateConfig } = require('./syncCredential.cjs');

function requestError(status) {
  return Object.assign(new Error(status === 401 ? '请重新登录云端' : `云端请求失败（HTTP ${status}）`),
    { httpStatus: status, ...(status === 401 ? { code: 'LOGIN_REQUIRED' } : {}) });
}
function createSyncClient({ config, credential, fetch: fetchImpl = globalThis.fetch } = {}) {
  config = validateConfig(config);
  let cookie = '', csrf = '', loginPromise = null;
  const active = new Set();
  function headers(data, extra = {}) {
    return { ...(cookie ? { Cookie: cookie } : {}), ...extra, ...(data === undefined ? {} : {
      Origin: config.origin, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1',
      ...(csrf ? { 'X-Dashboard-CSRF': csrf } : {}),
    }) };
  }
  async function exchange(route, data, extra = {}, stream = false, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    active.add(controller);
    const timer = setTimeout(abort, data === undefined ? 60000 : 30000);
    const cleanup = () => { clearTimeout(timer); active.delete(controller); signal?.removeEventListener('abort', abort); };
    try {
      const response = await fetchImpl(baseUrl(config) + route, { method: data === undefined ? 'GET' : 'POST',
        headers: headers(data, extra), body: data === undefined ? undefined : JSON.stringify(data),
        signal: controller.signal, redirect: 'error' });
      if (stream && response.ok) { clearTimeout(timer); return { response, cleanup }; }
      if (response.status === 401) { await response.body?.cancel(); throw requestError(401); }
      if (!response.ok && response.status !== 304) { await response.body?.cancel(); throw requestError(response.status); }
      const body = response.status === 304 ? { notModified: true } : await response.json();
      const sessionCookie = response.headers.get('set-cookie')?.match(/(?:^|,\s*)dashboard_session=([^;]+)/);
      if (sessionCookie) cookie = 'dashboard_session=' + sessionCookie[1];
      cleanup();
      return body;
    } catch (error) {
      cleanup();
      if (error.httpStatus) throw error;
      throw Object.assign(new Error('云端连接失败或请求超时'), { code: 'NETWORK_ERROR' });
    }
  }
  async function deviceLogin() {
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      cookie = ''; csrf = '';
      const token = typeof credential === 'function' ? await credential() : credential?.token || credential;
      if (!token) throw requestError(401);
      await exchange('/api/auth/device-login', { token });
      const session = await exchange('/api/auth/session');
      if (!session.user || !session.csrfToken || !cookie) throw requestError(401);
      csrf = session.csrfToken;
    })();
    try { await loginPromise; } finally { loginPromise = null; }
  }
  async function authenticated(route, data, extra, stream, signal) {
    if (!cookie) await deviceLogin();
    try { return await exchange(route, data, extra, stream, signal); }
    catch (error) {
      if (error.httpStatus !== 401) throw error;
      await deviceLogin();
      return exchange(route, data, extra, stream, signal);
    }
  }
  const remote = id => '/api/sync/projects/' + encodeURIComponent(id);
  async function subscribe(onEvent, { signal, onOpen } = {}) {
    const { response, cleanup } = await authenticated('/api/stream', undefined, { Accept: 'text/event-stream' }, true, signal);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', event = '', data = [];
    const line = async value => {
      if (!value) {
        if (event === 'board:changed' && data.length) {
          let parsed;
          try { parsed = JSON.parse(data.join('\n')); } catch { /* Ignore malformed events, keep polling fallback. */ }
          if (typeof parsed?.projectId === 'string') await onEvent(parsed);
        }
        event = ''; data = [];
      } else if (value.startsWith('event:')) event = value.slice(6).trim();
      else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    };
    try {
      onOpen?.();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const value = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          await line(value);
        }
        if (buffer.length > 1048576) throw new Error('事件流数据过长');
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); cleanup(); }
  }
  return {
    deviceLogin,
    async passwordLogin(username, password) {
      const session = await exchange('/api/auth/login', { username, password });
      if (!session.user || !session.csrfToken || !cookie) throw requestError(401);
      csrf = session.csrfToken;
    },
    request: (route, data) => authenticated(route, data),
    async logout() {
      try { if (cookie) await exchange('/api/auth/logout', {}); } finally { cookie = ''; csrf = ''; }
    },
    sendOps: (id, ackSeq, ops) => authenticated(remote(id) + '/ops', { ackSeq, ops }),
    snapshot: (id, etag) => authenticated(remote(id) + '/snapshot', undefined, etag ? { 'If-None-Match': etag } : {}),
    listProjects: () => authenticated('/api/sync/projects'),
    upload: (id, board, name) => authenticated(remote(id) + '/upload', { board, ...(name === undefined ? {} : { name }) }),
    subscribe,
    close() { for (const controller of active) controller.abort(); cookie = ''; csrf = ''; },
  };
}
module.exports = { createSyncClient, requestError };
