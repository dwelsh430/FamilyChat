# FamilyChat
A simple family chat board for home use.

**Open the chat:** https://dwelsh430.github.io/FamilyChat/

It's a single web page that works on phones and computers. Family members' browsers connect directly to each other, and every device keeps its own copy of the chat. There is no central server. See [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for a plain-language explanation and step-by-step instructions.

## Features
- **Family chat board.** One shared chat for everyone who has the family code. Messages go straight between devices, and each device keeps the full history, so messages reach people even after the sender has gone offline. Invite family with ☰ → *Copy invite link*.
- **Grocery Store board.** A shared shopping list organized by store. Anyone can add stores and items, rename them, check items off, and clear checked items after a trip.
- **Your own boards.** Tap **+ New board** to make boards like "Dad's Xmas Wish List". Each board holds lists, and each list holds items. Everyone can edit every board. A dot on a tab means someone else changed it.
- **Signed messages.** Each device has its own private key and signs every message. Messages that can't be proven show "· unverified", and people who share a name get a short code to tell them apart (like "Darcy · 7242").
- **Several devices, one person.** ☰ → *Link another device* shows a QR code or link for your other phone or computer. If you lose a device, remove it under ☰ → *My devices*.
- **Notifications.** ☰ → *Notifications* gives you a browser notification for new messages while the chat is open in the background. On iPhone and iPad, add the chat to your Home Screen first.
- **Connection relay.** ☰ → *Connection relay* takes the details of a TURN relay so phones on mobile data can connect too. The details travel in invite links and between family members, never in this repository.
- **Works offline, syncs later.** Edits and messages made offline spread when family members are online at the same time.
- **Backup.** ☰ → *Save a backup* downloads a copy of the chat, boards and device list.

## Good to know
- Messages only travel while at least two people have the chat open at the same time.
- Devices on different networks (especially mobile data) usually need a connection relay to connect. See HOW-IT-WORKS.md.
- Notifications stop once the chat is fully closed, because the app has no push server.
- Anyone with the family code can join, so share it only with family.

## Files
- `index.html`: the chat page (built file, self-contained)
- `sw.js`, `manifest.webmanifest`, `icon-*.png`: notifications and Home Screen install
- `src/`: the source code, build script (`npm run build`) and automated tests
