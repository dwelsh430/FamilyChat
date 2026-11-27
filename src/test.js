const {chromium} = require('playwright');
const URL='http://localhost:8765/chat/?relay=ws://localhost:7447#code=test-otter-maple-4821';
(async () => {
  const browser = await chromium.launch({args: ['--disable-features=WebRtcHideLocalIpsWithMdns']});
  const mk = async (name, vp) => {
    const ctx = await browser.newContext(vp ? {viewport: vp, deviceScaleFactor: 2} : {});
    const p = await ctx.newPage();
    p.on('pageerror', e => console.log(name, 'pageerror:', e.message));
    await p.goto(URL); await p.fill('#nameInput', name); await p.click('#joinBtn');
    return p;
  };
  const waitOnline = async (p, n) => { for (let i=0;i<40;i++){ const t=await p.textContent('#statusText'); if (t.startsWith(n)) return t; await p.waitForTimeout(500);} return await p.textContent('#statusText') };
  const a = await mk('Darcy');
  const b = await mk('Grandma', {width: 390, height: 760});
  console.log('a:', await waitOnline(a,'1'));
  await a.fill('#input','Dinner at our place Sunday?'); await a.click('#sendBtn');
  await b.waitForTimeout(1500);
  await a.context().close();   // Darcy goes offline
  await b.waitForTimeout(1000);
  const c = await mk('Uncle Pat');
  console.log('c:', await waitOnline(c,'1'));
  await c.waitForTimeout(1500);
  console.log('C (joined after Darcy left) sees Darcy msg:', (await c.textContent('#messages')).includes('Dinner at our place'));
  await c.fill('#input','Count me in!'); await c.click('#sendBtn');
  await b.waitForTimeout(1500);
  await c.reload(); await c.waitForTimeout(800);
  console.log('C after reload still has history:', (await c.textContent('#messages')).includes('Count me in'));
  await b.click('#menuBtn'); await b.waitForTimeout(300); await b.screenshot({path:'menu.png'}); await b.click('#closeMenu');
  await b.screenshot({path:'phone.png'});
  await browser.close();
})();
