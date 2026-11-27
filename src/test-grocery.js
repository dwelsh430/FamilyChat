// Automated test of the Grocery Store board with simulated family members.
// Needs: node relay.js (local test relay) and a web server on :8765 at the repo root.
const {chromium} = require('playwright')
const URL = 'http://localhost:8765/?relay=ws://localhost:7447#code=test-grocery-' + Date.now()
let failures = 0
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++ }

;(async () => {
  const browser = await chromium.launch({args: ['--disable-features=WebRtcHideLocalIpsWithMdns']})
  const mk = async (name, vp) => {
    const ctx = await browser.newContext(vp ? {viewport: vp, deviceScaleFactor: 2} : {})
    const p = await ctx.newPage()
    p.on('pageerror', e => { console.log(name, 'pageerror:', e.message); failures++ })
    p.on('dialog', d => d.accept())
    await p.goto(URL); await p.fill('#nameInput', name); await p.click('#joinBtn')
    await p.click('#tabGrocery')
    return p
  }
  const waitFor = async (p, fn, arg) => { try { await p.waitForFunction(fn, arg, {timeout: 15000}); return true } catch { return false } }
  const board = p => p.textContent('#groceryBoard')
  const addStore = async (p, name) => { await p.fill('#g-new-store', name); await p.press('#g-new-store', 'Enter') }
  const storeSection = (p, name) => p.locator('.g-store', {has: p.locator('.g-store-name', {hasText: name})})
  const addItem = async (p, store, item) => {
    const input = storeSection(p, store).locator('.g-add input')
    await input.fill(item); await input.press('Enter')
  }
  const hasText = t => document.getElementById('groceryBoard').textContent.includes(t)

  const a = await mk('Darcy')
  const b = await mk('Grandma', {width: 390, height: 760})
  check('A and B connect', await waitFor(a, () => document.getElementById('statusText').textContent.startsWith('1')))

  await addStore(a, 'Costco'); await addItem(a, 'Costco', 'Milk'); await addItem(a, 'Costco', 'Eggs')
  await addStore(a, 'Trader Joe\'s'); await addItem(a, 'Trader Joe\'s', 'Bananas')
  check('B sees stores and items A added', await waitFor(b, () => ['Costco','Milk','Eggs','Trader Joe','Bananas'].every(t => document.getElementById('groceryBoard').textContent.includes(t))))

  // B checks off Milk and renames Eggs
  await storeSection(b, 'Costco').locator('.g-item', {hasText: 'Milk'}).locator('input[type=checkbox]').check()
  await storeSection(b, 'Costco').locator('.g-item-name', {hasText: 'Eggs'}).click()
  await b.fill('#g-editing', 'Eggs (2 dozen)'); await b.press('#g-editing', 'Enter')
  check('A sees Milk checked off', await waitFor(a, () => [...document.querySelectorAll('.g-item.done')].some(e => e.textContent.includes('Milk'))))
  check('A sees Eggs renamed', await waitFor(a, hasText, 'Eggs (2 dozen)'))

  // B adds an item while A is typing a new item: A's half-typed text must survive
  const aInput = storeSection(a, 'Trader Joe\'s').locator('.g-add input')
  await aInput.fill('Coff')
  await addItem(b, 'Trader Joe\'s', 'Bread')
  await waitFor(a, hasText, 'Bread')
  check('A\'s half-typed text survives an incoming change', (await storeSection(a, 'Trader Joe\'s').locator('.g-add input').inputValue()) === 'Coff')
  await storeSection(a, 'Trader Joe\'s').locator('.g-add input').fill('')

  // Both rename the same store at almost the same time: everyone ends up with the same name
  await storeSection(a, 'Trader Joe').locator('.g-store-name').click()
  await storeSection(b, 'Trader Joe').locator('.g-store-name').click()
  await a.fill('#g-editing', 'TJ (Darcy)'); await b.fill('#g-editing', 'TJ (Grandma)')
  await Promise.all([a.press('#g-editing', 'Enter'), b.press('#g-editing', 'Enter')])
  await a.waitForTimeout(2500)
  const names = async p => (await p.locator('.g-store-name').allTextContents()).join('|')
  check('Simultaneous renames end up the same on both devices', (await names(a)) === (await names(b)))

  // A deletes the item list via "Clear checked"
  await storeSection(a, 'Costco').locator('.g-clear').click()
  check('B sees checked item cleared', await waitFor(b, () => !document.getElementById('groceryBoard').textContent.includes('Milk')))

  await b.screenshot({path: 'grocery-phone.png'})

  // A goes offline; C joins later and gets everything from B
  await a.context().close()
  const c = await mk('Uncle Pat')
  check('C (joined after Darcy left) gets the full list', await waitFor(c, () => ['Costco','Eggs (2 dozen)','Bananas','Bread'].every(t => document.getElementById('groceryBoard').textContent.includes(t))))

  // Offline edit: C reloads, list persists; C deletes a store and B sees it
  await c.reload(); await c.click('#tabGrocery')
  check('C keeps the list after reload', await waitFor(c, hasText, 'Bananas'))
  await storeSection(c, 'Costco').locator('.g-store-head .g-x').click()
  check('B sees store deleted by C', await waitFor(b, () => !document.getElementById('groceryBoard').textContent.includes('Costco')))

  // Chat still works alongside
  await c.click('#tabChat'); await c.fill('#input', 'Got the bread'); await c.click('#sendBtn')
  check('Chat still works next to the board', await waitFor(b, () => document.getElementById('messages').textContent.includes('Got the bread')))

  await browser.close()
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})()
