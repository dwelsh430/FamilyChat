// Automated test of family-made boards with simulated family members.
// Needs: node relay.js (local test relay) and a web server on :8765 at the repo root.
// Optional: OLD_URL=http://host/ (the previous version of the page) to test mixing versions.
const {chromium} = require('playwright')
const CODE = 'test-boards-' + Date.now()
const URL = 'http://localhost:8765/?relay=ws://localhost:7447#code=' + CODE
const OLD_URL = process.env.OLD_URL ? process.env.OLD_URL + '?relay=ws://localhost:7447#code=' + CODE : null
let failures = 0
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++ }

;(async () => {
  const browser = await chromium.launch({args: ['--disable-features=WebRtcHideLocalIpsWithMdns']})
  let nextPrompt = ''
  const mk = async (name, url = URL, vp) => {
    const ctx = await browser.newContext(vp ? {viewport: vp, deviceScaleFactor: 2} : {})
    const p = await ctx.newPage()
    p.on('pageerror', e => { console.log(name, 'pageerror:', e.message); failures++ })
    p.on('dialog', d => d.type() === 'prompt' ? d.accept(nextPrompt) : d.accept())
    await p.goto(url); await p.fill('#nameInput', name); await p.click('#joinBtn')
    return p
  }
  const waitFor = async (p, fn, arg) => { try { await p.waitForFunction(fn, arg, {timeout: 15000}); return true } catch { return false } }
  const tabsText = () => document.querySelector('nav.tabs').textContent
  const viewHas = t => (document.getElementById('boardView') || document.getElementById('groceryBoard')).textContent.includes(t)
  const listSection = (p, name) => p.locator('.g-store', {has: p.locator('.g-store-name', {hasText: name})})
  const addList = async (p, name) => { await p.fill('#g-new-list', name); await p.press('#g-new-list', 'Enter') }
  const addItem = async (p, list, item) => { const i = listSection(p, list).locator('.g-add input'); await i.fill(item); await i.press('Enter') }
  const tab = (p, name) => p.locator('nav.tabs button', {hasText: name})

  const a = await mk('Darcy')
  const b = await mk('Dad', URL, {width: 390, height: 760})
  check('A and B connect', await waitFor(a, () => document.getElementById('statusText').textContent.startsWith('1')))
  check('Grocery Store tab is there by default', await waitFor(a, () => document.querySelector('nav.tabs').textContent.includes('Grocery Store')))

  // A makes a new board with two lists
  nextPrompt = "Dad's Xmas Wish List"
  await a.click('#tab-new')
  check('New board opens right away', await waitFor(a, () => !!document.querySelector('.b-name')))
  await addList(a, 'Books'); await addItem(a, 'Books', 'History of Rome'); await addItem(a, 'Books', 'Cookbook')
  await addList(a, 'Tools')
  if (!await waitFor(a, viewHas, 'Tools')) console.log('DEBUG view:', await a.textContent('#boardView'), 'tabs:', await a.textContent('nav.tabs'))
  await addItem(a, 'Tools', 'Cordless drill')
  check('B sees the new board tab', await waitFor(b, tabsText, null) && await waitFor(b, () => document.querySelector('nav.tabs').textContent.includes("Dad's Xmas Wish List")))
  check('B sees a dot on the new board tab', await waitFor(b, () => [...document.querySelectorAll('nav.tabs .has-new')].some(e => e.textContent.includes('Xmas'))))
  await tab(b, 'Xmas').click()
  check('B sees lists and items', await waitFor(b, () => ['Books','History of Rome','Cookbook','Tools','Cordless drill'].every(t => document.getElementById('boardView').textContent.includes(t))))
  check('Dot clears once B opens the board', !(await tab(b, 'Xmas').getAttribute('class') || '').includes('has-new'))

  // B checks off an item, renames the board; A sees both
  await listSection(b, 'Tools').locator('.g-item', {hasText: 'Cordless drill'}).locator('input[type=checkbox]').check()
  await b.click('.b-name'); await b.fill('#g-editing', 'Xmas Wish Lists'); await b.press('#g-editing', 'Enter')
  check('A sees board renamed', await waitFor(a, () => document.querySelector('nav.tabs').textContent.includes('Xmas Wish Lists')))
  check('A sees item checked off', await waitFor(a, () => [...document.querySelectorAll('.g-item.done')].some(e => e.textContent.includes('Cordless drill'))))

  // Grocery board still separate
  await tab(a, 'Grocery Store').click()
  check('Grocery Store does not show the wish list', !(await a.textContent('#boardView')).includes('History of Rome'))
  await addList(a, 'Costco'); await addItem(a, 'Costco', 'Milk')
  await tab(b, 'Grocery Store').click()
  check('B sees grocery item', await waitFor(b, viewHas, 'Milk'))

  await tab(b, 'Xmas').click()
  await b.screenshot({path: 'boards-phone.png'})

  // A leaves; C joins and gets the boards from B
  await a.context().close()
  const c = await mk('Grandma')
  await waitFor(c, () => document.getElementById('statusText').textContent.startsWith('1'))
  check('C (joined after Darcy left) gets the board', await waitFor(c, () => document.querySelector('nav.tabs').textContent.includes('Xmas Wish Lists')))
  await tab(c, 'Xmas').click()
  check('C gets its items', await waitFor(c, viewHas, 'Cookbook'))
  await c.reload()
  check('C reopens on the same board after reload', await waitFor(c, () => !!document.querySelector('.b-name') && document.getElementById('boardView').textContent.includes('Cookbook')))

  // C deletes the board while B is looking at it: B goes back to the Grocery Store
  await c.click('.b-head .g-x')
  check('B sees board gone and lands on Grocery Store', await waitFor(b, () => !document.querySelector('nav.tabs').textContent.includes('Xmas') && document.getElementById('tab-grocery').getAttribute('aria-selected') === 'true'))

  if (OLD_URL) {
    // Someone still on the previous version of the page joins
    const old = await mk('Uncle Pat (old version)', OLD_URL)
    await old.click('#tabGrocery')
    check('Old version still gets the Grocery Store', await waitFor(old, viewHas, 'Milk'))
    nextPrompt = 'Mom wish list'
    await c.click('#tab-new'); await addList(c, 'Jewelry')
    await old.waitForTimeout(2000)
    check('Old version is not confused by new boards', !(await old.textContent('#groceryBoard')).includes('Jewelry'))
    await old.locator('.g-store', {has: old.locator('.g-store-name', {hasText: 'Costco'})}).locator('.g-add input').fill('Bread')
    await old.locator('.g-store', {has: old.locator('.g-store-name', {hasText: 'Costco'})}).locator('.g-add input').press('Enter')
    await tab(b, 'Grocery Store').click()
    check('Grocery edit from old version reaches new version', await waitFor(b, viewHas, 'Bread'))
  }

  await browser.close()
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})()
