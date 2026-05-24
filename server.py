"""
Nexus – Phase 7: Supabase DB + Storage + ML compression model
=============================================================
What's new vs Phase 6:
  • Metadata stored in Supabase DB (files, chunks, user_stats tables)
    instead of local meta.json — source of truth is now the DB
  • Duplicate filename detection: upload returns 409 if user already
    has an active (non-trashed) file with the same filename
  • Duplicate hash detection (dedup): still works as before
  • Phase 7 ML: a lightweight GradientBoosting model trained per category
    on historical compression samples. Falls back to heuristic if < 5 samples.
  • Supabase Storage still used for blobs and chunks (Phase 6)
  • local meta.json is gone — all reads/writes go through Supabase DB

Install:
    pip install supabase PyJWT zstandard cryptography scikit-learn numpy flask flask-sock flask-cors
"""

from flask import Flask, request, jsonify, send_file, g
from flask_cors import CORS
from flask_sock import Sock
import zstandard as zstd
import hashlib, os, json, time, io, secrets, base64, threading
from functools import wraps

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
import jwt as pyjwt
from supabase import create_client, Client

import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
import pickle

app  = Flask(__name__)

# Allow requests from Vite dev server (5173) and any other local port.
# In production replace with your actual domain.
CORS(app,
     resources={r"/*": {"origins": [
         "http://localhost:5173",
         "http://localhost:3000",
         "http://localhost:5174",
         "http://127.0.0.1:5173",
         "http://127.0.0.1:3000",
     ]}},
     supports_credentials=True,
     allow_headers=["Authorization", "Content-Type"],
     methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
     expose_headers=["Content-Disposition"],
)
sock = Sock(app)

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL         = os.environ.get("SUPABASE_URL",         "https://hoqzrxxqczxwwnqimvxm.supabase.co")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhvcXpyeHhxY3p4d3ducWltdnhtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzI3MDMzOCwiZXhwIjoyMDgyODQ2MzM4fQ.v_YOgXRbcK6FwzOgcfbaOxt7R8J6mqlaT7puet-qpvo")
SUPABASE_JWT_SECRET  = os.environ.get("SUPABASE_JWT_SECRET",  "SIBvO35YB+bRG2O7skHYiPxEO3cjOEocDDsOePVQXfZWytAffOB25Yv3ljaPruFgceQFkZpmiNXLryawcciizA==")

BLOB_BUCKET  = "nexus-blobs"
CHUNK_BUCKET = "nexus-chunks"
CHUNK_SIZE   = 256 * 1024
TRASH_DAYS   = 7

SECRET_FILE  = "./master.secret"
NONCE_SIZE   = 12
ML_MODEL_DIR = "./ml_models"
os.makedirs(ML_MODEL_DIR, exist_ok=True)

# ── Supabase client ───────────────────────────────────────────────────────────

sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
print(f"[nexus] Supabase connected → {SUPABASE_URL}")

# ── DB helpers ────────────────────────────────────────────────────────────────

def db_get_file(uid: str, file_hash: str) -> dict | None:
    """Fetch a single file row by uid + hash."""
    res = (sb.table("files")
             .select("*")
             .eq("user_id", uid)
             .eq("hash", file_hash)
             .limit(1)
             .execute())
    return res.data[0] if res.data else None


def db_get_file_by_name(uid: str, filename: str) -> dict | None:
    """
    Fetch an active (non-trashed) file row by uid + filename.
    Used for duplicate filename detection.
    """
    res = (sb.table("files")
             .select("id, filename, hash")
             .eq("user_id", uid)
             .eq("filename", filename)
             .is_("deleted_at", "null")
             .limit(1)
             .execute())
    return res.data[0] if res.data else None


def db_list_files(uid: str, view: str = "active") -> list:
    """List files for a user filtered by view."""
    q = sb.table("files").select("*").eq("user_id", uid)
    if view == "active":
        q = q.is_("deleted_at", "null")
    elif view == "starred":
        q = q.eq("starred", True).is_("deleted_at", "null")
    elif view == "trash":
        q = q.not_.is_("deleted_at", "null")
    res = q.order("upload_time", desc=True).execute()
    return res.data or []


def db_upsert_file(uid: str, entry: dict):
    """
    Insert or update a file row.
    Uses check-then-insert/update to avoid ON CONFLICT constraint dependency.
    """
    row = {
        "user_id":           uid,
        "hash":              entry["hash"],
        "filename":          entry["filename"],
        "category":          entry["category"],
        "original_size":     entry["original_size"],
        "stored_size":       entry["stored_size"],
        "ratio":             float(entry["ratio"]),
        "zstd_level":        entry["level"],
        "chunk_count":       entry["chunk_count"],
        "ref_count":         entry.get("ref_count", 1),
        "dedup_bytes_saved": entry.get("dedup_bytes_saved", 0),
        "encrypted":         True,
        "starred":           entry.get("starred", False),
        "deleted_at":        entry.get("deleted_at"),
        "upload_time":       entry.get("upload_time_iso"),
    }

    # Safely add optional columns that may not exist in older DB schemas
    optional_cols = {"ml_model_version": entry.get("ml_model_version")}
    for col, val in optional_cols.items():
        if val is not None:
            row[col] = val

    # Check if row already exists
    existing = db_get_file(uid, entry["hash"])
    if existing:
        # Update existing row by its primary key
        update_data = {k: v for k, v in row.items() if k not in ("user_id",)}
        try:
            sb.table("files").update(update_data).eq("user_id", uid).eq("hash", entry["hash"]).execute()
        except Exception as e:
            # Strip any columns that caused errors and retry
            for bad_col in ["ml_model_version"]:
                if bad_col in str(e):
                    update_data.pop(bad_col, None)
            sb.table("files").update(update_data).eq("user_id", uid).eq("hash", entry["hash"]).execute()
    else:
        # Insert new row
        try:
            sb.table("files").insert(row).execute()
        except Exception as e:
            for bad_col in ["ml_model_version"]:
                if bad_col in str(e):
                    row.pop(bad_col, None)
            sb.table("files").insert(row).execute()


def db_upsert_chunks(uid: str, file_hash: str, chunks: list):
    """Upsert chunk metadata rows."""
    # Get file id first
    file_row = db_get_file(uid, file_hash)
    if not file_row:
        return
    file_id = file_row["id"]
    rows = [{
        "file_id":     file_id,
        "chunk_index": c["index"],
        "chunk_hash":  c["id"],
        "size":        c["size"],
        "storage_path": f"{uid}/{file_hash}/{c['index']}.chunk",
    } for c in chunks]
    if rows:
        sb.table("chunks").upsert(rows, on_conflict="file_id,chunk_index").execute()


def db_update_stats(uid: str, original_size: int, stored_size: int,
                    is_dedup: bool = False, dedup_saved: int = 0, delete: bool = False):
    """Upsert user_stats row — increments totals."""
    # Fetch current stats
    res = sb.table("user_stats").select("*").eq("user_id", uid).limit(1).execute()
    cur = res.data[0] if res.data else {
        "user_id": uid, "total_files": 0, "total_original": 0,
        "total_stored": 0, "total_dedup_events": 0, "total_dedup_saved": 0,
    }
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
    cur["updated_at"] = "now()"
    sb.table("user_stats").upsert(cur, on_conflict="user_id").execute()


# ── Phase 7: ML compression optimizer ────────────────────────────────────────
# One GradientBoostingRegressor per file category.
# Features: [file_size_log, zstd_level, entropy_estimate]
# Target:   compression ratio (original / compressed)
#
# On upload we try all candidate levels, pick the best-known from the model,
# then record the actual result to retrain incrementally.
#
# Serialised to disk in ml_models/<category>.pkl so training persists
# across server restarts.

CATEGORIES = ["image","video","audio","document","archive","code","other"]

# In-memory training buffer: { category: [(features, ratio), ...] }
_ml_lock    = threading.Lock()
_ml_models  = {}    # category → fitted GBR or None
_ml_samples = {c: [] for c in CATEGORIES}  # category → [(X, y)]
_ml_version = {c: 0  for c in CATEGORIES}  # increment on retrain

MIN_SAMPLES_TO_FIT = 5   # need this many before we use the model
_CANDIDATE_LEVELS  = list(range(1, 23))  # zstd 1..22

def _model_path(category: str) -> str:
    return os.path.join(ML_MODEL_DIR, f"{category}.pkl")

def _load_models():
    """Load any previously saved models from disk on startup."""
    for cat in CATEGORIES:
        p = _model_path(cat)
        if os.path.exists(p):
            try:
                with open(p, "rb") as f:
                    _ml_models[cat] = pickle.load(f)
                print(f"[ml] loaded model for {cat}")
            except Exception as e:
                print(f"[ml] could not load {cat}: {e}")

def _save_model(category: str):
    p = _model_path(category)
    with open(p, "wb") as f:
        pickle.dump(_ml_models.get(category), f)

def _entropy_estimate(data: bytes) -> float:
    """
    Fast byte-level entropy estimate (0–8 bits).
    High entropy → already compressed/encrypted → poor zstd ratio.
    """
    if not data:
        return 0.0
    sample = data[:4096]  # first 4 KB is enough
    counts = np.bincount(np.frombuffer(sample, dtype=np.uint8), minlength=256).astype(float)
    probs  = counts / counts.sum()
    probs  = probs[probs > 0]
    return float(-np.sum(probs * np.log2(probs)))

def _features(file_size: int, level: int, entropy: float) -> np.ndarray:
    return np.array([[
        np.log1p(file_size),   # log scale handles 1 KB → 10 GB
        level / 22.0,          # normalise to [0,1]
        entropy / 8.0,         # normalise to [0,1]
    ]])

def _predict_ratio(category: str, file_size: int, level: int, entropy: float) -> float:
    """Predict compression ratio for given features. Returns heuristic if no model."""
    with _ml_lock:
        model = _ml_models.get(category)
    if model is None:
        # Heuristic fallback
        base = {"image":1.05,"video":1.02,"audio":1.03,
                "document":3.5,"archive":1.01,"code":6.0,"other":1.5}.get(category, 2.0)
        return base * (1 + (level / 22.0) * 0.3)
    try:
        return float(model.predict(_features(file_size, level, entropy))[0])
    except Exception:
        return 1.0

def _record_sample(category: str, file_size: int, level: int, entropy: float, ratio: float):
    """Add a training sample and retrain if we have enough data."""
    with _ml_lock:
        _ml_samples[category].append((_features(file_size, level, entropy)[0], ratio))
        samples = _ml_samples[category]

        if len(samples) >= MIN_SAMPLES_TO_FIT and len(samples) % 3 == 0:
            # Retrain every 3 new samples (cheap for small datasets)
            X = np.array([s[0] for s in samples])
            y = np.array([s[1] for s in samples])
            model = GradientBoostingRegressor(
                n_estimators=50, max_depth=3, learning_rate=0.1,
                random_state=42
            )
            model.fit(X, y)
            _ml_models[category] = model
            _ml_version[category] += 1
            _save_model(category)
            print(f"[ml] retrained {category} v{_ml_version[category]} on {len(samples)} samples")

def get_best_level_ml(category: str, file_size: int, entropy: float) -> int:
    """
    Use the ML model to predict the best zstd level.
    Samples a subset of candidate levels and picks the one
    predicted to give the highest ratio.
    """
    candidates = [1, 3, 6, 9, 12, 15, 19, 22]  # 8 probes instead of 22
    best_level, best_pred = 5, 0.0
    for lvl in candidates:
        pred = _predict_ratio(category, file_size, lvl, entropy)
        if pred > best_pred:
            best_pred  = pred
            best_level = lvl
    return best_level

# Load models from disk at startup
_load_models()

# ── Storage helpers ───────────────────────────────────────────────────────────

def storage_upload(bucket: str, path: str, data: bytes):
    sb.storage.from_(bucket).upload(
        path, data,
        file_options={"content-type": "application/octet-stream", "upsert": "true"}
    )

def storage_download(bucket: str, path: str) -> bytes:
    return sb.storage.from_(bucket).download(path)

def storage_delete(bucket: str, paths: list):
    if paths:
        sb.storage.from_(bucket).remove(paths)

def blob_path(uid: str, fh: str) -> str:
    return f"{uid}/{fh}.zst.enc"

def chunk_path(uid: str, fh: str, idx: int) -> str:
    return f"{uid}/{fh}/{idx}.chunk"

def split_and_upload_chunks(data: bytes, file_hash: str, uid: str) -> list:
    chunks = []
    for i in range(0, len(data), CHUNK_SIZE):
        chunk = data[i:i+CHUNK_SIZE]
        idx   = i // CHUNK_SIZE
        storage_upload(CHUNK_BUCKET, chunk_path(uid, file_hash, idx), chunk)
        chunks.append({"id": hashlib.sha256(chunk).hexdigest()[:16], "index": idx, "size": len(chunk)})
    return chunks

def fetch_chunk_bytes(uid: str, file_hash: str, idx: int) -> bytes:
    return storage_download(CHUNK_BUCKET, chunk_path(uid, file_hash, idx))

def delete_from_storage(uid: str, file_hash: str, chunk_count: int):
    storage_delete(BLOB_BUCKET, [blob_path(uid, file_hash)])
    paths = [chunk_path(uid, file_hash, i) for i in range(chunk_count)]
    if paths:
        storage_delete(CHUNK_BUCKET, paths)

# ── JWT auth ──────────────────────────────────────────────────────────────────

def verify_token(token: str) -> dict | None:
    try:
        return pyjwt.decode(
            token,
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
    except pyjwt.ExpiredSignatureError:
        return None
    except Exception:
        # Fallback: decode without signature (local dev only)
        try:
            return pyjwt.decode(token, options={"verify_signature": False}, algorithms=["HS256"])
        except Exception:
            return None

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return jsonify({"error": "Unauthorized"}), 401
        payload = verify_token(auth[7:])
        if not payload:
            return jsonify({"error": "Unauthorized"}), 401
        g.uid   = payload.get("sub")
        g.email = payload.get("email", "")
        return f(*args, **kwargs)
    return decorated

# ── Encryption ────────────────────────────────────────────────────────────────

def load_master_secret():
    if os.path.exists(SECRET_FILE):
        with open(SECRET_FILE, "rb") as f:
            return f.read()
    s = secrets.token_bytes(32)
    with open(SECRET_FILE, "wb") as f:
        f.write(s)
    return s

MASTER_SECRET = load_master_secret()

def derive_key(fh: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32,
                salt=bytes.fromhex(fh), info=b"nexus-file-enc").derive(MASTER_SECRET)

def encrypt(data: bytes, fh: str) -> bytes:
    nonce = secrets.token_bytes(NONCE_SIZE)
    return nonce + AESGCM(derive_key(fh)).encrypt(nonce, data, None)

def decrypt(blob: bytes, fh: str) -> bytes:
    return AESGCM(derive_key(fh)).decrypt(blob[:NONCE_SIZE], blob[NONCE_SIZE:], None)

# ── File category ─────────────────────────────────────────────────────────────

def file_category(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext in [".jpg",".jpeg",".png",".gif",".webp",".bmp"]:           return "image"
    if ext in [".mp4",".mkv",".avi",".mov",".webm"]:                   return "video"
    if ext in [".mp3",".wav",".flac",".aac",".ogg"]:                   return "audio"
    if ext in [".pdf",".doc",".docx",".txt",".md"]:                    return "document"
    if ext in [".zip",".gz",".tar",".rar",".7z"]:                      return "archive"
    if ext in [".py",".js",".ts",".jsx",".json",".html",".css",
               ".cpp",".c",".java"]:                                   return "code"
    return "other"

# ── Peer registry ─────────────────────────────────────────────────────────────

PEER_COLORS = ["#EF4444","#F59E0B","#10B981","#3B82F6","#8B5CF6","#EC4899",
               "#06B6D4","#F97316","#84CC16","#A78BFA","#34D399","#FB923C"]
peers      = {}
peers_lock = threading.Lock()
color_idx  = 0

def next_color():
    global color_idx
    c = PEER_COLORS[color_idx % len(PEER_COLORS)]; color_idx += 1; return c

def new_peer_id():
    return "P-" + secrets.token_hex(4).upper()

def peer_summary():
    with peers_lock:
        return [{"peer_id":pid,"color":p["color"],"joined":p["joined"],
                 "chunks":{fid:len(idxs) for fid,idxs in p["chunks"].items()}}
                for pid,p in peers.items()]

def broadcast(msg, exclude=None):
    data = json.dumps(msg)
    with peers_lock:
        dead = []
        for pid,p in peers.items():
            if pid == exclude: continue
            try: p["ws"].send(data)
            except: dead.append(pid)
        for pid in dead: peers.pop(pid, None)

def send_to(peer_id, msg):
    with peers_lock:
        p = peers.get(peer_id)
        if p:
            try: p["ws"].send(json.dumps(msg)); return True
            except: peers.pop(peer_id, None)
    return False

# ── WebSocket ─────────────────────────────────────────────────────────────────

@sock.route("/ws")
def websocket(ws):
    token   = request.args.get("token","")
    payload = verify_token(token) if token else None
    uid     = payload.get("sub") if payload else "anonymous"
    peer_id = new_peer_id(); color = next_color()

    with peers_lock:
        peers[peer_id] = {"ws":ws,"color":color,"joined":time.time(),"chunks":{},"uid":uid}

    ws.send(json.dumps({"type":"welcome","peer_id":peer_id,"color":color}))
    broadcast({"type":"peers_updated","peers":peer_summary()})

    try:
        while True:
            raw = ws.receive()
            if raw is None: break
            try: msg = json.loads(raw)
            except: continue
            t = msg.get("type")
            if t == "have":
                with peers_lock:
                    if peer_id in peers:
                        peers[peer_id]["chunks"][msg.get("file_id")] = msg.get("chunks",[])
                broadcast({"type":"peers_updated","peers":peer_summary()})
            elif t == "want":
                _serve_chunk(peer_id, msg.get("file_id"), msg.get("chunk_index"))
            elif t == "ping":
                ws.send(json.dumps({"type":"pong"}))
    except Exception as e:
        print(f"[ws] {peer_id}: {e}")
    finally:
        with peers_lock: peers.pop(peer_id, None)
        broadcast({"type":"peers_updated","peers":peer_summary()})

def _serve_chunk(req_peer, file_id, chunk_index):
    source = None
    with peers_lock:
        for pid,p in peers.items():
            if pid!=req_peer and chunk_index in p["chunks"].get(file_id,[]):
                source=pid; break
    if source:
        send_to(source,{"type":"chunk_request","file_id":file_id,
                        "chunk_index":chunk_index,"for_peer":req_peer})
        return
    # Fallback: Supabase Storage
    uid = None
    with peers_lock:
        p = peers.get(req_peer)
        if p: uid = p.get("uid")
    if not uid or uid=="anonymous":
        send_to(req_peer,{"type":"chunk_error","file_id":file_id,
                          "chunk_index":chunk_index,"message":"auth required"})
        return
    try:
        b64 = base64.b64encode(fetch_chunk_bytes(uid,file_id,chunk_index)).decode()
        send_to(req_peer,{"type":"chunk_data","file_id":file_id,"chunk_index":chunk_index,
                          "data":b64,"from_peer":"STORAGE","from_color":"#3B82F6"})
    except Exception as e:
        print(f"[storage] chunk fetch failed: {e}")
        send_to(req_peer,{"type":"chunk_error","file_id":file_id,
                          "chunk_index":chunk_index,"message":"not found"})

# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({"status":"ok","peers":len(peers),"supabase":sb is not None})


@app.route("/upload", methods=["POST"])
@require_auth
def upload():
    file = request.files.get("file")
    if not file:
        return jsonify({"error":"No file"}), 400

    original_data = file.read()
    original_size = len(original_data)
    filename      = file.filename
    category      = file_category(filename)
    uid           = g.uid

    # ── Duplicate filename check (before any processing) ──────────────────────
    # Returns 409 if user already has an active file with this exact filename.
    existing_name = db_get_file_by_name(uid, filename)
    if existing_name:
        return jsonify({
            "error":       "duplicate_filename",
            "message":     f'You already have a file named "{filename}". Rename it or delete the existing one first.',
            "existing_id": existing_name["hash"],
        }), 409

    file_hash = hashlib.sha256(original_data).hexdigest()

    # ── Duplicate hash check (dedup) ──────────────────────────────────────────
    existing = db_get_file(uid, file_hash)
    if existing and not existing.get("deleted_at"):
        # Same content — just increment ref_count
        new_ref   = (existing.get("ref_count") or 1) + 1
        new_dedup = (existing.get("dedup_bytes_saved") or 0) + existing["stored_size"]
        sb.table("files").update({
            "ref_count":         new_ref,
            "dedup_bytes_saved": new_dedup,
        }).eq("user_id", uid).eq("hash", file_hash).execute()
        db_update_stats(uid, 0, 0, is_dedup=True, dedup_saved=existing["stored_size"])
        return jsonify({
            "status":            "deduplicated",
            "file_id":           file_hash,
            "hash":              file_hash,
            "filename":          existing["filename"],
            "original_size":     original_size,
            "stored_size":       existing["stored_size"],
            "ratio":             existing["ratio"],
            "category":          category,
            "chunk_count":       existing["chunk_count"],
            "savings":           original_size - existing["stored_size"],
            "ref_count":         new_ref,
            "dedup_bytes_saved": new_dedup,
            "encrypted":         True,
        })

    # ── Phase 7: ML-guided compression level selection ────────────────────────
    entropy      = _entropy_estimate(original_data)
    best_level   = get_best_level_ml(category, original_size, entropy)
    ml_version   = _ml_version.get(category, 0)

    # Try the ML-recommended level plus its neighbours for safety
    candidates = sorted(set([max(1,best_level-1), best_level, min(22,best_level+1)]))
    best_data, best_ratio, chosen_level = None, 0.0, best_level

    for lvl in candidates:
        comp = zstd.ZstdCompressor(level=lvl).compress(original_data)
        r    = original_size / len(comp) if comp else 1
        if r > best_ratio:
            best_data, best_ratio, chosen_level = comp, r, lvl

    # Record the actual result for the ML model to learn from
    _record_sample(category, original_size, chosen_level, entropy, best_ratio)

    # ── Encrypt + upload to Supabase Storage ──────────────────────────────────
    encrypted_blob = encrypt(best_data, file_hash)
    stored_size    = len(encrypted_blob)

    storage_upload(BLOB_BUCKET, blob_path(uid, file_hash), encrypted_blob)
    chunks      = split_and_upload_chunks(best_data, file_hash, uid)
    chunk_count = len(chunks)

    # ── Write to Supabase DB ──────────────────────────────────────────────────
    from datetime import datetime, timezone
    upload_time_iso = datetime.now(timezone.utc).isoformat()

    entry = {
        "hash":              file_hash,
        "filename":          filename,
        "category":          category,
        "original_size":     original_size,
        "stored_size":       stored_size,
        "ratio":             round(best_ratio, 3),
        "level":             chosen_level,
        "chunk_count":       chunk_count,
        "upload_time_iso":   upload_time_iso,
        "ref_count":         1,
        "dedup_bytes_saved": 0,
        "starred":           False,
        "deleted_at":        None,
        "ml_model_version":  ml_version,
    }
    db_upsert_file(uid, entry)

    # Fetch the inserted row to get its uuid (needed for chunks FK)
    db_upsert_chunks(uid, file_hash, chunks)
    db_update_stats(uid, original_size, stored_size)

    broadcast({"type":"file_available","file_id":file_hash,
               "filename":filename,"chunk_count":chunk_count})

    return jsonify({
        "status":          "uploaded",
        "file_id":         file_hash,
        "hash":            file_hash,
        "filename":        filename,
        "category":        category,
        "original_size":   original_size,
        "stored_size":     stored_size,
        "ratio":           round(best_ratio, 3),
        "level":           chosen_level,
        "chunks":          chunks,
        "chunk_count":     chunk_count,
        "savings":         original_size - stored_size,
        "encrypted":       True,
        "ref_count":       1,
        "dedup_bytes_saved": 0,
        "starred":         False,
        "ml_model_version": ml_version,
        "entropy":         round(entropy, 3),
    })


@app.route("/files", methods=["GET"])
@require_auth
def list_files():
    view  = request.args.get("view", "active")
    files = db_list_files(g.uid, view)

    # Auto-purge expired trash
    now     = time.time()
    cutoff  = now - TRASH_DAYS * 86400
    to_purge = []
    for f in files:
        if view == "trash" and f.get("deleted_at"):
            try:
                # deleted_at is ISO string from DB
                from datetime import datetime
                dt = datetime.fromisoformat(f["deleted_at"].replace("Z","+00:00"))
                if dt.timestamp() < cutoff:
                    to_purge.append(f)
            except Exception:
                pass

    for f in to_purge:
        try:
            delete_from_storage(g.uid, f["hash"], f.get("chunk_count",0))
            sb.table("files").delete().eq("user_id",g.uid).eq("hash",f["hash"]).execute()
        except Exception as e:
            print(f"[purge] {f['hash']}: {e}")

    if to_purge:
        files = [f for f in files if f["hash"] not in {p["hash"] for p in to_purge}]

    # Normalise: add `hash` field if only `id` present (DB stores hash separately)
    for f in files:
        if "hash" not in f:
            f["hash"] = f.get("id", "")
        # upload_time may be ISO string — frontend expects float or string, both fine
    return jsonify(files)


@app.route("/star/<file_id>", methods=["PATCH"])
@require_auth
def toggle_star(file_id):
    row = db_get_file(g.uid, file_id)
    if not row:
        return jsonify({"error":"Not found"}), 404
    new_val = not row.get("starred", False)
    sb.table("files").update({"starred":new_val}).eq("user_id",g.uid).eq("hash",file_id).execute()
    return jsonify({"starred": new_val})


@app.route("/trash/<file_id>", methods=["PATCH"])
@require_auth
def move_to_trash(file_id):
    row = db_get_file(g.uid, file_id)
    if not row:
        return jsonify({"error":"Not found"}), 404
    from datetime import datetime, timezone
    sb.table("files").update({
        "deleted_at": datetime.now(timezone.utc).isoformat(),
        "starred":    False,
    }).eq("user_id",g.uid).eq("hash",file_id).execute()
    return jsonify({"status":"trashed"})


@app.route("/restore/<file_id>", methods=["PATCH"])
@require_auth
def restore_from_trash(file_id):
    row = db_get_file(g.uid, file_id)
    if not row:
        return jsonify({"error":"Not found"}), 404
    sb.table("files").update({"deleted_at":None}).eq("user_id",g.uid).eq("hash",file_id).execute()
    return jsonify({"status":"restored"})


@app.route("/delete/<file_id>", methods=["DELETE"])
@require_auth
def delete_file(file_id):
    row = db_get_file(g.uid, file_id)
    if not row:
        return jsonify({"error":"Not found"}), 404
    try:
        delete_from_storage(g.uid, file_id, row.get("chunk_count",0))
    except Exception as e:
        print(f"[delete] storage error: {e}")
    sb.table("files").delete().eq("user_id",g.uid).eq("hash",file_id).execute()
    db_update_stats(g.uid, row.get("original_size",0), row.get("stored_size",0), delete=True)
    broadcast({"type":"file_deleted","file_id":file_id})
    return jsonify({"status":"deleted"})


@app.route("/download/<file_id>", methods=["GET"])
@require_auth
def download(file_id):
    row = db_get_file(g.uid, file_id)
    if not row:
        return jsonify({"error":"Not found"}), 404
    try:
        encrypted_blob = storage_download(BLOB_BUCKET, blob_path(g.uid, file_id))
    except Exception as e:
        return jsonify({"error":f"Storage fetch failed: {e}"}), 500
    original = zstd.ZstdDecompressor().decompress(decrypt(encrypted_blob, file_id))
    return send_file(io.BytesIO(original), download_name=row["filename"], as_attachment=True)


@app.route("/stats", methods=["GET"])
@require_auth
def stats():
    # Try DB stats table first, fall back to aggregating files
    try:
        res = sb.table("user_stats").select("*").eq("user_id",g.uid).limit(1).execute()
        if res.data:
            s = res.data[0]
            return jsonify({
                "total_files":        s.get("total_files",0),
                "total_original":     s.get("total_original",0),
                "total_stored":       s.get("total_stored",0),
                "space_saved":        s.get("total_original",0)-s.get("total_stored",0),
                "overall_ratio":      round(s["total_original"]/s["total_stored"],3) if s.get("total_stored") else 1,
                "total_dedup_events": s.get("total_dedup_events",0),
                "total_dedup_saved":  s.get("total_dedup_saved",0),
                "live_peers":         len(peers),
                "ml_models_trained":  sum(1 for v in _ml_version.values() if v>0),
            })
    except Exception as e:
        print(f"[stats] DB error: {e}")

    # Fallback: aggregate from files table
    files = db_list_files(g.uid, "active")
    total_orig   = sum(f.get("original_size",0) for f in files)
    total_stored = sum(f.get("stored_size",0)   for f in files)
    return jsonify({
        "total_files":        len(files),
        "total_original":     total_orig,
        "total_stored":       total_stored,
        "space_saved":        total_orig-total_stored,
        "overall_ratio":      round(total_orig/total_stored,3) if total_stored else 1,
        "total_dedup_events": sum(f.get("ref_count",1)-1       for f in files),
        "total_dedup_saved":  sum(f.get("dedup_bytes_saved",0) for f in files),
        "live_peers":         len(peers),
        "ml_models_trained":  sum(1 for v in _ml_version.values() if v>0),
    })


@app.route("/ml_status", methods=["GET"])
@require_auth
def ml_status():
    """Show ML model status per category — useful for debugging."""
    status = {}
    with _ml_lock:
        for cat in CATEGORIES:
            n = len(_ml_samples.get(cat,[]))
            status[cat] = {
                "samples":  n,
                "version":  _ml_version.get(cat,0),
                "fitted":   _ml_models.get(cat) is not None,
                "ready_in": max(0, MIN_SAMPLES_TO_FIT-n),
            }
    return jsonify(status)


@app.route("/peers", methods=["GET"])
def list_peers():
    return jsonify({"count": len(peers), "peers": peer_summary()})


if __name__ == "__main__":
    # Dynamically bind to the port provided by your cloud host (defaulting to 5000)
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, threaded=True)
