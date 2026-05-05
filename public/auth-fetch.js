/* credentials для cookie-сессии; при 401 — редирект на вход для админ-API */
(function () {
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const merged = { credentials: 'same-origin', ...(init || {}) };
    return orig.call(this, input, merged).then(function (res) {
      if (res.status !== 401) return res;
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (
        typeof url === 'string'
        && url.includes('/api/')
        && !url.includes('/api/v1/')
        && !url.includes('/api/auth/login')
      ) {
        window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
      }
      return res;
    });
  };

  window.logoutBotme = async function logoutBotme() {
    await orig.call(window, '/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    window.location.href = '/login.html';
  };
})();
