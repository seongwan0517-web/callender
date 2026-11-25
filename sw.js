// Time Schedule 서비스 워커 — 앱 설치(홈 화면 추가)용
// - 화면(index.html): 최신을 받아오되, 3초 안에 안 오거나 인터넷이 끊기면 마지막으로 받은 화면을 보여준다.
// - 디자인·아이콘 등 같은 사이트 파일: 저장본을 바로 쓰고 뒤에서 최신으로 갱신.
// - 버전이 박힌 라이브러리·글꼴(CDN): 한 번 받으면 휴대폰에 저장해 두고 다시 받지 않는다.
// 로그인·데이터(Firebase) 요청은 건드리지 않는다.
const CACHE = 'time-schedule-v4';
const LIBS = 'time-schedule-libs-v1';
const SHELL = ['/', '/index.html', '/app.css?v=2', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

// 주소에 버전이 들어 있어 내용이 바뀌지 않는 외부 파일들
const LIB_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];
const isLib = url =>
  LIB_HOSTS.includes(url.hostname) ||
  (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== LIBS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ===== 푸시 알림 =====
// 동기화 Apps Script 가 FCM 으로 보내는 data 메시지: { data: { title, body, url, tag } }
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { data: { body: event.data && event.data.text() } }; }
  const d = payload.data || payload.notification || {};
  const title = d.title || 'Time Schedule';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag || 'time-schedule',
    renotify: true,
    data: { url: d.url || '/' }
  }));
});

// 알림을 누르면 앱을 열거나, 이미 열려 있으면 그 창으로 이동
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

const storable = res => res && (res.ok || res.type === 'opaque');

function saveTo(cacheName, req, res) {
  if (storable(res)) {
    const copy = res.clone();
    caches.open(cacheName).then(c => c.put(req, copy)).catch(() => {});
  }
  return res;
}

// 라이브러리·글꼴: 저장본 우선
function cacheFirst(req) {
  return caches.open(LIBS).then(c => c.match(req)).then(hit =>
    hit || fetch(req).then(res => saveTo(LIBS, req, res))
  );
}

// 화면: 최신 우선, 3초 넘게 걸리거나 끊기면 저장본
function networkFirst(req) {
  const network = fetch(req).then(res => saveTo(CACHE, req, res));
  const fallback = () => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('/index.html'));
  const timeout = new Promise(resolve => setTimeout(resolve, 3000)).then(fallback);
  return Promise.race([
    network.catch(fallback),
    timeout.then(hit => hit || network)
  ]);
}

// 디자인·아이콘: 저장본을 바로 쓰고 뒤에서 갱신
function staleWhileRevalidate(req) {
  return caches.match(req).then(hit => {
    const network = fetch(req).then(res => saveTo(CACHE, req, res));
    if (hit) { network.catch(() => {}); return hit; }
    return network;
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isLib(url)) return event.respondWith(cacheFirst(req));
  // 같은 사이트만 처리 (Firebase 로그인 처리 경로 /__/ 는 제외)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/__/')) return;

  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    return event.respondWith(networkFirst(req));
  }
  event.respondWith(staleWhileRevalidate(req));
});
