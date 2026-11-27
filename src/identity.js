// ---------------------------------------------------------------------------
// Identity: who wrote what.
//
// * Every device makes its own private signing key the first time it opens the
//   app. The private key never leaves the device (the browser stores it so it
//   can't even be read back out).
// * A "user" (like Darcy) is the first device's key. Its user ID is a
//   fingerprint of that key.
// * More devices join the same user by "linking": an existing device signs a
//   note saying "this new key is also Darcy". A device can also sign a note
//   removing another device (for a lost phone).
// * Every chat message is signed by the device that wrote it. Everyone checks
//   the signature, and checks that the key really belongs to that user.
//
// These device notes are shared between family members like chat messages.
// ---------------------------------------------------------------------------

const enc = new TextEncoder()
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = s => {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='
  return Uint8Array.from(atob(s), c => c.charCodeAt(0))
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const ALG = {name: 'ECDSA', namedCurve: 'P-256'}
const SIGN = {name: 'ECDSA', hash: 'SHA-256'}

export async function fingerprint(pk) {
  return hex(await crypto.subtle.digest('SHA-256', unb64(pk))).slice(0, 20)
}

const keyCache = new Map()
async function importPk(pk) {
  if (!keyCache.has(pk)) keyCache.set(pk, crypto.subtle.importKey('raw', unb64(pk), ALG, false, ['verify']))
  return keyCache.get(pk)
}

export async function verifySig(pk, payload, sig) {
  try {
    if (typeof pk !== 'string' || pk.length > 120 || typeof sig !== 'string' || sig.length > 120) return false
    return await crypto.subtle.verify(SIGN, await importPk(pk), unb64(sig), enc.encode(JSON.stringify(payload)))
  } catch { return false }
}

// What exactly gets signed for each kind of record.
export const msgPayload = m => ['msg', m.id, m.ts, m.name, m.text, m.uid]
const devPayload = r => ['dev', r.id, r.ts, r.t, r.uid, r.pk, r.label || '', r.spk]

// ---------------- this device's key ----------------
// Kept in IndexedDB as a non-exportable key. If IndexedDB is unavailable we
// fall back to an exportable key in localStorage (less protected, still works).
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('familychat', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('keys')
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
}
async function idbGet(k) {
  const db = await idb()
  return new Promise((res, rej) => { const q = db.transaction('keys').objectStore('keys').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
}
async function idbPut(k, v) {
  const db = await idb()
  return new Promise((res, rej) => { const t = db.transaction('keys', 'readwrite'); t.objectStore('keys').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error) })
}
async function idbDel(k) {
  const db = await idb()
  return new Promise(res => { const t = db.transaction('keys', 'readwrite'); t.objectStore('keys').delete(k); t.oncomplete = () => res(); t.onerror = () => res() })
}

export async function loadDeviceKey(store, {fresh = false} = {}) {
  if (!fresh) {
    try {
      const k = await idbGet('device')
      if (k?.privateKey && k?.pk) return k
    } catch {}
    const j = store.get('fc:devkey', null)
    if (j?.jwk && j?.pk) {
      try {
        const privateKey = await crypto.subtle.importKey('jwk', j.jwk, ALG, false, ['sign'])
        return {privateKey, pk: j.pk}
      } catch {}
    }
  }
  try {
    const pair = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify'])
    const pk = b64(await crypto.subtle.exportKey('raw', pair.publicKey))
    const k = {privateKey: pair.privateKey, pk}
    await idbPut('device', k)
    if ((await idbGet('device'))?.pk !== pk) throw new Error('not saved')
    store.set('fc:devkey', null)
    return k
  } catch {
    const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
    const pk = b64(await crypto.subtle.exportKey('raw', pair.publicKey))
    store.set('fc:devkey', {jwk: await crypto.subtle.exportKey('jwk', pair.privateKey), pk})
    try { await idbDel('device') } catch {}
    return {privateKey: pair.privateKey, pk}
  }
}

export async function signWith(key, payload) {
  return b64(await crypto.subtle.sign(SIGN, key.privateKey, enc.encode(JSON.stringify(payload))))
}

export function deviceLabel() {
  const ua = navigator.userAgent
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac/.test(ua) ? (navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac') : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser'
  return `${os} ${br}`
}

// ---------------- device notes ----------------
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max

export function validDevRecord(r) {
  return r && typeof r === 'object' && (r.t === 'dev.add' || r.t === 'dev.remove') &&
    isStr(r.id, 80) && typeof r.ts === 'number' && isFinite(r.ts) &&
    isStr(r.uid, 40) && isStr(r.pk, 120) && isStr(r.spk, 120) && isStr(r.sig, 120) &&
    (r.label === undefined || (typeof r.label === 'string' && r.label.length <= 40))
}
const cleanDev = r => {
  const c = {id: r.id, ts: r.ts, t: r.t, uid: r.uid, pk: r.pk, spk: r.spk, sig: r.sig}
  if (r.label) c.label = r.label
  return c
}
export const verifyDevRecord = r => validDevRecord(r) && verifySig(r.spk, devPayload(r), r.sig)

export async function makeDevRecord(key, {t, uid, pk, label}) {
  const r = {id: crypto.randomUUID(), ts: Date.now(), t, uid, pk, spk: key.pk}
  if (label) r.label = label.slice(0, 40)
  r.sig = await signWith(key, devPayload(r))
  return r
}

// Works out, from all device notes, which keys belong to which user and when.
// Rules: a user's first key (its fingerprint is the user ID) belongs to it
// from the start. A key added by one of the user's current keys belongs to it
// from that moment. A key removed by one of the user's current keys stops
// belonging to it from that moment.
export async function computeDevices(records) {
  const byUser = new Map()   // uid -> Map(pk -> {pk, label, added, removed})
  const sorted = [...records].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  const fp = new Map()
  for (const r of sorted) if (!fp.has(r.pk)) fp.set(r.pk, await fingerprint(r.pk))
  for (const r of sorted) if (!fp.has(r.spk)) fp.set(r.spk, await fingerprint(r.spk))
  const activeAt = (uid, pk, ts) => {
    const d = byUser.get(uid)?.get(pk)
    if (d) return d.added <= ts && !(d.removed <= ts)
    return fp.get(pk) === uid   // the user's first key, not yet seen in a note
  }
  for (const r of sorted) {
    if (!byUser.has(r.uid)) byUser.set(r.uid, new Map())
    const devs = byUser.get(r.uid)
    if (!activeAt(r.uid, r.spk, r.ts)) continue   // signer isn't (or is no longer) this user's device
    if (fp.get(r.spk) === r.uid && !devs.has(r.spk)) devs.set(r.spk, {pk: r.spk, added: -Infinity, removed: undefined, label: undefined})
    if (r.t === 'dev.add') {
      const d = devs.get(r.pk)
      if (!d) devs.set(r.pk, {pk: r.pk, label: r.label, added: fp.get(r.pk) === r.uid ? -Infinity : r.ts, removed: undefined})
      else if (r.label && !d.label) d.label = r.label
    } else if (r.t === 'dev.remove') {
      const d = devs.get(r.pk) || (fp.get(r.pk) === r.uid ? {pk: r.pk, added: -Infinity} : null)
      if (d && d.removed === undefined) { d.removed = r.ts; devs.set(r.pk, d) }
    }
  }
  return {
    // Did this key belong to this user at this time?
    keyOk: (uid, pk, ts) => { const d = byUser.get(uid)?.get(pk); return d ? d.added <= ts && !(d.removed <= ts) : null },
    devicesOf: uid => [...(byUser.get(uid)?.values() || [])],
    isRemoved: (uid, pk) => byUser.get(uid)?.get(pk)?.removed !== undefined
  }
}

export function createIdentityStore({store, storageKey}) {
  let recs = new Map()
  return {
    load() { recs = new Map(); for (const r of store.get(storageKey(), [])) if (validDevRecord(r)) recs.set(r.id, cleanDev(r)) },
    async merge(list) {
      let added = 0
      for (const r of list || []) {
        if (!validDevRecord(r) || recs.has(r.id)) continue
        if (!(await verifyDevRecord(r))) continue
        recs.set(r.id, cleanDev(r)); added++
      }
      if (added) store.set(storageKey(), [...recs.values()])
      return added
    },
    ids: () => [...recs.keys()],
    all: () => [...recs.values()],
    forUser: uid => [...recs.values()].filter(r => r.uid === uid),
    missingFor: theirs => [...recs.values()].filter(r => !theirs.has(r.id))
  }
}

// ---------------- linking a new device ----------------
// The link shown on the existing device carries a one-time secret. The new
// device proves it saw the link (an HMAC with the secret), and the existing
// device proves the same back, so nobody else in the family room can butt in.
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', unb64(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify'])
}
export const newLinkSecret = () => b64(crypto.getRandomValues(new Uint8Array(16)))
export async function linkTag(secret) { return hex(await crypto.subtle.digest('SHA-256', unb64(secret))).slice(0, 16) }
export async function linkMac(secret, ...parts) {
  return b64(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(JSON.stringify(parts))))
}
export async function linkMacOk(secret, mac, ...parts) {
  try { return await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64(mac), enc.encode(JSON.stringify(parts))) }
  catch { return false }
}
