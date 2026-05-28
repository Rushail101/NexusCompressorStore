/**
 * Nexus – Features 1, 2, 3
 * ==========================
 * Feature 1: Client-side zstd compression (WASM)
 *   - Before uploading, compress in browser using zstd-codec WASM
 *   - Sends X-Pre-Compressed: true header so server skips re-compression
 *   - Sends X-Original-Size and X-Entropy headers for ML recording
 *   - Falls back to direct upload if WASM not loaded
 *   - Shows compression happening in upload button
 *
 * Feature 2: Resumable uploads
 *   - Files > 10 MB use chunked resumable upload automatically
 *   - POST /upload/init → get session_id
 *   - Upload chunks sequentially with progress bar
 *   - POST /upload/finish → assemble on server
 *   - Can retry failed chunks without restarting
 *   - Progress shown in upload modal
 *
 * Feature 3: Public share links
 *   - "Copy public link" button in share modal
 *   - Creates /p/<token> link — anyone can download without account
 *   - Shows link in share modal with copy button
 *   - Can revoke public link separately from private shares
 *   - Public download page at /p/<token> (info endpoint)
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = "https://hoqzrxxqczxwwnqimvxm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhvcXpyeHhxY3p4d3ducWltdnhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcyNzAzMzgsImV4cCI6MjA4Mjg0NjMzOH0.KWrM31jwQu98qevgPKbSzEIrsulKpjxiBQ1X4QlkHFc";
const supabase  = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const ADMIN_EMAIL        = "rushailharjai10@gmail.com";
const API                = import.meta.env.VITE_API_URL || "http://localhost:5000";
const WS_URL             = import.meta.env.VITE_WS_URL  || "ws://localhost:5000/ws";
const RESUMABLE_THRESHOLD = 10 * 1024 * 1024;  // 10 MB — use resumable above this
const CHUNK_SIZE          = 256 * 1024;          // 256 KB chunks

// ── Helpers ───────────────────────────────────────────────────────

const fmt = (b) => {
  if (!b || b===0) return "0 B";
  const k=1024, s=["B","KB","MB","GB","TB"], i=Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1))+" "+s[i];
};
const relTime = (ts) => {
  if (!ts) return "—";
  const t = typeof ts==="string" ? new Date(ts).getTime()/1000 : ts;
  const d = Date.now()/1000 - t;
  if (d<60) return "just now";
  if (d<3600) return Math.floor(d/60)+"m ago";
  if (d<86400) return Math.floor(d/3600)+"h ago";
  return Math.floor(d/86400)+"d ago";
};
const daysLeft = (del) => {
  if (!del) return null;
  const t = typeof del==="string" ? new Date(del).getTime()/1000 : del;
  return Math.max(0, Math.ceil(7-(Date.now()/1000-t)/86400));
};
const catIcon  = (c) => ({image:"🖼️",video:"🎬",audio:"🎵",document:"📄",archive:"📦",code:"💻",other:"📎"})[c]||"📎";
const catColor = (c) => ({image:"#F59E0B",video:"#EF4444",audio:"#8B5CF6",document:"#3B82F6",archive:"#F97316",code:"#10B981",other:"#6B7280"})[c]||"#6B7280";

const apiFetch = (token) => (path, opts={}) =>
  fetch(`${API}${path}`, { ...opts, headers:{ Authorization:`Bearer ${token}`, ...opts.headers }});

// ── Feature 1: Client-side compression ───────────────────────────
// Uses zstd-codec WASM library (loaded via script tag in index.html)
// <script src="https://cdn.jsdelivr.net/npm/zstd-codec@0.1.2/bundle/zstd-codec.min.js"></script>

function computeEntropy(bytes) {
  const sample = bytes.slice(0, 4096);
  const counts = new Array(256).fill(0);
  for (let i = 0; i < sample.length; i++) counts[sample[i]]++;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (counts[i] === 0) continue;
    const p = counts[i] / sample.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Already-compressed formats — skip client compression for these
const SKIP_COMPRESSION_EXTS = new Set([
  ".jpg",".jpeg",".png",".gif",".webp",".mp4",".mkv",".avi",".mov",
  ".mp3",".aac",".ogg",".flac",".zip",".gz",".tar",".rar",".7z",
  ".zst",".bz2",".webm",".heic",".avif"
]);

async function compressClientSide(file) {
  // Check if already compressed format
  const ext = "." + file.name.split(".").pop().toLowerCase();
  if (SKIP_COMPRESSION_EXTS.has(ext)) {
    return { compressed: null, skipped: true, reason: "already_compressed" };
  }

  // Check if zstd-codec WASM is available
  if (!window.ZstdCodec) {
    return { compressed: null, skipped: true, reason: "wasm_unavailable" };
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const uint8       = new Uint8Array(arrayBuffer);
    const entropy     = computeEntropy(uint8);

    // Skip compression for high-entropy data (won't compress well)
    if (entropy > 7.5) {
      return { compressed: null, skipped: true, reason: "high_entropy", entropy };
    }

    return new Promise((resolve) => {
      window.ZstdCodec.run(zstd => {
        try {
          const simple     = new zstd.Simple();
          const compressed = simple.compress(uint8, 6); // level 6 — good balance
          const ratio      = uint8.length / compressed.length;

          // Only use client compression if it actually helps
          if (ratio < 1.05) {
            resolve({ compressed: null, skipped: true, reason: "no_benefit", entropy });
            return;
          }

          resolve({
            compressed:    compressed,
            originalSize:  uint8.length,
            compressedSize: compressed.length,
            ratio,
            entropy,
            skipped: false,
          });
        } catch (e) {
          resolve({ compressed: null, skipped: true, reason: "error", entropy: 0 });
        }
      });
    });
  } catch (e) {
    return { compressed: null, skipped: true, reason: "error" };
  }
}

// ── Feature 2: Resumable upload ───────────────────────────────────

async function resumableUpload(file, token, folderId, onProgress) {
  const ap = apiFetch(token);

  // Step 1: Try client-side compression first
  onProgress({ stage: "compressing", pct: 0 });
  const compResult = await compressClientSide(file);
  const useClientComp = !compResult.skipped;

  const uploadData     = useClientComp ? compResult.compressed : null;
  const totalSize      = useClientComp ? compResult.originalSize : file.size;
  const dataToChunk    = uploadData || await file.arrayBuffer().then(b => new Uint8Array(b));
  const totalChunks    = Math.ceil(dataToChunk.length / CHUNK_SIZE);

  onProgress({ stage: "compressing", pct: 100,
    saved: useClientComp ? totalSize - dataToChunk.length : 0 });

  // Step 2: Init session
  onProgress({ stage: "initialising", pct: 0 });
  const initRes = await ap("/upload/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename:       file.name,
      total_size:     totalSize,
      total_chunks:   totalChunks,
      folder_id:      folderId || null,
      pre_compressed: useClientComp,
    }),
  });
  const initData = await initRes.json();
  if (!initRes.ok) return { error: initData.error || "Init failed", ...initData };
  const { session_id } = initData;

  // Step 3: Upload chunks
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end   = Math.min(start + CHUNK_SIZE, dataToChunk.length);
    const chunk = dataToChunk.slice(start, end);

    const fd = new FormData();
    fd.append("session_id",  session_id);
    fd.append("chunk_index", String(i));
    fd.append("chunk",       new Blob([chunk]), `chunk_${i}`);

    let attempts = 0;
    while (attempts < 3) {
      try {
        const res = await ap("/upload/chunk", { method: "POST", body: fd });
        if (res.ok) break;
      } catch (e) {
        attempts++;
        if (attempts >= 3) return { error: `Chunk ${i} failed after 3 retries` };
        await new Promise(r => setTimeout(r, 1000 * attempts));
      }
      attempts++;
    }

    onProgress({
      stage: "uploading",
      pct:   Math.round(((i + 1) / totalChunks) * 100),
      chunk: i + 1, totalChunks,
    });
  }

  // Step 4: Finish
  onProgress({ stage: "finishing", pct: 100 });
  const finishRes = await ap("/upload/finish", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      session_id,
      entropy: compResult.entropy || null,
    }),
  });
  return finishRes.json();
}

// Regular upload with optional client-side compression
async function regularUpload(file, token, folderId, onProgress) {
  const ap = apiFetch(token);

  onProgress({ stage: "compressing", pct: 0 });
  const compResult = await compressClientSide(file);
  const useClientComp = !compResult.skipped;

  onProgress({ stage: "uploading", pct: 50,
    saved: useClientComp ? (compResult.originalSize - compResult.compressedSize) : 0 });

  const fd = new FormData();
  if (useClientComp) {
    fd.append("file", new Blob([compResult.compressed]), file.name);
  } else {
    fd.append("file", file);
  }
  if (folderId) fd.append("folder_id", folderId);

  const headers = { Authorization: `Bearer ${token}` };
  if (useClientComp) {
    headers["X-Pre-Compressed"] = "true";
    headers["X-Original-Size"]  = String(compResult.originalSize);
    headers["X-Entropy"]        = String(compResult.entropy || 0);
  }

  const res  = await fetch(`${API}/upload`, { method: "POST", body: fd, headers });
  const data = await res.json();
  onProgress({ stage: "done", pct: 100 });
  if (!res.ok) return { ...data, httpStatus: res.status };
  return data;
}

// ── Upload progress modal ─────────────────────────────────────────

function UploadProgressModal({ filename, progress, onCancel }) {
  const stages = { compressing:"Compressing…", initialising:"Starting upload…",
                   uploading:"Uploading…", finishing:"Finalising…", done:"Done!" };
  const label  = stages[progress?.stage] || "Preparing…";
  const pct    = progress?.pct || 0;
  const saved  = progress?.saved || 0;

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}}>
      <div style={{background:"#161616",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,
        padding:"1.5rem",width:440,maxWidth:"90vw",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}}>
        <h2 style={{margin:"0 0 4px",fontSize:15,fontWeight:500,color:"#fff"}}>⬆ Uploading</h2>
        <p style={{margin:"0 0 16px",fontSize:12,color:"rgba(255,255,255,0.4)",
          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{filename}</p>

        <div style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,
            color:"rgba(255,255,255,0.4)",marginBottom:6}}>
            <span>{label}</span>
            <span>{pct}%</span>
          </div>
          <div style={{height:6,background:"rgba(255,255,255,0.07)",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",borderRadius:3,
              background:progress?.stage==="done"?"#10B981":"linear-gradient(90deg,#3B82F6,#8B5CF6)",
              width:`${pct}%`,transition:"width 0.2s ease"}}/>
          </div>
        </div>

        {progress?.stage==="uploading" && progress?.totalChunks > 1 && (
          <p style={{margin:"0 0 10px",fontSize:12,color:"rgba(255,255,255,0.35)"}}>
            Chunk {progress.chunk} of {progress.totalChunks}
          </p>
        )}
        {saved > 0 && (
          <div style={{background:"rgba(16,185,129,0.08)",border:"0.5px solid rgba(16,185,129,0.2)",
            borderRadius:8,padding:"8px 12px",marginBottom:10,fontSize:12,color:"#10B981"}}>
            🗜 Client-side compression saved {fmt(saved)} before upload
          </div>
        )}
        {onCancel && progress?.stage !== "done" && (
          <button onClick={onCancel} style={{background:"none",border:"0.5px solid rgba(255,255,255,0.1)",
            borderRadius:8,padding:"6px 14px",cursor:"pointer",fontSize:12,
            color:"rgba(255,255,255,0.4)",fontFamily:"inherit"}}>Cancel</button>
        )}
      </div>
    </div>
  );
}

// ── Auth page ─────────────────────────────────────────────────────

function AuthPage({ onAuth }) {
  const [mode,setMode]         = useState("login");
  const [email,setEmail]       = useState("");
  const [password,setPassword] = useState("");
  const [loading,setLoading]   = useState(false);
  const [error,setError]       = useState("");
  const [success,setSuccess]   = useState("");
  const inp = {width:"100%",padding:"11px 14px",boxSizing:"border-box",
    background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",
    borderRadius:10,color:"#fff",fontSize:14,outline:"none",fontFamily:"inherit"};
  const submit = async () => {
    if (!email||!password) return;
    setLoading(true); setError(""); setSuccess("");
    try {
      if (mode==="signup") {
        const {error:e} = await supabase.auth.signUp({email,password});
        if (e) throw e;
        setSuccess("Check your email to confirm, then sign in."); setMode("login");
      } else {
        const {data,error:e} = await supabase.auth.signInWithPassword({email,password});
        if (e) throw e;
        onAuth(data.session);
      }
    } catch(e) { setError(e.message||"Something went wrong"); }
    finally    { setLoading(false); }
  };
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",
      height:"100vh",background:"#0a0a0a",fontFamily:"var(--font-sans)"}}>
      <div style={{width:400,padding:"2.5rem",background:"#161616",
        border:"1px solid rgba(255,255,255,0.09)",borderRadius:20,
        boxShadow:"0 32px 80px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:28}}>
          <div style={{width:36,height:36,borderRadius:10,
            background:"linear-gradient(135deg,#3B82F6,#8B5CF6)",
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⬡</div>
          <span style={{fontSize:22,fontWeight:700,color:"#fff",letterSpacing:"-0.5px"}}>Nexus</span>
        </div>
        <h2 style={{margin:"0 0 5px",fontSize:20,fontWeight:600,color:"#fff"}}>
          {mode==="login"?"Welcome back":"Create account"}</h2>
        <p style={{margin:"0 0 24px",fontSize:14,color:"rgba(255,255,255,0.4)"}}>
          {mode==="login"?"Sign in to your account":"Start with 10 GB free storage"}</p>
        {error&&<div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",
          borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#FCA5A5"}}>{error}</div>}
        {success&&<div style={{background:"rgba(16,185,129,0.1)",border:"0.5px solid rgba(16,185,129,0.3)",
          borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#6EE7B7"}}>{success}</div>}
        <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
          <input type="email" placeholder="Email address" value={email}
            onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={inp}/>
          <input type="password" placeholder="Password (min 6 chars)" value={password}
            onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={inp}/>
        </div>
        <button onClick={submit} disabled={loading||!email||!password} style={{width:"100%",
          padding:"12px",borderRadius:10,border:"none",fontFamily:"inherit",
          background:loading||!email||!password?"rgba(59,130,246,0.35)":"#3B82F6",
          color:"#fff",fontSize:15,fontWeight:500,
          cursor:loading?"wait":!email||!password?"not-allowed":"pointer",transition:"background 0.15s"}}>
          {loading?"Please wait…":mode==="login"?"Sign in":"Create account"}
        </button>
        <p style={{margin:"18px 0 0",textAlign:"center",fontSize:13,color:"rgba(255,255,255,0.4)"}}>
          {mode==="login"?"No account? ":"Already have one? "}
          <span onClick={()=>{setMode(mode==="login"?"signup":"login");setError("");setSuccess("");}}
            style={{color:"#60A5FA",cursor:"pointer",fontWeight:500}}>
            {mode==="login"?"Sign up free":"Sign in"}</span>
        </p>
      </div>
    </div>
  );
}

// ── WebSocket hook ────────────────────────────────────────────────

function useP2P(token, { onFileAvailable }) {
  const wsRef = useRef(null);
  const [myPeerId,setMyPeerId]   = useState(null);
  const [myColor,setMyColor]     = useState("#6B7280");
  const [peerCount,setPeerCount] = useState(0);
  const [wsStatus,setWsStatus]   = useState("disconnected");
  const sendMsg = useCallback((msg) => {
    if (wsRef.current?.readyState===WebSocket.OPEN)
      wsRef.current.send(JSON.stringify(msg));
  }, []);
  useEffect(() => {
    if (!token) return;
    let ws, timer;
    const connect = () => {
      setWsStatus("connecting");
      ws = new WebSocket(`${WS_URL}?token=${token}`);
      wsRef.current = ws;
      ws.onopen = () => { setWsStatus("connected"); ws.send(JSON.stringify({type:"register"})); };
      ws.onmessage = (e) => {
        let msg; try { msg=JSON.parse(e.data); } catch { return; }
        if (msg.type==="welcome")        { setMyPeerId(msg.peer_id); setMyColor(msg.color); }
        if (msg.type==="peers_updated")  { setPeerCount((msg.peers||[]).length); }
        if (msg.type==="chunk_data")     { wsRef.current?._chunkHandler?.(msg); }
        if (msg.type==="file_available") { onFileAvailable?.(); }
      };
      ws.onclose = () => { setWsStatus("disconnected"); setMyPeerId(null); timer=setTimeout(connect,3000); };
      ws.onerror = () => ws.close();
    };
    connect();
    const ping = setInterval(()=>{ if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:"ping"})); },25000);
    return () => { clearTimeout(timer); clearInterval(ping); ws?.close(); };
  }, [token]); // eslint-disable-line
  return { ws:wsRef, myPeerId, myColor, peerCount, wsStatus, sendMsg };
}

// ── P2P Downloader modal ──────────────────────────────────────────

function P2PDownloader({ file, sendMsg, wsRef, myColor, token, onClose, onHaveChunks }) {
  const [chunks,setChunks]   = useState({});
  const [status,setStatus]   = useState("requesting");
  const [totalMs,setTotalMs] = useState(null);
  const [log,setLog]         = useState([]);
  const startRef    = useRef(Date.now());
  const { chunk_count:chunkCount, hash:fileId } = file;
  useEffect(() => {
    if (!wsRef.current) return;
    wsRef.current._chunkHandler = (msg) => {
      if (msg.file_id!==fileId) return;
      const bin=atob(msg.data); const bytes=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      const elapsed=Date.now()-startRef.current;
      setChunks(p=>({...p,[msg.chunk_index]:{from_peer:msg.from_peer,from_color:msg.from_color||myColor,elapsed}}));
      setLog(p=>[{idx:msg.chunk_index,peer:msg.from_peer,color:msg.from_color||"#6B7280",ms:elapsed},...p.slice(0,8)]);
    };
    return () => { if(wsRef.current) wsRef.current._chunkHandler=null; };
  }, [fileId,myColor,wsRef]);
  useEffect(() => {
    startRef.current=Date.now();
    for(let i=0;i<chunkCount;i++) setTimeout(()=>sendMsg({type:"want",file_id:fileId,chunk_index:i}),i*5);
  }, [fileId,chunkCount,sendMsg]);
  useEffect(() => {
    if (Object.keys(chunks).length>0&&Object.keys(chunks).length>=chunkCount) {
      setTotalMs(Date.now()-startRef.current); setStatus("done");
      fetch(`${API}/download/${fileId}`,{headers:{Authorization:`Bearer ${token}`}})
        .then(r=>r.blob()).then(blob=>{ const url=URL.createObjectURL(blob);
          const a=document.createElement("a"); a.href=url; a.download=file.filename; a.click();
          setTimeout(()=>URL.revokeObjectURL(url),10000); });
      onHaveChunks(fileId, Array.from({length:chunkCount},(_,i)=>i));
    }
  }, [chunks,chunkCount,fileId,file,token,onHaveChunks]);
  const progress=chunkCount>0?Object.keys(chunks).length/chunkCount:0;
  const uniquePeers=[...new Set(Object.values(chunks).map(c=>c.from_peer))];
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#161616",
        border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",
        width:560,maxWidth:"94vw",boxShadow:"0 32px 80px rgba(0,0,0,0.8)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div>
            <h2 style={{margin:0,fontSize:16,fontWeight:500,color:"#fff"}}>
              {status==="done"?"✅ Download complete":"⬇️ P2P Download"}</h2>
            <p style={{margin:"3px 0 0",fontSize:12,color:"rgba(255,255,255,0.4)",
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:400}}>{file.filename}</p>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",
            fontSize:18,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,
            color:"rgba(255,255,255,0.35)",marginBottom:6}}>
            <span>{Object.keys(chunks).length} / {chunkCount} chunks</span>
            <span>{status==="done"?`✓ ${totalMs}ms`:`${uniquePeers.length} peer${uniquePeers.length!==1?"s":""} active`}</span>
          </div>
          <div style={{height:6,background:"rgba(255,255,255,0.07)",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",borderRadius:3,width:`${Math.round(progress*100)}%`,
              background:status==="done"?"#10B981":"linear-gradient(90deg,#8B5CF6,#3B82F6)",
              transition:"width 0.1s"}}/>
          </div>
        </div>
        {uniquePeers.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
          {uniquePeers.map(pid=>{const s=Object.values(chunks).find(c=>c.from_peer===pid);
            const col=s?.from_color||"#6B7280";
            const cnt=Object.values(chunks).filter(c=>c.from_peer===pid).length;
            return <div key={pid} style={{display:"flex",alignItems:"center",gap:5,
              background:`${col}22`,border:`1px solid ${col}`,borderRadius:6,
              padding:"3px 9px",fontSize:11,color:col}}>
              <div style={{width:7,height:7,borderRadius:"50%",background:col}}/>{pid}
              <span style={{opacity:0.55}}>{cnt} chunks</span></div>;})}</div>}
        <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:12,maxHeight:130,
          overflowY:"auto",padding:"10px",background:"rgba(255,255,255,0.02)",
          borderRadius:8,border:"0.5px solid rgba(255,255,255,0.05)"}}>
          {Array.from({length:chunkCount},(_,i)=>{const c=chunks[i];
            return <div key={i} style={{width:22,height:22,borderRadius:4,
              background:c?c.from_color:"rgba(255,255,255,0.05)",
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:8,color:"#fff",fontWeight:600,opacity:c?1:0.3}}>{i+1}</div>;})}
        </div>
        <div style={{background:"rgba(0,0,0,0.4)",borderRadius:6,padding:"8px 10px",
          fontSize:11,fontFamily:"monospace",maxHeight:70,overflowY:"auto",
          border:"0.5px solid rgba(255,255,255,0.05)"}}>
          {log.length===0?<span style={{color:"rgba(255,255,255,0.2)"}}>waiting…</span>
            :log.map((l,i)=><div key={i} style={{color:i===0?"#fff":"rgba(255,255,255,0.3)",marginBottom:2}}>
              <span style={{color:l.color}}>{l.peer}</span>{" → chunk "}
              <span style={{color:"rgba(255,255,255,0.6)"}}>{l.idx}</span>{" "}
              <span style={{color:"rgba(255,255,255,0.25)"}}>+{l.ms}ms</span>
            </div>)}
        </div>
        {status==="done"&&<p style={{margin:"10px 0 0",fontSize:12,color:"#10B981",textAlign:"center"}}>
          All {chunkCount} chunks assembled ✓</p>}
      </div>
    </div>
  );
}

// ── Upload result modal ───────────────────────────────────────────

function UploadResult({ result, onClose }) {
  const saved=result.savings||0;
  const pct=result.original_size>0?Math.round((saved/result.original_size)*100):0;
  const isDupe=result.status==="deduplicated";
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",
        border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",
        width:460,maxWidth:"90vw",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <h2 style={{margin:0,fontSize:15,fontWeight:500,color:"#fff"}}>
            {isDupe?"⚡ Deduplicated":"✅ Uploaded"}</h2>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",
            fontSize:16,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>
        {isDupe
          ?<div style={{background:"rgba(59,130,246,0.1)",border:"0.5px solid rgba(59,130,246,0.3)",
              borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:13,color:"#93C5FD"}}>
              Exact duplicate — <strong>{result.ref_count}× referenced</strong>. Saved {fmt(result.dedup_bytes_saved)}.
            </div>
          :<div style={{background:"rgba(16,185,129,0.06)",border:"0.5px solid rgba(16,185,129,0.2)",
              borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:12,
              color:"rgba(255,255,255,0.5)",lineHeight:1.6}}>
              <span style={{color:"#10B981",fontWeight:500}}>Pipeline:</span>{" "}
              {result.pre_compressed?"browser zstd → ":""}plaintext → SHA-256 → zstd → AES-256-GCM → chunk → P2P
            </div>}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
          {[["Original",fmt(result.original_size),"#6B7280"],
            ["Stored",fmt(result.stored_size),"#10B981"],
            ["Saved",`${pct}%`,"#8B5CF6"]].map(([l,v,c])=>(
            <div key={l} style={{background:"rgba(255,255,255,0.04)",borderRadius:10,
              padding:"12px",borderTop:`2px solid ${c}`}}>
              <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.4)",
                textTransform:"uppercase",letterSpacing:"0.05em"}}>{l}</p>
              <p style={{margin:"6px 0 0",fontSize:18,fontWeight:500,color:c}}>{v}</p>
            </div>))}
        </div>
        <div style={{background:"rgba(255,255,255,0.03)",borderRadius:8,padding:"10px 14px",fontSize:12}}>
          {[["Ratio",`${result.ratio}×`],
            ["zstd level", result.pre_compressed?"client-side (level 6)":`server level ${result.level}`],
            ["Category",`${catIcon(result.category)} ${result.category}`],
            ["Chunks",`${result.chunk_count||"—"} × 256 KB`],
            ...(result.entropy!=null?[["Entropy",`${result.entropy} bits`]]:[]),
            ...(result.ml_model_version!=null?[["ML model",`v${result.ml_model_version}${result.ml_model_version===0?" (heuristic)":""}`]]:[]),
            ...(result.pre_compressed?[["Compressed by","browser (WASM)"]]:[]),
          ].map(([l,v])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
              <span style={{color:"rgba(255,255,255,0.4)"}}>{l}</span>
              <span style={{color:"rgba(255,255,255,0.8)",fontWeight:500}}>{v}</span>
            </div>))}
        </div>
      </div>
    </div>
  );
}

// ── Feature 3: Share modal with public link ───────────────────────

function ShareModal({ file, token, onClose }) {
  const [email,setEmail]       = useState("");
  const [expiry,setExpiry]     = useState("");
  const [loading,setLoading]   = useState(false);
  const [shares,setShares]     = useState([]);
  const [publicLink,setPublicLink] = useState(null);
  const [error,setError]       = useState("");
  const [success,setSuccess]   = useState("");
  const [copied,setCopied]     = useState(false);
  const ap = apiFetch(token);

  useEffect(() => {
    // Load existing private shares
    ap(`/share/${file.hash}`).then(r=>r.json()).then(d=>{ if(Array.isArray(d)) setShares(d); });
    // Load existing public link
    ap(`/share/${file.hash}/public`).then(r=>r.json()).then(d=>{
      if (d.exists) setPublicLink(d);
    });
  }, [file.hash]); // eslint-disable-line

  const share = async () => {
    if (!email) return;
    setLoading(true); setError(""); setSuccess("");
    try {
      const res  = await ap(`/share/${file.hash}`, {method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({email:email.trim().toLowerCase(),
          expires_days: expiry ? parseInt(expiry) : null})});
      const data = await res.json();
      if (!res.ok) { setError(data.error||"Failed"); return; }
      setSuccess(`Shared with ${email}`); setEmail(""); setExpiry("");
      ap(`/share/${file.hash}`).then(r=>r.json()).then(d=>{ if(Array.isArray(d)) setShares(d); });
    } catch(e) { setError(e.message); } finally { setLoading(false); }
  };

  const revoke = async (recipientEmail) => {
    await ap(`/share/${file.hash}/revoke?email=${encodeURIComponent(recipientEmail)}`,{method:"DELETE"});
    setShares(prev=>prev.filter(s=>s.shared_with!==recipientEmail));
  };

  const createPublicLink = async () => {
    const res  = await ap(`/share/${file.hash}/public`, {method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({expires_days: expiry ? parseInt(expiry) : null})});
    const data = await res.json();
    if (res.ok || res.status===200) {
      setPublicLink({exists:true, token:data.token, public_url:data.public_url||`${window.location.origin}/p/${data.token}`});
    }
  };

  const revokePublicLink = async () => {
    await ap(`/share/${file.hash}/public`, {method:"DELETE"});
    setPublicLink(null);
  };

  const copyLink = (url) => {
    navigator.clipboard.writeText(url);
    setCopied(true); setTimeout(()=>setCopied(false), 2000);
  };

  const inp = {flex:1,padding:"9px 12px",background:"rgba(255,255,255,0.06)",
    border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,color:"#fff",
    fontSize:13,outline:"none",fontFamily:"inherit"};

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:250}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",
        border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",
        width:500,maxWidth:"90vw",boxShadow:"0 24px 60px rgba(0,0,0,0.7)",
        maxHeight:"85vh",overflowY:"auto"}}>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div>
            <h2 style={{margin:0,fontSize:15,fontWeight:500,color:"#fff"}}>🔗 Share file</h2>
            <p style={{margin:"3px 0 0",fontSize:12,color:"rgba(255,255,255,0.4)",
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:360}}>
              {file.filename}</p>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",
            fontSize:16,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>

        {/* Feature 3: Public link section */}
        <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,
          padding:"12px",marginBottom:16,border:"0.5px solid rgba(255,255,255,0.07)"}}>
          <p style={{margin:"0 0 8px",fontSize:12,fontWeight:500,
            color:"rgba(255,255,255,0.5)",textTransform:"uppercase",letterSpacing:"0.05em"}}>
            Public link</p>
          {publicLink?.exists ? (
            <div>
              <div style={{display:"flex",gap:8,marginBottom:8}}>
                <input readOnly value={publicLink.public_url||`${window.location.origin}/p/${publicLink.token}`}
                  style={{...inp,flex:1,fontSize:11,color:"rgba(255,255,255,0.6)"}}/>
                <button onClick={()=>copyLink(publicLink.public_url||`${window.location.origin}/p/${publicLink.token}`)}
                  style={{background:copied?"rgba(16,185,129,0.2)":"rgba(59,130,246,0.12)",
                    border:`0.5px solid ${copied?"rgba(16,185,129,0.4)":"rgba(59,130,246,0.3)"}`,
                    borderRadius:8,padding:"6px 14px",cursor:"pointer",fontSize:12,
                    color:copied?"#34D399":"#60A5FA",fontFamily:"inherit",whiteSpace:"nowrap"}}>
                  {copied?"✓ Copied":"Copy"}
                </button>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.3)"}}>
                  Anyone with this link can download — no login needed
                </p>
                <button onClick={revokePublicLink}
                  style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",
                    borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:11,
                    color:"#FCA5A5",fontFamily:"inherit",whiteSpace:"nowrap",marginLeft:8}}>
                  Revoke
                </button>
              </div>
            </div>
          ) : (
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <p style={{margin:0,fontSize:12,color:"rgba(255,255,255,0.4)",flex:1}}>
                Create a link anyone can use to download this file
              </p>
              <button onClick={createPublicLink}
                style={{background:"rgba(59,130,246,0.12)",border:"0.5px solid rgba(59,130,246,0.3)",
                  borderRadius:8,padding:"7px 14px",cursor:"pointer",fontSize:12,
                  color:"#60A5FA",fontFamily:"inherit",whiteSpace:"nowrap"}}>
                Create link
              </button>
            </div>
          )}
        </div>

        {/* Private share section */}
        <p style={{margin:"0 0 8px",fontSize:12,fontWeight:500,
          color:"rgba(255,255,255,0.5)",textTransform:"uppercase",letterSpacing:"0.05em"}}>
          Share with user</p>

        {error&&<div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",
          borderRadius:8,padding:"9px 12px",marginBottom:12,fontSize:13,color:"#FCA5A5"}}>{error}</div>}
        {success&&<div style={{background:"rgba(16,185,129,0.1)",border:"0.5px solid rgba(16,185,129,0.3)",
          borderRadius:8,padding:"9px 12px",marginBottom:12,fontSize:13,color:"#6EE7B7"}}>{success}</div>}

        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <input type="email" placeholder="Recipient email" value={email}
            onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&share()} style={inp}/>
          <input type="number" placeholder="Days" value={expiry}
            onChange={e=>setExpiry(e.target.value)}
            style={{...inp,width:80,flex:"none"}} min="1" max="365"/>
        </div>
        <button onClick={share} disabled={loading||!email}
          style={{width:"100%",padding:"9px",borderRadius:8,border:"none",
            background:loading||!email?"rgba(59,130,246,0.35)":"#3B82F6",
            color:"#fff",fontSize:13,fontWeight:500,
            cursor:loading||!email?"not-allowed":"pointer",fontFamily:"inherit",marginBottom:16}}>
          {loading?"Sharing…":"Share (view-only)"}
        </button>

        {shares.length>0&&(
          <div>
            <p style={{margin:"0 0 8px",fontSize:11,color:"rgba(255,255,255,0.4)",
              textTransform:"uppercase",letterSpacing:"0.05em"}}>Shared with</p>
            {shares.map(s=>(
              <div key={s.shared_with} style={{display:"flex",alignItems:"center",
                justifyContent:"space-between",padding:"8px 10px",
                background:"rgba(255,255,255,0.03)",borderRadius:8,marginBottom:6}}>
                <div>
                  <p style={{margin:0,fontSize:13,color:"#fff"}}>{s.shared_with}</p>
                  <p style={{margin:"2px 0 0",fontSize:11,color:"rgba(255,255,255,0.3)"}}>
                    {relTime(s.created_at)}{s.expires_at?` · expires ${relTime(s.expires_at)}`:" · no expiry"}
                  </p>
                </div>
                <button onClick={()=>revoke(s.shared_with)}
                  style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",
                    borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:12,
                    color:"#FCA5A5",fontFamily:"inherit"}}>Revoke</button>
              </div>
            ))}
          </div>
        )}
        <p style={{margin:"12px 0 0",fontSize:11,color:"rgba(255,255,255,0.25)"}}>
          Recipients can download but not delete your file.
        </p>
      </div>
    </div>
  );
}

// ── Error modals ──────────────────────────────────────────────────

function DuplicateError({ filename, onClose }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",
        border:"1px solid rgba(239,68,68,0.3)",borderRadius:16,padding:"1.5rem",
        width:420,maxWidth:"90vw"}}>
        <h2 style={{margin:"0 0 12px",fontSize:15,fontWeight:500,color:"#fff"}}>⚠️ File already exists</h2>
        <p style={{margin:"0 0 16px",fontSize:13,color:"#FCA5A5",lineHeight:1.6}}>
          You already have <strong style={{color:"#fff"}}>"{filename}"</strong> in this folder.</p>
        <button onClick={onClose} style={{width:"100%",padding:"9px",borderRadius:8,border:"none",
          background:"#3B82F6",color:"#fff",fontSize:13,fontWeight:500,
          cursor:"pointer",fontFamily:"inherit"}}>OK</button>
      </div>
    </div>
  );
}

function QuotaError({ message, onClose }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",
        border:"1px solid rgba(239,68,68,0.3)",borderRadius:16,padding:"1.5rem",
        width:420,maxWidth:"90vw"}}>
        <h2 style={{margin:"0 0 12px",fontSize:15,fontWeight:500,color:"#fff"}}>💾 Quota exceeded</h2>
        <p style={{margin:"0 0 16px",fontSize:13,color:"#FCA5A5",lineHeight:1.6}}>{message}</p>
        <button onClick={onClose} style={{width:"100%",padding:"9px",borderRadius:8,border:"none",
          background:"#3B82F6",color:"#fff",fontSize:13,fontWeight:500,
          cursor:"pointer",fontFamily:"inherit"}}>OK</button>
      </div>
    </div>
  );
}

// ── New folder modal ──────────────────────────────────────────────

function NewFolderModal({ token, parentId, onCreated, onClose }) {
  const [name,setName]       = useState("");
  const [loading,setLoading] = useState(false);
  const [error,setError]     = useState("");
  const create = async () => {
    if (!name.trim()) return;
    setLoading(true); setError("");
    try {
      const res  = await apiFetch(token)("/folders",{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({name:name.trim(),parent_id:parentId||null})});
      const data = await res.json();
      if (!res.ok) { setError(data.error||"Failed"); return; }
      onCreated(data); onClose();
    } catch(e) { setError(e.message); } finally { setLoading(false); }
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",
        border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",
        width:380,maxWidth:"90vw"}}>
        <h2 style={{margin:"0 0 16px",fontSize:15,fontWeight:500,color:"#fff"}}>📁 New folder</h2>
        {error&&<div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",
          borderRadius:8,padding:"9px 12px",marginBottom:12,fontSize:13,color:"#FCA5A5"}}>{error}</div>}
        <input autoFocus type="text" placeholder="Folder name" value={name}
          onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&create()}
          style={{width:"100%",padding:"11px 14px",boxSizing:"border-box",
            background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",
            borderRadius:10,color:"#fff",fontSize:14,outline:"none",fontFamily:"inherit",marginBottom:12}}/>
        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{flex:1,padding:"9px",borderRadius:8,
            border:"0.5px solid rgba(255,255,255,0.12)",background:"transparent",
            color:"rgba(255,255,255,0.6)",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          <button onClick={create} disabled={loading||!name.trim()} style={{flex:1,padding:"9px",
            borderRadius:8,border:"none",
            background:loading||!name.trim()?"rgba(59,130,246,0.35)":"#3B82F6",
            color:"#fff",fontSize:13,fontWeight:500,
            cursor:loading||!name.trim()?"not-allowed":"pointer",fontFamily:"inherit"}}>Create</button>
        </div>
      </div>
    </div>
  );
}

// ── Admin dashboard ───────────────────────────────────────────────

function AdminDashboard({ token, onClose }) {
  const [stats,setStats]     = useState(null);
  const [users,setUsers]     = useState([]);
  const [loading,setLoading] = useState(true);
  const ap = apiFetch(token);
  useEffect(() => {
    Promise.all([ap("/admin/stats"),ap("/admin/users")])
      .then(async([sr,ur])=>{ const[s,u]=await Promise.all([sr.json(),ur.json()]);
        setStats(s); setUsers(Array.isArray(u)?u:[]); })
      .finally(()=>setLoading(false));
  }, []); // eslint-disable-line
  const card=(l,v,c="#fff")=>(
    <div style={{background:"rgba(255,255,255,0.04)",borderRadius:10,padding:"12px 14px"}}>
      <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.05em"}}>{l}</p>
      <p style={{margin:"5px 0 0",fontSize:20,fontWeight:500,color:c}}>{v}</p>
    </div>);
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",backdropFilter:"blur(8px)",
      display:"flex",alignItems:"flex-start",justifyContent:"center",zIndex:400,
      overflowY:"auto",padding:"2rem 1rem"}}>
      <div style={{width:"100%",maxWidth:860,background:"#161616",
        border:"1px solid rgba(255,255,255,0.1)",borderRadius:20,padding:"1.75rem",
        boxShadow:"0 32px 80px rgba(0,0,0,0.8)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div>
            <h2 style={{margin:0,fontSize:18,fontWeight:500,color:"#fff"}}>⚡ Admin Dashboard</h2>
            <p style={{margin:"3px 0 0",fontSize:12,color:"rgba(255,255,255,0.4)"}}>Platform health and statistics</p>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",
            fontSize:20,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>
        {loading?<p style={{color:"rgba(255,255,255,0.4)",fontSize:14}}>Loading…</p>:stats&&(<>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10,marginBottom:20}}>
            {card("Total users",  stats.total_users,          "#60A5FA")}
            {card("Total files",  stats.total_files,          "#fff")}
            {card("Storage used", fmt(stats.total_stored_bytes),"#F59E0B")}
            {card("Space saved",  fmt(stats.platform_saved),  "#10B981")}
            {card("Dedup events", stats.total_dedup_events,   "#A78BFA")}
            {card("Live peers",   stats.live_peers,           "#34D399")}
            {card("ML models",    stats.ml_models_trained+" trained","#8B5CF6")}
            {card("Total quota",  fmt(stats.total_quota_bytes),"rgba(255,255,255,0.4)")}
          </div>
          <div style={{background:"rgba(255,255,255,0.03)",borderRadius:12,padding:"1rem",marginBottom:20}}>
            <p style={{margin:"0 0 10px",fontSize:12,fontWeight:500,color:"rgba(255,255,255,0.4)",
              textTransform:"uppercase",letterSpacing:"0.05em"}}>Live P2P Network</p>
            {!stats.peers?.length
              ?<p style={{margin:0,fontSize:13,color:"rgba(255,255,255,0.3)"}}>No peers connected</p>
              :<div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                {(stats.peers||[]).map(p=>{
                  const chunks=Object.values(p.chunks||{}).reduce((a,b)=>a+b,0);
                  return <div key={p.peer_id} style={{display:"flex",alignItems:"center",gap:6,
                    background:`${p.color}18`,border:`0.5px solid ${p.color}44`,borderRadius:8,padding:"6px 10px"}}>
                    <div style={{width:7,height:7,borderRadius:"50%",background:p.color}}/>
                    <span style={{fontSize:12,color:p.color,fontWeight:500}}>{p.peer_id}</span>
                    <span style={{fontSize:11,color:"rgba(255,255,255,0.3)"}}>{chunks} chunks</span>
                  </div>;})}
              </div>}
          </div>
          {users.length>0&&(
            <div>
              <p style={{margin:"0 0 10px",fontSize:12,fontWeight:500,color:"rgba(255,255,255,0.4)",
                textTransform:"uppercase",letterSpacing:"0.05em"}}>Users</p>
              <div style={{background:"rgba(255,255,255,0.02)",border:"0.5px solid rgba(255,255,255,0.07)",
                borderRadius:12,overflow:"hidden"}}>
                <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr",gap:12,
                  padding:"8px 14px",borderBottom:"0.5px solid rgba(255,255,255,0.07)",
                  fontSize:11,fontWeight:500,color:"rgba(255,255,255,0.3)",
                  textTransform:"uppercase",letterSpacing:"0.05em"}}>
                  <span>User ID</span><span>Files</span><span>Stored</span><span>Quota</span><span>Dedup saved</span>
                </div>
                {users.map(u=>{
                  const qb=u.quota_bytes||(10*1024*1024*1024); const ub=u.total_stored||0;
                  const up=Math.round(ub/qb*100);
                  return <div key={u.user_id} style={{display:"grid",
                    gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr",gap:12,padding:"10px 14px",
                    borderBottom:"0.5px solid rgba(255,255,255,0.05)",fontSize:13}}>
                    <span style={{color:"rgba(255,255,255,0.5)",fontSize:11,overflow:"hidden",
                      textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={u.user_id}>
                      {u.user_id?.slice(0,16)}…</span>
                    <span style={{color:"#fff"}}>{u.total_files||0}</span>
                    <span style={{color:"#F59E0B"}}>{fmt(ub)}</span>
                    <span style={{color:up>80?"#FCA5A5":"#10B981"}}>{up}%</span>
                    <span style={{color:"#A78BFA"}}>{fmt(u.total_dedup_saved||0)}</span>
                  </div>;})}
              </div>
            </div>)}
        </>)}
      </div>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────

function Sidebar({ stats, activeView, setActiveView, user, onSignOut, trashCount,
                   folders, currentFolderId, onFolderClick, isAdmin, onAdminOpen }) {
  const usedBytes  = stats?.total_stored||0;
  const quotaBytes = stats?.quota_bytes||(10*1024*1024*1024);
  const usedPct    = Math.min(100,(usedBytes/quotaBytes)*100);
  const totalSaved = stats?(stats.total_original-stats.total_stored):0;
  const mlTrained  = stats?.ml_models_trained||0;
  const quotaPct   = stats?.quota_used_pct||0;
  const nav = [
    {id:"active",  icon:"🗂️", label:"My Files"},
    {id:"shared",  icon:"🔗", label:"Shared with me"},
    {id:"starred", icon:"⭐", label:"Starred"},
    {id:"trash",   icon:"🗑️", label:"Trash", badge:trashCount},
  ];
  return (
    <aside style={{width:215,flexShrink:0,padding:"1rem 0.75rem",
      borderRight:"0.5px solid rgba(255,255,255,0.07)",
      display:"flex",flexDirection:"column",gap:2,overflow:"hidden"}}>
      {nav.map(item=>(
        <button key={item.id} onClick={()=>setActiveView(item.id)} style={{
          display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"9px 12px",borderRadius:10,border:"none",cursor:"pointer",
          fontSize:13,textAlign:"left",fontFamily:"inherit",
          background:activeView===item.id&&!currentFolderId?"rgba(255,255,255,0.08)":"transparent",
          color:activeView===item.id&&!currentFolderId?"#fff":"rgba(255,255,255,0.55)",
          fontWeight:activeView===item.id&&!currentFolderId?500:400,
          transition:"background 0.1s,color 0.1s"}}>
          <span style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:16}}>{item.icon}</span>{item.label}</span>
          {item.badge>0&&<span style={{fontSize:10,background:"rgba(239,68,68,0.2)",
            color:"#FCA5A5",borderRadius:10,padding:"1px 7px",fontWeight:600}}>{item.badge}</span>}
        </button>))}
      {folders.length>0&&activeView==="active"&&(
        <div style={{marginTop:4,paddingTop:4,borderTop:"0.5px solid rgba(255,255,255,0.06)"}}>
          {folders.map(f=>(
            <button key={f.id} onClick={()=>onFolderClick(f.id)} style={{
              display:"flex",alignItems:"center",gap:8,padding:"7px 12px",
              borderRadius:8,border:"none",cursor:"pointer",fontSize:12,
              textAlign:"left",fontFamily:"inherit",width:"100%",
              background:currentFolderId===f.id?"rgba(255,255,255,0.08)":"transparent",
              color:currentFolderId===f.id?"#fff":"rgba(255,255,255,0.5)",
              transition:"background 0.1s"}}>
              <span>📁</span>
              <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</span>
            </button>))}
        </div>)}
      <div style={{marginTop:"auto",padding:"12px",background:"rgba(255,255,255,0.03)",
        borderRadius:12,border:"0.5px solid rgba(255,255,255,0.06)"}}>
        <p style={{margin:"0 0 8px",fontSize:11,color:"rgba(255,255,255,0.4)",
          textTransform:"uppercase",letterSpacing:"0.05em"}}>Storage</p>
        <div style={{height:4,background:"rgba(255,255,255,0.08)",borderRadius:2,marginBottom:8,overflow:"hidden"}}>
          <div style={{width:`${usedPct.toFixed(1)}%`,height:"100%",
            background:quotaPct>85?"#EF4444":"linear-gradient(90deg,#3B82F6,#8B5CF6)",
            borderRadius:2,transition:"width 0.3s"}}/>
        </div>
        <p style={{margin:0,fontSize:12,color:quotaPct>85?"#FCA5A5":"rgba(255,255,255,0.6)"}}>
          {fmt(usedBytes)} <span style={{color:"rgba(255,255,255,0.3)"}}>/ {fmt(quotaBytes)}</span></p>
        {stats&&<p style={{margin:"4px 0 0",fontSize:11,color:"#10B981"}}>{fmt(totalSaved)} saved</p>}
        <div style={{marginTop:6,paddingTop:6,borderTop:"0.5px solid rgba(255,255,255,0.06)"}}>
          <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.4)"}}>🤖 ML: <span style={{color:mlTrained>0?"#A78BFA":"rgba(255,255,255,0.25)"}}>{mlTrained>0?`${mlTrained} trained`:"collecting…"}</span></p>
        </div>
      </div>
      {isAdmin&&(
        <button onClick={onAdminOpen} style={{display:"flex",alignItems:"center",gap:8,
          padding:"8px 12px",borderRadius:10,border:"0.5px solid rgba(239,68,68,0.3)",
          cursor:"pointer",fontSize:12,background:"rgba(239,68,68,0.08)",
          color:"#FCA5A5",fontFamily:"inherit",marginTop:4}}>
          <span>⚡</span>Admin Dashboard
        </button>)}
      <div style={{padding:"10px 12px",borderTop:"0.5px solid rgba(255,255,255,0.07)",marginTop:4,
        display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
        <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.5)",overflow:"hidden",
          textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>{user?.email}</p>
        <button onClick={onSignOut} title="Sign out" style={{background:"none",
          border:"0.5px solid rgba(255,255,255,0.12)",borderRadius:7,padding:"4px 8px",
          cursor:"pointer",fontSize:11,color:"rgba(255,255,255,0.4)",flexShrink:0,fontFamily:"inherit"}}>↩</button>
      </div>
    </aside>
  );
}

// ── Top bar ───────────────────────────────────────────────────────

function TopBar({ wsStatus, myPeerId, myColor, peerCount, onUpload, onNewFolder,
                  uploading, searchQuery, setSearchQuery, activeView, breadcrumb, onBreadcrumbClick }) {
  const dotColor = wsStatus==="connected"?"#10B981":wsStatus==="connecting"?"#F59E0B":"#EF4444";
  return (
    <header style={{height:58,display:"flex",alignItems:"center",gap:12,
      padding:"0 1.25rem",borderBottom:"0.5px solid rgba(255,255,255,0.07)",
      background:"#0f0f0f",flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginRight:8}}>
        <div style={{width:28,height:28,borderRadius:8,
          background:"linear-gradient(135deg,#3B82F6,#8B5CF6)",
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>⬡</div>
        <span style={{fontSize:17,fontWeight:600,color:"#fff",letterSpacing:"-0.3px"}}>Nexus</span>
      </div>
      {breadcrumb.length>1?(
        <div style={{display:"flex",alignItems:"center",gap:4,fontSize:13,color:"rgba(255,255,255,0.5)"}}>
          {breadcrumb.map((crumb,i)=>(
            <span key={crumb.id||"root"} style={{display:"flex",alignItems:"center",gap:4}}>
              {i>0&&<span style={{opacity:0.3}}>/</span>}
              <button onClick={()=>onBreadcrumbClick(crumb.id)} style={{background:"none",border:"none",
                cursor:i<breadcrumb.length-1?"pointer":"default",
                color:i===breadcrumb.length-1?"#fff":"rgba(255,255,255,0.5)",
                fontSize:13,fontFamily:"inherit",padding:"2px 4px",borderRadius:4}}>
                {crumb.name}</button>
            </span>))}
        </div>
      ):(
        <div style={{flex:1,maxWidth:480,position:"relative"}}>
          <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",
            fontSize:14,color:"rgba(255,255,255,0.3)"}}>🔍</span>
          <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
            placeholder="Search files…"
            style={{width:"100%",padding:"8px 12px 8px 36px",background:"rgba(255,255,255,0.06)",
              border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:10,color:"#fff",
              fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
        </div>)}
      <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:6,background:"rgba(255,255,255,0.05)",
          border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:20,padding:"5px 12px",
          fontSize:12,color:"rgba(255,255,255,0.6)",flexShrink:0}}>
          <div style={{width:7,height:7,borderRadius:"50%",background:dotColor}}/>
          {wsStatus==="connected"
            ?<span><span style={{color:myColor,fontWeight:500}}>{myPeerId}</span>
                <span style={{color:"rgba(255,255,255,0.3)"}}> · {peerCount} peer{peerCount!==1?"s":""}</span></span>
            :<span style={{color:dotColor}}>{wsStatus}</span>}
        </div>
        {activeView==="active"&&(
          <button onClick={onNewFolder} style={{background:"rgba(255,255,255,0.07)",
            border:"0.5px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"7px 14px",
            color:"rgba(255,255,255,0.7)",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>
            📁 New folder</button>)}
        {activeView!=="trash"&&(
          <button onClick={onUpload} disabled={uploading} style={{
            background:uploading?"rgba(59,130,246,0.3)":"#3B82F6",border:"none",
            borderRadius:10,padding:"8px 18px",color:"#fff",fontSize:13,fontWeight:500,
            cursor:uploading?"not-allowed":"pointer",fontFamily:"inherit",transition:"background 0.15s"}}>
            {uploading?"⏳ Uploading…":"⬆ Upload"}</button>)}
      </div>
    </header>
  );
}

// ── File row ──────────────────────────────────────────────────────

function FileRow({ file, view, onStar, onTrash, onRestore, onDelete, onP2PDownload, onShare }) {
  const p     = file.original_size>0?Math.round(((file.original_size-file.stored_size)/file.original_size)*100):0;
  const color = catColor(file.category);
  const [hover,setHover] = useState(false);
  const days  = daysLeft(file.deleted_at);
  return (
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 70px 1fr auto",
        alignItems:"center",gap:12,padding:"10px 16px",
        background:hover?"rgba(255,255,255,0.04)":"transparent",
        borderBottom:"0.5px solid rgba(255,255,255,0.05)",
        transition:"background 0.1s",fontSize:13}}>
      <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
        <div style={{width:32,height:32,borderRadius:8,flexShrink:0,
          background:`${color}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>
          {catIcon(file.category)}</div>
        <div style={{minWidth:0}}>
          <p style={{margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
            color:file.deleted_at?"rgba(255,255,255,0.4)":"#fff",fontWeight:500}}
            title={file.filename}>{file.filename}</p>
          <div style={{display:"flex",gap:5,marginTop:3,flexWrap:"wrap"}}>
            {file.encrypted&&<span style={{fontSize:10,color:"#10B981"}}>🔒</span>}
            {file.starred&&<span style={{fontSize:10,color:"#FCD34D"}}>★</span>}
            {(file.ref_count||1)>1&&<span style={{fontSize:10,color:"#A78BFA"}}>×{file.ref_count}</span>}
            {file.ml_model_version>0&&<span style={{fontSize:10,color:"#8B5CF6"}}>🤖v{file.ml_model_version}</span>}
            {view==="trash"&&days!=null&&<span style={{fontSize:10,color:days<=2?"#FCA5A5":"rgba(255,255,255,0.3)"}}>{days}d left</span>}
          </div>
        </div>
      </div>
      <span style={{color:"rgba(255,255,255,0.45)"}}>{fmt(file.original_size)}</span>
      <span style={{color:"rgba(255,255,255,0.45)"}}>{fmt(file.stored_size)}</span>
      <span style={{color:"#10B981",fontWeight:500}}>{p}%</span>
      <span style={{color:"rgba(255,255,255,0.3)",fontSize:12}}>
        {view==="trash"?`deleted ${relTime(file.deleted_at)}`:relTime(file.upload_time)}</span>
      <div style={{display:"flex",gap:4}}>
        {(view==="active"||view==="starred")&&<>
          <button onClick={()=>onP2PDownload(file)} style={{background:"rgba(59,130,246,0.1)",
            border:"0.5px solid rgba(59,130,246,0.3)",borderRadius:7,padding:"5px 8px",
            cursor:"pointer",fontSize:12,color:"#60A5FA",fontFamily:"inherit"}}>⬇</button>
          <button onClick={()=>onShare(file)} style={{background:"rgba(16,185,129,0.1)",
            border:"0.5px solid rgba(16,185,129,0.3)",borderRadius:7,padding:"5px 8px",
            cursor:"pointer",fontSize:12,color:"#34D399",fontFamily:"inherit"}}>🔗</button>
          <button onClick={()=>onStar(file.hash,file.starred)} style={{
            background:file.starred?"rgba(251,191,36,0.15)":"none",
            border:`0.5px solid ${file.starred?"rgba(251,191,36,0.4)":"rgba(255,255,255,0.1)"}`,
            borderRadius:7,padding:"5px 7px",cursor:"pointer",fontSize:12,
            color:file.starred?"#FCD34D":"rgba(255,255,255,0.35)",fontFamily:"inherit"}}>
            {file.starred?"★":"☆"}</button>
          <button onClick={()=>onTrash(file.hash)} style={{background:"none",
            border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:7,padding:"5px 7px",
            cursor:"pointer",fontSize:12,color:"rgba(255,255,255,0.3)",fontFamily:"inherit"}}>🗑</button>
        </>}
        {view==="trash"&&<>
          <button onClick={()=>onRestore(file.hash)} style={{background:"rgba(16,185,129,0.1)",
            border:"0.5px solid rgba(16,185,129,0.3)",borderRadius:7,padding:"5px 10px",
            cursor:"pointer",fontSize:12,color:"#34D399",fontFamily:"inherit"}}>↩ Restore</button>
          <button onClick={()=>onDelete(file.hash)} style={{background:"rgba(239,68,68,0.1)",
            border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:7,padding:"5px 7px",
            cursor:"pointer",fontSize:12,color:"#FCA5A5",fontFamily:"inherit"}}>✕</button>
        </>}
        {view==="shared"&&(
          <button onClick={()=>onP2PDownload(file)} style={{background:"rgba(59,130,246,0.1)",
            border:"0.5px solid rgba(59,130,246,0.3)",borderRadius:7,padding:"5px 8px",
            cursor:"pointer",fontSize:12,color:"#60A5FA",fontFamily:"inherit"}}>⬇</button>)}
      </div>
    </div>
  );
}

// ── Folder row ────────────────────────────────────────────────────

function FolderRow({ folder, onOpen, onDelete, onRename }) {
  const [hover,setHover]     = useState(false);
  const [renaming,setRenaming] = useState(false);
  const [newName,setNewName]  = useState(folder.name);
  return (
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 70px 1fr auto",
        alignItems:"center",gap:12,padding:"10px 16px",
        background:hover?"rgba(255,255,255,0.04)":"transparent",
        borderBottom:"0.5px solid rgba(255,255,255,0.05)",
        transition:"background 0.1s",fontSize:13,cursor:"pointer"}}
      onClick={()=>onOpen(folder.id)}>
      <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
        <div style={{width:32,height:32,borderRadius:8,flexShrink:0,
          background:"rgba(251,191,36,0.15)",
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>📁</div>
        <div style={{minWidth:0}}>
          {renaming?(
            <input autoFocus value={newName} onChange={e=>setNewName(e.target.value)}
              onClick={e=>e.stopPropagation()}
              onKeyDown={e=>{ if(e.key==="Enter"){onRename(folder.id,newName);setRenaming(false);}
                             if(e.key==="Escape")setRenaming(false); }}
              onBlur={()=>{onRename(folder.id,newName);setRenaming(false);}}
              style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",
                borderRadius:5,color:"#fff",fontSize:13,padding:"2px 6px",
                fontFamily:"inherit",outline:"none"}}/>
          ):(
            <p style={{margin:0,overflow:"hidden",textOverflow:"ellipsis",
              whiteSpace:"nowrap",color:"#fff",fontWeight:500}}>{folder.name}</p>)}
          <p style={{margin:"2px 0 0",fontSize:11,color:"rgba(255,255,255,0.3)"}}>
            Folder · {relTime(folder.created_at)}</p>
        </div>
      </div>
      <span/><span/><span/><span/>
      <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
        <button onClick={()=>setRenaming(true)} style={{background:"none",
          border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:7,padding:"5px 7px",
          cursor:"pointer",fontSize:12,color:"rgba(255,255,255,0.4)",fontFamily:"inherit"}}>✏️</button>
        <button onClick={()=>onDelete(folder.id)} style={{background:"none",
          border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:7,padding:"5px 7px",
          cursor:"pointer",fontSize:12,color:"rgba(255,255,255,0.3)",fontFamily:"inherit"}}>🗑</button>
      </div>
    </div>
  );
}

// ── Shared-with-me view ───────────────────────────────────────────

function SharedWithMeView({ token, onP2PDownload }) {
  const [items,setItems]     = useState([]);
  const [loading,setLoading] = useState(true);
  useEffect(() => {
    apiFetch(token)("/shared-with-me").then(r=>r.json())
      .then(d=>{ if(Array.isArray(d)) setItems(d); })
      .finally(()=>setLoading(false));
  }, [token]);
  if (loading) return <p style={{color:"rgba(255,255,255,0.3)",fontSize:14,padding:"2rem 0"}}>Loading…</p>;
  if (!items.length) return <div style={{textAlign:"center",padding:"4rem 0",
    color:"rgba(255,255,255,0.25)",fontSize:14}}>Nothing shared with you yet</div>;
  return (
    <div style={{background:"rgba(255,255,255,0.02)",border:"0.5px solid rgba(255,255,255,0.07)",
      borderRadius:14,overflow:"hidden"}}>
      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 70px 1fr auto",gap:12,
        padding:"8px 16px",borderBottom:"0.5px solid rgba(255,255,255,0.07)",
        fontSize:11,fontWeight:500,color:"rgba(255,255,255,0.3)",
        textTransform:"uppercase",letterSpacing:"0.05em"}}>
        <span>Name</span><span>Original</span><span>Stored</span><span>Saved</span><span>Shared</span><span/>
      </div>
      {items.map(item=>{
        const f=item.files||{};
        const p=f.original_size>0?Math.round(((f.original_size-f.stored_size)/f.original_size)*100):0;
        return <div key={item.share_token} style={{display:"grid",
          gridTemplateColumns:"2fr 1fr 1fr 70px 1fr auto",alignItems:"center",
          gap:12,padding:"10px 16px",borderBottom:"0.5px solid rgba(255,255,255,0.05)",fontSize:13}}>
          <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
            <div style={{width:32,height:32,borderRadius:8,background:`${catColor(f.category)}22`,
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>
              {catIcon(f.category)}</div>
            <p style={{margin:0,overflow:"hidden",textOverflow:"ellipsis",
              whiteSpace:"nowrap",color:"#fff",fontWeight:500}}>{f.filename}</p>
          </div>
          <span style={{color:"rgba(255,255,255,0.45)"}}>{fmt(f.original_size)}</span>
          <span style={{color:"rgba(255,255,255,0.45)"}}>{fmt(f.stored_size)}</span>
          <span style={{color:"#10B981",fontWeight:500}}>{p}%</span>
          <span style={{color:"rgba(255,255,255,0.3)",fontSize:12}}>{relTime(item.created_at)}</span>
          <button onClick={()=>onP2PDownload({...f,hash:f.hash,chunk_count:f.chunk_count})}
            style={{background:"rgba(59,130,246,0.1)",border:"0.5px solid rgba(59,130,246,0.3)",
              borderRadius:7,padding:"5px 8px",cursor:"pointer",fontSize:12,
              color:"#60A5FA",fontFamily:"inherit"}}>⬇</button>
        </div>;})}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────

export default function App() {
  const [session,         setSession]         = useState(null);
  const [authReady,       setAuthReady]       = useState(false);
  const [files,           setFiles]           = useState([]);
  const [folders,         setFolders]         = useState([]);
  const [trashFiles,      setTrashFiles]      = useState([]);
  const [stats,           setStats]           = useState(null);
  const [uploading,       setUploading]       = useState(false);
  const [uploadProgress,  setUploadProgress]  = useState(null);
  const [uploadFilename,  setUploadFilename]  = useState("");
  const [result,          setResult]          = useState(null);
  const [dupError,        setDupError]        = useState(null);
  const [quotaError,      setQuotaError]      = useState(null);
  const [error,           setError]           = useState(null);
  const [p2pTarget,       setP2pTarget]       = useState(null);
  const [shareTarget,     setShareTarget]     = useState(null);
  const [activeView,      setActiveView]      = useState("active");
  const [currentFolderId, setCurrentFolderId] = useState(null);
  const [breadcrumb,      setBreadcrumb]      = useState([{id:null,name:"My Files"}]);
  const [searchQuery,     setSearchQuery]     = useState("");
  const [dragging,        setDragging]        = useState(false);
  const [showNewFolder,   setShowNewFolder]   = useState(false);
  const [showAdmin,       setShowAdmin]       = useState(false);
  const inputRef = useRef();

  const isAdmin = session?.user?.email === ADMIN_EMAIL;

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{ setSession(session); setAuthReady(true); });
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_,s)=>setSession(s));
    return ()=>subscription.unsubscribe();
  },[]);

  const handleSignOut = async ()=>{
    await supabase.auth.signOut(); setSession(null); setFiles([]); setStats(null); setFolders([]);
  };
  const token = session?.access_token;
  const ap    = useMemo(()=> token ? apiFetch(token) : null, [token]);

  const { ws, myPeerId, myColor, peerCount, wsStatus, sendMsg } = useP2P(token, {
    onFileAvailable: ()=>refresh(),
  });

  const refresh = useCallback(async ()=>{
    if (!ap) return;
    try {
      const [fRes,tRes,sRes,folRes] = await Promise.all([
        ap(`/files?view=${activeView}${currentFolderId?`&folder_id=${currentFolderId}`:""}`),
        ap(`/files?view=trash`),
        ap(`/stats`),
        activeView==="active"
          ? ap(`/folders${currentFolderId?`?parent_id=${currentFolderId}`:""}`)
          : Promise.resolve({json:()=>[]}),
      ]);
      if (fRes.status===401) { setError("Session expired — please sign in again."); return; }
      const [f,t,s,fol] = await Promise.all([fRes.json(),tRes.json(),sRes.json(),
        folRes.json?folRes.json():folRes]);
      setFiles(Array.isArray(f)?f:[]);
      setTrashFiles(Array.isArray(t)?t:[]);
      setStats(s);
      setFolders(Array.isArray(fol)?fol:[]);
    } catch(e) { setError(`Cannot reach backend: ${e.message}`); }
  },[ap, activeView, currentFolderId]);

  useEffect(()=>{ if(token) refresh(); },[token, activeView, currentFolderId]); // eslint-disable-line

  const openFolder = useCallback(async (folderId)=>{
    setCurrentFolderId(folderId);
    if (!folderId) { setBreadcrumb([{id:null,name:"My Files"}]); return; }
    try {
      const res  = await ap(`/folders/${folderId}/breadcrumb`);
      const data = await res.json();
      setBreadcrumb(Array.isArray(data)?data:[{id:null,name:"My Files"}]);
    } catch { setBreadcrumb([{id:null,name:"My Files"},{id:folderId,name:"Folder"}]); }
  },[ap]);

  // ── Feature 1+2: Smart upload dispatcher ─────────────────────
  const uploadFile = async (file) => {
    setUploading(true); setError(null); setDupError(null);
    setQuotaError(null); setUploadFilename(file.name);
    setUploadProgress({stage:"compressing",pct:0});

    try {
      let data;

      if (file.size > RESUMABLE_THRESHOLD) {
        // Feature 2: Use resumable upload for large files
        data = await resumableUpload(file, token, currentFolderId, (prog) => {
          setUploadProgress(prog);
        });
      } else {
        // Feature 1: Regular upload with optional client compression
        data = await regularUpload(file, token, currentFolderId, (prog) => {
          setUploadProgress(prog);
        });
      }

      if (data.httpStatus===409 || data.error==="duplicate_filename") {
        setDupError({filename:file.name}); return;
      }
      if (data.httpStatus===413 || data.error==="quota_exceeded") {
        setQuotaError(data.message); return;
      }
      if (data.error) { setError(`Upload failed: ${data.error}`); return; }

      setResult(data); refresh();
    } catch(e) { setError(`Upload failed: ${e.message}`); }
    finally    { setUploading(false); setUploadProgress(null); }
  };

  const handleStar    = async (h,cur) => {
    await ap(`/star/${h}`,{method:"PATCH"});
    setFiles(p=>p.map(f=>f.hash===h?{...f,starred:!cur}:f));
    if(activeView==="starred"&&cur) refresh();
  };
  const handleTrash   = async (h) => { await ap(`/trash/${h}`,{method:"PATCH"}); setFiles(p=>p.filter(f=>f.hash!==h)); refresh(); };
  const handleRestore = async (h) => { await ap(`/restore/${h}`,{method:"PATCH"}); setFiles(p=>p.filter(f=>f.hash!==h)); refresh(); };
  const handleDelete  = async (h) => {
    if (!window.confirm("Permanently delete? Cannot be undone.")) return;
    await ap(`/delete/${h}`,{method:"DELETE"});
    setFiles(p=>p.filter(f=>f.hash!==h)); refresh();
  };
  const handleHaveChunks = useCallback((fid,idxs)=>{ sendMsg({type:"have",file_id:fid,chunks:idxs}); },[sendMsg]);

  const handleFolderDelete = async (fid) => {
    if (!window.confirm("Delete folder? Files will be moved to root.")) return;
    await ap(`/folders/${fid}`,{method:"DELETE"}); refresh();
  };
  const handleFolderRename = async (fid, name) => {
    if (!name.trim()) return;
    await ap(`/folders/${fid}`,{method:"PATCH",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({name})}); refresh();
  };

  const visibleFiles = files.filter(f=>f.filename.toLowerCase().includes(searchQuery.toLowerCase()));
  const viewTitle    = {active:"My Files",starred:"Starred",trash:"Trash",shared:"Shared with me"}[activeView]||"My Files";

  if (!authReady) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",
      height:"100vh",background:"#0a0a0a",color:"rgba(255,255,255,0.3)",fontSize:14}}>Loading…</div>
  );
  if (!session) return <AuthPage onAuth={s=>setSession(s)}/>;

  return (
    <div style={{display:"flex",flexDirection:"column",width:"100%",height:"100vh",
      background:"#0f0f0f",color:"#fff",fontFamily:"var(--font-sans)",overflow:"hidden"}}>

      <TopBar wsStatus={wsStatus} myPeerId={myPeerId} myColor={myColor} peerCount={peerCount}
        onUpload={()=>inputRef.current?.click()} onNewFolder={()=>setShowNewFolder(true)}
        uploading={uploading} searchQuery={searchQuery} setSearchQuery={setSearchQuery}
        activeView={activeView} breadcrumb={breadcrumb} onBreadcrumbClick={openFolder}/>

      <input ref={inputRef} type="file" style={{display:"none"}}
        onChange={e=>{ if(e.target.files[0]) uploadFile(e.target.files[0]); }}/>

      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        <Sidebar stats={stats} activeView={activeView}
          setActiveView={(v)=>{ setActiveView(v); setSearchQuery(""); setCurrentFolderId(null);
            setBreadcrumb([{id:null,name:"My Files"}]); }}
          user={session.user} onSignOut={handleSignOut} trashCount={trashFiles.length}
          folders={folders} currentFolderId={currentFolderId} onFolderClick={openFolder}
          isAdmin={isAdmin} onAdminOpen={()=>setShowAdmin(true)}/>

        <main style={{flex:1,overflowY:"auto",padding:"1.25rem 1.5rem",minWidth:0}}>
          {error&&(
            <div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",
              borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#FCA5A5"}}>
              {error}
              <button onClick={()=>setError(null)} style={{float:"right",background:"none",
                border:"none",cursor:"pointer",color:"#FCA5A5",fontSize:14}}>✕</button>
            </div>)}

          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
            <div>
              <h2 style={{margin:"0 0 2px",fontSize:18,fontWeight:500}}>{viewTitle}</h2>
              <p style={{margin:0,fontSize:12,color:"rgba(255,255,255,0.35)"}}>
                {visibleFiles.length} file{visibleFiles.length!==1?"s":""}
                {activeView==="active"&&stats?` · ${fmt(stats.total_stored||0)} stored`:""}
                {activeView==="trash"?" · deleted after 7 days":""}
              </p>
            </div>
          </div>

          {activeView==="shared"&&<SharedWithMeView token={token} onP2PDownload={setP2pTarget}/>}

          {activeView==="active"&&files.length===0&&folders.length===0&&(
            <div
              onDrop={e=>{e.preventDefault();setDragging(false);if(e.dataTransfer.files[0])uploadFile(e.dataTransfer.files[0]);}}
              onDragOver={e=>{e.preventDefault();setDragging(true)}}
              onDragLeave={()=>setDragging(false)}
              onClick={()=>inputRef.current?.click()}
              style={{border:`1.5px dashed ${dragging?"#8B5CF6":"rgba(255,255,255,0.12)"}`,
                borderRadius:16,padding:"5rem 2rem",textAlign:"center",cursor:"pointer",
                background:dragging?"rgba(139,92,246,0.05)":"transparent",transition:"all 0.15s"}}>
              <p style={{margin:"0 0 8px",fontSize:20}}>📂</p>
              <p style={{margin:"0 0 6px",fontSize:15,fontWeight:500}}>Drop files here or click Upload</p>
              <p style={{margin:0,fontSize:13,color:"rgba(255,255,255,0.35)"}}>
                Compressed in browser · encrypted · P2P distributed · Supabase stored</p>
            </div>)}

          {(visibleFiles.length===0&&folders.length===0)&&activeView!=="active"&&activeView!=="shared"&&(
            <div style={{textAlign:"center",padding:"4rem 0",color:"rgba(255,255,255,0.25)",fontSize:14}}>
              {activeView==="starred"?"No starred files — click ☆ on a file":
               activeView==="trash"?"Trash is empty":""}
            </div>)}

          {(visibleFiles.length>0||folders.length>0)&&activeView!=="shared"&&(
            <div
              onDrop={e=>{if(activeView!=="trash"){e.preventDefault();setDragging(false);
                if(e.dataTransfer.files[0])uploadFile(e.dataTransfer.files[0]);}}}
              onDragOver={e=>{if(activeView!=="trash"){e.preventDefault();setDragging(true);}}}
              onDragLeave={()=>setDragging(false)} style={{position:"relative"}}>
              {dragging&&activeView!=="trash"&&(
                <div style={{position:"absolute",inset:0,zIndex:10,
                  background:"rgba(139,92,246,0.15)",border:"2px dashed #8B5CF6",
                  borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <p style={{fontSize:16,fontWeight:500,color:"#A78BFA"}}>Drop to upload</p>
                </div>)}
              <div style={{background:"rgba(255,255,255,0.02)",border:"0.5px solid rgba(255,255,255,0.07)",
                borderRadius:14,overflow:"hidden"}}>
                <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 70px 1fr auto",
                  gap:12,padding:"8px 16px",borderBottom:"0.5px solid rgba(255,255,255,0.07)",
                  fontSize:11,fontWeight:500,color:"rgba(255,255,255,0.3)",
                  textTransform:"uppercase",letterSpacing:"0.05em"}}>
                  <span>Name</span><span>Original</span><span>Stored</span><span>Saved</span>
                  <span>{activeView==="trash"?"Deleted":"Modified"}</span><span/>
                </div>
                {folders.map(f=><FolderRow key={f.id} folder={f} onOpen={openFolder}
                  onDelete={handleFolderDelete} onRename={handleFolderRename}/>)}
                {visibleFiles.map(f=><FileRow key={f.hash||f.id} file={f} view={activeView}
                  onStar={handleStar} onTrash={handleTrash} onRestore={handleRestore}
                  onDelete={handleDelete} onP2PDownload={setP2pTarget} onShare={setShareTarget}/>)}
              </div>
            </div>)}

          {visibleFiles.length===0&&searchQuery&&(
            <div style={{textAlign:"center",padding:"3rem 0",color:"rgba(255,255,255,0.3)",fontSize:14}}>
              No files match "{searchQuery}"</div>)}
        </main>
      </div>

      {/* Modals */}
      {uploading&&uploadProgress&&(
        <UploadProgressModal filename={uploadFilename} progress={uploadProgress}/>)}
      {result      &&<UploadResult result={result} onClose={()=>setResult(null)}/>}
      {dupError    &&<DuplicateError filename={dupError.filename} onClose={()=>setDupError(null)}/>}
      {quotaError  &&<QuotaError message={quotaError} onClose={()=>setQuotaError(null)}/>}
      {shareTarget &&<ShareModal file={shareTarget} token={token} onClose={()=>setShareTarget(null)}/>}
      {showNewFolder&&<NewFolderModal token={token} parentId={currentFolderId}
        onCreated={()=>refresh()} onClose={()=>setShowNewFolder(false)}/>}
      {showAdmin   &&<AdminDashboard token={token} onClose={()=>setShowAdmin(false)}/>}
      {p2pTarget   &&<P2PDownloader file={p2pTarget} sendMsg={sendMsg} wsRef={ws}
        myColor={myColor} token={token} onClose={()=>setP2pTarget(null)}
        onHaveChunks={handleHaveChunks}/>}
    </div>
  );
}
