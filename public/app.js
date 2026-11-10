// The Wishlist — front end (plain JS, no build step)
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const local = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let session = local.get("wishlist-session"); // { code, memberId, name }
let state = { group: null, members: [], items: [], santa: null };
let view = local.get("wishlist-view", "christmas"); // christmas | birthday | shopping
let person = "all";
let editing = null;       // item being edited, or null for new
let pendingPhoto = null;  // data URL of a newly chosen photo
let pendingRemote = null; // image URL found by link autofill
let removePhoto = false;
let chosenEmoji = null;
let animateNext = true;  // play entrance animations only when the view changes, not on background refresh

const LIST_EMOJI = { christmas: "🎄", birthday: "🎂" };
const EMOJIS = ["🎁","🎄","🎂","🧸","🎮","🎧","📚","👟","🧥","🧦","💄","🌸","💍","⌚","📷","🎨","🧩","🎲","🧱","⚽","🏀","🚲","⛺","☕","🍫","🍳","🕯️","🪴","🐶","🐱","✈️","🎟️","💵","🛍️","💻","📱"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (name, cls = "") => `<span class="avatar ${cls}" style="--h:${hue(name)}">${esc((name || "?").trim()[0]?.toUpperCase() || "?")}</span>`;
const memberName = (id) => state.members.find((m) => m.id === id)?.name || "Someone";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Days until the next occurrence of month/day (0 = today)
function daysUntil(month, day) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), month - 1, day);
  if (target < start) target = new Date(now.getFullYear() + 1, month - 1, day);
  return Math.round((target - start) / 86400000);
}
function christmasLine() {
  const d = daysUntil(12, 25);
  if (d === 0) return "🎄 Merry Christmas!";
  if (d === 1) return "🎄 Christmas is tomorrow!";
  return `🎄 ${d} days until Christmas`;
}
function birthdayLine(bday, who = "") {
  if (!bday) return "";
  const [m, d] = bday.split("-").map(Number);
  const n = daysUntil(m, d);
  if (n === 0) return `🥳 ${who ? who + "'s" : "Your"} birthday is today!`;
  return `🎂 ${n === 1 ? "Tomorrow" : `in ${n} days`} · ${MONTHS[m - 1].slice(0, 3)} ${d}`;
}

function priceLabel(item) {
  if (item.price_type === "none" || item.price == null) return `<span class="price none">No price</span>`;
  return `<span class="price">${item.price_type === "approx" ? "~" : ""}${money(item.price)}</span>`;
}

// ---------------- welcome ----------------
function showWelcome(err = "") {
  $("#app").hidden = true;
  $("#welcome").hidden = false;
  $("#welcome-error").textContent = err;
  $("#welcome-countdown").textContent = christmasLine();
  document.body.className = "";
  const join = new URLSearchParams(location.search).get("join");
  if (join) {
    $("#join-form").code.value = join.toUpperCase();
    $("#join-form").name.focus();
  }
  sky.mode("snow");
}

$("#create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api("/api/groups", { method: "POST", body: { name: f.get("name"), member: f.get("member") } });
    session = { code: r.code, memberId: r.member_id, name: f.get("member").trim() };
    local.set("wishlist-session", session);
    await load();
    toast(`Group created! Tap the 🔗 code to copy an invite link.`);
  } catch (err) { $("#welcome-error").textContent = err.message; }
});

$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const code = f.get("code").trim().toUpperCase();
  try {
    const r = await api(`/api/groups/${encodeURIComponent(code)}/members`, { method: "POST", body: { name: f.get("name") } });
    session = { code, memberId: r.member_id, name: f.get("name").trim() };
    local.set("wishlist-session", session);
    history.replaceState(null, "", location.pathname);
    await load();
    toast(`Welcome, ${session.name}! 🎉`);
  } catch (err) { $("#welcome-error").textContent = err.message; }
});

const inviteLink = () => `${location.origin}/?join=${session.code}`;
async function copyText(text, ok) {
  try { await navigator.clipboard.writeText(text); toast(ok); }
  catch { prompt("Copy this:", text); }
}
$("#copy-code").addEventListener("click", () => copyText(inviteLink(), "Invite link copied. Send it to the family! 💌"));

// ---------------- main view ----------------
async function load() {
  try {
    state = await api(`/api/groups/${encodeURIComponent(session.code)}?me=${session.memberId}`);
  } catch (err) {
    if (/No group/.test(err.message)) { local.del("wishlist-session"); session = null; return showWelcome(err.message); }
    return toast("Couldn't refresh. Check your connection.");
  }
  if (!state.members.some((m) => m.id === session.memberId)) {
    local.del("wishlist-session"); session = null;
    return showWelcome("Please sign in again.");
  }
  $("#welcome").hidden = true;
  $("#app").hidden = false;
  $("#group-name").textContent = state.group.name;
  $("#copy-code").textContent = state.group.code;
  $("#me").textContent = session.name;
  document.title = `${state.group.name} · The Wishlist`;
  if (person !== "all" && !state.members.some((m) => String(m.id) === person)) person = "all";
  render();
}

const myClaim = (item) => (item.claims || []).find((c) => c.member_id === session.memberId);
const myBirthday = () => state.members.find((m) => m.id === session.memberId)?.birthday;

function render() {
  document.body.classList.toggle("birthday", view === "birthday");
  document.body.classList.toggle("shopping", view === "shopping");
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  sky.mode(view === "birthday" ? "confetti" : "snow");
  $("#lists").classList.toggle("no-anim", !animateNext);
  animateNext = false;

  $("#countdown").textContent = view === "birthday"
    ? (myBirthday() ? birthdayLine(myBirthday()) : "🎂 Add your birthday in ⚙️")
    : christmasLine();

  const mine = state.items.filter((i) => myClaim(i));
  $("#shop-count").textContent = mine.filter((i) => myClaim(i).status !== "bought").length || mine.length;
  $("#shop-count").hidden = !mine.length;

  renderSantaBanner();
  $("#filters").hidden = view === "shopping";
  if (view === "shopping") return renderShopping();
  renderChips();

  const sort = $("#sort").value;
  const budget = $("#budget").value;
  const hideTaken = $("#hide-taken").checked;
  const sorters = {
    wanted: (a, b) => (b.priority || 0) - (a.priority || 0) || b.date_added.localeCompare(a.date_added) || b.id - a.id,
    newest: (a, b) => b.date_added.localeCompare(a.date_added) || b.id - a.id,
    oldest: (a, b) => a.date_added.localeCompare(b.date_added) || a.id - b.id,
    "price-low": (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
    "price-high": (a, b) => (b.price ?? -1) - (a.price ?? -1),
  };

  // Me first, then everyone else alphabetically
  const people = [...state.members]
    .filter((m) => person === "all" || String(m.id) === person)
    .sort((a, b) => (b.id === session.memberId) - (a.id === session.memberId));

  const html = people.map((m, pi) => {
    const isMe = m.id === session.memberId;
    const all = state.items.filter((i) => i.member_id === m.id && i.list === view);
    const items = all
      .filter((i) => budget === "any" || (i.price != null && i.price <= Number(budget)))
      .filter((i) => !(hideTaken && !isMe && (i.claims || []).length && !myClaim(i)))
      .sort(sorters[sort]);
    const total = all.reduce((s, i) => s + (i.price_type !== "none" && i.price ? i.price : 0), 0);
    const covered = all.filter((i) => (i.claims || []).length).length;
    const isSanta = state.santa?.receiver_id === m.id;

    const pills = [];
    if (view === "birthday" && m.birthday) pills.push(`<span class="pill accent">${birthdayLine(m.birthday)}</span>`);
    if (isSanta && view === "christmas") pills.push(`<span class="pill gold">🎅 Your Secret Santa pick</span>`);
    if (isMe && all.length) pills.push(`<span class="pill">🙈 Who's buying what is hidden from you</span>`);
    if (!isMe && all.length) pills.push(`<span class="pill green">${covered}/${all.length} covered</span><span class="progress" title="${covered} of ${all.length} gifts claimed"><i style="width:${(covered / all.length) * 100}%"></i></span>`);

    const cards = items.map((i, idx) => itemCard(i, isMe, idx)).join("");
    const emptyMsg = isMe
      ? `<span class="big">${LIST_EMOJI[view]}</span>Your ${view} list is empty. Tap <strong>＋ Add a wish</strong> to start!`
      : all.length ? `<span class="big">🔍</span>Nothing matches these filters.`
      : `<span class="big">🦗</span>${esc(m.name)} hasn't added anything yet.`;
    return `
      <section class="person" style="animation-delay:${pi * 40}ms">
        <div class="person-head">
          ${avatar(m.name, "lg")}
          <div>
            <h2>${esc(m.name)}${isMe ? " <small style='font-size:.6em;color:var(--muted)'>(me)</small>" : ""}</h2>
            <div class="meta-line"><span>${plural(all.length, "wish")}</span>${total ? `<span>≈ ${money(total)} total</span>` : ""}</div>
          </div>
          <div class="right">${pills.join("")}</div>
        </div>
        ${items.length ? `<div class="grid">${cards}</div>` : `<div class="empty">${emptyMsg}</div>`}
      </section>`;
  }).join("");
  $("#lists").innerHTML = html || `<div class="empty"><span class="big">👋</span>No one here yet.</div>`;
}

function itemCard(i, isMe, idx) {
  const claims = i.claims || [];
  const mineC = myClaim(i);
  const others = claims.filter((c) => c.member_id !== session.memberId);
  const anyBought = claims.some((c) => c.status === "bought");
  const taken = !isMe && claims.length;
  const stamp = anyBought ? "Bought ✓" : "Reserved";
  const emoji = i.emoji || LIST_EMOJI[i.list];

  let claimHtml = "";
  if (!isMe) {
    const names = (list) => list.map((c) => `<strong>${esc(c.name)}</strong>`).join(" & ");
    if (mineC) {
      claimHtml = `
        <div class="claim">
          <div class="who">✨ You're getting this${others.length ? ` with ${names(others)}` : ""}</div>
          <div class="actions">
            <button class="btn small ${mineC.status === "bought" ? "secondary" : "primary"}" data-act="${mineC.status === "bought" ? "unbuy" : "buy"}" data-id="${i.id}">${mineC.status === "bought" ? "✓ Bought" : "Mark bought"}</button>
            <button class="btn small ghost" data-act="unclaim" data-id="${i.id}">Unclaim</button>
          </div>
        </div>`;
    } else if (others.length) {
      claimHtml = `
        <div class="claim">
          <div class="who">${anyBought ? "✅ Bought by" : "🔒 Reserved by"} ${names(others)}</div>
          <div class="actions"><button class="btn small ghost" data-act="claim" data-id="${i.id}">🤝 Chip in too</button></div>
        </div>`;
    } else {
      claimHtml = `
        <div class="claim">
          <div class="actions"><button class="btn small secondary" data-act="claim" data-id="${i.id}">🎁 I'll get this</button></div>
        </div>`;
    }
  }

  return `
    <article class="item ${taken ? "taken" : ""} ${taken && anyBought ? "bought" : ""} ${mineC ? "mine-claim" : ""}" style="animation-delay:${Math.min(idx, 12) * 35}ms">
      <div class="thumb ${i.photo_url ? "" : "wrap"}" ${taken ? `data-stamp="${stamp}"` : ""}>
        ${i.priority ? `<span class="ribbon">❤️ Most wanted</span>` : ""}
        ${i.photo_url ? `<img src="${esc(i.photo_url)}" alt="${esc(i.name)}" loading="lazy">` : `<span class="emoji">${esc(emoji)}</span>`}
      </div>
      <div class="body">
        <div class="name">${esc(i.name)}</div>
        ${priceLabel(i)}
        ${i.notes ? `<div class="notes">${esc(i.notes)}</div>` : ""}
        ${i.link ? `<a class="view" href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">View item ↗</a>` : ""}
        <div class="meta">
          <span>Added ${fmtDate(i.date_added)}</span>
          ${isMe ? `<button class="edit" data-id="${i.id}">Edit</button>` : ""}
        </div>
      </div>
      ${claimHtml}
    </article>`;
}

function renderChips() {
  const chips = [`<button class="chip all ${person === "all" ? "active" : ""}" data-person="all">Everyone</button>`]
    .concat([...state.members]
      .sort((a, b) => (b.id === session.memberId) - (a.id === session.memberId))
      .map((m) => `<button class="chip ${person === String(m.id) ? "active" : ""}" data-person="${m.id}">${avatar(m.name)}${esc(m.name)}${m.id === session.memberId ? " (me)" : ""}</button>`));
  $("#people-chips").innerHTML = chips.join("");
}

function renderSantaBanner() {
  const s = state.santa;
  const el = $("#santa-banner");
  if (!s || !s.receiver_id || view === "birthday") { el.innerHTML = ""; return; }
  const name = memberName(s.receiver_id);
  el.innerHTML = `
    <div class="santa">
      <span class="hat">🎅</span>
      <div class="txt">
        <div>Secret Santa: you're buying for</div>
        <div class="reveal"><span class="blur" id="santa-name" title="Tap to reveal">${esc(name)}</span>${s.budget ? ` · budget ${money(s.budget)}` : ""}</div>
      </div>
      <button class="btn small" id="santa-see">See their list</button>
    </div>`;
  $("#santa-name").addEventListener("click", (e) => e.target.classList.toggle("blur"));
  $("#santa-see").addEventListener("click", () => { animateNext = true; view = "christmas"; person = String(s.receiver_id); local.set("wishlist-view", view); render(); });
}

function renderShopping() {
  const mine = state.items.filter((i) => myClaim(i))
    .sort((a, b) => memberName(a.member_id).localeCompare(memberName(b.member_id)) || a.name.localeCompare(b.name));
  const bought = mine.filter((i) => myClaim(i).status === "bought");
  // Split gifts count as your share of the price
  const share = (i) => (i.price_type !== "none" && i.price ? i.price / (i.claims.length || 1) : 0);
  const spend = mine.reduce((s, i) => s + share(i), 0);
  const people = new Set(mine.map((i) => i.member_id)).size;

  const rows = mine.map((i, idx) => {
    const c = myClaim(i);
    const others = i.claims.filter((x) => x.member_id !== session.memberId);
    const done = c.status === "bought";
    return `
      <div class="shop-row ${done ? "done" : ""}" style="animation-delay:${idx * 30}ms">
        <div class="mini-thumb">${i.photo_url ? `<img src="${esc(i.photo_url)}" alt="">` : esc(i.emoji || LIST_EMOJI[i.list])}</div>
        <div>
          <div class="t">${esc(i.name)}</div>
          <div class="s">For ${esc(memberName(i.member_id))} · ${LIST_EMOJI[i.list]} ${i.list}${i.price != null && i.price_type !== "none" ? ` · ${i.price_type === "approx" ? "~" : ""}${money(i.price)}` : ""}${others.length ? ` · splitting with ${others.map((o) => esc(o.name)).join(" & ")}` : ""}</div>
        </div>
        <div class="right">
          ${i.link ? `<a class="btn small ghost" href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">Buy ↗</a>` : ""}
          <button class="check-btn ${done ? "on" : ""}" data-act="${done ? "unbuy" : "buy"}" data-id="${i.id}">${done ? "✓ Bought" : "○ To buy"}</button>
          <button class="btn small ghost" data-act="unclaim" data-id="${i.id}" title="Unclaim" aria-label="Unclaim">✕</button>
        </div>
      </div>`;
  }).join("");

  $("#lists").innerHTML = `
    <div class="shop-summary">
      <div class="stat"><div class="n">${mine.length}</div><div class="l">gifts claimed</div></div>
      <div class="stat"><div class="n">${bought.length}/${mine.length}</div><div class="l">bought so far</div></div>
      <div class="stat"><div class="n">${people}</div><div class="l">${people === 1 ? "person" : "people"} covered</div></div>
      <div class="stat"><div class="n">${money(spend)}</div><div class="l">your estimated spend</div></div>
    </div>
    <section class="person">
      <div class="person-head"><h2>🛍️ Your shopping list</h2><div class="right"><span class="pill">Only you can see this</span></div></div>
      ${mine.length ? `<div class="shop-list">${rows}</div>`
        : `<div class="empty"><span class="big">🛒</span>Nothing here yet. Open someone's list and tap <strong>🎁 I'll get this</strong>. It'll show up here, and they'll never know.</div>`}
    </section>`;
}

// ---------------- interactions ----------------
$$(".tab").forEach((t) => t.addEventListener("click", () => { animateNext = true; view = t.dataset.view; local.set("wishlist-view", view); render(); }));
$("#people-chips").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (c) { animateNext = true; person = c.dataset.person; render(); }
});
["#sort", "#budget", "#hide-taken"].forEach((s) => $(s).addEventListener("change", () => { animateNext = true; render(); }));

$("#lists").addEventListener("click", async (e) => {
  const edit = e.target.closest(".edit");
  if (edit) return openDialog(state.items.find((i) => i.id === Number(edit.dataset.id)));
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  const url = `/api/groups/${encodeURIComponent(session.code)}/items/${id}/claim`;
  btn.disabled = true;
  try {
    if (act === "unclaim") {
      await api(url, { method: "DELETE", body: { member_id: session.memberId } });
      toast("Unclaimed. It's back up for grabs");
    } else {
      await api(url, { method: "POST", body: { member_id: session.memberId, status: act === "buy" ? "bought" : "reserved" } });
      const r = btn.getBoundingClientRect();
      if (act !== "unbuy") sky.burst(r.left + r.width / 2, r.top + r.height / 2);
      toast(act === "claim" ? "🎁 Claimed! Added to your shopping list" : act === "buy" ? "✅ Marked as bought. Nice!" : "Marked as not bought yet");
    }
    await load();
  } catch (err) { toast(err.message); btn.disabled = false; }
});

// ---------------- add / edit dialog ----------------
const dialog = $("#item-dialog");
const form = $("#item-form");

$$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
$$("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); })); // click backdrop

function setPreview(src) {
  $("#photo-preview").src = src || "";
  $("#photo-preview").hidden = !src;
  $("#drop-hint").hidden = !!src;
  $("#remove-photo").hidden = !src;
}
function syncPrice() { $("#price-wrap").hidden = form.price_type.value === "none"; }
function setEmoji(e) {
  chosenEmoji = e;
  $("#emoji-btn").textContent = e || LIST_EMOJI[form.list.value];
  $$("#emoji-grid button").forEach((b) => b.classList.toggle("sel", b.textContent === e));
}

$("#emoji-grid").innerHTML = EMOJIS.map((e) => `<button type="button">${e}</button>`).join("");
$("#emoji-btn").addEventListener("click", () => ($("#emoji-grid").hidden = !$("#emoji-grid").hidden));
$("#emoji-grid").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) { setEmoji(b.textContent); $("#emoji-grid").hidden = true; }
});
$$('input[name="list"]').forEach((r) => r.addEventListener("change", () => setEmoji(chosenEmoji)));

function openDialog(item = null) {
  editing = item;
  pendingPhoto = null;
  pendingRemote = null;
  removePhoto = false;
  form.reset();
  $("#form-error").textContent = "";
  $("#dialog-title").textContent = item ? "Edit wish" : "Add a wish";
  $("#delete-btn").hidden = !item;
  $("#finder").hidden = !!item;
  $("#finder-input").value = "";
  $("#finder-results").hidden = true;
  $("#emoji-grid").hidden = true;
  form.list.value = item ? item.list : (view === "shopping" ? "christmas" : view);
  form.name.value = item?.name || "";
  form.link.value = item?.link || "";
  form.price_type.value = item?.price_type || "exact";
  form.price.value = item?.price ?? "";
  form.priority.checked = !!item?.priority;
  form.date_added.value = item?.date_added || today();
  form.notes.value = item?.notes || "";
  setEmoji(item?.emoji || null);
  setPreview(item?.photo_url);
  syncPrice();
  dialog.showModal();
  (item ? form.name : $("#finder-input")).focus();
}

$("#add-btn").addEventListener("click", () => openDialog());
$$('input[name="price_type"]').forEach((r) => r.addEventListener("change", syncPrice));

// Photo: click, drag & drop, or paste. Images are shrunk in the browser before upload.
const dz = $("#dropzone");
dz.addEventListener("click", () => $("#photo-input").click());
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#photo-input").click(); } });
$("#photo-input").addEventListener("change", (e) => e.target.files[0] && takeFile(e.target.files[0]));
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => {
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
  if (file) return takeFile(file);
  const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
  if (/^https?:\/\//i.test(url)) { pendingRemote = url.trim(); pendingPhoto = null; removePhoto = false; setPreview(pendingRemote); return; }
  $("#form-error").textContent = "Please drop an image file.";
});
dialog.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) { e.preventDefault(); takeFile(file); }
});
$("#remove-photo").addEventListener("click", () => { pendingPhoto = null; pendingRemote = null; removePhoto = true; setPreview(null); });

async function takeFile(file) {
  if (!file.type.startsWith("image/")) return ($("#form-error").textContent = "That file isn't an image.");
  $("#form-error").textContent = "";
  try {
    pendingPhoto = await shrink(file, 1200);
    pendingRemote = null;
    removePhoto = false;
    setPreview(pendingPhoto);
  } catch { $("#form-error").textContent = "Couldn't read that image."; }
}

function shrink(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------------- search & autofill ----------------
const finderInput = $("#finder-input");
const finderResults = $("#finder-results");
let kbIndex = -1;
const isUrl = (s) => /^(https?:\/\/|www\.)\S+\.\S+/i.test(s.trim()) || /^[\w-]+\.(com|net|org|co|shop|store|us|uk|ca)\/\S*/i.test(s.trim());

function searchIdeas(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return (window.GIFT_IDEAS || [])
    .map(([e, n, p, tags]) => {
      const name = n.toLowerCase(), hay = `${name} ${tags}`;
      if (!words.every((w) => hay.includes(w) || hay.split(/\s+/).some((t) => t.startsWith(w.replace(/s$/, ""))))) return null;
      const score = words.reduce((s, w) => s + (name.startsWith(w) ? 3 : name.includes(w) ? 2 : 1), 0);
      return { e, n, p, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

function storeLinks(q) {
  const enc = encodeURIComponent(q);
  return [
    ["Amazon", `https://www.amazon.com/s?k=${enc}`],
    ["Target", `https://www.target.com/s?searchTerm=${enc}`],
    ["Walmart", `https://www.walmart.com/search?q=${enc}`],
    ["Etsy", `https://www.etsy.com/search?q=${enc}`],
    ["Google Shopping", `https://www.google.com/search?tbm=shop&q=${enc}`],
  ].map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${n} ↗</a>`).join("");
}

function renderFinder() {
  const q = finderInput.value.trim();
  kbIndex = -1;
  if (!q) { finderResults.hidden = true; return; }
  let html = "";
  if (isUrl(q)) {
    html = `<button type="button" class="sugg" data-url="${esc(q)}"><span class="e">✨</span><span class="n">Autofill from this link</span><span class="p">name · photo · price</span></button>`;
  } else {
    const ideas = searchIdeas(q);
    if (ideas.length) {
      html += `<div class="sec">Gift ideas</div>` + ideas.map((x, i) =>
        `<button type="button" class="sugg" data-idea="${i}"><span class="e">${x.e}</span><span class="n">${esc(x.n)}</span><span class="p">~${money(x.p)}</span></button>`).join("");
    }
    html += `<button type="button" class="sugg" data-custom="1"><span class="e">✏️</span><span class="n">Use “${esc(q)}”</span></button>`;
    html += `<div class="sec">Find the exact one</div><div class="stores">${storeLinks(q)}</div>
             <div class="finder-tip">Found it? Copy the product link and paste it in the search box (or the Link field) to autofill the name, photo &amp; price.</div>`;
    finderResults._ideas = ideas;
  }
  finderResults.innerHTML = html;
  finderResults.hidden = false;
}

function pickIdea(x) {
  form.name.value = x.n;
  setEmoji(x.e);
  form.price_type.value = "approx";
  form.price.value = x.p;
  syncPrice();
  finderResults.hidden = true;
  finderInput.value = "";
  form.name.focus();
  form.name.select();
}

finderInput.addEventListener("input", renderFinder);
finderInput.addEventListener("paste", () => setTimeout(() => { if (isUrl(finderInput.value)) autofill(finderInput.value); }, 0));
finderInput.addEventListener("keydown", (e) => {
  const opts = $$(".sugg", finderResults);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!opts.length) return;
    kbIndex = (kbIndex + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle("kb", i === kbIndex));
    opts[kbIndex].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault(); // never submit the whole form from the search box
    (opts[kbIndex] || opts[0])?.click();
  } else if (e.key === "Escape" && !finderResults.hidden) {
    e.preventDefault(); finderResults.hidden = true;
  }
});
finderResults.addEventListener("click", (e) => {
  const b = e.target.closest(".sugg");
  if (!b) return;
  if (b.dataset.url) return autofill(b.dataset.url);
  if (b.dataset.idea) return pickIdea(finderResults._ideas[Number(b.dataset.idea)]);
  if (b.dataset.custom) { form.name.value = finderInput.value.trim(); finderResults.hidden = true; finderInput.value = ""; form.name.focus(); }
});

async function autofill(url) {
  url = (url || "").trim();
  if (!url) return ($("#form-error").textContent = "Paste a product link first.");
  const btn = $("#autofill-btn");
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin">✨</span> Looking…`;
  $("#form-error").textContent = "";
  finderResults.hidden = true;
  try {
    const r = await api("/api/preview", { method: "POST", body: { url } });
    if (r.name) form.name.value = r.name;
    form.link.value = r.link || url;
    if (r.price != null) { form.price_type.value = "exact"; form.price.value = r.price; syncPrice(); }
    if (r.image && !pendingPhoto) { pendingRemote = r.image; removePhoto = false; setPreview(r.image); }
    finderInput.value = "";
    toast(`✨ Filled in from ${r.site || "the link"}${r.price == null ? ". Add a price if you know it" : ""}`);
  } catch (err) {
    form.link.value = form.link.value || url;
    finderInput.value = "";
    $("#form-error").textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
}
$("#autofill-btn").addEventListener("click", () => autofill(form.link.value));
$("#photo-preview").addEventListener("error", () => {
  if (pendingRemote) { pendingRemote = null; setPreview(null); }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const priceType = form.price_type.value;
  if (priceType === "exact" && form.price.value === "") {
    return ($("#form-error").textContent = "Enter a price, or choose “Approx.” or “No price”.");
  }
  const body = {
    member_id: session.memberId,
    list: form.list.value,
    name: form.name.value,
    link: form.link.value,
    price_type: priceType,
    price: priceType === "none" ? null : form.price.value,
    date_added: form.date_added.value,
    notes: form.notes.value,
    priority: form.priority.checked,
    emoji: chosenEmoji,
  };
  if (pendingPhoto) body.photo = pendingPhoto;
  else if (pendingRemote) body.photo_remote = pendingRemote;
  if (removePhoto) body.remove_photo = true;

  const btn = $("#save-btn");
  btn.disabled = true;
  try {
    if (editing) await api(`/api/groups/${encodeURIComponent(session.code)}/items/${editing.id}`, { method: "PUT", body });
    else await api(`/api/groups/${encodeURIComponent(session.code)}/items`, { method: "POST", body });
    dialog.close();
    view = body.list;
    local.set("wishlist-view", view);
    await load();
    if (!editing) { const r = $("#add-btn").getBoundingClientRect(); sky.burst(r.left + r.width / 2, r.top + r.height / 2); }
    toast(editing ? "Wish updated" : "Wish added 🎁");
  } catch (err) {
    $("#form-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("#delete-btn").addEventListener("click", async () => {
  if (!editing || !confirm(`Delete “${editing.name}”?`)) return;
  try {
    await api(`/api/groups/${encodeURIComponent(session.code)}/items/${editing.id}`, { method: "DELETE", body: { member_id: session.memberId } });
    dialog.close();
    await load();
    toast("Wish deleted");
  } catch (err) { $("#form-error").textContent = err.message; }
});

// ---------------- profile / group dialog ----------------
const profile = $("#profile-dialog");
const pform = $("#profile-form");
pform.bmonth.innerHTML = `<option value="">—</option>` + MONTHS.map((m, i) => `<option value="${String(i + 1).padStart(2, "0")}">${m}</option>`).join("");
pform.bday.innerHTML = `<option value="">—</option>` + Array.from({ length: 31 }, (_, i) => `<option value="${String(i + 1).padStart(2, "0")}">${i + 1}</option>`).join("");

function openProfile() {
  const b = myBirthday();
  pform.bmonth.value = b ? b.slice(0, 2) : "";
  pform.bday.value = b ? b.slice(3) : "";
  $("#invite-link").value = inviteLink();
  renderSantaPanel();
  profile.showModal();
}
$("#profile-btn").addEventListener("click", openProfile);
$("#copy-invite").addEventListener("click", () => copyText(inviteLink(), "Invite link copied 💌"));

$("#save-bday").addEventListener("click", async () => {
  const m = pform.bmonth.value, d = pform.bday.value;
  if (!!m !== !!d) return toast("Pick both a month and a day");
  try {
    await api(`/api/groups/${encodeURIComponent(session.code)}/members/${session.memberId}`, {
      method: "PUT", body: { member_id: session.memberId, birthday: m ? `${m}-${d}` : null },
    });
    await load();
    toast(m ? "🎂 Birthday saved" : "Birthday cleared");
  } catch (err) { toast(err.message); }
});

function renderSantaPanel() {
  const s = state.santa;
  const n = state.members.length;
  const el = $("#santa-panel");
  if (!s) {
    el.innerHTML = `
      <p class="hint">Draw names so everyone gets one secret person to shop for. Each person only sees their own pick. ${n < 3 ? `<br><strong>Needs at least 3 people. You have ${n}.</strong>` : ""}</p>
      <div class="link-row">
        <label class="price-input" style="flex:1"><span>$</span><input id="santa-budget" type="number" min="0" step="1" placeholder="Budget (optional)"></label>
        <button type="button" class="btn small primary" id="santa-draw" ${n < 3 ? "disabled" : ""}>🎲 Draw names</button>
      </div>`;
  } else {
    el.innerHTML = `
      <p class="hint">Drawn by ${esc(s.drawn_by)} on ${fmtDate(s.drawn_at.slice(0, 10))}${s.budget ? ` · budget ${money(s.budget)}` : ""}.
      ${s.receiver_id ? "" : "<br>You joined after the draw, so you don't have a pick. Redraw to include everyone."}</p>
      <div class="link-row">
        <button type="button" class="btn small secondary" id="santa-redraw">🔄 Redraw (new picks for all)</button>
        <button type="button" class="btn small ghost" id="santa-cancel">Cancel Secret Santa</button>
      </div>`;
  }
  $("#santa-draw")?.addEventListener("click", () => santa("POST", $("#santa-budget").value));
  $("#santa-redraw")?.addEventListener("click", () => {
    if (confirm("Redraw names? Everyone gets a NEW person, so let the family know!")) santa("POST", s.budget);
  });
  $("#santa-cancel")?.addEventListener("click", () => { if (confirm("Cancel Secret Santa for the whole group?")) santa("DELETE"); });
}

async function santa(method, budget) {
  try {
    await api(`/api/groups/${encodeURIComponent(session.code)}/santa`, { method, body: { member_id: session.memberId, budget } });
    await load();
    renderSantaPanel();
    if (method === "POST") { profile.close(); view = "christmas"; render(); sky.burst(innerWidth / 2, 200); toast("🎅 Names drawn! Tap the blurred name to reveal yours"); }
    else toast("Secret Santa cancelled");
  } catch (err) { toast(err.message); }
}

$("#leave-btn").addEventListener("click", () => {
  if (!confirm("Sign out? You can get back in with the group code and the same name.")) return;
  local.del("wishlist-session");
  session = null;
  profile.close();
  showWelcome();
});

// ---------------- falling snow / confetti + celebration bursts ----------------
const sky = (() => {
  const c = $("#sky"), ctx = c.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let on = local.get("wishlist-snow", true) && !reduced;
  let kind = "snow", flakes = [], bursts = [], raf = 0, w = 0, h = 0, dpr = 1;
  const COLORS = ["#c2367f", "#7c4bd1", "#f2b134", "#2bb3a3", "#ff6b6b", "#5b8def"];

  function size() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = c.width = innerWidth * dpr; h = c.height = innerHeight * dpr;
    c.style.width = innerWidth + "px"; c.style.height = innerHeight + "px";
  }
  function make(spread) {
    const count = Math.round(Math.min(90, innerWidth / 14));
    flakes = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: spread ? Math.random() * h : -10, r: (Math.random() * 2.2 + 1) * dpr,
      vy: (Math.random() * .6 + .35) * dpr, vx: (Math.random() - .5) * .3 * dpr, ph: Math.random() * 6.28,
      rot: Math.random() * 6.28, vr: (Math.random() - .5) * .1, col: COLORS[(Math.random() * COLORS.length) | 0],
    }));
  }
  function heroBottom() {
    const hero = $(".hero");
    return hero && !$("#app").hidden ? hero.getBoundingClientRect().bottom * dpr : (kind === "snow" ? h * .45 : h);
  }
  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    if (on) {
      const hb = heroBottom();
      for (const f of flakes) {
        f.y += f.vy; f.x += f.vx + Math.sin(t / 1400 + f.ph) * .25 * dpr; f.rot += f.vr;
        if (f.y > h + 10) { f.y = -10; f.x = Math.random() * w; }
        if (f.x > w + 10) f.x = -10; if (f.x < -10) f.x = w + 10;
        if (kind === "snow") {
          // white over the dark header, a soft frosty blue over the cream page
          ctx.fillStyle = f.y < hb ? "rgba(255,255,255,.85)" : "rgba(150,175,200,.32)";
          ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.283); ctx.fill();
        } else {
          ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot);
          ctx.globalAlpha = f.y < hb ? .9 : .35; ctx.fillStyle = f.col;
          ctx.fillRect(-f.r * 1.4, -f.r * .6, f.r * 2.8, f.r * 1.2); ctx.restore();
        }
      }
    }
    // bursts (always on, they're short)
    for (let i = bursts.length - 1; i >= 0; i--) {
      const p = bursts[i];
      p.vy += .18 * dpr; p.x += p.vx; p.y += p.vy; p.life -= 1; p.rot += p.vr;
      ctx.save(); ctx.globalAlpha = Math.max(0, p.life / 70); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      if (p.emoji) { ctx.font = `${18 * dpr}px serif`; ctx.textAlign = "center"; ctx.fillText(p.emoji, 0, 0); }
      else { ctx.fillStyle = p.col; ctx.fillRect(-4 * dpr, -2 * dpr, 8 * dpr, 4 * dpr); }
      ctx.restore();
      if (p.life <= 0) bursts.splice(i, 1);
    }
    raf = (on || bursts.length) ? requestAnimationFrame(frame) : 0;
  }
  function start() { if (!raf) raf = requestAnimationFrame(frame); }
  function syncBtn() { $("#snow-btn").classList.toggle("off", !on); $("#snow-btn").textContent = kind === "confetti" ? "🎊" : "❄️"; }

  addEventListener("resize", () => { size(); make(true); });
  size(); make(true);
  return {
    mode(k) { if (k !== kind) { kind = k; make(true); } syncBtn(); if (on) start(); },
    toggle() { on = !on; local.set("wishlist-snow", on); syncBtn(); if (on) start(); },
    burst(x, y) {
      if (reduced) return;
      const em = kind === "confetti" ? ["🎉", "🎈", "✨"] : ["🎁", "⭐", "❄️", "✨"];
      for (let i = 0; i < 34; i++) {
        const a = Math.random() * Math.PI * 2, s = (Math.random() * 5 + 3) * dpr;
        bursts.push({ x: x * dpr, y: y * dpr, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 4 * dpr, life: 60 + Math.random() * 20,
          rot: 0, vr: (Math.random() - .5) * .3, col: COLORS[i % COLORS.length], emoji: i % 4 === 0 ? em[i % em.length] : null });
      }
      start();
    },
  };
})();
$("#snow-btn").addEventListener("click", () => sky.toggle());

// Keep everyone's view fresh: refresh every 30s when the tab is visible and no dialog is open.
setInterval(() => {
  if (session && !document.hidden && !$$("dialog").some((d) => d.open)) load();
}, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && session && !$$("dialog").some((d) => d.open)) load(); });

// ---------------- start ----------------
if (session && new URLSearchParams(location.search).get("join") && new URLSearchParams(location.search).get("join").toUpperCase() !== session.code) {
  showWelcome(); // invited to a different group
} else if (session) {
  history.replaceState(null, "", location.pathname);
  load();
} else showWelcome();
