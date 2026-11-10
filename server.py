#!/usr/bin/env python3
"""The Wishlist — a tiny shared Christmas & birthday wish list server.

No dependencies beyond the Python standard library.
Run:  python3 server.py   then open http://localhost:8000
"""
import base64
import ipaddress
import json
import mimetypes
import os
import random
import re
import secrets
import socket
import sqlite3
import uuid
from datetime import date, datetime
from html import unescape
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import URLError
from urllib.parse import parse_qs, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
DATA = os.environ.get("DATA_DIR") or os.path.join(ROOT, "data")  # point at a persistent disk when hosted
UPLOADS = os.path.join(DATA, "uploads")
DB_PATH = os.path.join(DATA, "wishlist.db")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY = 15 * 1024 * 1024  # 15 MB
LISTS = ("christmas", "birthday")
PRICE_TYPES = ("exact", "approx", "none")
CLAIM_STATUSES = ("reserved", "bought")
FETCH_UA = "TheWishlist/2.0 (link preview)"

os.makedirs(UPLOADS, exist_ok=True)


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS groups (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                code TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS members (
                id INTEGER PRIMARY KEY,
                group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE (group_id, name COLLATE NOCASE)
            );
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY,
                group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                list TEXT NOT NULL,
                name TEXT NOT NULL,
                link TEXT,
                photo TEXT,
                price_type TEXT NOT NULL DEFAULT 'exact',
                price REAL,
                notes TEXT,
                date_added TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            -- Who is getting what. Never sent to the item's owner.
            CREATE TABLE IF NOT EXISTS claims (
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'reserved',
                created_at TEXT NOT NULL,
                PRIMARY KEY (item_id, member_id)
            );
            CREATE TABLE IF NOT EXISTS santa (
                group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                giver_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                receiver_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                PRIMARY KEY (group_id, giver_id)
            );
            CREATE TABLE IF NOT EXISTS santa_draws (
                group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
                drawn_by TEXT NOT NULL,
                budget REAL,
                drawn_at TEXT NOT NULL
            );
            """
        )
        # Lightweight migrations for databases created by older versions.
        add_column(conn, "items", "priority", "INTEGER NOT NULL DEFAULT 0")
        add_column(conn, "items", "emoji", "TEXT")
        add_column(conn, "members", "birthday", "TEXT")  # "MM-DD"


def add_column(conn, table, column, decl):
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def now():
    return datetime.now().isoformat(timespec="seconds")


def new_code():
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no look-alike characters
    return "".join(secrets.choice(alphabet) for _ in range(6))


def save_photo_bytes(data, ext):
    name = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(UPLOADS, name), "wb") as f:
        f.write(data)
    return name


def save_photo(data_url):
    """Decode a data: URL from the browser and save it; return the filename."""
    m = re.match(r"^data:image/(png|jpe?g|gif|webp);base64,(.+)$", data_url or "", re.S)
    if not m:
        raise ValueError("Photo must be a PNG, JPEG, GIF or WebP image.")
    ext = {"jpeg": "jpg"}.get(m.group(1), m.group(1))
    return save_photo_bytes(base64.b64decode(m.group(2)), ext)


def save_remote_photo(url):
    """Download an image found by link autofill. Returns filename or None."""
    try:
        data, ctype, _ = safe_fetch(url, max_bytes=8 * 1024 * 1024, accept="image/*")
    except Exception:
        return None
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}.get(
        (ctype or "").split(";")[0].strip().lower()
    )
    return save_photo_bytes(data, ext) if ext and data else None


def delete_photo(name):
    if name:
        path = os.path.join(UPLOADS, os.path.basename(name))
        if os.path.exists(path):
            os.remove(path)


def clean_item(body, partial=False):
    """Validate item fields from a request body."""
    out = {}
    if not partial or "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            raise ValueError("Item name is required.")
        out["name"] = name[:200]
    if not partial or "list" in body:
        if body.get("list") not in LISTS:
            raise ValueError("List must be 'christmas' or 'birthday'.")
        out["list"] = body["list"]
    if "link" in body:
        link = (body.get("link") or "").strip()
        if link and not re.match(r"^https?://", link, re.I):
            link = "https://" + link
        out["link"] = link[:2000] or None
    if not partial or "price_type" in body:
        pt = body.get("price_type") or "exact"
        if pt not in PRICE_TYPES:
            raise ValueError("Invalid price type.")
        out["price_type"] = pt
        price = body.get("price")
        if pt == "none" or price in (None, ""):
            out["price"] = None
        else:
            try:
                out["price"] = round(float(price), 2)
            except (TypeError, ValueError):
                raise ValueError("Price must be a number.")
            if out["price"] < 0:
                raise ValueError("Price can't be negative.")
    if "notes" in body:
        out["notes"] = (body.get("notes") or "").strip()[:1000] or None
    if not partial or "date_added" in body:
        d = body.get("date_added") or date.today().isoformat()
        try:
            date.fromisoformat(d)
        except ValueError:
            raise ValueError("Date must be YYYY-MM-DD.")
        out["date_added"] = d
    if "priority" in body:
        out["priority"] = 1 if body.get("priority") else 0
    if "emoji" in body:
        out["emoji"] = (body.get("emoji") or "").strip()[:16] or None
    return out


# ---------------------------------------------------------------------------
# Link autofill: fetch a product page and read its preview tags
# (Open Graph / schema.org JSON-LD), the same data chat apps use for previews.
# ---------------------------------------------------------------------------
def assert_public_host(url):
    """Refuse URLs pointing at this machine or the private network."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError("Please enter a full web link (https://…).")
    try:
        infos = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80))
    except socket.gaierror:
        raise ValueError("Couldn't find that website.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ValueError("That link isn't a public website.")


class SafeRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        assert_public_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def safe_fetch(url, max_bytes, accept):
    assert_public_host(url)
    opener = build_opener(SafeRedirects)
    req = Request(url, headers={"User-Agent": FETCH_UA, "Accept": accept, "Accept-Language": "en-US,en"})
    with opener.open(req, timeout=8) as res:
        return res.read(max_bytes), res.headers.get("Content-Type", ""), res.geturl()


class MetaParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.title = ""
        self.ld = []
        self._in_title = False
        self._in_ld = False
        self._buf = []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"].strip()
        elif tag == "title":
            self._in_title = True
        elif tag == "script" and "ld+json" in a.get("type", ""):
            self._in_ld, self._buf = True, []

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "script" and self._in_ld:
            self._in_ld = False
            self.ld.append("".join(self._buf))

    def handle_data(self, data):
        if self._in_title and not self.title:
            self.title = data.strip()
        if self._in_ld:
            self._buf.append(data)


def find_products(node):
    """Yield schema.org Product objects anywhere inside parsed JSON-LD."""
    if isinstance(node, list):
        for n in node:
            yield from find_products(n)
    elif isinstance(node, dict):
        t = node.get("@type")
        types = t if isinstance(t, list) else [t]
        if "Product" in types or "ProductGroup" in types:
            yield node
        for v in node.values():
            if isinstance(v, (list, dict)):
                yield from find_products(v)


def to_price(v):
    if v in (None, ""):
        return None
    m = re.search(r"\d[\d,]*(?:\.\d+)?", str(v))
    try:
        return round(float(m.group(0).replace(",", "")), 2) if m else None
    except ValueError:
        return None


def link_preview(url):
    url = (url or "").strip()
    if url and not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    try:
        raw, ctype, final = safe_fetch(url, max_bytes=2 * 1024 * 1024, accept="text/html,*/*;q=0.8")
    except ValueError:
        raise
    except (URLError, socket.timeout, OSError) as e:
        code = getattr(e, "code", None)
        if code in (403, 429, 503):
            raise ValueError("That store blocks automatic previews. Fill the details in by hand, or try another store's link.")
        raise ValueError("Couldn't reach that page.")
    if "html" not in ctype.lower():
        raise ValueError("That link isn't a web page.")
    charset = re.search(r"charset=([\w-]+)", ctype)
    html = raw.decode(charset.group(1) if charset else "utf-8", errors="replace")
    p = MetaParser()
    try:
        p.feed(html)
    except Exception:
        pass
    m = p.meta
    name = m.get("og:title") or m.get("twitter:title") or p.title
    image = m.get("og:image") or m.get("og:image:secure_url") or m.get("twitter:image")
    price = to_price(m.get("product:price:amount") or m.get("og:price:amount") or m.get("price"))
    for block in p.ld:
        try:
            data = json.loads(block)
        except (ValueError, TypeError):
            continue
        for prod in find_products(data):
            name = name or prod.get("name")
            img = prod.get("image")
            if isinstance(img, list):
                img = img[0] if img else None
            if isinstance(img, dict):
                img = img.get("url")
            image = image or img
            if price is None:
                offers = prod.get("offers")
                offers = offers if isinstance(offers, list) else [offers]
                for o in offers:
                    if isinstance(o, dict):
                        price = to_price(o.get("price") or o.get("lowPrice"))
                        if price is not None:
                            break
            break
    name = unescape(name or "").strip()
    # "Cozy Slippers | Store Name" -> "Cozy Slippers"
    name = re.split(r"\s+[|•–—]\s+|\s+-\s+(?=[A-Z][\w.&' ]{1,30}$)", name)[0].strip() if name else ""
    blocked = re.search(r"robot|captcha|access denied|are you a human|just a moment", name, re.I)
    if blocked or (not name and not image):
        raise ValueError("That store blocks automatic previews. Fill the details in by hand, or try another store's link.")
    return {
        "name": name[:200],
        "image": urljoin(final, image) if image else None,
        "price": price,
        "link": final,
        "site": (urlparse(final).hostname or "").replace("www.", ""),
    }


# ---------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def derangement(ids):
    """Shuffle so nobody draws themselves."""
    while True:
        out = ids[:]
        random.shuffle(out)
        if all(a != b for a, b in zip(ids, out)):
            return dict(zip(ids, out))


class Handler(BaseHTTPRequestHandler):
    server_version = "TheWishlist/2.0"

    # ---------- plumbing ----------
    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "That upload is too large (15 MB max).")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "Invalid JSON.")

    def send_file(self, path, cache=False):
        if not os.path.isfile(path):
            return self.send_json(404, {"error": "Not found"})
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400" if cache else "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def dispatch(self, method):
        url = urlparse(self.path)
        path = url.path
        self.query = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if path.startswith("/api/"):
                return self.route_api(method, path)
            if method != "GET":
                raise ApiError(405, "Method not allowed")
            if path.startswith("/uploads/"):
                return self.send_file(os.path.join(UPLOADS, os.path.basename(path)), cache=True)
            rel = path.lstrip("/") or "index.html"
            full = os.path.normpath(os.path.join(PUBLIC, rel))
            if not full.startswith(PUBLIC) or not os.path.isfile(full):
                full = os.path.join(PUBLIC, "index.html")  # single-page app fallback
            return self.send_file(full)
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except ValueError as e:
            self.send_json(400, {"error": str(e)})
        except Exception as e:  # pragma: no cover
            print("ERROR:", repr(e))
            self.send_json(500, {"error": "Something went wrong on the server."})

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    # ---------- helpers ----------
    @staticmethod
    def require_member(conn, gid, mid):
        row = conn.execute("SELECT * FROM members WHERE id=? AND group_id=?", (mid, gid)).fetchone()
        if not row:
            raise ApiError(403, "You're not a member of this group.")
        return row

    def group_payload(self, conn, group, me):
        gid = group["id"]
        members = conn.execute(
            "SELECT id, name, birthday FROM members WHERE group_id=? ORDER BY name COLLATE NOCASE", (gid,)
        ).fetchall()
        names = {m["id"]: m["name"] for m in members}
        items = conn.execute(
            "SELECT * FROM items WHERE group_id=? ORDER BY date_added DESC, id DESC", (gid,)
        ).fetchall()
        claims = {}
        for c in conn.execute(
            "SELECT c.* FROM claims c JOIN items i ON i.id=c.item_id WHERE i.group_id=? ORDER BY c.created_at",
            (gid,),
        ):
            claims.setdefault(c["item_id"], []).append(
                {"member_id": c["member_id"], "name": names.get(c["member_id"], "?"), "status": c["status"]}
            )
        out_items = []
        for row in items:
            d = dict(row)
            d["photo_url"] = f"/uploads/{d['photo']}" if d.get("photo") else None
            # The surprise rule: claim info is only ever sent to people who
            # aren't the item's owner (and only to known members).
            if me is not None and d["member_id"] != me:
                d["claims"] = claims.get(d["id"], [])
            out_items.append(d)

        santa = None
        draw = conn.execute("SELECT * FROM santa_draws WHERE group_id=?", (gid,)).fetchone()
        if draw:
            santa = {"drawn_by": draw["drawn_by"], "budget": draw["budget"], "drawn_at": draw["drawn_at"]}
            mine = conn.execute(
                "SELECT receiver_id FROM santa WHERE group_id=? AND giver_id=?", (gid, me)
            ).fetchone()
            santa["receiver_id"] = mine["receiver_id"] if mine else None
        return {
            "group": {"name": group["name"], "code": group["code"]},
            "members": [dict(m) for m in members],
            "items": out_items,
            "santa": santa,
        }

    # ---------- API ----------
    def route_api(self, method, path):
        parts = [p for p in path.split("/") if p][1:]  # drop "api"

        # POST /api/preview {url}  -> autofill details from a product link
        if parts == ["preview"] and method == "POST":
            return self.send_json(200, link_preview(self.read_json().get("url")))

        # POST /api/groups  {name, member}
        if parts == ["groups"] and method == "POST":
            body = self.read_json()
            gname = (body.get("name") or "").strip()[:100]
            member = (body.get("member") or "").strip()[:60]
            if not gname or not member:
                raise ApiError(400, "Group name and your name are required.")
            with db() as conn:
                for _ in range(10):
                    code = new_code()
                    if not conn.execute("SELECT 1 FROM groups WHERE code=?", (code,)).fetchone():
                        break
                cur = conn.execute(
                    "INSERT INTO groups (name, code, created_at) VALUES (?,?,?)", (gname, code, now())
                )
                gid = cur.lastrowid
                mid = conn.execute(
                    "INSERT INTO members (group_id, name, created_at) VALUES (?,?,?)", (gid, member, now())
                ).lastrowid
            return self.send_json(201, {"code": code, "member_id": mid})

        if len(parts) >= 2 and parts[0] == "groups":
            code = parts[1].upper()
            with db() as conn:
                group = conn.execute("SELECT * FROM groups WHERE code=?", (code,)).fetchone()
            if not group:
                raise ApiError(404, "No group found with that code.")
            gid = group["id"]
            rest = parts[2:]

            # GET /api/groups/CODE?me=MEMBER_ID  -> group, members, items (+ claims on others' items)
            if not rest and method == "GET":
                try:
                    me = int(self.query.get("me", ""))
                except ValueError:
                    me = None
                with db() as conn:
                    if me is not None and not conn.execute(
                        "SELECT 1 FROM members WHERE id=? AND group_id=?", (me, gid)
                    ).fetchone():
                        me = None
                    return self.send_json(200, self.group_payload(conn, group, me))

            # POST /api/groups/CODE/members  {name}  (join, or rejoin as existing name)
            if rest == ["members"] and method == "POST":
                name = (self.read_json().get("name") or "").strip()[:60]
                if not name:
                    raise ApiError(400, "Your name is required.")
                with db() as conn:
                    row = conn.execute(
                        "SELECT id FROM members WHERE group_id=? AND name=? COLLATE NOCASE", (gid, name)
                    ).fetchone()
                    mid = row["id"] if row else conn.execute(
                        "INSERT INTO members (group_id, name, created_at) VALUES (?,?,?)", (gid, name, now())
                    ).lastrowid
                return self.send_json(200, {"member_id": mid})

            # PUT /api/groups/CODE/members/ID  {member_id, birthday}
            if len(rest) == 2 and rest[0] == "members" and method == "PUT":
                body = self.read_json()
                if str(body.get("member_id")) != rest[1]:
                    raise ApiError(403, "You can only change your own profile.")
                bday = (body.get("birthday") or "").strip() or None
                if bday:
                    if not re.match(r"^\d{2}-\d{2}$", bday):
                        raise ApiError(400, "Birthday must be MM-DD.")
                    try:
                        date.fromisoformat(f"2000-{bday}")
                    except ValueError:
                        raise ApiError(400, "That isn't a real date.")
                with db() as conn:
                    self.require_member(conn, gid, body.get("member_id"))
                    conn.execute("UPDATE members SET birthday=? WHERE id=?", (bday, body["member_id"]))
                return self.send_json(200, {"ok": True})

            # POST /api/groups/CODE/items
            if rest == ["items"] and method == "POST":
                body = self.read_json()
                fields = clean_item(body)
                mid = body.get("member_id")
                with db() as conn:
                    self.require_member(conn, gid, mid)
                    if body.get("photo"):
                        fields["photo"] = save_photo(body["photo"])
                    elif body.get("photo_remote"):
                        fields["photo"] = save_remote_photo(body["photo_remote"])
                    else:
                        fields["photo"] = None
                    for k, v in (("link", None), ("notes", None), ("priority", 0), ("emoji", None)):
                        fields.setdefault(k, v)
                    cur = conn.execute(
                        """INSERT INTO items (group_id, member_id, list, name, link, photo,
                               price_type, price, notes, date_added, created_at, priority, emoji)
                           VALUES (:gid,:mid,:list,:name,:link,:photo,:price_type,:price,:notes,
                                   :date_added,:created,:priority,:emoji)""",
                        {**fields, "gid": gid, "mid": mid, "created": now()},
                    )
                return self.send_json(201, {"id": cur.lastrowid})

            # PUT / DELETE /api/groups/CODE/items/ID
            if len(rest) == 2 and rest[0] == "items" and method in ("PUT", "DELETE"):
                body = self.read_json()
                with db() as conn:
                    item = conn.execute(
                        "SELECT * FROM items WHERE id=? AND group_id=?", (rest[1], gid)
                    ).fetchone()
                    if not item:
                        raise ApiError(404, "Item not found.")
                    if item["member_id"] != body.get("member_id"):
                        raise ApiError(403, "You can only change your own items.")
                    if method == "DELETE":
                        conn.execute("DELETE FROM items WHERE id=?", (item["id"],))
                        delete_photo(item["photo"])
                        return self.send_json(200, {"ok": True})
                    fields = clean_item(body, partial=True)
                    if body.get("remove_photo") or body.get("photo") or body.get("photo_remote"):
                        delete_photo(item["photo"])
                        if body.get("photo"):
                            fields["photo"] = save_photo(body["photo"])
                        elif body.get("photo_remote"):
                            fields["photo"] = save_remote_photo(body["photo_remote"])
                        else:
                            fields["photo"] = None
                    if fields:
                        sets = ", ".join(f"{k}=:{k}" for k in fields)
                        conn.execute(f"UPDATE items SET {sets} WHERE id=:id", {**fields, "id": item["id"]})
                return self.send_json(200, {"ok": True})

            # POST / DELETE /api/groups/CODE/items/ID/claim  {member_id, status}
            if len(rest) == 3 and rest[0] == "items" and rest[2] == "claim" and method in ("POST", "DELETE"):
                body = self.read_json()
                mid = body.get("member_id")
                with db() as conn:
                    self.require_member(conn, gid, mid)
                    item = conn.execute(
                        "SELECT * FROM items WHERE id=? AND group_id=?", (rest[1], gid)
                    ).fetchone()
                    if not item:
                        raise ApiError(404, "Item not found.")
                    if item["member_id"] == mid:
                        raise ApiError(403, "No peeking at your own gifts! 🙈")
                    if method == "DELETE":
                        conn.execute("DELETE FROM claims WHERE item_id=? AND member_id=?", (item["id"], mid))
                    else:
                        status = body.get("status") or "reserved"
                        if status not in CLAIM_STATUSES:
                            raise ApiError(400, "Invalid status.")
                        conn.execute(
                            """INSERT INTO claims (item_id, member_id, status, created_at) VALUES (?,?,?,?)
                               ON CONFLICT(item_id, member_id) DO UPDATE SET status=excluded.status""",
                            (item["id"], mid, status, now()),
                        )
                return self.send_json(200, {"ok": True})

            # POST /api/groups/CODE/santa {member_id, budget}  -> (re)draw Secret Santa
            # DELETE /api/groups/CODE/santa {member_id}         -> cancel it
            if rest == ["santa"] and method in ("POST", "DELETE"):
                body = self.read_json()
                with db() as conn:
                    me = self.require_member(conn, gid, body.get("member_id"))
                    conn.execute("DELETE FROM santa WHERE group_id=?", (gid,))
                    conn.execute("DELETE FROM santa_draws WHERE group_id=?", (gid,))
                    if method == "POST":
                        ids = [r["id"] for r in conn.execute("SELECT id FROM members WHERE group_id=?", (gid,))]
                        if len(ids) < 3:
                            raise ApiError(400, "You need at least 3 people in the group for Secret Santa.")
                        budget = to_price(body.get("budget"))
                        for giver, receiver in derangement(ids).items():
                            conn.execute(
                                "INSERT INTO santa (group_id, giver_id, receiver_id) VALUES (?,?,?)",
                                (gid, giver, receiver),
                            )
                        conn.execute(
                            "INSERT INTO santa_draws (group_id, drawn_by, budget, drawn_at) VALUES (?,?,?,?)",
                            (gid, me["name"], budget, now()),
                        )
                return self.send_json(200, {"ok": True})

        raise ApiError(404, "Unknown API route.")


if __name__ == "__main__":
    init_db()
    print(f"🎁 The Wishlist is running at http://localhost:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
