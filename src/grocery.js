// ---------------------------------------------------------------------------
// Grocery Store board.
//
// Everyone can add, rename, check off and delete stores and items, even while
// offline. To make edits from different devices merge cleanly, we never send
// "the list". Each device instead records small *changes* ("add item milk to
// Costco", "check off milk") and shares those, just like chat messages. Every
// device replays all changes in time order to build the same list. If two
// people change the same thing, the later change wins.
// ---------------------------------------------------------------------------

const TYPES = new Set([
  'store.add', 'store.rename', 'store.delete',
  'item.add', 'item.rename', 'item.check', 'item.delete'
])
const MAX_NAME = 120

export function validOp(o) {
  return o && typeof o === 'object' &&
    typeof o.id === 'string' && o.id.length <= 80 &&
    typeof o.ts === 'number' && isFinite(o.ts) &&
    typeof o.by === 'string' && o.by.length <= 40 &&
    TYPES.has(o.t) &&
    typeof o.sid === 'string' && o.sid.length <= 80 &&
    (o.iid === undefined || (typeof o.iid === 'string' && o.iid.length <= 80)) &&
    (o.name === undefined || (typeof o.name === 'string' && o.name.length <= MAX_NAME)) &&
    (o.done === undefined || typeof o.done === 'boolean')
}

const clean = o => {
  const c = {id: o.id, ts: o.ts, by: o.by, t: o.t, sid: o.sid}
  if (o.iid !== undefined) c.iid = o.iid
  if (o.name !== undefined) c.name = o.name
  if (o.done !== undefined) c.done = o.done
  return c
}

// Replay all changes in order and return the current list of stores.
export function buildState(ops) {
  const sorted = [...ops].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  const stores = new Map()   // sid -> {id, name, created, deleted, items: Map}
  const getStore = sid => {
    if (!stores.has(sid)) stores.set(sid, {id: sid, name: '', created: 0, deleted: false, items: new Map()})
    return stores.get(sid)
  }
  for (const o of sorted) {
    const s = getStore(o.sid)
    switch (o.t) {
      case 'store.add': s.name = o.name || s.name; s.created = s.created || o.ts; s.by = s.by || o.by; break
      case 'store.rename': if (o.name) s.name = o.name; break
      case 'store.delete': s.deleted = true; break
      default: {
        if (!o.iid) break
        if (!s.items.has(o.iid)) s.items.set(o.iid, {id: o.iid, name: '', created: 0, done: false, deleted: false})
        const it = s.items.get(o.iid)
        if (o.t === 'item.add') { it.name = o.name || it.name; it.created = it.created || o.ts; it.by = it.by || o.by }
        else if (o.t === 'item.rename') { if (o.name) it.name = o.name }
        else if (o.t === 'item.check') { it.done = !!o.done; it.doneBy = o.by }
        else if (o.t === 'item.delete') it.deleted = true
      }
    }
  }
  return [...stores.values()]
    .filter(s => !s.deleted && s.created)
    .sort((a, b) => a.created - b.created)
    .map(s => ({
      ...s,
      items: [...s.items.values()]
        .filter(i => !i.deleted && i.created)
        .sort((a, b) => (a.done - b.done) || (a.created - b.created))
    }))
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
export function createGrocery({root, storageKey, getName, deviceId, onLocalOps, store}) {
  let ops = new Map()
  const editing = {key: null}   // which name is being edited, survives re-render
  let rendering = false

  const save = () => store.set(storageKey(), [...ops.values()])

  function load() {
    ops = new Map()
    for (const o of store.get(storageKey(), [])) if (validOp(o)) ops.set(o.id, clean(o))
    render()
  }

  function merge(list) {
    let added = 0
    for (const o of list || []) if (validOp(o) && !ops.has(o.id)) { ops.set(o.id, clean(o)); added++ }
    if (added) { save(); render() }
    return added
  }

  const newId = () => deviceId + ':' + crypto.randomUUID()

  function apply(...changes) {
    const now = Date.now()
    const made = changes.map((c, i) => clean({...c, id: newId(), ts: now + i * 0.001, by: getName()}))
    merge(made)
    onLocalOps(made)
  }

  // ---- small DOM helper ----
  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
      else if (v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v)
    }
    for (const k of kids) if (k != null) e.append(k)
    return e
  }

  // A name that turns into a text box when tapped.
  function editableName(key, value, cls, onSave) {
    if (editing.key === key) {
      const input = el('input', {class: 'g-edit', id: 'g-editing', value, maxlength: MAX_NAME, 'aria-label': 'Edit name'})
      let done = false
      const finish = commit => {
        if (done || rendering) return; done = true
        editing.key = null
        const v = input.value.trim()
        if (commit && v && v !== value) onSave(v)
        else render()
      }
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true) }
        if (e.key === 'Escape') finish(false)
      })
      input.addEventListener('blur', () => finish(true))
      setTimeout(() => { if (document.activeElement !== input) { input.focus(); input.select() } }, 0)
      return input
    }
    return el('button', {class: 'g-name ' + cls, title: 'Tap to rename',
      onclick: () => { editing.key = key; render() }}, value)
  }

  function addRow(placeholder, label, onAdd, id) {
    const input = el('input', {placeholder, maxlength: MAX_NAME, 'aria-label': placeholder, id})
    const submit = () => {
      const v = input.value.trim()
      if (!v) return input.focus()
      input.value = ''
      onAdd(v)
      // keep typing more items without re-tapping the box
      setTimeout(() => document.getElementById(id)?.focus(), 0)
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit() } })
    return el('div', {class: 'g-add'}, input, el('button', {class: 'primary', onclick: submit}, label))
  }

  function render() {
    // Don't wipe a box someone is typing in when a change arrives from family.
    const active = document.activeElement
    const keepId = active && root.contains(active) && active.id ? active.id : null
    const keepVal = keepId ? active.value : null

    const stores = buildState(ops.values())
    const kids = [addRow('New store, e.g. Costco', 'Add store',
      name => apply({t: 'store.add', sid: newId(), name}), 'g-new-store')]

    if (!stores.length) {
      kids.push(el('div', {class: 'empty'}, 'No stores yet. Add one above, then add items under it. Everyone in the family can edit this list.'))
    }

    for (const s of stores) {
      const left = s.items.filter(i => !i.done).length
      const doneCount = s.items.length - left
      const items = s.items.map(i => el('li', {class: 'g-item' + (i.done ? ' done' : '')},
        el('input', {type: 'checkbox', checked: i.done, 'aria-label': 'Got ' + i.name,
          onchange: e => apply({t: 'item.check', sid: s.id, iid: i.id, done: e.target.checked})}),
        editableName('i:' + i.id, i.name, 'g-item-name',
          name => apply({t: 'item.rename', sid: s.id, iid: i.id, name})),
        el('button', {class: 'g-x', 'aria-label': 'Delete ' + i.name, title: 'Delete item',
          onclick: () => apply({t: 'item.delete', sid: s.id, iid: i.id})}, '×')
      ))
      kids.push(el('section', {class: 'g-store'},
        el('div', {class: 'g-store-head'},
          editableName('s:' + s.id, s.name, 'g-store-name',
            name => apply({t: 'store.rename', sid: s.id, name})),
          el('span', {class: 'g-count'}, left ? `${left} to get` : s.items.length ? 'all done' : ''),
          el('button', {class: 'g-x', 'aria-label': 'Delete store ' + s.name, title: 'Delete store',
            onclick: () => {
              if (confirm(`Delete "${s.name}" and its ${s.items.length} item(s) for everyone?`))
                apply({t: 'store.delete', sid: s.id})
            }}, '×')
        ),
        items.length ? el('ul', {class: 'g-items'}, ...items) : null,
        addRow('Add an item', 'Add', name => apply({t: 'item.add', sid: s.id, iid: newId(), name}), 'g-new-' + s.id),
        doneCount ? el('button', {class: 'g-clear',
          onclick: () => apply(...s.items.filter(i => i.done).map(i => ({t: 'item.delete', sid: s.id, iid: i.id})))
        }, `Clear ${doneCount} checked item${doneCount > 1 ? 's' : ''}`) : null
      ))
    }
    rendering = true
    try { root.replaceChildren(...kids) } finally { rendering = false }

    if (keepId) {
      const again = document.getElementById(keepId)
      if (again) { again.value = keepVal; again.focus() }
    } else if (editing.key && !document.getElementById('g-editing')) {
      editing.key = null   // the thing being renamed was deleted by someone
    }
  }

  return {
    load, merge, render,
    ids: () => [...ops.keys()],
    has: id => ops.has(id),
    get: ids => ids.map(id => ops.get(id)).filter(Boolean),
    missingFor: theirIds => [...ops.values()].filter(o => !theirIds.has(o.id))
  }
}
