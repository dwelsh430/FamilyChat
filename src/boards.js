// ---------------------------------------------------------------------------
// Boards: the Grocery Store board plus any boards the family creates
// (like "Dad's Xmas Wish List"). A board holds lists, and a list holds items.
// For the Grocery Store, the lists are stores.
//
// Everyone can add, rename, check off and delete things, even while offline.
// To make edits from different devices merge cleanly, we never send "the
// board". Each device records small *changes* ("add item Milk to Costco",
// "check off Milk") and shares those, just like chat messages. Every device
// replays all changes in time order to build the same boards. If two people
// change the same thing, the later change wins.
//
// Changes to the Grocery Store carry no board id, exactly like the first
// version of the app, so older copies of the app keep working with it.
// Changes to other boards carry a board id and travel on their own channel,
// which older copies simply ignore.
// ---------------------------------------------------------------------------

export const GROCERY = 'grocery'
const TYPES = new Set([
  'board.add', 'board.rename', 'board.delete',
  'store.add', 'store.rename', 'store.delete',   // "store" = a list on a board
  'item.add', 'item.rename', 'item.check', 'item.delete'
])
const MAX_NAME = 120
const isStr = (v, max) => typeof v === 'string' && v.length <= max

export function validOp(o) {
  if (!o || typeof o !== 'object') return false
  if (!isStr(o.id, 80) || typeof o.ts !== 'number' || !isFinite(o.ts) || !isStr(o.by, 40) || !TYPES.has(o.t)) return false
  if (o.bid !== undefined && (!isStr(o.bid, 80) || o.bid === GROCERY)) return false
  if (o.t.startsWith('board.')) { if (o.bid === undefined) return false }
  else if (!isStr(o.sid, 80)) return false
  return (o.iid === undefined || isStr(o.iid, 80)) &&
    (o.name === undefined || isStr(o.name, MAX_NAME)) &&
    (o.done === undefined || typeof o.done === 'boolean')
}

const clean = o => {
  const c = {id: o.id, ts: o.ts, by: o.by, t: o.t}
  for (const k of ['bid', 'sid', 'iid', 'name', 'done']) if (o[k] !== undefined) c[k] = o[k]
  return c
}

export const boardOf = o => o.bid || GROCERY

// Replay all changes in order and return the boards, each with its lists and items.
export function buildState(ops) {
  const sorted = [...ops].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  const boards = new Map([[GROCERY, {id: GROCERY, name: 'Grocery Store', created: -1, deleted: false, fixed: true}]])
  const lists = new Map()   // sid -> {id, bid, name, created, deleted, items: Map}
  const getBoard = bid => {
    if (!boards.has(bid)) boards.set(bid, {id: bid, name: '', created: 0, deleted: false})
    return boards.get(bid)
  }
  for (const o of sorted) {
    if (o.t.startsWith('board.')) {
      const b = getBoard(o.bid)
      if (o.t === 'board.add') { b.name = o.name || b.name; b.created = b.created || o.ts; b.by = b.by || o.by }
      else if (o.t === 'board.rename') { if (o.name) b.name = o.name }
      else b.deleted = true
      continue
    }
    if (!lists.has(o.sid)) lists.set(o.sid, {id: o.sid, bid: boardOf(o), name: '', created: 0, deleted: false, items: new Map()})
    const s = lists.get(o.sid)
    switch (o.t) {
      case 'store.add': s.name = o.name || s.name; s.created = s.created || o.ts; break
      case 'store.rename': if (o.name) s.name = o.name; break
      case 'store.delete': s.deleted = true; break
      default: {
        if (!o.iid) break
        if (!s.items.has(o.iid)) s.items.set(o.iid, {id: o.iid, name: '', created: 0, done: false, deleted: false})
        const it = s.items.get(o.iid)
        if (o.t === 'item.add') { it.name = o.name || it.name; it.created = it.created || o.ts; it.by = it.by || o.by }
        else if (o.t === 'item.rename') { if (o.name) it.name = o.name }
        else if (o.t === 'item.check') it.done = !!o.done
        else if (o.t === 'item.delete') it.deleted = true
      }
    }
  }
  const out = [...boards.values()]
    .filter(b => !b.deleted && b.created)
    .sort((a, b) => a.created - b.created)
    .map(b => ({...b, lists: []}))
  const byId = new Map(out.map(b => [b.id, b]))
  for (const s of [...lists.values()].sort((a, b) => a.created - b.created)) {
    if (s.deleted || !s.created || !byId.has(s.bid)) continue
    byId.get(s.bid).lists.push({...s, items: [...s.items.values()]
      .filter(i => !i.deleted && i.created)
      .sort((a, b) => (a.done - b.done) || (a.created - b.created))})
  }
  return out
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
export function createBoards({root, tabs, storageKey, getName, deviceId, onLocalOps, store, getTab, setTab}) {
  let ops = new Map()
  let boards = buildState([])
  const changed = new Set()     // boards someone else changed since you last looked
  const editing = {key: null}   // which name is being edited, survives re-render
  let rendering = false

  const save = () => store.set(storageKey(), [...ops.values()])

  function load() {
    ops = new Map()
    for (const o of store.get(storageKey(), [])) if (validOp(o)) ops.set(o.id, clean(o))
    changed.clear()
    render()
  }

  function merge(list, fromPeer) {
    let added = 0
    for (const o of list || []) {
      if (validOp(o) && !ops.has(o.id)) {
        ops.set(o.id, clean(o)); added++
        if (fromPeer && 'board:' + boardOf(o) !== getTab()) changed.add(boardOf(o))
      }
    }
    if (added) { save(); render() }
    return added
  }

  const newId = () => deviceId + ':' + crypto.randomUUID()

  function apply(...changes) {
    const now = Date.now()
    const made = changes.map((c, i) => {
      const o = {...c, id: newId(), ts: now + i * 0.001, by: getName()}
      if (o.bid === GROCERY) delete o.bid
      return clean(o)
    })
    merge(made, false)
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
      // keep typing more without re-tapping the box (unless you've moved on)
      setTimeout(() => {
        const a = document.activeElement
        if (!a || a === document.body || a.id === id) document.getElementById(id)?.focus()
      }, 0)
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit() } })
    return el('div', {class: 'g-add'}, input, el('button', {class: 'primary', onclick: submit}, label))
  }

  function newBoard() {
    const name = (prompt('Name the new board (for example "Dad\'s Xmas Wish List"):') || '').trim().slice(0, MAX_NAME)
    if (!name) return
    const bid = newId()
    apply({t: 'board.add', bid, name})
    setTab('board:' + bid)
  }

  function renderTabs() {
    const current = getTab()
    const btns = boards.map(b => {
      const tab = 'board:' + b.id
      return el('button', {role: 'tab', id: 'tab-' + (b.id === GROCERY ? GROCERY : 'b' + b.id.replace(/[^a-zA-Z0-9_-]/g, '')),
        'aria-selected': String(current === tab), class: changed.has(b.id) ? 'has-new' : '',
        onclick: () => setTab(tab)}, b.name || 'Untitled')
    })
    btns.push(el('button', {class: 'tab-new', id: 'tab-new', title: 'Make a new board', onclick: newBoard}, '+ New board'))
    tabs.replaceChildren(...btns)
    tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest', inline: 'nearest'})
  }

  function renderBoard(b) {
    const grocery = b.id === GROCERY
    const kids = []
    if (!grocery) {
      kids.push(el('div', {class: 'b-head'},
        editableName('b:' + b.id, b.name, 'b-name', name => apply({t: 'board.rename', bid: b.id, name})),
        el('button', {class: 'g-x', 'aria-label': 'Delete board ' + b.name, title: 'Delete board',
          onclick: () => {
            if (confirm(`Delete the board "${b.name}" and everything on it, for everyone?`)) {
              apply({t: 'board.delete', bid: b.id})
              setTab('board:' + GROCERY)
            }
          }}, '×')))
    }
    kids.push(addRow(grocery ? 'New store, e.g. Costco' : 'New list, e.g. Gift ideas',
      grocery ? 'Add store' : 'Add list',
      name => apply({t: 'store.add', bid: b.id, sid: newId(), name}), 'g-new-list'))

    if (!b.lists.length) {
      kids.push(el('div', {class: 'empty'}, grocery
        ? 'No stores yet. Add one above, then add items under it. Everyone in the family can edit this list.'
        : 'No lists yet. Add one above, then add items to it. Everyone in the family can edit this board.'))
    }

    for (const s of b.lists) {
      const left = s.items.filter(i => !i.done).length
      const doneCount = s.items.length - left
      const items = s.items.map(i => el('li', {class: 'g-item' + (i.done ? ' done' : '')},
        el('input', {type: 'checkbox', checked: i.done, 'aria-label': 'Done: ' + i.name,
          onchange: e => apply({t: 'item.check', bid: b.id, sid: s.id, iid: i.id, done: e.target.checked})}),
        editableName('i:' + i.id, i.name, 'g-item-name',
          name => apply({t: 'item.rename', bid: b.id, sid: s.id, iid: i.id, name})),
        el('button', {class: 'g-x', 'aria-label': 'Delete ' + i.name, title: 'Delete item',
          onclick: () => apply({t: 'item.delete', bid: b.id, sid: s.id, iid: i.id})}, '×')
      ))
      kids.push(el('section', {class: 'g-store'},
        el('div', {class: 'g-store-head'},
          editableName('s:' + s.id, s.name, 'g-store-name',
            name => apply({t: 'store.rename', bid: b.id, sid: s.id, name})),
          el('span', {class: 'g-count'}, left ? (grocery ? `${left} to get` : `${left} left`) : s.items.length ? 'all done' : ''),
          el('button', {class: 'g-x', 'aria-label': 'Delete ' + s.name, title: grocery ? 'Delete store' : 'Delete list',
            onclick: () => {
              if (confirm(`Delete "${s.name}" and its ${s.items.length} item(s) for everyone?`))
                apply({t: 'store.delete', bid: b.id, sid: s.id})
            }}, '×')
        ),
        items.length ? el('ul', {class: 'g-items'}, ...items) : null,
        addRow('Add an item', 'Add', name => apply({t: 'item.add', bid: b.id, sid: s.id, iid: newId(), name}), 'g-new-' + s.id),
        doneCount ? el('button', {class: 'g-clear',
          onclick: () => apply(...s.items.filter(i => i.done).map(i => ({t: 'item.delete', bid: b.id, sid: s.id, iid: i.id})))
        }, `Clear ${doneCount} checked item${doneCount > 1 ? 's' : ''}`) : null
      ))
    }
    return kids
  }

  function render() {
    boards = buildState(ops.values())
    const tab = getTab()
    // If the board you're looking at was deleted by someone, go to the Grocery Store.
    if (tab.startsWith('board:') && !boards.some(b => 'board:' + b.id === tab)) { setTab('board:' + GROCERY); return }
    if (tab.startsWith('board:')) changed.delete(tab.slice(6))
    renderTabs()
    const board = boards.find(b => 'board:' + b.id === tab)
    if (!board) return

    // Don't wipe a box someone is typing in when a change arrives from family.
    const active = document.activeElement
    const sameBoard = root.dataset.board === board.id
    const keepId = sameBoard && active && root.contains(active) && active.id ? active.id : null
    const typed = new Map(!sameBoard ? [] : [...root.querySelectorAll('input[id]:not([type=checkbox])')].filter(i => i.value).map(i => [i.id, i.value]))
    if (!sameBoard) { editing.key = null; root.dataset.board = board.id; root.scrollTop = 0 }

    const kids = renderBoard(board)
    rendering = true
    try { root.replaceChildren(...kids) } finally { rendering = false }

    // Put back anything half-typed, in any box.
    for (const [id, v] of typed) { const i = document.getElementById(id); if (i && root.contains(i)) i.value = v }
    if (keepId) {
      document.getElementById(keepId)?.focus()
    } else if (editing.key && !document.getElementById('g-editing')) {
      editing.key = null   // the thing being renamed was deleted by someone
    }
  }

  const isGrocery = o => !o.bid
  return {
    load, render,
    merge: list => merge(list, true),
    exists: tab => boards.some(b => 'board:' + b.id === tab),
    all: () => [...ops.values()],
    // Grocery changes and other-board changes are synced on separate channels.
    groceryIds: () => [...ops.values()].filter(isGrocery).map(o => o.id),
    boardIds: () => [...ops.values()].filter(o => !isGrocery(o)).map(o => o.id),
    missingFor: (theirIds, grocery) => [...ops.values()].filter(o => isGrocery(o) === grocery && !theirIds.has(o.id))
  }
}
