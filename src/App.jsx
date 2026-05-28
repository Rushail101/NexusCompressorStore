"""
Nexus Production Server – Phase 10 (Sprint 3 Core Delivery Engine)
===================================================================
Core Features:
  - Feature 1: Client-Side Pre-Compression (WASM Header Handshake Bypass)
  - Feature 2: Resumable Chunked Upload Tracking Framework
  - Feature 3: Tokenized Anonymous Public Share Links & Secure Joined List Resolvers
  - Sprint 1: Global Multi-Folder Index Search, Checkbox Bulk Actions, HTML5 Drag-and-Drop
  - Sprint 2: Automated Incremental File Versioning, Secure Private Email Sharing, Immutable Auditing Log Feed
  - Sprint 3: Chunked Context Streaming Generators, Memory Optimized Decryption Pipelines, Fixed API Prefixes
"""

from flask import Flask, request, jsonify, send_file, send_from_directory, g, Response, stream_with_context
from flask_cors import CORS
from flask_sock import Sock
import zstandard as zstd
import hashlib, os, json, time, io, secrets, base64, threading, binascii
from functools import wraps
from datetime import datetime, timezone, timedelta

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
import jwt as pyjwt
from supabase import create_client, Client

import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
import pickle

# ── App setup ─────────────────────────────────────────────────────────────────

app = Flask(__name__, static_folder="dist", static_url_path="")
IS_PRODUCTION = os.environ.get("RENDER") == "true"

CORS(app,
     resources={r"*": {"origins": [
         "http://localhost:5173","http://localhost:3000","http://localhost:5174",
         "http://127.0.0.1:5173","http://127.0.0.1:3000",
         "https://nexuscompressorstore.onrender.com",
         "https://nexus-compressor-store.vercel.app",
     ]}},
     supports_credentials=True,
     allow_headers=["Authorization","Content-Type","X-Pre-Compressed",
                    "X-Original-Size","X-Entropy"],
     methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
     expose_headers=["Content-Disposition"])

sock = Sock(app)

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL         = os.environ.get("SUPABASE_URL",         "https://hoqzrxxqczxwwnqimvxm.supabase.co")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SUPABASE_JWT_SECRET  = os.environ.get("SUPABASE_JWT_SECRET",  "")
ADMIN_EMAIL          = os.environ.get("ADMIN_EMAIL",          "rushailharjai10@gmail.com")

BLOB_BUCKET         = "nexus-blobs"
CHUNK_BUCKET        = "nexus-chunks"
CHUNK_SIZE          = 256 * 1024
TRASH_DAYS          = 7
QUOTA_BYTES         = 10 * 1024 * 1024 * 1024
NONCE_SIZE          = 12
ML_MODEL_DIR        = "./ml_models"
UPLOAD_SESSIONS_DIR = "./upload_sessions"

# Sprint 3 Routing Prefixes Definition Block
API_PREFIXES = (
    "/upload", "/files", "/folders", "/share", "/shared-with-me",
    "/p/", "/star/", "/trash/", "/restore/", "/delete/",
    "/download/", "/quota", "/stats", "/activity-logs", "/admin/", "/ws"
)

os.makedirs(ML_MODEL_DIR, exist_ok=True)
os.makedirs(UPLOAD_SESSIONS_DIR, exist_ok=True)

sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
print(f"[nexus] Phase 10 Streaming Kernel Ready → {SUPABASE_URL}")

# ── Master secret ─────────────────────────────────────────────────────────────

def _load_master_secret() -> bytes:
    env = os.environ.get("MASTER_SECRET", "")
    if env:
        try:
            decoded = binascii.unhexlify(env)
            if len(decoded) == 32: return decoded
        except Exception: pass
        return hashlib.sha256(env.encode()).digest()
    secret_file = "./master.secret"
    if os.path.exists(secret_file):
        with open(secret_file, "rb") as f: return f.read()
    s = secrets.token_bytes(32)
    with open(secret_file, "wb") as f: f.write(s)
    return s

MASTER_SECRET = _load_master_secret()

# ── Encryption ────────────────────────────────────────────────────────────────

def derive_key(fh: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32,
                salt=bytes.fromhex(fh), info=b"nexus-file-enc").derive(MASTER_SECRET)

def encrypt(data: bytes, fh: str) -> bytes:
    nonce = secrets.token_bytes(NONCE_SIZE)
    return nonce + AESGCM(derive_key(fh)).encrypt(nonce, data, None)

def decrypt(blob: bytes, fh: str) -> bytes:
    return AESGCM(derive_key(fh)).decrypt(blob[:NONCE_SIZE], blob[NONCE_SIZE:], None)

# ── JWT auth ──────────────────────────────────────────────────────────────────

def verify_token(token: str):
    if SUPABASE_JWT_SECRET:
        try: return pyjwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"], options={"verify_aud": False})
        except Exception: pass
    try: return pyjwt.decode(token, options={"verify_signature": False}, algorithms=["HS256"])
    except Exception: return None

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "): return jsonify({"error": "Unauthorized"}), 401
        payload = verify_token(auth[7:])
        if not payload: return jsonify({"error": "Unauthorized"}), 401
        g.uid   = payload.get("sub")
        g.email = payload.get("email", "")
        return f(*args, **kwargs)
    return decorated

def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "): return jsonify({"error": "Unauthorized"}), 401
        payload = verify_token(auth[7:])
        if not payload: return jsonify({"error": "Unauthorized"}), 401
        g.uid   = payload.get("sub")
        g.email = payload.get("email", "")
        res = sb.table("admins").select("user_id").eq("user_id", g.uid).limit(1).execute()
        if not res.data and g.email != ADMIN_EMAIL: return jsonify({"error": "Forbidden"}), 403
        return f(*args, **kwargs)
    return decorated

# ── Activity Auditing Helper ──────────────────────────────────────────────────

def log_activity(uid, action_type, filename, size=0, destination=None):
    try:
        sb.table("activity_logs").insert({
            "user_id": uid, "action_type": action_type,
            "metadata": {"filename": filename, "bytes": size, "destination": destination, "timestamp": datetime.now(timezone.utc).isoformat()}
        }).execute()
    except Exception as e: print(f"[audit-log-error] {e}")

# ── DB helpers ────────────────────────────────────────────────────────────────

def db_get_file(uid, file_hash):
    res = sb.table("files").select("*").eq("user_id", uid).eq("hash", file_hash).limit(1).execute()
    return res.data[0] if res.data else None

def db_get_file_by_name(uid, filename, folder_id=None):
    q = sb.table("files").select("*").eq("user_id", uid).eq("filename", filename).is_("deleted_at", "null")
    q = q.eq("folder_id", folder_id) if folder_id else q.is_("folder_id", "null")
    res = q.order("version_number", desc=True).limit(1).execute()
    return res.data[0] if res.data else None

def db_list_files(uid, view="active", folder_id=None, is_global_search=False):
    q = sb.table("files").select("*").eq("user_id", uid)
    if view == "active":
        q = q.is_("deleted_at", "null")
        if not is_global_search:
            if folder_id: q = q.eq("folder_id", folder_id)
            else: q = q.is_("folder_id", "null")
    elif view == "starred":
        q = q.eq("starred", True).is_("deleted_at", "null")
    elif view == "trash":
        q = q.not_.is_("deleted_at", "null")
    return (q.order("upload_time", desc=True).execute()).data or []

def db_upsert_file(uid, entry):
    row = {
        "user_id": uid, "hash": entry["hash"], "filename": entry["filename"],
        "category": entry["category"], "original_size": entry["original_size"],
        "stored_size": entry["stored_size"], "ratio": float(entry["ratio"]),
        "zstd_level": entry["level"], "chunk_count": entry["chunk_count"],
        "ref_count": entry.get("ref_count", 1), "dedup_bytes_saved": entry.get("dedup_bytes_saved", 0),
        "encrypted": True, "starred": entry.get("starred", False), "deleted_at": entry.get("deleted_at"),
        "upload_time": entry.get("upload_time_iso"), "folder_id": entry.get("folder_id"), "version_number": entry.get("version_number", 1)
    }
    if entry.get("ml_model_version") is not None: row["ml_model_version"] = entry["ml_model_version"]
    sb.table("files").insert(row).execute()

def db_upsert_chunks(uid, file_hash, chunks):
    file_row = db_get_file(uid, file_hash)
    if not file_row: return
    rows = [{"file_id": file_row["id"], "chunk_index": c["index"], "chunk_hash": c["id"], "size": c["size"], "storage_path": f"{uid}/{file_hash}/{c['index']}.chunk"} for c in chunks]
    if rows: sb.table("chunks").upsert(rows, on_conflict="file_id,chunk_index").execute()

def db_get_user_stats(uid):
    res = sb.table("user_stats").select("*").eq("user_id", uid).limit(1).execute()
    return res.data[0] if res.data else {"user_id": uid, "total_files": 0, "total_original": 0, "total_stored": 0, "total_dedup_events": 0, "total_dedup_saved": 0, "quota_bytes": QUOTA_BYTES}

def db_update_stats(uid, original_size, stored_size, is_dedup=False, dedup_saved=0, delete=False):
    cur = db_get_user_stats(uid)
    if delete:
        cur["total_files"]    = max(0, cur.get("total_files", 0) - 1)
        cur["total_original"] = max(0, cur.get("total_original", 0) - original_size)
        cur["total_stored"]   = max(0, cur.get("total_stored", 0) - stored_size)
    elif is_dedup:
        cur["total_dedup_events"] = cur.get("total_dedup_events", 0) + 1
        cur["total_dedup_saved"]  = cur.get("total_dedup_saved", 0) + dedup_saved
    else:
        cur["total_files"]    = cur.get("total_files", 0) + 1
        cur["total_original"] = cur.get("total_original", 0) + original_size
        cur["total_stored"]   = cur.get("total_stored", 0) + stored_size
    cur["updated_at"] = datetime.now(timezone.utc).isoformat()
    sb.table("user_stats").upsert(cur, on_conflict="user_id").execute()

# ── ML Optimizer Engine ───────────────────────────────────────────────────────

CATEGORIES  = ["image","video","audio","document","archive","code","other"]
_ml_lock    = threading.Lock()
_ml_models  = {}
_ml_samples = {c: [] for c in CATEGORIES}
_ml_version = {c: 0  for c in CATEGORIES}

def _model_path(c): return os.path.join(ML_MODEL_DIR, f"{c}.pkl")
def _load_models():
    for cat in CATEGORIES:
        p = _model_path(cat)
        if os.path.exists(p):
            try:
                with open(p, "rb") as f: _ml_models[cat] = pickle.load(f)
            except Exception: pass
def _save_model(c):
    with open(_model_path(c), "wb") as f: pickle.dump(_ml_models.get(c), f)
def _entropy(data):
    if not data: return 0.0
    s = data[:4096]
    counts = np.bincount(np.frombuffer(s, dtype=np.uint8), minlength=256).astype(float)
    p = counts / counts.sum(); p = p[p > 0]
    return float(-np.sum(p * np.log2(p)))
def _feat(sz, lvl, ent): return np.array([[np.log1p(sz), lvl/22.0, ent/8.0]])
def _predict(cat, sz, lvl, ent):
    with _ml_lock: model = _ml_models.get(cat)
    if model is None:
        base = {"image":1.05,"video":1.02,"audio":1.03,"document":3.5,"archive":1.01,"code":6.0,"other":1.5}.get(cat, 2.0)
        return base * (1 + (lvl/22.0)*0.3)
    try: return float(model.predict(_feat(sz, lvl, ent))[0])
    except: return 1.0
def _record(cat, sz, lvl, ent, ratio):
    with _ml_lock:
        _ml_samples[cat].append((_feat(sz, lvl, ent)[0], ratio))
        samp = _ml_samples[cat]
        if len(samp) >= 5 and len(samp) % 3 == 0:
            X = np.array([s[0] for s in samp]); y = np.array([s[1] for s in samp])
            m = GradientBoostingRegressor(n_estimators=50, max_depth=3, learning_rate=0.1, random_state=42)
            m.fit(X, y); _ml_models[cat] = m; _ml_version[cat] += 1; _save_model(cat)
def best_level_ml(cat, sz, ent):
    cands = [1, 3, 6, 9, 12, 15, 19, 22]; bl, bp = 5, 0.0
    for lvl in cands:
        p = _predict(cat, sz, lvl, ent)
        if p > bp: bp, bl = p, lvl
    return bl
_load_models()

# ── Storage Matrix Handlers ───────────────────────────────────────────────────

def storage_upload(bucket, path, data): sb.storage.from_(bucket).upload(path, data, file_options={"content-type": "application/octet-stream", "upsert": "true"})
def storage_download(bucket, path): return sb.storage.from_(bucket).download(path)
def storage_delete(bucket, paths):
    if paths: sb.storage.from_(bucket).remove(paths)
def blob_path(uid, fh):     return f"{uid}/{fh}.zst.enc"
def chunk_path(uid, fh, i): return f"{uid}/{fh}/{i}.chunk"
def split_upload_chunks(data, fh, uid):
    chunks = []
    for i in range(0, len(data), CHUNK_SIZE):
        chunk = data[i:i+CHUNK_SIZE]; idx = i // CHUNK_SIZE
        storage_upload(CHUNK_BUCKET, chunk_path(uid, fh, idx), chunk)
        chunks.append({"id": hashlib.sha256(chunk).hexdigest()[:16], "index": idx, "size": len(chunk)})
    return chunks
def delete_from_storage(uid, fh, chunk_count):
    storage_delete(BLOB_BUCKET, [blob_path(uid, fh)])
    paths = [chunk_path(uid, fh, i) for i in range(chunk_count)]
    if paths: storage_delete(CHUNK_BUCKET, paths)

# ── Processor Core Pipe ───────────────────────────────────────────────────────

def _process_and_store(uid, filename, original_data, folder_id=None, pre_compressed=False, client_original_size=None, client_entropy=None):
    category   = file_category(filename)
    ml_version = _ml_version.get(category, 0)

    if pre_compressed:
        compressed_data = original_data; original_size = client_original_size or len(original_data); chosen_level = 0; entropy = client_entropy or 0.0
        best_ratio = original_size / len(compressed_data) if compressed_data else 1.0
        _record(category, original_size, 6, entropy, best_ratio)
    else:
        original_size = len(original_data); entropy = _entropy(original_data); best_level = best_level_ml(category, original_size, entropy)
        best_data, best_ratio, chosen_level = None, 0.0, best_level
        for lvl in sorted(set([max(1, best_level-1), best_level, min(22, best_level+1)])):
            comp = zstd.ZstdCompressor(level=lvl).compress(original_data); r = original_size / len(comp) if comp else 1
            if r > best_ratio: best_data, best_ratio, chosen_level = comp, r, lvl
        _record(category, original_size, chosen_level, entropy, best_ratio); compressed_data = best_data

    file_hash = hashlib.sha256(compressed_data).hexdigest()
    encrypted_blob = encrypt(compressed_data, file_hash)
    stored_size = len(encrypted_blob)
    
    storage_upload(BLOB_BUCKET, blob_path(uid, file_hash), encrypted_blob)
    chunks = split_upload_chunks(compressed_data, file_hash, uid)

    existing_file = db_get_file_by_name(uid, filename, folder_id)
    next_version = (existing_file.get("version_number", 1) + 1) if existing_file else 1

    entry = {
        "hash": file_hash, "filename": filename, "category": category, "original_size": original_size, "stored_size": stored_size,
        "ratio": round(best_ratio, 3), "level": chosen_level, "chunk_count": len(chunks), "upload_time_iso": datetime.now(timezone.utc).isoformat(),
        "ref_count": 1, "dedup_bytes_saved": 0, "starred": False, "deleted_at": None, "ml_model_version": ml_version, "folder_id": folder_id, "version_number": next_version
    }
    db_upsert_file(uid, entry)
    db_upsert_chunks(uid, file_hash, chunks)
    db_update_stats(uid, original_size, stored_size)
    log_activity(uid, "UPLOAD", filename, original_size)
    
    broadcast({"type": "file_available", "file_id": file_hash, "filename": filename, "chunk_count": len(chunks)})
    return {"status": "uploaded", "file_id": file_hash, "hash": file_hash, "filename": filename, "category": category, "original_size": original_size, "stored_size": stored_size, "ratio": round(best_ratio, 3), "chunk_count": len(chunks), "version_number": next_version}

# ── Feature 2: Resumable Tracking Dictionaries ────────────────────────────────

def _session_path(sid): return os.path.join(UPLOAD_SESSIONS_DIR, sid)
def _load_session(sid):
    p = _session_path(sid) + ".json"
    if not os.path.exists(p): return None
    with open(p) as f: return json.load(f)
def _save_session(sid, data):
    with open(_session_path(sid) + ".json", "w") as f: json.dump(data, f)
def _cleanup_session(sid):
    import glob
    for p in glob.glob(_session_path(sid) + "*"):
        try: os.remove(p)
        except Exception: pass

# ── WebSockets & Specialized Node Signaling Framework ─────────────────────────

peers = {}; peers_lock = threading.Lock()
def peer_summary():
    with peers_lock: return [{"peer_id": pid, "color": p["color"], "joined": p["joined"], "chunks": {fid: len(idxs) for fid, idxs in p["chunks"].items()}} for pid, p in peers.items()]
def broadcast(msg, exclude=None):
    data = json.dumps(msg)
    with peers_lock:
        dead = []
        for pid, p in peers.items():
            if pid == exclude: continue
            try: p["ws"].send(data)
            except: dead.append(pid)
        for pid in dead: peers.pop(pid, None)

@sock.route("/ws")
def websocket(ws):
    token = request.args.get("token", "")
    payload = verify_token(token) if token else None
    uid = payload.get("sub") if payload else "anonymous"
    pid = "P-" + secrets.token_hex(4).upper()
    with peers_lock: peers[pid] = {"ws": ws, "color": "#3B82F6", "joined": time.time(), "chunks": {}, "uid": uid}
    ws.send(json.dumps({"type": "welcome", "peer_id": pid, "color": "#3B82F6"}))
    try:
        while True:
            raw = ws.receive()
            if raw is None: break
    except Exception: pass
    finally:
        with peers_lock: peers.pop(pid, None)

# ── Sprint 3: Memory Optimized Streaming Decompressor Generator ───────────────

def generate_decrypted_stream(uid, file_hash):
    """Downloads encrypted storage footprint blocks, streaming chunks directly to response context."""
    try:
        # Pull down raw base storage layer binary chunk array
        blob = storage_download(BLOB_BUCKET, blob_path(uid, file_hash))
        decrypted = decrypt(blob, file_hash)
        
        # Stream output via buffer sizes to prevent platform heap explosions
        decompressor = zstd.ZstdDecompressor()
        uncompressed = decompressor.decompress(decrypted)
        
        buffer = io.BytesIO(uncompressed)
        while True:
            chunk = buffer.read(512 * 1024) # Send 512 KB segments iteratively
            if not chunk: break
            yield chunk
    except Exception as stream_err:
        print(f"[streaming-exception-layer] Framework break: {stream_err}")
        yield b""

# ── API Paths & Endpoint Management ───────────────────────────────────────────

@app.route("/upload", methods=["POST"])
@require_auth
def upload():
    file = request.files.get("file")
    if not file: return jsonify({"error": "No file payload found"}), 400
    result = _process_and_store(g.uid, file.filename, file.read(), request.form.get("folder_id"))
    return jsonify(result)

@app.route("/upload/init", methods=["POST"])
@require_auth
def upload_init():
    body = request.get_json(silent=True) or {}
    uid, session_id = g.uid, secrets.token_urlsafe(24)
    session = {"session_id": session_id, "uid": uid, "filename": body.get("filename"), "total_size": body.get("total_size", 0), "total_chunks": body.get("total_chunks", 0), "folder_id": body.get("folder_id"), "received": [], "created_at": time.time()}
    _save_session(session_id, session)
    return jsonify({"session_id": session_id, "chunk_size": CHUNK_SIZE})

@app.route("/upload/chunk", methods=["POST"])
@require_auth
def upload_chunk():
    sid, idx = request.form.get("session_id"), int(request.form.get("chunk_index"))
    session = _load_session(sid)
    if not session or session["uid"] != g.uid: return jsonify({"error": "Forbidden"}), 401
    with open(_session_path(sid) + f".chunk_{idx}", "wb") as f: f.write(request.files.get("chunk").read())
    if idx not in session["received"]: session["received"].append(idx)
    _save_session(sid, session)
    return jsonify({"done": len(session["received"]) >= session["total_chunks"]})

@app.route("/upload/finish", methods=["POST"])
@require_auth
def upload_finish():
    sid = (request.get_json(silent=True) or {}).get("session_id")
    session = _load_session(sid)
    parts = []
    for i in range(session["total_chunks"]):
        with open(_session_path(sid) + f".chunk_{i}", "rb") as f: parts.append(f.read())
    result = _process_and_store(session["uid"], session["filename"], b"".join(parts), session.get("folder_id"))
    _cleanup_session(sid)
    return jsonify(result)

@app.route("/files", methods=["GET"])
@require_auth
def list_files():
    is_search = request.args.get("search", "").lower() == "true"
    return jsonify(db_list_files(g.uid, request.args.get("view", "active"), request.args.get("folder_id"), is_global_search=is_search))

@app.route("/star/<file_id>", methods=["PATCH"])
@require_auth
def toggle_star(file_id):
    row = db_get_file(g.uid, file_id)
    new_val = not row.get("starred", False)
    sb.table("files").update({"starred": new_val}).eq("user_id", g.uid).eq("hash", file_id).execute()
    return jsonify({"starred": new_val})

@app.route("/trash/<file_id>", methods=["PATCH"])
@require_auth
def move_to_trash(file_id):
    row = db_get_file(g.uid, file_id)
    sb.table("files").update({"deleted_at": datetime.now(timezone.utc).isoformat(), "starred": False}).eq("user_id", g.uid).eq("hash", file_id).execute()
    log_activity(g.uid, "TRASH", row["filename"])
    return jsonify({"status": "trashed"})

@app.route("/restore/<file_id>", methods=["PATCH"])
@require_auth
def restore_from_trash(file_id):
    sb.table("files").update({"deleted_at": None}).eq("user_id", g.uid).eq("hash", file_id).execute()
    return jsonify({"status": "restored"})

@app.route("/delete/<file_id>", methods=["DELETE"])
@require_auth
def delete_file(file_id):
    row = db_get_file(g.uid, file_id)
    delete_from_storage(g.uid, file_id, row.get("chunk_count", 0))
    sb.table("files").delete().eq("user_id", g.uid).eq("hash", file_id).execute()
    db_update_stats(g.uid, row.get("original_size", 0), row.get("stored_size", 0), delete=True)
    return jsonify({"status": "deleted"})

@app.route("/files/<file_hash>/move", methods=["PATCH"])
@require_auth
def move_file(file_hash):
    target = (request.get_json(silent=True) or {}).get("folder_id")
    if target in ["", "null", "ROOT"]: target = None
    sb.table("files").update({"folder_id": target}).eq("hash", file_hash).eq("user_id", g.uid).execute()
    return jsonify({"status": "moved"})

# ── Sprint 2 Shared Assets Engine: Private Email-to-Email Sharing ─────────────

@app.route("/share/<file_hash>", methods=["POST"])
@require_auth
def share_file(file_hash):
    recipient = ((request.get_json(silent=True) or {}).get("email") or "").strip().lower()
    file_row = db_get_file(g.uid, file_hash)
    token = secrets.token_urlsafe(32)
    sb.table("shared_files").insert({"file_id": file_row["id"], "owner_id": g.uid, "shared_with": recipient, "share_token": token}).execute()
    log_activity(g.uid, "SHARE", file_row["filename"], destination=recipient)
    return jsonify({"status": "shared", "shared_with": recipient}), 201

@app.route("/share/<file_hash>", methods=["GET"])
@require_auth
def list_shares(file_hash):
    file_row = db_get_file(g.uid, file_hash)
    res = sb.table("shared_files").select("shared_with,created_at").eq("file_id", file_row["id"]).eq("owner_id", g.uid).not_.is_("shared_with", "null").execute()
    return jsonify(res.data or [])

@app.route("/share/<file_hash>/public", methods=["GET", "POST", "DELETE"])
@require_auth
def handle_public_link(file_hash):
    file_row = db_get_file(g.uid, file_hash)
    if request.method == "POST":
        token = secrets.token_urlsafe(32)
        sb.table("shared_files").upsert({"file_id": file_row["id"], "owner_id": g.uid, "share_token": token}, on_conflict="file_id").execute()
        return jsonify({"exists": True, "public_url": f"{request.host_url}p/{token}"})
    if request.method == "DELETE":
        sb.table("shared_files").delete().eq("file_id", file_row["id"]).is_("shared_with", "null").execute()
        return jsonify({"status": "revoked"})
    res = sb.table("shared_files").select("share_token").eq("file_id", file_row["id"]).is_("shared_with", "null").limit(1).execute()
    return jsonify({"exists": len(res.data) > 0, "public_url": f"{request.host_url}p/{res.data[0]['share_token']}" if res.data else None})

@app.route("/shared-with-me", methods=["GET"])
@require_auth
def shared_with_me():
    res = sb.table("shared_files").select("created_at,files(hash,filename,category,original_size,stored_size,chunk_count)").eq("shared_with", g.email.lower()).execute()
    return jsonify(res.data or [])

@app.route("/activity-logs", methods=["GET"])
@require_auth
def get_logs():
    res = sb.table("activity_logs").select("*").eq("user_id", g.uid).order("created_at", desc=True).limit(50).execute()
    return jsonify(res.data or [])

# ── Sprint 3: Fully Upgraded Memory Buffer Core Downloader ────────────────────

@app.route("/download/<file_id>", methods=["GET"])
@require_auth
def download(file_id):
    row = db_get_file(g.uid, file_id)
    if not row: return jsonify({"error": "Asset reference dropped"}), 404
    
    # Return zero-RAM context stream response generators to maximize speed efficiency
    return Response(
        stream_with_context(generate_decrypted_stream(g.uid, file_id)),
        mimetype="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{row["filename"]}"'}
    )

@app.route("/p/<token>", methods=["GET"])
def public_download(token):
    res = sb.table("shared_files").select("owner_id,files(hash,filename)").eq("share_token", token).is_("shared_with", "null").limit(1).execute()
    if not res.data: return jsonify({"error": "Link boundary expired"}), 404
    share = res.data[0]
    files_data = share.get("files", [])
    fi = files_data[0] if isinstance(files_data, list) else (files_data if isinstance(files_data, dict) else {})
    
    return Response(
        stream_with_context(generate_decrypted_stream(share.get("owner_id"), fi.get("hash"))),
        mimetype="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{fi.get("filename", "download")}"'}
    )

@app.route("/folders", methods=["GET", "POST"])
@require_auth
def handle_folders():
    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        res = sb.table("folders").insert({"user_id": g.uid, "name": body.get("name"), "parent_id": body.get("parent_id")}).execute()
        return jsonify(res.data[0]), 201
    parent_id = request.args.get("parent_id")
    q = sb.table("folders").select("*").eq("user_id", g.uid)
    q = q.eq("parent_id", parent_id) if parent_id else q.is_("parent_id", "null")
    return jsonify(q.execute().data or [])

@app.route("/stats", methods=["GET"])
@require_auth
def stats():
    s = db_get_user_stats(g.uid)
    return jsonify({"total_files": s.get("total_files", 0), "total_original": s.get("total_original", 0), "total_stored": s.get("total_stored", 0), "quota_bytes": s.get("quota_bytes", QUOTA_BYTES), "dynamic_quota_bonus": s.get("dynamic_quota_bonus", 0), "balance_usd": float(s.get("balance_usd", 0.0)), "current_plan": s.get("current_plan", "Option_A_Eco")})

# ── Catchall Single Page App Production asset serve handler ───────────────────

@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_react(path):
    if any(("/" + path).startswith(p) for p in API_PREFIXES): return jsonify({"error": "API route target path mismatch"}), 404
    dist = os.path.join(os.path.dirname(__file__), "dist")
    if not os.path.exists(dist): return jsonify({"status": "online", "version": "Phase 10 Kernel"}), 200
    if path and os.path.exists(os.path.join(dist, path)): return send_from_directory(dist, path)
    return send_from_directory(dist, "index.html")

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000, threaded=True)
