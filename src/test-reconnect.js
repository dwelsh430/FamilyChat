// Automated test: switching family code and coming back reconnects properly.
// Needs: node relay.js (local test relay) and a web server on :8765 at the repo root.
const {chromium} = require('playwright')
const CODE = 'test-reconnect-' + Date.now()
const URL = 'http://localhost:8765/?relay=ws://localhost:7447#code=' + CODE
let failures = 0
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++ }

;(async () => {
  const browser = await chromium.launch({args: ['--disable-features=WebRtcHideLocalIpsWithMdns']})
  const open = async name => {
    const p = await (await browser.newContext()).newPage()
    p.on('pageerror', e => { console.log(name, 'pageerror:', e.message); failures++ })
    await p.goto(URL); await p.fill('#nameInput', name); await p.click('#joinBtn')
    return p
  }
  const waitFor = async (p, fn, arg, ms = 15000) => { try { await p.waitForFunction(fn, arg, {timeout: ms}); return true } catch { return false } }
  const peers = n => document.getElementById('statusText').textContent.startsWith(String(n))
  const hasMsg = t => document.getElementById('messages').textContent.includes(t)

  const a = await open('Darcy'), b = await open('Grandma')
  check('A and B connect', await waitFor(a, peers, 1))
  // Darcy taps "Switch family code" and immediately re-joins the same family
  await a.click('#menuBtn'); await a.click('#leaveBtn')
  await a.fill('#codeInput', CODE); await a.click('#joinBtn')
  check('After switching back to the same code, A reconnects', await waitFor(a, peers, 1, 20000))
  await b.fill('#input', 'Still there?'); await b.click('#sendBtn')
  check('Messages still arrive after reconnecting', await waitFor(a, hasMsg, 'Still there?'))
  await browser.close()
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})()
