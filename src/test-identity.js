// Automated test of signed messages, linked devices and removing a device.
// Needs: node relay.js (local test relay) and a web server on :8765 at the repo root.
// Optional: OLD_URL=http://host/ (the previous version of the page) to test mixing versions.
const {chromium} = require('playwright')
const CODE = 'test-ident-' + Date.now()
const Q = '?relay=ws://localhost:7447'
const URL = 'http://localhost:8765/' + Q + '#code=' + CODE
const OLD_URL = process.env.OLD_URL ? process.env.OLD_URL + Q + '#code=' + CODE : null
let failures = 0
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++ }

;(async () => {
  const browser = await chromium.launch({args: ['--disable-features=WebRtcHideLocalIpsWithMdns']})
  const open = async (name, url = URL, vp) => {
    const ctx = await browser.newContext(vp ? {viewport: vp, deviceScaleFactor: 2} : {})
    const p = await ctx.newPage()
    p.on('pageerror', e => { console.log(name, 'pageerror:', e.message); failures++ })
    p.on('dialog', d => d.accept())
    await p.goto(url)
    if (name) { await p.fill('#nameInput', name); await p.click('#joinBtn') }
    return p
  }
  const waitFor = async (p, fn, arg, ms = 15000) => { try { await p.waitForFunction(fn, arg, {timeout: ms}); return true } catch { return false } }
  const say = async (p, text) => { await p.fill('#input', text); await p.click('#sendBtn') }
  // Returns {who, mine} for the message bubble containing text
  const bubble = (p, text) => p.evaluate(t => {
    const el = [...document.querySelectorAll('.msg')].find(e => e.textContent.includes(t))
    return el ? {who: el.querySelector('.who')?.textContent || '', mine: el.classList.contains('mine')} : null
  }, text)
  const hasMsg = t => [...document.querySelectorAll('.msg')].some(e => e.textContent.includes(t))
  const peers = n => document.getElementById('statusText').textContent.startsWith(String(n))

  const a = await open('Darcy')
  const b = await open('Grandma', URL, {width: 390, height: 760})
  check('A and B connect', await waitFor(a, peers, 1))
  await say(a, 'Signed hello from Darcy')
  await waitFor(b, hasMsg, 'Signed hello from Darcy')
  let x = await bubble(b, 'Signed hello from Darcy')
  check('B sees Darcy\'s message as verified (no warning)', x && x.who === 'Darcy' && !x.mine)

  // C tries to forge messages as Darcy
  const c = await open('Mallory')
  await waitFor(c, peers, 2)
  const darcyUid = await a.evaluate(() => window.__fcTest.uid())
  await c.evaluate(async uid => {
    const t = window.__fcTest
    const forged = {id: 'x:' + crypto.randomUUID(), name: 'Darcy', text: 'Forged with my own key', ts: Date.now(), uid, pk: t.pk()}
    forged.sig = await t.sign(forged)
    const badSig = {id: 'x:' + crypto.randomUUID(), name: 'Darcy', text: 'Forged with a bad signature', ts: Date.now(), uid, pk: t.pk(), sig: 'AAAA'}
    const unsigned = {id: 'x:' + crypto.randomUUID(), name: 'Darcy', text: 'Forged with no signature', ts: Date.now()}
    t.send([forged, badSig, unsigned])
  }, darcyUid)
  await waitFor(b, hasMsg, 'Forged with my own key')
  await b.waitForTimeout(1000)
  x = await bubble(b, 'Forged with my own key')
  check('Forged message (someone else\'s key) is flagged unverified', x && x.who.includes('unverified'))
  check('Message with a bad signature is thrown away', !(await b.evaluate(hasMsg, 'Forged with a bad signature')))
  x = await bubble(b, 'Forged with no signature')
  check('Unsigned message is shown but flagged unverified', x && x.who.includes('unverified'))

  // Name clash: C renames to Darcy and posts, properly signed as C
  await c.evaluate(() => { window.prompt = () => 'Darcy' })
  await c.click('#menuBtn'); await c.click('#renameBtn'); await c.click('#closeMenu')
  await say(c, 'I am also called Darcy')
  await waitFor(b, hasMsg, 'I am also called Darcy')
  await b.waitForTimeout(500)
  const tagC = await bubble(b, 'I am also called Darcy'), tagA = await bubble(b, 'Signed hello from Darcy')
  check('Two people named Darcy get different short codes', tagC && tagA && /· \w{4}/.test(tagC.who) && /· \w{4}/.test(tagA.who) && tagC.who !== tagA.who)
  await c.context().close()

  // Link a second device to Darcy
  await a.click('#menuBtn'); await a.click('#linkBtn')
  await waitFor(a, () => document.getElementById('linkUrl').value.includes('link='))
  check('Link screen shows a QR code', await a.evaluate(() => !!document.querySelector('#linkQr svg')))
  const link = await a.inputValue('#linkUrl')
  const hash = link.slice(link.indexOf('#'))
  const a2 = await open(null, 'http://localhost:8765/' + Q + hash, {width: 390, height: 760})
  check('New device shows the "Link this device" screen', await waitFor(a2, () => document.getElementById('setup').classList.contains('linking')))
  await a2.click('#linkJoinBtn')
  check('New device gets linked', await waitFor(a2, () => !document.getElementById('setup').classList.contains('show'), null, 25000))
  check('Existing device says linked', await waitFor(a, () => document.getElementById('linkStatus').textContent.startsWith('Linked')))
  await a.click('#linkClose')
  check('Linked device has the same user and name', (await a2.evaluate(() => window.__fcTest.uid())) === darcyUid)
  check('Linked device gets the chat history', await waitFor(a2, hasMsg, 'Signed hello from Darcy'))
  x = await bubble(a2, 'Signed hello from Darcy')
  check('On the new device, messages from the first device show as mine', x && x.mine)

  await say(a2, 'Hello from my phone')
  await waitFor(a, hasMsg, 'Hello from my phone'); await waitFor(b, hasMsg, 'Hello from my phone')
  await b.waitForTimeout(500)
  x = await bubble(a, 'Hello from my phone')
  check('On the first device, the phone\'s message shows as mine', x && x.mine)
  x = await bubble(b, 'Hello from my phone')
  check('Grandma sees the phone\'s message as Darcy, verified', x && !x.who.includes('unverified') && x.who.startsWith('Darcy'))

  await a2.reload()
  check('Linked device stays linked after reload', await waitFor(a2, () => window.__fcTest && true) && (await a2.evaluate(() => window.__fcTest.uid())) === darcyUid)
  await a.click('#menuBtn')
  check('My devices lists both devices', await waitFor(a, () => document.querySelectorAll('#deviceList li').length === 2))
  await a.screenshot({path: 'devices-menu.png'})

  // Remove the phone
  await a.locator('#deviceList li button').click()
  await a.click('#closeMenu')
  check('Removed device gets a new identity', await waitFor(a2, uid => window.__fcTest.uid() !== uid, darcyUid))
  await say(a2, 'Message after removal')
  await waitFor(b, hasMsg, 'Message after removal')
  await b.waitForTimeout(800)
  x = await bubble(b, 'Message after removal')
  check('After removal, the old phone no longer posts as the real Darcy', x && x.who !== 'Darcy' && /· \w{4}/.test(x.who))
  x = await bubble(b, 'Hello from my phone')
  check('Messages sent before removal stay verified', x && !x.who.includes('unverified'))

  if (OLD_URL) {
    const old = await open('Uncle Pat (old version)', OLD_URL)
    check('Old version still gets messages', await waitFor(old, hasMsg, 'Signed hello from Darcy'))
    await say(old, 'Hi from the old page')
    await waitFor(a, hasMsg, 'Hi from the old page')
    x = await bubble(a, 'Hi from the old page')
    check('Message from the old version shows as unverified', x && x.who.includes('unverified'))
    x = await bubble(a, 'Signed hello from Darcy')
    check('Old version passing messages along doesn\'t break signatures', x && x.mine)
  }

  await b.screenshot({path: 'identity-phone.png'})
  await browser.close()
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})()
