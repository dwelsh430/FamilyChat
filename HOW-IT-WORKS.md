# Family Chat: first version

## What it is
One web page (`index.html`). Open it in any browser on a phone, tablet or computer. There's nothing to install and no account to make. Everyone who types the same **family code** sees the same chat board.

## How it works, in plain terms
- **Finding each other.** When you open the chat, your browser leaves a small "I'm here" note on a few public, free relay servers (part of a network called Nostr). Other family members' browsers look for notes that match your family code and use them to find you. The notes are encrypted with the family code, and **chat messages never go through these relays.** This is the one bit of outside help the app needs. Browsers can't find each other on the open internet without it. The relays are run by lots of different volunteers, the app uses several at once, and nobody owns or controls your chat.
- **Talking.** Once the browsers have found each other, they connect directly (WebRTC, the same technology video calls use) and send messages straight to each other, encrypted.
- **Keeping a copy.** Every device saves the whole chat. When two devices meet, they compare notes and fill in anything the other is missing. So if Grandma posts while you're offline, and Uncle Pat was online at the time, you get her message from Pat later even if Grandma has gone offline by then.

## Boards: Grocery Store and your own
The tabs at the top are **Chat**, the **Grocery Store** board, and any boards the family makes. Swipe the tabs sideways if they don't all fit.
- Tap **+ New board** to make your own, like "Dad's Xmas Wish List". A board holds lists, and each list holds items. On the Grocery Store board, the lists are stores.
- Anyone in the family can edit any board. Tap a name to rename it, tick the box when it's done, or tap × to delete it. Deleting a list or a whole board asks first.
- Tap **Clear checked items** to tidy a list.

Edits work offline too and spread to everyone the same way chat messages do. If two people change the same thing at about the same time, the later change wins. A dot on a tab means someone else changed that board.

Family members still on an older copy of the page keep seeing the Grocery Store, but they won't see the new boards until they reload.

## Things to know (limits of version 1)
- **Messages only travel when at least two people have the chat open at the same time.** If you post while nobody else is on, your message waits on your device and goes out the next time someone else opens the chat while you have it open too. A family member who leaves a computer or tablet open with the chat makes this work much better.
- **No notifications yet** when the page is closed. If a browser tab is open, the tab title shows the number of unread messages.
- **Some mobile networks block direct connections.** Usually it works. If one person can never connect from their phone's data plan but can on Wi-Fi, that's the reason. We can fix it later by adding a "TURN" relay, at the cost of a small outside service.
- **The family code is the key.** Anyone who has it can read and post. Choose a long one (the "Make a new code" button does this) and share it only with family.
- **Clearing browser data deletes your copy** of the chat. Other people's copies are fine, and you'll get the history back the next time you're both online. "Save a backup" in the menu downloads a copy.
- No editing or deleting messages, no photos yet.

## How the family tries it
1. Open the chat page link (see "Where the page lives" below).
2. Type your name. Tap **Make a new code** (only the first person does this), then **Join chat**.
3. Open the menu (☰) and tap **Copy invite link**. Send it to family by text or email. The link already has the family code in it, so they only type their name.
4. On a phone, use the browser's "Add to Home Screen" so it opens like an app.

## Where the page lives
Our family link: **https://dwelsh430.github.io/FamilyChat/** (served by GitHub Pages from this repository). The page contains only the app, never any messages, so a public address does not expose the chat.
- **GitHub Pages** (free, needs a GitHub account): put `index.html` in a repository and turn on Pages.
- Any other free static host (Netlify, Cloudflare Pages) works the same way.
- For a quick test on one computer you can also just double-click `index.html`.

## For later changes
The source is in `src/`. `app.js` is the app code and `template.html` is the page layout. `cd src && npm install && npm run build` rebuilds `index.html` with the networking library (Trystero 0.25.4, MIT license) bundled in. `boards.js` is the boards (Grocery Store and family-made boards). `src/relay.js` is a local test relay, and `src/test.js`, `src/test-grocery.js` and `src/test-boards.js` are automated multi-person tests.
