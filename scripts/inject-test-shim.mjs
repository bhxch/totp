// 测试专用：向构建产物 popup.html / options.html 注入增强版 chrome shim。
// 用法：node scripts/inject-test-shim.mjs [outputDir]
// 幂等：已注入（含标记注释）则先移除再注入。产物目录不进 git。

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MARK = '<!-- TEST-SHIM-INJECTED -->'
const dir = process.argv[2] ?? 'apps/extension/.output/chrome-mv3'

const shim = `${MARK}
<script>
(function () {
  // ===== chrome.* shim（测试专用，内存实现 + 审计） =====
  var store = {};
  function key(k) { return 'totp:' + k; }
  var storageListeners = { local: [], sync: [] };
  var calls = { contextMenus: [], alarms: [], notifications: [], offscreen: [], runtime: [] };

  function fireChanged(area, obj) {
    var changes = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        changes[k] = { newValue: obj[k], oldValue: store[area][key(k)] !== undefined ? store[area][key(k)] : undefined };
      }
    }
    storageListeners[area].slice().forEach(function (fn) {
      try { fn(changes, area); } catch (e) {}
    });
  }

  function makeStorageArea(area) {
    return {
      get: function (keys) {
        return Promise.resolve().then(function () {
          if (keys == null) {
            var o = {};
            for (var k in store[area]) {
              if (Object.prototype.hasOwnProperty.call(store[area], k)) o[k.replace(/^totp:/, '')] = store[area][k];
            }
            return o;
          }
          if (typeof keys === 'string') keys = [keys];
          var o2 = {};
          for (var i = 0; i < keys.length; i++) {
            var v = store[area][key(keys[i])];
            if (v !== undefined) o2[keys[i]] = v;
          }
          return o2;
        });
      },
      set: function (obj) {
        return Promise.resolve().then(function () {
          for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) store[area][key(k)] = obj[k];
          }
          fireChanged(area, obj);
        });
      },
      remove: function (keys) {
        return Promise.resolve().then(function () {
          if (typeof keys === 'string') keys = [keys];
          for (var i = 0; i < keys.length; i++) delete store[area][key(keys[i])];
        });
      },
      getBytesInUse: function () { return Promise.resolve(JSON.stringify(store[area]).length); }
    };
  }
  store.local = {}; store.sync = {};

  var chromeShim = {
    storage: {
      local: makeStorageArea('local'),
      sync: Object.assign(makeStorageArea('sync'), { QUOTA_BYTES: 102400 }),
      onChanged: {
        addListener: function (fn, areas) { (areas || ['local', 'sync']).forEach(function (a) { if (storageListeners[a]) storageListeners[a].push(fn); }); },
        removeListener: function (fn) {
          for (var a in storageListeners) {
            var i = storageListeners[a].indexOf(fn);
            if (i >= 0) storageListeners[a].splice(i, 1);
          }
        }
      }
    },
    runtime: {
      sendMessage: function (msg) { calls.runtime.push(msg); return Promise.resolve(); },
      onMessage: {
        listeners: [],
        addListener: function (fn) { this.listeners.push(fn); },
        removeListener: function (fn) { var i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }
      },
      onInstalled: { addListener: function (fn) { setTimeout(function () { try { fn({ reason: 'install' }); } catch (e) {} }, 0); } },
      onStartup: { addListener: function () {} },
      lastError: undefined,
      getURL: function (p) { return '/' + p.replace(/^\\//, ''); }
    },
    tabs: {
      query: function () {
        var u = new URLSearchParams(location.search).get('tabUrl');
        return Promise.resolve(u ? [{ url: u, id: 1, active: true }] : []);
      },
      create: function (opts) { calls.tabsCreate = calls.tabsCreate || []; calls.tabsCreate.push(opts); return Promise.resolve({ id: 2 }); }
    },
    action: { openPopup: function () { calls.openPopup = (calls.openPopup || 0) + 1; } },
    contextMenus: {
      create: function (opts, cb) { calls.contextMenus.push(opts); if (cb) cb(); },
      removeAll: function () {}
    },
    alarms: {
      create: function (name, info) { calls.alarms.push({ name: name, info: info }); },
      clear: function () { return Promise.resolve(true); },
      onAlarm: { addListener: function () {}, removeListener: function () {} }
    },
    offscreen: {
      createDocument: function () { calls.offscreen.push('createDocument'); return Promise.resolve(); },
      closeDocument: function () { return Promise.resolve(); },
      hasDocument: function () { return Promise.resolve(false); }
    },
    notifications: {
      create: function (id, opts) { calls.notifications.push(opts || id); return Promise.resolve('n1'); }
    },
    permissions: { contains: function () { return Promise.resolve(true); }, request: function () { return Promise.resolve(true); } }
  };
  Object.defineProperty(window, 'chrome', { value: chromeShim, writable: false, configurable: true });

  // ===== 可编程 fetch mock：__mockFetch(pattern, responder)；未命中走真实 fetch =====
  var mockRoutes = [];
  var realFetch = window.fetch.bind(window);
  window.__mockFetch = function (pattern, responder) { mockRoutes.push({ pattern: pattern, responder: responder }); };
  window.__clearMockFetch = function () { mockRoutes = []; };
  window.__fetchLog = [];
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    window.__fetchLog.push({ url: url, method: (init && init.method) || 'GET' });
    for (var i = 0; i < mockRoutes.length; i++) {
      var r = mockRoutes[i];
      var hit = (typeof r.pattern === 'string') ? url.indexOf(r.pattern) >= 0 : r.pattern.test(url);
      if (hit) return Promise.resolve().then(function () { return r.responder(url, init); });
    }
    return realFetch(input, init);
  };

  // ===== clipboard 捕获 =====
  window.__clipboard = [];
  if (navigator.clipboard) {
    try { Object.defineProperty(navigator.clipboard, 'writeText', { value: function (t) { window.__clipboard.push(t); return Promise.resolve(); }, configurable: true }); } catch (e) {}
  } else {
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: function (t) { window.__clipboard.push(t); return Promise.resolve(); } }, configurable: true }); } catch (e) {}
  }

  // ===== seed 注入：?seedVault=base64(json) / ?seedKeys=base64(obj) =====
  var sp = new URLSearchParams(location.search);
  var sv = sp.get('seedVault');
  if (sv) { try { store.local[key('vault')] = atob(sv); } catch (e) {} }
  var sk = sp.get('seedKeys');
  if (sk) {
    try {
      var obj = JSON.parse(atob(sk));
      for (var kk in obj) { if (Object.prototype.hasOwnProperty.call(obj, kk)) store.local[key(kk)] = typeof obj[kk] === 'string' ? obj[kk] : JSON.stringify(obj[kk]); }
    } catch (e) {}
  }

  // ===== 测试辅助 =====
  window.__calls = calls;
  window.__testStore = {
    get: function () { return store.local; },
    raw: function (k) { return store.local[key(k)]; },
    clear: function () { store.local = {}; store.sync = {}; },
    setVault: function (json) { store.local[key('vault')] = typeof json === 'string' ? json : JSON.stringify(json); },
    setKey: function (k, v) { store.local[key(k)] = typeof v === 'string' ? v : JSON.stringify(v); }
  };
})();
</script>`

function inject(file) {
  const p = join(dir, file)
  let html = readFileSync(p, 'utf8')
  // 幂等：移除旧 shim
  html = html.replace(/<!-- TEST-SHIM-INJECTED -->[\s\S]*?<\/script>\n?/, '')
  // 插到 <head> 后第一个位置（在任何 module script 之前）
  const idx = html.indexOf('<meta charset')
  if (idx < 0) throw new Error(`${file}: meta charset not found`)
  html = html.slice(0, idx) + shim + '\n    ' + html.slice(idx)
  writeFileSync(p, html, 'utf8')
  console.log(`injected: ${p}`)
}

inject('popup.html')
inject('options.html')
