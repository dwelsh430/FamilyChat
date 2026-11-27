
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

// Merge incoming messages; returns how many were new.
function merge(list) {
  let added = 0
  for (const m of list || []) {
    if (valid(m) && !messages.has(m.id)) {
      messages.set(m.id, {id: m.id, name: m.name, text: m.text, ts: m.ts})
      added++
    }
  }
  if (added) { saveMessages(); render() }
  return added
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
    const mine = m.id.startsWith(myDeviceId + ':')
    el.className = 'msg' + (mine ? ' mine' : '')
    if (!mine) {
      const who = document.createElement('div')
      who.className = 'who'; who.textContent = m.name
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

async function connect() {
  if (room) { room.leave(); room = null }
  peerNames.clear()
  loadMessages(); render()
  // Room name is derived from the code, so the code itself is never published.
  const roomId = (await sha256('room:' + familyCode)).slice(0, 32)
  // For testing only: ?relay=ws://host lets us point at a private relay.
  const testRelay = new URLSearchParams(location.search).get('relay')
  const config = {appId: APP_ID, password: familyCode}
  if (testRelay) config.relayConfig = {urls: [testRelay]}
  room = joinRoom(config, roomId)

  const helloA = room.makeAction('hello')   // {name, ids}
  const msgsA = room.makeAction('msgs')     // [messages]
  const wantA = room.makeAction('want')     // [ids I'm missing]
  const sendHello = (data, target) => helloA.send(data, target ? {target} : undefined)
  const sendMsgs = (data, target) => msgsA.send(data, target ? {target} : undefined)
  actions = {sendHello, sendMsgs}

  const hello = target => sendHello({name: myName, ids: [...messages.keys()]}, target)

  room.onPeerJoin = peerId => { hello(peerId); renderStatus() }
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
  }
  wantA.onMessage = (ids, {peerId}) => {
    if (!Array.isArray(ids)) return
    const found = ids.map(id => messages.get(id)).filter(Boolean)
    if (found.length) sendMsgs(found, peerId)
  }
  msgsA.onMessage = list => {
    if (!Array.isArray(list)) return
    const added = merge(list)
    if (added && document.hidden) bumpUnread(added)
  }
  renderStatus()
}

function sendMessage() {
  const text = $('input').value.trim()
  if (!text || !room) return
  const m = {id: myDeviceId + ':' + crypto.randomUUID(), name: myName, text: text.slice(0, 5000), ts: Date.now()}
  merge([m])
  actions.sendMsgs([m])
  $('input').value = ''
  autoGrow()
  $('messages').scrollTop = $('messages').scrollHeight
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
  renderStatus()
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
  actions?.sendHello({name: myName, ids: [...messages.keys()]})
  renderStatus(); $('menuInfo').textContent = `You are "${myName}". Family code: ${familyCode}`
}
$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify([...messages.values()], null, 2)], {type: 'application/json'})
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'family-chat-backup-' + new Date().toISOString().slice(0, 10) + '.json'
  a.click()
}
$('leaveBtn').onclick = () => { $('menu').classList.remove('show'); room?.leave(); room = null; renderStatus(); showSetup() }

// ---------- start ----------
const linkCode = codeFromLink()
if (myName && familyCode && (!linkCode || linkCode === familyCode)) {
  history.replaceState(null, '', location.pathname + location.search)
  connect()
} else {
  render(); renderStatus(); showSetup()
}
