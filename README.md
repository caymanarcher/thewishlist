# thewishlist

Shared Christmas 🎄 and birthday 🎂 wish lists for a family or friend group.

## Run it

Requires only Python 3 (no packages to install).

```bash
python3 server.py
```

Then open http://localhost:8000.

- **Create a group** → you get a 6-letter code. Tap the 🔗 code to copy an invite link
  (`/?join=CODE`) and send it to the family.
- **Join a group** with the code and your name (use the same name to sign back in).
- **Add wishes**: search the built-in gift ideas, jump to Amazon/Target/Walmart/Etsy to find the
  exact product, or paste a product link and hit ✨ Autofill to pull in the name, photo and price.
  You can also add a photo (drag & drop, click, or paste), a price (exact, approximate, or none),
  notes, an icon, and a ❤️ "really want this" flag.
- **Claim gifts secretly**: on anyone else's list, tap 🎁 *I'll get this* (or 🤝 *Chip in too* to
  split it). Everyone else sees it's taken, so nobody doubles up. **The person whose list it is never
  sees claims.** The server doesn't send that data to them at all.
- **🛍️ My shopping**: everything you've claimed, with bought/to-buy checkboxes and your estimated spend.
- **🎅 Secret Santa** (⚙️ menu): draw names for the group. Everyone sees only their own pick.
- **Birthdays**: add yours in ⚙️ to show a countdown on your birthday list.
- Filters for person, budget, "hide taken gifts", and sorting by most wanted / price / date.

Data is stored in `data/` (SQLite database + uploaded photos), which is git-ignored. Older databases
are upgraded automatically on start. Set `PORT=xxxx` to use a different port.

### Note on link autofill
Autofill reads the standard preview tags (Open Graph / schema.org) that a product page publishes,
the same data chat apps use for link previews. Many stores provide them. Some (often Amazon) block
automated requests; then just fill the details in by hand.
Set `DATA_DIR=/path` to store data somewhere else (e.g. a hosting provider's persistent disk).
