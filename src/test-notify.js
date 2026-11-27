// Automated test of message notifications.
// Needs: node relay.js (local test relay) and a web server on :8765 at the repo root.
const {chromium} = require('playwright')
const URL = 'http://localhost:8765/?relay=ws://localhost:7447#code=test-notify-' + Date.now()
let failures = 0
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++ }

;(async () => {
  const browser = await chromium.launch({args: ['--disable-features=WebRtcHideLocalIpsWithMdns']})
  const open = async (name, spy) => {
    const ctx = await browser.newContext({permissions: ['notifications']})
    if (spy) await ctx.addInitScript(() => {
      // Pretend the page can be hidden, and record notifications instead of showing them.
      window.__hidden = false; window.__notes = []
      Object.defineProperty(document, 'hidden', {get: () => window.__hidden})
      document.hasFocus = () => !window.__hidden
      // Headless Chromium always reports notifications as blocked, so stand in for the permission prompt.
      Object.defineProperty(Notification, 'permission', {get: () => window.__perm || 'default'})
      Notification.requestPermission = async () => (window.__perm = 'granted')
      if (self.ServiceWorkerRegistration) ServiceWorkerRegistration.prototype.showNotification = function (title, opts) { window.__notes.push({title, body: opts.body, via: 'sw'}); return Promise.resolve() }
    })
    const p = await ctx.newPage()
    p.on('pageerror', e => { console.log(name, 'pageerror:', e.message); failures++ })
    await p.goto(URL); await p.fill('#nameInput', name); await p.click('#joinBtn')
    return p
  }
  const waitFor = async (p, fn, arg) => { try { await p.waitForFunction(fn, arg, {timeout: 15000}); return true } catch { return false } }
  const say = async (p, text) => { await p.fill('#input', text); await p.click('#sendBtn') }
  const notes = p => p.evaluate(() => window.__notes)

  const a = await open('Darcy', true)
  const b = await open('Grandma')
  check('A and B connect', await waitFor(a, () => document.getElementById('statusText').textContent.startsWith('1')))
  check('Service worker registers', await waitFor(a, () => navigator.serviceWorker.getRegistration().then(r => !!r)))

  await a.click('#menuBtn')
  check('Menu shows notifications off', (await a.textContent('#notifyBtn')) === 'Notifications: Off')
  await a.click('#notifyBtn')
  check('Turning on works', await waitFor(a, () => document.getElementById('notifyBtn').textContent === 'Notifications: On'))
  await a.click('#closeMenu')

  await a.evaluate(() => { window.__hidden = true })
  await say(b, 'Dinner is at 6')
  check('Notification shown while chat is in the background', await waitFor(a, () => window.__notes.length === 1))
  let n = (await notes(a))[0]
  check('Notification shows sender and text', n && n.title === 'Grandma' && n.body === 'Dinner is at 6' && n.via === 'sw')

  await a.evaluate(() => { window.__hidden = false })
  await say(b, 'Bring a salad')
  await a.waitForFunction(() => document.getElementById('messages').textContent.includes('Bring a salad'))
  await a.waitForTimeout(500)
  check('No notification while you are looking at the chat', (await notes(a)).length === 1)

  await a.evaluate(() => { window.__hidden = true })
  await say(a, 'my own message')
  await a.waitForTimeout(1000)
  check('No notification for your own messages', (await notes(a)).length === 1)

  await say(b, 'One more thing')
  await waitFor(a, () => window.__notes.length === 2)
  check('Tab title shows unread count', /^\(\d+\) Family Chat$/.test(await a.title()))

  await a.evaluate(() => { window.__hidden = false })
  await a.click('#menuBtn'); await a.click('#notifyBtn'); await a.click('#closeMenu')
  await a.evaluate(() => { window.__hidden = true })
  await say(b, 'After turning off')
  await a.waitForFunction(() => document.getElementById('messages').textContent.includes('After turning off'))
  await a.waitForTimeout(500)
  check('Turning off stops notifications', (await notes(a)).length === 2)

  await browser.close()
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})()
