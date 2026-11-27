// Minimal Nostr relay for local testing only.
const {WebSocketServer} = require('ws')
const wss = new WebSocketServer({port: 7447})
const subs = new Map() // ws -> Map(subId -> filters)
const match = (f, ev) => (!f.kinds || f.kinds.includes(ev.kind)) &&
  (!f['#x'] || ev.tags.some(t => t[0]==='x' && f['#x'].includes(t[1])))
wss.on('connection', ws => {
  subs.set(ws, new Map())
  ws.on('message', raw => {
    const msg = JSON.parse(raw)
    if (msg[0]==='REQ') { subs.get(ws).set(msg[1], msg.slice(2)); ws.send(JSON.stringify(['EOSE', msg[1]])) }
    else if (msg[0]==='CLOSE') subs.get(ws).delete(msg[1])
    else if (msg[0]==='EVENT') {
      const ev = msg[1]
      ws.send(JSON.stringify(['OK', ev.id, true, '']))
      for (const [c, m] of subs) for (const [id, fs] of m) if (fs.some(f => match(f, ev))) c.send(JSON.stringify(['EVENT', id, ev]))
    }
  })
  ws.on('close', () => subs.delete(ws))
})
console.log('relay up')
