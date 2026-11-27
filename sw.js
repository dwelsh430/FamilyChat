// Family Chat service worker. It only shows notifications and opens the chat
// when you tap one. It doesn't cache anything, so you always get the latest page.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
self.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({type: 'window', includeUncontrolled: true})
    const open = wins.find(w => new URL(w.url).pathname === new URL(self.registration.scope).pathname)
    if (open) return open.focus()
    return self.clients.openWindow(self.registration.scope)
  })())
})
