// Automated test of the connection relay (TURN) settings.
// Needs: node relay.js (local test relay), a web server on :8765 at the repo root,
// and a TURN server on 127.0.0.1:3478 with user "family" / password "secretpass".
const {chromium} = require('playwright')
const CODE = 'test-turn-' + Date.now()
const BASE = 'http://localhost:8765/?relay=ws://localhost:7447'
let failures = 0
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++ }

;(async () => {
  const browser = await chromium.launch({args: ['--disable-features=WebRtcHideLocalIpsWithMdns']})
  const open = async (name, url) => {
    const ctx = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write']})
    const p = await ctx.newPage()
    p.on('pageerror', e => { console.log(name, 'pageerror:', e.message); failures++ })
    p.on('dialog', d => d.accept())
    await p.goto(url); await p.fill('#nameInput', name); await p.click('#joinBtn')
    return p
  }
  const waitFor = async (p, fn, arg, ms = 15000) => { try { await p.waitForFunction(fn, arg, {timeout: ms}); return true } catch { return false } }
  const peers = n => document.getElementById('statusText').textContent.startsWith(String(n))
  const hasMsg = t => document.getElementById('messages').textContent.includes(t)

  // Relay-only mode stands in for networks that block direct connections.
  const RELAY_ONLY = BASE + '&relayonly=1#code=' + CODE
  const a = await open('Darcy', RELAY_ONLY)
  const b = await open('Phone on mobile data', RELAY_ONLY)
  check('Without a relay, blocked devices cannot connect', !(await waitFor(a, peers, 1, 12000)))
  await b.context().close()

  // Darcy enters relay details
  await a.click('#menuBtn'); await a.click('#turnBtn')
  await a.fill('#turnUrls', '127.0.0.1:3478')
  await a.fill('#turnUser', 'family'); await a.fill('#turnPass', 'secretpass')
  await a.click('#turnSave')
  const saved = await a.evaluate(c => JSON.parse(localStorage.getItem('fc:turn:' + c)), CODE)
  check('Relay details saved (turn: added to the address)', saved && saved.urls[0] === 'turn:127.0.0.1:3478' && saved.username === 'family')

  // Invite link carries the relay details
  await a.waitForTimeout(1000)
  await a.click('#menuBtn'); await a.click('#inviteBtn'); await a.click('#closeMenu')
  const invite = await a.evaluate(() => navigator.clipboard.readText())
  check('Invite link includes relay details', invite.includes('&turn='))

  // A new family member opens the invite link on a "blocked" network
  const hash = invite.slice(invite.indexOf('#'))
  const c = await open('Grandma on mobile data', BASE + '&relayonly=1' + hash)
  check('With the relay, blocked devices connect', await waitFor(a, peers, 1, 25000))
  await c.fill('#input', 'Hello through the relay'); await c.click('#sendBtn')
  check('Messages flow through the relay', await waitFor(a, hasMsg, 'Hello through the relay'))

  // Someone who never got the relay details picks them up from any family member they reach.
  // (Both on ordinary networks here; the test machine can't relay to itself across addresses.)
  const f = await open('Mom on home Wi-Fi', BASE + hash)
  const d = await open('Uncle Pat', BASE + '#code=' + CODE)
  check('Older member picks up relay details from family', await waitFor(d, c => !!localStorage.getItem('fc:turn:' + c), CODE))

  // The link-another-device link also carries them
  await a.click('#menuBtn'); await a.click('#linkBtn')
  await waitFor(a, () => document.getElementById('linkUrl').value.includes('link='))
  check('Device link includes relay details', (await a.inputValue('#linkUrl')).includes('&turn='))

  await browser.close()
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})()
