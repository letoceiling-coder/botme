/* botme.neeklo.ru — встраиваемый виджет AI-ассистента.
 *
 * Использование на стороннем сайте:
 *   <script src="https://botme.neeklo.ru/widget.js" data-token="ast_xxxxxxxxxxxxxxxx"></script>
 *
 * Опциональные data-атрибуты:
 *   data-host="https://botme.neeklo.ru"   — переопределить хост сервера
 */
(function () {
  if (window.__botmeWidgetLoaded) return;
  window.__botmeWidgetLoaded = true;

  // Найдём собственный <script>
  var me = document.currentScript || (function () {
    var ss = document.getElementsByTagName('script');
    return ss[ss.length - 1];
  })();
  if (!me) return console.warn('[botme] не найден <script> загрузчика');

  var token = me.getAttribute('data-token');
  if (!token) return console.warn('[botme] обязателен атрибут data-token');

  var host = me.getAttribute('data-host')
    || (me.src ? new URL(me.src).origin : window.location.origin);

  var POSITIONS = {
    br: { right: '20px', bottom: '20px' },
    bl: { left:  '20px', bottom: '20px' },
    tr: { right: '20px', top:    '20px' },
    tl: { left:  '20px', top:    '20px' },
  };

  // 1) Тянем публичную инфу об ассистенте (тема, имя, приветствие)
  fetch(host + '/api/v1/assistant', {
    headers: { 'Authorization': 'Bearer ' + token },
  }).then(function (r) {
    if (!r.ok) throw new Error('botme widget: ' + r.status);
    return r.json();
  }).then(function (a) {
    mount(a);
  }).catch(function (e) {
    console.error('[botme]', e);
  });

  function mount(a) {
    var theme = a.theme || {};
    var pos = POSITIONS[theme.position] || POSITIONS.br;
    var color = theme.color || '#7c5cff';
    var brand = theme.brand || a.name || 'AI-ассистент';
    var avatar = theme.avatar || ''; // url или emoji

    // Контейнер фиксированной кнопки + iframe
    var wrap = document.createElement('div');
    wrap.id = 'botme-widget-root';
    setStyle(wrap, mergeStyle({
      position: 'fixed', zIndex: '2147483600',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }, pos));
    document.body.appendChild(wrap);

    // Кнопка
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Открыть чат с ' + brand);
    btn.innerHTML = avatarHtml(avatar) +
      '<span style="margin-left:8px;font-weight:600;font-size:14px;">' + escape(brand) + '</span>';
    setStyle(btn, {
      display: 'inline-flex', alignItems: 'center',
      padding: '12px 18px',
      borderRadius: '999px',
      background: 'linear-gradient(135deg,' + color + ',' + lighten(color, 0.25) + ')',
      color: '#fff',
      border: 'none', cursor: 'pointer',
      boxShadow: '0 10px 30px rgba(0,0,0,0.25), 0 0 0 4px ' + hexa(color, 0.18),
      transition: 'transform .15s, box-shadow .25s',
    });
    btn.onmouseenter = function () { btn.style.transform = 'scale(1.05)'; };
    btn.onmouseleave = function () { btn.style.transform = 'scale(1)'; };

    // Iframe (создаётся при первом клике)
    var iframe = null;
    var visible = false;

    btn.addEventListener('click', function () {
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.src = host + '/widget/?token=' + encodeURIComponent(token);
        iframe.title = brand;
        iframe.allow = 'clipboard-write';
        setStyle(iframe, mergeStyle({
          position: 'fixed', zIndex: '2147483601',
          width: 'min(420px, calc(100vw - 24px))',
          height: 'min(640px, calc(100vh - 100px))',
          border: 'none',
          borderRadius: '20px',
          background: '#0b0d12',
          boxShadow: '0 25px 80px rgba(0,0,0,0.45), 0 0 0 1px ' + hexa(color, 0.4),
          opacity: '0', transform: 'translateY(8px) scale(0.98)',
          transition: 'opacity .2s, transform .2s',
        }, framePos(theme.position)));
        document.body.appendChild(iframe);
        // плавное появление
        requestAnimationFrame(function () {
          iframe.style.opacity = '1';
          iframe.style.transform = 'translateY(0) scale(1)';
        });
      }
      visible = !visible;
      if (visible) {
        iframe.style.display = 'block';
        requestAnimationFrame(function () {
          iframe.style.opacity = '1';
          iframe.style.transform = 'translateY(0) scale(1)';
        });
        btn.style.display = 'none';
      } else {
        iframe.style.display = 'none';
        btn.style.display = 'inline-flex';
      }
    });

    wrap.appendChild(btn);

    // Слушаем сообщения из iframe (закрытие)
    window.addEventListener('message', function (ev) {
      var ok = ev.origin === host;
      if (!ok || !ev.data || ev.data.source !== 'botme-widget') return;
      if (ev.data.type === 'close') {
        if (iframe) iframe.style.display = 'none';
        btn.style.display = 'inline-flex';
        visible = false;
      }
      if (ev.data.type === 'ready') {
        // ничего пока
      }
    });
  }

  // ---------- утилиты ----------
  function framePos(position) {
    if (position === 'bl') return { left: '12px', bottom: '12px' };
    if (position === 'tr') return { right: '12px', top: '12px' };
    if (position === 'tl') return { left: '12px', top: '12px' };
    return { right: '12px', bottom: '12px' };
  }
  function setStyle(el, obj) {
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) el.style[k] = obj[k];
  }
  function mergeStyle(a, b) {
    var r = {}; for (var k in a) r[k] = a[k]; for (var k2 in b) r[k2] = b[k2]; return r;
  }
  function escape(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }
  function avatarHtml(av) {
    if (!av) {
      return '<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,0.18);font-size:14px;">💬</span>';
    }
    if (/^https?:\/\//.test(av)) {
      return '<img src="' + escape(av) + '" alt="" style="width:24px;height:24px;border-radius:50%;object-fit:cover;">';
    }
    return '<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,0.18);font-size:14px;">' + escape(av) + '</span>';
  }
  function hexa(hex, alpha) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var r = parseInt(h.substr(0, 2), 16);
    var g = parseInt(h.substr(2, 2), 16);
    var b = parseInt(h.substr(4, 2), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }
  function lighten(hex, amount) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var r = Math.min(255, Math.round(parseInt(h.substr(0, 2), 16) + 255 * amount));
    var g = Math.min(255, Math.round(parseInt(h.substr(2, 2), 16) + 255 * amount));
    var b = Math.min(255, Math.round(parseInt(h.substr(4, 2), 16) + 255 * amount));
    return '#' + [r, g, b].map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }
})();
