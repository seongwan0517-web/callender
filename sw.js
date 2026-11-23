// Time Schedule 서비스 워커 — 앱 설치(홈 화면 추가)용
// 항상 최신 화면을 받아오고(network-first), 인터넷이 끊겼을 때만 마지막으로 받은 화면을 보여준다.
// 로그인·데이터(Firebase) 요청은 건드리지 않는다.
const CACHE = 'time-schedule-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
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

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  // 같은 사이트의 GET 요청만 처리 (Firebase 로그인 처리 경로 /__/ 는 제외)
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/__/')) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
  );
});
