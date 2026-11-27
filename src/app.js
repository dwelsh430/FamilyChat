
// ---------------------------------------------------------------------------
// How this works (plain version):
//  * Trystero finds the other family members' browsers using public Nostr
//    relays (a bit like a public bulletin board for "I'm here" notes). Those
//    notes are encrypted with the family code. Chat messages never go there.
//  * Once found, browsers talk directly over WebRTC (encrypted).
//  * Every device stores all messages locally. When two devices meet, they
//    compare what they have and fill in each other's gaps, so messages spread
//    even if the original sender is offline.
// ---------------------------------------------------------------------------
import {joinRoom} from 'trystero'
import {createBoards, GROCERY} from './boards.js'
import qrcode from 'qrcode-generator'
import {
  loadDeviceKey, signWith, verifySig, msgPayload, fingerprint, deviceLabel,
  createIdentityStore, computeDevices, makeDevRecord,
  newLinkSecret, linkTag, linkMac, linkMacOk
} from './identity.js'

const APP_ID = 'familychat-p2p-v1'
const $ = id => document.getElementById(id)

// ---------- small storage helpers (wrapped: storage can be blocked) ----------
const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v) }
    catch { return fallback }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
}

// ---------- state ----------
let myName = store.get('fc:name', '')
let familyCode = store.get('fc:code', '')
let room = null
let actions = null
let messages = new Map()      // id -> {id, name, text, ts}
const peerNames = new Map()   // peerId -> name

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const msgKey = () => 'fc:msgs:' + familyCode

function loadMessages() {
  messages = new Map()
  for (const m of store.get(msgKey(), [])) if (valid(m)) messages.set(m.id, m)
}
function saveMessages() { store.set(msgKey(), [...messages.values()]) }

function valid(m) {
  return m && typeof m.id === 'string' && m.id.length <= 64 &&
    typeof m.name === 'string' && m.name.length <= 40 &&
    typeof m.text === 'string' && m.text.length <= 5000 &&
    typeof m.ts === 'number' && isFinite(m.ts)
}
const signed = m => typeof m.sig === 'string' && typeof m.pk === 'string' && typeof m.uid === 'string' && m.uid.length <= 40
const cleanMsg = m => {
  const c = {id: m.id, name: m.name, text: m.text, ts: m.ts}
  if (signed(m)) { c.uid = m.uid; c.pk = m.pk; c.sig = m.sig }
  return c
}

// Merge incoming messages; returns the ones that are brand new. Signed messages must
// carry a correct signature or they're thrown away. (Messages from older
// copies of the app have no signature: they're kept but marked "unverified".)
async function merge(list) {
  let added = 0
  const fresh = []
  for (const m of list || []) {
    if (!valid(m)) continue
    const have = messages.get(m.id)
    if (have && (signed(have) || !signed(m))) continue
    if (signed(m) && !(await verifySig(m.pk, msgPayload(m), m.sig))) continue
    if (!signed(m) && m.sig !== undefined) continue   // half a signature: not trustworthy
    messages.set(m.id, cleanMsg(m))
    added++
    if (!have) fresh.push(messages.get(m.id))
  }
  if (added) { saveMessages(); await refreshTrust() }
  return fresh
}

// ---------- rendering ----------
const fmtTime = ts => new Date(ts).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})
const fmtDay = ts => new Date(ts).toLocaleDateString([], {weekday: 'long', month: 'long', day: 'numeric'})

function render() {
  const box = $('messages')
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  const sorted = [...messages.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  box.replaceChildren()
  if (!sorted.length) {
    const e = document.createElement('div')
    e.className = 'empty'
    e.textContent = 'No messages yet. Say hello! Messages appear for others when they open the chat.'
    box.append(e)
    return
  }
  let lastDay = ''
  for (const m of sorted) {
    const day = fmtDay(m.ts)
    if (day !== lastDay) {
      const d = document.createElement('div')
      d.className = 'day'; d.textContent = day
      box.append(d); lastDay = day
    }
    const el = document.createElement('div')
    const trust = trustOf(m)
    const mine = trust === 'ok' ? m.uid === myUid : m.id.startsWith(myDeviceId + ':')
    el.className = 'msg' + (mine ? ' mine' : '')
    if (!mine || trust !== 'ok') {
      const who = document.createElement('div')
      who.className = 'who'
      who.textContent = mine ? 'You' : m.name
      if (trust === 'ok' && nameClash.get(m.name.toLowerCase())?.size > 1) {
        const tag = document.createElement('span')
        tag.className = 'uidtag'; tag.textContent = ' · ' + m.uid.slice(0, 4)
        tag.title = 'More than one person uses this name. This code tells them apart.'
        who.append(tag)
      }
      if (trust !== 'ok') {
        const warn = document.createElement('span')
        warn.className = 'unverified'
        warn.textContent = trust === 'removed' ? ' · from a removed device' : ' · unverified'
        warn.title = TRUST_HELP[trust]
        who.append(warn)
      }
      el.append(who)
    }
    const body = document.createElement('div')
    body.textContent = m.text
    const t = document.createElement('div')
    t.className = 'time'; t.textContent = fmtTime(m.ts)
    el.append(body, t)
    box.append(el)
  }
  if (nearBottom) box.scrollTop = box.scrollHeight
}

// ---------- who wrote what ----------
const TRUST_HELP = {
  unsigned: 'Sent from an older copy of the app, so it has no signature. It may be genuine, but the app can\'t prove who wrote it.',
  pending: 'Signed, but this device hasn\'t yet learned that the signing device belongs to this person. This usually clears up once more family members are online.',
  removed: 'Signed by a device its owner has since removed (for example a lost phone).',
  wrong: 'Signed by a device that does not belong to this person.'
}
let devices = null                 // which keys belong to which user
const pkFp = new Map()             // public key -> fingerprint
let nameClash = new Map()          // lowercase name -> set of user IDs using it

function trustOf(m) {
  if (!signed(m)) return 'unsigned'
  const ok = devices?.keyOk(m.uid, m.pk, m.ts)
  if (ok === true) return 'ok'
  if (ok === null || ok === undefined) {
    if (pkFp.get(m.pk) === m.uid && !devices?.isRemoved(m.uid, m.pk)) return 'ok'   // the person's first device
    return 'pending'
  }
  return devices.isRemoved(m.uid, m.pk) ? 'removed' : 'wrong'
}

async function refreshTrust() {
  devices = await computeDevices(ids.all())
  for (const m of messages.values()) if (signed(m) && !pkFp.has(m.pk)) pkFp.set(m.pk, await fingerprint(m.pk))
  nameClash = new Map()
  for (const m of messages.values()) {
    if (trustOf(m) !== 'ok') continue
    const k = m.name.toLowerCase()
    if (!nameClash.has(k)) nameClash.set(k, new Set())
    nameClash.get(k).add(m.uid)
  }
  await checkThisDevice()
  render()
  renderDevices()
}

function renderStatus() {
  const n = room ? Object.keys(room.getPeers()).length : 0
  $('status').classList.toggle('online', n > 0)
  $('statusText').textContent = !room ? 'Not connected'
    : n === 0 ? 'Waiting for family…'
    : n === 1 ? '1 other online' : n + ' others online'
  const list = $('peerList')
  list.replaceChildren()
  const me = document.createElement('li')
  me.textContent = (myName || 'You') + ' (you)'
  list.append(me)
  for (const id of Object.keys(room ? room.getPeers() : {})) {
    const li = document.createElement('li')
    li.textContent = peerNames.get(id) || 'Someone (connecting…)'
    list.append(li)
  }
}

function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('show')
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2200)
}

// ---------- networking ----------
// A stable id for this device, so "my" messages stay on the right after reloads.
let myDeviceId = store.get('fc:device', '')
if (!myDeviceId) { myDeviceId = crypto.randomUUID().slice(0, 8); store.set('fc:device', myDeviceId) }

// This device's signing key and the user it belongs to.
let devKey = null
let myUid = store.get('fc:uid', '')
const ids = createIdentityStore({store, storageKey: () => 'fc:ids:' + familyCode})

async function initIdentity() {
  devKey = await loadDeviceKey(store)
  const fp = await fingerprint(devKey.pk)
  const bundle = store.get('fc:mybundle', [])
  // A device that isn't linked to anyone is its own user.
  if (!myUid || (myUid !== fp && !bundle.some(r => r.t === 'dev.add' && r.pk === devKey.pk && r.uid === myUid))) {
    myUid = fp; store.set('fc:uid', myUid); store.set('fc:mybundle', [])
  }
}

// Make sure the notes about my own devices are in this family's list, and
// keep a copy of them so they come along if I switch family codes.
async function publishMyDevices() {
  const mine = store.get('fc:mybundle', [])
  if (!mine.some(r => r.t === 'dev.add' && r.pk === devKey.pk)) {
    if (myUid === await fingerprint(devKey.pk)) mine.push(await makeDevRecord(devKey, {t: 'dev.add', uid: myUid, pk: devKey.pk, label: deviceLabel()}))
  }
  await ids.merge(mine)
  saveMyBundle()
}
function saveMyBundle() { store.set('fc:mybundle', ids.forUser(myUid)) }

// If one of my other devices removed this one, start over as a new person.
let resetting = false
async function checkThisDevice() {
  if (resetting || !devices || !devKey || !devices.isRemoved(myUid, devKey.pk)) return
  resetting = true
  devKey = await loadDeviceKey(store, {fresh: true})
  myUid = await fingerprint(devKey.pk)
  store.set('fc:uid', myUid); store.set('fc:mybundle', [])
  await publishMyDevices()
  actions?.sendIds(ids.forUser(myUid))
  toast('This device was removed from your user, so it now has a new identity.')
  resetting = false
  await refreshTrust()
}

// Boards (Grocery Store + family-made boards) share small "changes" the same way chat shares messages.
let currentTab = 'chat'
const boards = createBoards({
  root: $('boardView'),
  tabs: $('boardTabs'),
  storageKey: () => 'fc:grocery:' + familyCode,   // name kept from v1 so existing lists stay
  getName: () => myName,
  deviceId: myDeviceId,
  store,
  getTab: () => currentTab,
  setTab: name => showTab(name),
  onLocalOps: list => {
    const g = list.filter(o => !o.bid), other = list.filter(o => o.bid)
    if (g.length) actions?.sendOps(g)
    if (other.length) actions?.sendBoardOps(other)
  }
})

async function connect() {
  if (room) { room.leave(); room = null }
  peerNames.clear()
  loadMessages(); boards.load(); ids.load()
  await publishMyDevices()
  await refreshTrust()
  showTab(savedTab())
  // Room name is derived from the code, so the code itself is never published.
  const roomId = (await sha256('room:' + familyCode)).slice(0, 32)
  // For testing only: ?relay=ws://host lets us point at a private relay.
  const testRelay = new URLSearchParams(location.search).get('relay')
  const config = {appId: APP_ID, password: familyCode}
  if (testRelay) config.relayConfig = {urls: [testRelay]}
  // Test-only hook (only when a private test relay is used) so automated tests can try forging messages.
  if (testRelay) window.__fcTest = {uid: () => myUid, pk: () => devKey.pk, send: list => actions.sendMsgs(list),
    sign: m => signWith(devKey, msgPayload(m))}
  room = joinRoom(config, roomId)

  const helloA = room.makeAction('hello')   // {name, ids}
  const msgsA = room.makeAction('msgs')     // [messages]
  const wantA = room.makeAction('want')     // [ids I'm missing]
  const opsA = room.makeAction('gops')      // [grocery changes]
  const sendOps = (data, target) => opsA.send(data, target ? {target} : undefined)
  const bopsA = room.makeAction('bops')     // [changes to family-made boards]
  const sendBoardOps = (data, target) => bopsA.send(data, target ? {target} : undefined)
  const sendHello = (data, target) => helloA.send(data, target ? {target} : undefined)
  const sendMsgs = (data, target) => msgsA.send(data, target ? {target} : undefined)
  const idsA = room.makeAction('ids')       // [notes about which devices belong to whom]
  const sendIds = (data, target) => idsA.send(data, target ? {target} : undefined)
  const linkA = room.makeAction('link')     // linking a new device (see identity.js)
  actions = {sendHello, sendMsgs, sendOps, sendBoardOps, sendIds, linkA}

  const helloData = () => ({name: myName, ids: [...messages.keys()], gids: boards.groceryIds(), bids: boards.boardIds(), iids: ids.ids()})
  actions.helloData = helloData
  const hello = target => sendHello(helloData(), target)

  room.onPeerJoin = peerId => { hello(peerId); renderStatus(); if (pendingLink) sendLinkRequest(peerId) }
  room.onPeerLeave = peerId => { peerNames.delete(peerId); renderStatus() }

  // When a peer says hello, learn their name, send what they lack, ask for what we lack.
  helloA.onMessage = (data, {peerId}) => {
    if (!data || typeof data !== 'object') return
    peerNames.set(peerId, String(data.name || 'Someone').slice(0, 40))
    renderStatus()
    const theirs = new Set(Array.isArray(data.ids) ? data.ids : [])
    const missingForThem = [...messages.values()].filter(m => !theirs.has(m.id))
    if (missingForThem.length) sendMsgs(missingForThem, peerId)
    const want = [...theirs].filter(id => typeof id === 'string' && !messages.has(id))
    if (want.length) wantA.send(want, {target: peerId})
    // Grocery changes: send the ones they don't have yet (they do the same for us).
    if (Array.isArray(data.gids)) {
      const lacking = boards.missingFor(new Set(data.gids), true)
      if (lacking.length) sendOps(lacking, peerId)
    }
    // Notes about devices (only peers running this version send iids).
    if (Array.isArray(data.iids)) {
      const lacking = ids.missingFor(new Set(data.iids))
      if (lacking.length) sendIds(lacking, peerId)
    }
    // Family-made boards (only peers running this version send bids).
    if (Array.isArray(data.bids)) {
      const lacking = boards.missingFor(new Set(data.bids), false)
      if (lacking.length) sendBoardOps(lacking, peerId)
    }
  }
  wantA.onMessage = (ids, {peerId}) => {
    if (!Array.isArray(ids)) return
    const found = ids.map(id => messages.get(id)).filter(Boolean)
    if (found.length) sendMsgs(found, peerId)
  }
  msgsA.onMessage = async list => {
    if (!Array.isArray(list)) return
    const fresh = await merge(list)
    const fromOthers = fresh.filter(m => !isMine(m))
    if (fromOthers.length && document.hidden) bumpUnread(fromOthers.length)
    notifyNew(fromOthers)
  }
  idsA.onMessage = async list => {
    if (!Array.isArray(list)) return
    if (await ids.merge(list)) { saveMyBundle(); await refreshTrust() }
  }
  linkA.onMessage = (data, {peerId}) => onLinkMessage(data, peerId)
  opsA.onMessage = list => {
    if (!Array.isArray(list)) return
    boards.merge(list)
  }
  bopsA.onMessage = list => { if (Array.isArray(list)) boards.merge(list) }
  renderStatus()
}

// ---------- tabs ----------
function showTab(name) {
  if (name !== 'chat' && !boards.exists(name)) name = 'chat'
  currentTab = name
  store.set('fc:tab', name)
  $('tabChat').setAttribute('aria-selected', String(name === 'chat'))
  document.body.dataset.tab = name === 'chat' ? 'chat' : 'board'
  boards.render()
  if (name === 'chat') $('messages').scrollTop = $('messages').scrollHeight
}
$('tabChat').onclick = () => showTab('chat')
function savedTab() {
  const t = store.get('fc:tab', 'chat')
  return t === 'grocery' ? 'board:' + GROCERY : t   // 'grocery' was the old name
}

async function sendMessage() {
  const text = $('input').value.trim()
  if (!text || !room || !myName || !devKey) return
  $('input').value = ''
  const m = {id: myDeviceId + ':' + crypto.randomUUID(), name: myName, text: text.slice(0, 5000), ts: Date.now(), uid: myUid, pk: devKey.pk}
  m.sig = await signWith(devKey, msgPayload(m))
  await merge([m])
  actions.sendMsgs([m])
  autoGrow()
  $('messages').scrollTop = $('messages').scrollHeight
}

function isMine(m) {
  return trustOf(m) === 'ok' ? m.uid === myUid : m.id.startsWith(myDeviceId + ':')
}

// ---------- browser notifications ----------
// Shown while the chat is open in the background (another tab, another app,
// phone screen off with the browser still running). Browsers can't wake a
// closed page without a push server, which this app deliberately doesn't have.
const notifySupported = 'Notification' in window
let swReg = null
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(r => { swReg = r }).catch(() => {})
}
const notifyOn = () => notifySupported && Notification.permission === 'granted' && store.get('fc:notify', false)

function renderNotifyBtn() {
  const b = $('notifyBtn')
  if (!notifySupported) {
    const ios = /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone
    b.textContent = ios ? 'Notifications: add to Home Screen first' : 'Notifications not supported here'
    b.disabled = !ios
    return
  }
  b.disabled = false
  b.textContent = notifyOn() ? 'Notifications: On' : Notification.permission === 'denied' ? 'Notifications: blocked' : 'Notifications: Off'
}

$('notifyBtn').onclick = async () => {
  if (!notifySupported) return toast('On iPhone/iPad: Share → Add to Home Screen, open it from there, then turn this on.')
  if (notifyOn()) { store.set('fc:notify', false); renderNotifyBtn(); return toast('Notifications off') }
  if (Notification.permission === 'denied') return toast('Notifications are blocked. Allow them for this site in your browser settings.')
  const p = await Notification.requestPermission()
  store.set('fc:notify', p === 'granted')
  renderNotifyBtn()
  toast(p === 'granted' ? 'Notifications on. You\'ll get them while the chat is open in the background.' : 'Notifications were not allowed')
}

async function notifyNew(list) {
  if (!list.length || !notifyOn() || (!document.hidden && document.hasFocus())) return
  const last = list[list.length - 1]
  const who = m => m.name + (trustOf(m) === 'ok' ? '' : ' (unverified)')
  const title = list.length === 1 ? who(last) : `${list.length} new messages`
  const body = list.length === 1 ? last.text.slice(0, 200) : list.slice(-3).map(m => `${who(m)}: ${m.text.slice(0, 80)}`).join('\n')
  const opts = {body, tag: 'familychat', renotify: true, icon: 'icon-192.png', badge: 'icon-192.png'}
  try {
    // Android needs notifications to come from the service worker.
    const reg = swReg || await navigator.serviceWorker?.getRegistration()
    if (reg?.showNotification) await reg.showNotification(title, opts)
    else { const n = new Notification(title, opts); n.onclick = () => { window.focus(); n.close() } }
  } catch {}
}

// ---------- unread badge in tab title ----------
let unread = 0
function bumpUnread(n) { unread += n; document.title = `(${unread}) Family Chat` }
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { unread = 0; document.title = 'Family Chat' }
})

// ---------- UI wiring ----------
function autoGrow() {
  const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'
}
$('input').addEventListener('input', autoGrow)
$('input').addEventListener('keydown', e => {
  // Enter sends on computers; Shift+Enter makes a new line. On phones use the Send button.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault(); sendMessage()
  }
})
$('sendBtn').onclick = sendMessage

function codeFromLink() {
  const m = location.hash.match(/code=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}

function randomCode() {
  const words = ['apple','maple','river','cedar','otter','pebble','sunny','harbor','meadow','robin','ember','willow','comet','juniper','acorn','breeze','canyon','clover','falcon','lantern']
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length]
  const num = 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000)
  return `${pick()}-${pick()}-${pick()}-${num}`
}

function showSetup() {
  $('nameInput').value = myName
  $('codeInput').value = codeFromLink() || familyCode
  $('setup').classList.add('show')
  setTimeout(() => ($('nameInput').value ? $('codeInput') : $('nameInput')).focus(), 50)
}

function showLinkSetup(code, secret) {
  $('setup').classList.add('show', 'linking')
  $('linkSetupStatus').textContent = 'Tap "Link this device", then keep the link screen open on your other device.'
  $('linkJoinBtn').onclick = async () => {
    familyCode = code; store.set('fc:code', familyCode)
    history.replaceState(null, '', location.pathname + location.search)
    pendingLink = secret
    $('linkJoinBtn').disabled = true
    $('linkSetupStatus').textContent = 'Looking for your other device…'
    await connect()
    sendLinkRequest()
  }
  $('linkCancelBtn').onclick = () => {
    pendingLink = null
    history.replaceState(null, '', location.pathname + location.search)
    $('setup').classList.remove('linking')
    if (myName && familyCode) { $('setup').classList.remove('show'); if (!room) connect() } else showSetup()
  }
}

$('genCode').onclick = () => { $('codeInput').value = randomCode() }
$('joinBtn').onclick = async () => {
  const name = $('nameInput').value.trim()
  const code = $('codeInput').value.trim()
  if (!name) return $('nameInput').focus()
  if (code.length < 6) { toast('Family code needs at least 6 characters'); return $('codeInput').focus() }
  myName = name; familyCode = code
  store.set('fc:name', myName); store.set('fc:code', familyCode)
  history.replaceState(null, '', location.pathname + location.search)  // keep code out of the address bar
  $('setup').classList.remove('show')
  await connect()
}

$('menuBtn').onclick = () => {
  $('menuInfo').textContent = `You are "${myName}". Family code: ${familyCode}`
  renderStatus(); renderDevices(); renderNotifyBtn()
  $('menu').classList.add('show')
}
$('closeMenu').onclick = () => $('menu').classList.remove('show')
$('menu').onclick = e => { if (e.target.id === 'menu') $('menu').classList.remove('show') }

$('inviteBtn').onclick = async () => {
  const link = location.origin + location.pathname + '#code=' + encodeURIComponent(familyCode)
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({title: 'Family Chat', text: 'Join our family chat', url: link})
    } else {
      await navigator.clipboard.writeText(link); toast('Invite link copied')
    }
  } catch { prompt('Copy this invite link:', link) }
}
$('renameBtn').onclick = () => {
  const n = (prompt('Your name:', myName) || '').trim()
  if (!n) return
  myName = n.slice(0, 40); store.set('fc:name', myName)
  if (actions) actions.sendHello(actions.helloData())
  renderStatus(); $('menuInfo').textContent = `You are "${myName}". Family code: ${familyCode}`
}
$('exportBtn').onclick = () => {
  const backup = {messages: [...messages.values()], boards: boards.all(), devices: ids.all()}
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type: 'application/json'})
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'family-chat-backup-' + new Date().toISOString().slice(0, 10) + '.json'
  a.click()
}
$('leaveBtn').onclick = () => { $('menu').classList.remove('show'); room?.leave(); room = null; renderStatus(); showSetup() }

// ---------- linking another device ----------
// On the device you already use: show a link / QR code with a one-time secret.
let activeLink = null   // {secret, tag, until}
function linkParam() {
  const m = location.hash.match(/link=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}
$('linkBtn').onclick = async () => {
  if (!room) return toast('Connect first')
  const secret = newLinkSecret()
  activeLink = {secret, tag: await linkTag(secret), until: Date.now() + 10 * 60 * 1000}
  const link = location.origin + location.pathname + '#code=' + encodeURIComponent(familyCode) + '&link=' + secret
  const qr = qrcode(0, 'M'); qr.addData(link); qr.make()
  $('linkQr').innerHTML = qr.createSvgTag({cellSize: 4, margin: 2, scalable: true})
  $('linkUrl').value = link
  $('linkStatus').textContent = 'Waiting for your other device… (this code works for 10 minutes)'
  $('menu').classList.remove('show')
  $('linkDialog').classList.add('show')
}
$('linkCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('linkUrl').value); toast('Link copied') }
  catch { $('linkUrl').select() }
}
$('linkClose').onclick = () => { activeLink = null; $('linkDialog').classList.remove('show') }

// On the new device: ask the room for the device holding the secret.
let pendingLink = null  // secret
async function sendLinkRequest(target) {
  if (!pendingLink || !actions) return
  actions.linkA.send({kind: 'req', tag: await linkTag(pendingLink), pk: devKey.pk, label: deviceLabel(),
    mac: await linkMac(pendingLink, 'req', devKey.pk)}, target ? {target} : undefined)
}

async function onLinkMessage(d, peerId) {
  if (!d || typeof d !== 'object') return
  // Existing device: a new device is asking to join my user.
  if (d.kind === 'req' && activeLink && Date.now() < activeLink.until && d.tag === activeLink.tag &&
      typeof d.pk === 'string' && d.pk.length <= 120 && await linkMacOk(activeLink.secret, d.mac, 'req', d.pk)) {
    const secret = activeLink.secret
    activeLink = null
    const label = typeof d.label === 'string' ? d.label.slice(0, 40) : 'New device'
    const rec = await makeDevRecord(devKey, {t: 'dev.add', uid: myUid, pk: d.pk, label})
    await ids.merge([rec]); saveMyBundle()
    actions.sendIds([rec])
    actions.linkA.send({kind: 'ok', uid: myUid, name: myName, recs: ids.forUser(myUid),
      mac: await linkMac(secret, 'ok', myUid, d.pk, myName)}, {target: peerId})
    $('linkStatus').textContent = `Linked ${label}. You can close this.`
    $('linkQr').replaceChildren()
    await refreshTrust()
    return
  }
  // New device: my other device said yes.
  if (d.kind === 'ok' && pendingLink && typeof d.uid === 'string' && typeof d.name === 'string' &&
      await linkMacOk(pendingLink, d.mac, 'ok', d.uid, devKey.pk, d.name)) {
    await ids.merge(Array.isArray(d.recs) ? d.recs : [])
    const check = await computeDevices(ids.all())
    if (check.keyOk(d.uid, devKey.pk, Date.now()) !== true) return toast('Linking failed. Try a new link.')
    pendingLink = null
    myUid = d.uid; myName = d.name.slice(0, 40)
    store.set('fc:uid', myUid); store.set('fc:name', myName)
    saveMyBundle()
    $('setup').classList.remove('show')
    actions.sendHello(actions.helloData())
    toast(`This device is now linked to ${myName}`)
    await refreshTrust()
    renderStatus()
  }
}

// ---------- my devices ----------
function renderDevices() {
  const list = $('deviceList')
  if (!list || !devices || !devKey) return
  list.replaceChildren()
  const mine = devices.devicesOf(myUid).filter(d => d.removed === undefined)
  if (!mine.some(d => d.pk === devKey.pk)) mine.unshift({pk: devKey.pk, label: deviceLabel()})
  for (const d of mine) {
    const li = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = (d.label || 'Device') + (d.pk === devKey.pk ? ' (this device)' : '')
    li.append(label)
    if (d.pk !== devKey.pk) {
      const b = document.createElement('button')
      b.className = 'small'; b.textContent = 'Remove'
      b.onclick = async () => {
        if (!confirm(`Remove "${d.label || 'this device'}" from your user? Messages it sends from now on will be marked as not from you.`)) return
        const rec = await makeDevRecord(devKey, {t: 'dev.remove', uid: myUid, pk: d.pk})
        await ids.merge([rec]); saveMyBundle()
        actions?.sendIds([rec])
        await refreshTrust()
        toast('Device removed. If it was lost, consider a new family code too.')
      }
      li.append(b)
    }
    list.append(li)
  }
  $('myId').textContent = 'Your user code: ' + myUid.slice(0, 4)
}

// ---------- start ----------
await initIdentity()
const linkCode = codeFromLink()
const linkSecret = linkParam()
if (linkSecret && linkCode) {
  showLinkSetup(linkCode, linkSecret)
} else if (myName && familyCode && (!linkCode || linkCode === familyCode)) {
  history.replaceState(null, '', location.pathname + location.search)
  connect()
} else {
  render(); renderStatus(); showSetup()
}
