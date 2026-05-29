/**
 * Nexus – Phase 9
 * ================
 * New features:
 *   1. Client-side compression — zstd-wasm compresses in browser before upload
 *   2. Resumable uploads — large files chunked with progress bar, auto-resume on failure
 *   3. Public share links — anyone with link can download, no account needed
 *   4. Email notifications — recipient emailed when file shared with them
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = "https://hoqzrxxqczxwwnqimvxm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhvcXpyeHhxY3p4d3ducWltdnhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcyNzAzMzgsImV4cCI6MjA4Mjg0NjMzOH0.KWrM31jwQu98qevgPKbSzEIrsulKpjxiBQ1X4QlkHFc";
const supabase  = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const ADMIN_EMAIL = "rushailharjai10@gmail.com";

// In production (Render), React and API are served from the same origin.
// On Vercel frontend → Render backend, set VITE_API_URL in Vercel env vars.
const API = import.meta.env.VITE_API_URL || "";
// WebSocket URL: auto-derives from API host so it works on any deployment.
const _wsBase = API
  ? API.replace(/^http/, "ws")
  : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
const WS_URL = import.meta.env.VITE_WS_URL || `${_wsBase}/ws`;

// Resumable upload threshold — files above this use chunked upload
const RESUMABLE_THRESHOLD = 10 * 1024 * 1024;  // 10 MB
const UPLOAD_CHUNK_SIZE   =  5 * 1024 * 1024;  //  5 MB per chunk

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (b) => {
  if (!b||b===0) return "0 B";
  const k=1024,s=["B","KB","MB","GB","TB"],i=Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1))+" "+s[i];
};
const relTime = (ts) => {
  if (!ts) return "—";
  const t=typeof ts==="string"?new Date(ts).getTime()/1000:ts, d=Date.now()/1000-t;
  if (d<60) return "just now"; if (d<3600) return Math.floor(d/60)+"m ago";
  if (d<86400) return Math.floor(d/3600)+"h ago"; return Math.floor(d/86400)+"d ago";
};
const daysLeft = (del) => {
  if (!del) return null;
  const t=typeof del==="string"?new Date(del).getTime()/1000:del;
  return Math.max(0,Math.ceil(7-(Date.now()/1000-t)/86400));
};
const catIcon  = (c) => ({image:"🖼️",video:"🎬",audio:"🎵",document:"📄",archive:"📦",code:"💻",other:"📎"})[c]||"📎";
const catColor = (c) => ({image:"#F59E0B",video:"#EF4444",audio:"#8B5CF6",document:"#3B82F6",archive:"#F97316",code:"#10B981",other:"#6B7280"})[c]||"#6B7280";

const apiFetch = (token) => (path,opts={}) =>
  fetch(`${API}${path}`,{...opts,headers:{Authorization:`Bearer ${token}`,...opts.headers}});

// ── Feature 1: Client-side zstd compression ───────────────────────────────────
// Uses zstd-wasm loaded from CDN. Falls back gracefully if unavailable.

let zstdReady = false;
let zstdCompress = null;

async function initZstd() {
  if (zstdReady) return true;
  try {
    // Load zstd-wasm from CDN
    const { ZstdInit } = await import("https://cdn.jsdelivr.net/npm/zstd-wasm@0.0.21/+esm");
    const { compress } = await ZstdInit();
    zstdCompress = (data, level=5) => compress(data, level);
    zstdReady = true;
    console.log("[nexus] zstd-wasm ready — client-side compression enabled");
    return true;
  } catch (e) {
    console.warn("[nexus] zstd-wasm unavailable — server-side compression only:", e.message);
    return false;
  }
}

// Attempt to init on module load (non-blocking)
initZstd();

async function compressClientSide(arrayBuffer) {
  if (!zstdReady || !zstdCompress) return null;
  try {
    const input      = new Uint8Array(arrayBuffer);
    const compressed = zstdCompress(input, 5);
    // Only use client compression if it actually saves space
    if (compressed.length >= input.length) return null;
    return compressed;
  } catch (e) {
    console.warn("[nexus] client compression failed:", e.message);
    return null;
  }
}

// ── Feature 2: Resumable upload engine ────────────────────────────────────────

async function resumableUpload(file, token, folderId, onProgress, signal) {
  const ap          = apiFetch(token);
  const totalChunks = Math.ceil(file.size / UPLOAD_CHUNK_SIZE);

  // 1. Start session
  const startRes = await ap("/upload/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename:     file.name,
      total_size:   file.size,
      total_chunks: totalChunks,
      folder_id:    folderId || null,
    }),
  });
  const startData = await startRes.json();
  if (!startRes.ok) throw new Error(startData.error || "Failed to start upload");
  const { session_id } = startData;

  // 2. Upload chunks with retry
  for (let i = 0; i < totalChunks; i++) {
    if (signal?.aborted) throw new Error("Upload cancelled");

    const start = i * UPLOAD_CHUNK_SIZE;
    const chunk = file.slice(start, start + UPLOAD_CHUNK_SIZE);
    const buf   = await chunk.arrayBuffer();

    let attempts = 0;
    while (attempts < 3) {
      try {
        const res = await ap(`/upload/chunk/${session_id}?chunk_index=${i}`, {
          method:  "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body:    buf,
          signal,
        });
        if (!res.ok) throw new Error(`Chunk ${i} failed: ${res.status}`);
        break;
      } catch (e) {
        attempts++;
        if (attempts === 3) throw e;
        await new Promise(r => setTimeout(r, 1000 * attempts)); // back-off
      }
    }

    onProgress?.({ chunksUploaded: i + 1, totalChunks, pct: Math.round(((i+1)/totalChunks)*100) });
  }

  // 3. Complete — server assembles, compresses, encrypts, stores
  const completeRes = await ap(`/upload/complete/${session_id}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ client_compressed: false }),
  });
  const data = await completeRes.json();
  if (!completeRes.ok) throw new Error(data.error || "Assembly failed");
  return data;
}

// ── Auth page ─────────────────────────────────────────────────────────────────

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
        const {error:e}=await supabase.auth.signUp({email,password});
        if (e) throw e;
        setSuccess("Check your email to confirm, then sign in."); setMode("login");
      } else {
        const {data,error:e}=await supabase.auth.signInWithPassword({email,password});
        if (e) throw e; onAuth(data.session);
      }
    } catch(e){setError(e.message||"Something went wrong");}
    finally{setLoading(false);}
  };
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#0a0a0a",fontFamily:"var(--font-sans)"}}>
      <div style={{width:400,padding:"2.5rem",background:"#161616",border:"1px solid rgba(255,255,255,0.09)",borderRadius:20,boxShadow:"0 32px 80px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:28}}>
          <div style={{width:36,height:36,borderRadius:10,background:"linear-gradient(135deg,#3B82F6,#8B5CF6)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⬡</div>
          <span style={{fontSize:22,fontWeight:700,color:"#fff",letterSpacing:"-0.5px"}}>Nexus</span>
        </div>
        <h2 style={{margin:"0 0 5px",fontSize:20,fontWeight:600,color:"#fff"}}>{mode==="login"?"Welcome back":"Create account"}</h2>
        <p style={{margin:"0 0 24px",fontSize:14,color:"rgba(255,255,255,0.4)"}}>{mode==="login"?"Sign in to your account":"Start with 10 GB free storage"}</p>
        {error&&<div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#FCA5A5"}}>{error}</div>}
        {success&&<div style={{background:"rgba(16,185,129,0.1)",border:"0.5px solid rgba(16,185,129,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#6EE7B7"}}>{success}</div>}
        <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
          <input type="email" placeholder="Email address" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={inp}/>
          <input type="password" placeholder="Password (min 6 chars)" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={inp}/>
        </div>
        <button onClick={submit} disabled={loading||!email||!password} style={{width:"100%",padding:"12px",borderRadius:10,border:"none",fontFamily:"inherit",background:loading||!email||!password?"rgba(59,130,246,0.35)":"#3B82F6",color:"#fff",fontSize:15,fontWeight:500,cursor:loading?"wait":!email||!password?"not-allowed":"pointer",transition:"background 0.15s"}}>
          {loading?"Please wait…":mode==="login"?"Sign in":"Create account"}
        </button>
        <p style={{margin:"18px 0 0",textAlign:"center",fontSize:13,color:"rgba(255,255,255,0.4)"}}>
          {mode==="login"?"No account? ":"Already have one? "}
          <span onClick={()=>{setMode(mode==="login"?"signup":"login");setError("");setSuccess("");}} style={{color:"#60A5FA",cursor:"pointer",fontWeight:500}}>{mode==="login"?"Sign up free":"Sign in"}</span>
        </p>
      </div>
    </div>
  );
}

// ── Upload progress modal ─────────────────────────────────────────────────────

function UploadProgressModal({ filename, pct, chunksUploaded, totalChunks, onCancel }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}}>
      <div style={{background:"#1a1a1a",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:420,maxWidth:"90vw",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}}>
        <h2 style={{margin:"0 0 6px",fontSize:15,fontWeight:500,color:"#fff"}}>⬆ Uploading…</h2>
        <p style={{margin:"0 0 20px",fontSize:12,color:"rgba(255,255,255,0.4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{filename}</p>

        {/* Progress bar */}
        <div style={{height:6,background:"rgba(255,255,255,0.08)",borderRadius:3,overflow:"hidden",marginBottom:10}}>
          <div style={{height:"100%",width:`${pct}%`,background:"linear-gradient(90deg,#3B82F6,#8B5CF6)",borderRadius:3,transition:"width 0.2s"}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"rgba(255,255,255,0.4)",marginBottom:20}}>
          <span>Chunk {chunksUploaded} of {totalChunks}</span>
          <span>{pct}%</span>
        </div>

        {/* Feature callout */}
        <div style={{background:"rgba(59,130,246,0.06)",border:"0.5px solid rgba(59,130,246,0.2)",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.6}}>
          <span style={{color:"#60A5FA",fontWeight:500}}>Resumable upload</span> — if this fails, it will pick up from chunk {chunksUploaded} instead of restarting.
        </div>

        <button onClick={onCancel} style={{width:"100%",padding:"9px",borderRadius:8,border:"0.5px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.08)",color:"#FCA5A5",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Cancel upload</button>
      </div>
    </div>
  );
}

// ── Upload result modal ───────────────────────────────────────────────────────

function UploadResult({ result, onClose }) {
  const saved=result.savings||0; const p=result.original_size>0?Math.round((saved/result.original_size)*100):0;
  const isDupe=result.status==="deduplicated";
  const clientCompressed = result.client_compressed;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:460,maxWidth:"90vw",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <h2 style={{margin:0,fontSize:15,fontWeight:500,color:"#fff"}}>{isDupe?"⚡ Deduplicated":"✅ Uploaded"}</h2>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>
        {isDupe
          ?<div style={{background:"rgba(59,130,246,0.1)",border:"0.5px solid rgba(59,130,246,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:13,color:"#93C5FD"}}>Exact duplicate — <strong>{result.ref_count}× referenced</strong>. Saved {fmt(result.dedup_bytes_saved)}.</div>
          :<div style={{background:"rgba(16,185,129,0.06)",border:"0.5px solid rgba(16,185,129,0.2)",borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.6}}>
            <span style={{color:"#10B981",fontWeight:500}}>Pipeline:</span>{" "}
            {clientCompressed
              ? "plaintext → zstd (browser🌐) → upload → AES-256-GCM → chunk → Supabase + P2P"
              : "plaintext → SHA-256 → zstd → AES-256-GCM → chunk → Supabase + P2P"}
          </div>
        }
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
          {[["Original",fmt(result.original_size),"#6B7280"],["Stored",fmt(result.stored_size),"#10B981"],["Saved",`${p}%`,"#8B5CF6"]].map(([l,v,c])=>(
            <div key={l} style={{background:"rgba(255,255,255,0.04)",borderRadius:10,padding:"12px",borderTop:`2px solid ${c}`}}>
              <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.05em"}}>{l}</p>
              <p style={{margin:"6px 0 0",fontSize:18,fontWeight:500,color:c}}>{v}</p>
            </div>
          ))}
        </div>
        <div style={{background:"rgba(255,255,255,0.03)",borderRadius:8,padding:"10px 14px",fontSize:12}}>
          {[["Ratio",`${result.ratio}×`],["zstd level",`level ${result.level}`],
            ["Category",`${catIcon(result.category)} ${result.category}`],
            ["Chunks",`${result.chunk_count||"—"} × 256 KB`],
            ["Compression",clientCompressed?"Browser (zstd-wasm)":"Server (ML-guided)"],
            ...(result.entropy!=null?[["Entropy",`${result.entropy} bits`]]:[]),
            ...(result.ml_model_version!=null?[["ML model",`v${result.ml_model_version}${result.ml_model_version===0?" (heuristic)":""}`]]:[]),
          ].map(([l,v])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
              <span style={{color:"rgba(255,255,255,0.4)"}}>{l}</span>
              <span style={{color:"rgba(255,255,255,0.8)",fontWeight:500}}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Feature 3: Public share link modal ────────────────────────────────────────

function PublicShareModal({ file, token, onClose }) {
  const [loading,    setLoading]    = useState(false);
  const [link,       setLink]       = useState(null);
  const [expiry,     setExpiry]     = useState("");
  const [maxDl,      setMaxDl]      = useState("");
  const [password,   setPassword]   = useState("");
  const [copied,     setCopied]     = useState(false);
  const [error,      setError]      = useState("");
  const ap = apiFetch(token);

  const generate = async () => {
    setLoading(true); setError("");
    try {
      const res  = await ap(`/share/${file.hash}/public`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          expires_days:  expiry  ? parseInt(expiry)  : null,
          max_downloads: maxDl   ? parseInt(maxDl)   : null,
          password:      password || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error||"Failed"); return; }
      setLink(data.public_url);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const copy = () => {
    navigator.clipboard.writeText(link);
    setCopied(true); setTimeout(()=>setCopied(false),2000);
  };

  const inp = {flex:1,padding:"9px 12px",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,color:"#fff",fontSize:13,outline:"none",fontFamily:"inherit"};

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:250}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:480,maxWidth:"90vw",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}}>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div>
            <h2 style={{margin:0,fontSize:15,fontWeight:500,color:"#fff"}}>🌐 Public link</h2>
            <p style={{margin:"3px 0 0",fontSize:12,color:"rgba(255,255,255,0.4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:360}}>{file.filename}</p>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>

        <div style={{background:"rgba(16,185,129,0.06)",border:"0.5px solid rgba(16,185,129,0.2)",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.6}}>
          Anyone with this link can download the file — <strong style={{color:"#10B981"}}>no account required</strong>. The file stays encrypted on disk; only the download is public.
        </div>

        {error&&<div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"9px 12px",marginBottom:12,fontSize:13,color:"#FCA5A5"}}>{error}</div>}

        {!link ? (
          <>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <div>
                <p style={{margin:"0 0 5px",fontSize:11,color:"rgba(255,255,255,0.4)"}}>Expires after (days)</p>
                <input type="number" placeholder="Never" value={expiry} onChange={e=>setExpiry(e.target.value)} min="1" style={{...inp,flex:"none",width:"100%",boxSizing:"border-box"}}/>
              </div>
              <div>
                <p style={{margin:"0 0 5px",fontSize:11,color:"rgba(255,255,255,0.4)"}}>Max downloads</p>
                <input type="number" placeholder="Unlimited" value={maxDl} onChange={e=>setMaxDl(e.target.value)} min="1" style={{...inp,flex:"none",width:"100%",boxSizing:"border-box"}}/>
              </div>
            </div>
            <div style={{marginBottom:16}}>
              <p style={{margin:"0 0 5px",fontSize:11,color:"rgba(255,255,255,0.4)"}}>Password protect (optional)</p>
              <input type="password" placeholder="Leave blank for no password" value={password} onChange={e=>setPassword(e.target.value)} style={{...inp,flex:"none",width:"100%",boxSizing:"border-box"}}/>
            </div>
            <button onClick={generate} disabled={loading} style={{width:"100%",padding:"10px",borderRadius:9,border:"none",background:loading?"rgba(59,130,246,0.35)":"#3B82F6",color:"#fff",fontSize:13,fontWeight:500,cursor:loading?"not-allowed":"pointer",fontFamily:"inherit"}}>
              {loading?"Generating…":"Generate public link"}
            </button>
          </>
        ) : (
          <div>
            <p style={{margin:"0 0 8px",fontSize:12,color:"rgba(255,255,255,0.5)"}}>Your public link is ready:</p>
            <div style={{display:"flex",gap:8,marginBottom:16}}>
              <input readOnly value={link} style={{...inp,flex:1,color:"#60A5FA",fontSize:12}}/>
              <button onClick={copy} style={{padding:"9px 16px",borderRadius:8,border:"none",background:copied?"rgba(16,185,129,0.2)":"rgba(59,130,246,0.15)",color:copied?"#34D399":"#60A5FA",fontSize:13,cursor:"pointer",fontFamily:"inherit",flexShrink:0,transition:"all 0.2s"}}>
                {copied?"✓ Copied":"Copy"}
              </button>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>window.open(link,"_blank")} style={{flex:1,padding:"9px",borderRadius:8,border:"0.5px solid rgba(255,255,255,0.1)",background:"transparent",color:"rgba(255,255,255,0.6)",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>
                Test link ↗
              </button>
              <button onClick={onClose} style={{flex:1,padding:"9px",borderRadius:8,border:"none",background:"#3B82F6",color:"#fff",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Feature 3+4: Private share modal (with email notification) ─────────────────

function ShareModal({ file, token, onClose }) {
  const [email,    setEmail]    = useState("");
  const [expiry,   setExpiry]   = useState("");
  const [loading,  setLoading]  = useState(false);
  const [shares,   setShares]   = useState([]);
  const [error,    setError]    = useState("");
  const [success,  setSuccess]  = useState("");
  const [tab,      setTab]      = useState("private"); // "private" | "public"
  const ap = apiFetch(token);

  useEffect(()=>{
    ap(`/share/${file.hash}`).then(r=>r.json()).then(d=>{ if(Array.isArray(d)) setShares(d); });
  },[file.hash]); // eslint-disable-line

  const share = async () => {
    if (!email) return;
    setLoading(true); setError(""); setSuccess("");
    try {
      const res = await ap(`/share/${file.hash}`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email:email.trim().toLowerCase(),expires_days:expiry?parseInt(expiry):null})});
      const data = await res.json();
      if (!res.ok){setError(data.error||"Failed");return;}
      // ── Feature 4: Email sent server-side automatically ───────────────────
      setSuccess(`✉️ Shared with ${email} — they'll receive an email notification`);
      setEmail(""); setExpiry("");
      ap(`/share/${file.hash}`).then(r=>r.json()).then(d=>{if(Array.isArray(d))setShares(d);});
    } catch(e){setError(e.message);} finally{setLoading(false);}
  };

  const revoke = async (recipientEmail) => {
    await ap(`/share/${file.hash}/revoke?email=${encodeURIComponent(recipientEmail)}`,{method:"DELETE"});
    setShares(p=>p.filter(s=>s.shared_with!==recipientEmail));
  };

  const inp={flex:1,padding:"9px 12px",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,color:"#fff",fontSize:13,outline:"none",fontFamily:"inherit"};

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:250}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:500,maxWidth:"90vw",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div>
            <h2 style={{margin:0,fontSize:15,fontWeight:500,color:"#fff"}}>🔗 Share file</h2>
            <p style={{margin:"3px 0 0",fontSize:12,color:"rgba(255,255,255,0.4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:380}}>{file.filename}</p>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>

        {/* Tab switcher */}
        <div style={{display:"flex",background:"rgba(255,255,255,0.05)",borderRadius:9,padding:3,gap:2,marginBottom:16}}>
          {[["private","🔒 Private (by email)"],["public","🌐 Public link"]].map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:"7px",borderRadius:7,border:"none",cursor:"pointer",fontSize:12,fontFamily:"inherit",background:tab===id?"rgba(255,255,255,0.12)":"transparent",color:tab===id?"#fff":"rgba(255,255,255,0.4)",transition:"all 0.1s"}}>{label}</button>
          ))}
        </div>

        {tab==="private"&&<>
          {error&&<div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"9px 12px",marginBottom:12,fontSize:13,color:"#FCA5A5"}}>{error}</div>}
          {success&&<div style={{background:"rgba(16,185,129,0.1)",border:"0.5px solid rgba(16,185,129,0.3)",borderRadius:8,padding:"9px 12px",marginBottom:12,fontSize:13,color:"#6EE7B7"}}>{success}</div>}

          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <input type="email" placeholder="Recipient email" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&share()} style={inp}/>
            <input type="number" placeholder="Days" value={expiry} onChange={e=>setExpiry(e.target.value)} style={{...inp,width:80,flex:"none"}} min="1"/>
          </div>

          {/* Feature 4 callout */}
          <div style={{background:"rgba(59,130,246,0.06)",border:"0.5px solid rgba(59,130,246,0.2)",borderRadius:8,padding:"8px 12px",marginBottom:12,fontSize:12,color:"rgba(255,255,255,0.4)"}}>
            ✉️ Recipient will receive an email notification with a download link.
          </div>

          <button onClick={share} disabled={loading||!email} style={{width:"100%",padding:"9px",borderRadius:8,border:"none",background:loading||!email?"rgba(59,130,246,0.35)":"#3B82F6",color:"#fff",fontSize:13,fontWeight:500,cursor:loading||!email?"not-allowed":"pointer",fontFamily:"inherit",marginBottom:16}}>
            {loading?"Sharing…":"Share & notify by email"}
          </button>

          {shares.filter(s=>!s.is_public).length>0&&(
            <div>
              <p style={{margin:"0 0 8px",fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Shared with</p>
              {shares.filter(s=>!s.is_public).map(s=>(
                <div key={s.shared_with} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 10px",background:"rgba(255,255,255,0.03)",borderRadius:8,marginBottom:6}}>
                  <div>
                    <p style={{margin:0,fontSize:13,color:"#fff"}}>{s.shared_with}</p>
                    <p style={{margin:"2px 0 0",fontSize:11,color:"rgba(255,255,255,0.3)"}}>{relTime(s.created_at)}{s.expires_at?` · expires ${relTime(s.expires_at)}`:" · no expiry"}</p>
                  </div>
                  <button onClick={()=>revoke(s.shared_with)} style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:12,color:"#FCA5A5",fontFamily:"inherit"}}>Revoke</button>
                </div>
              ))}
            </div>
          )}
        </>}

        {tab==="public"&&<PublicShareInline file={file} token={token}/>}
      </div>
    </div>
  );
}

// Public share inline (embedded in ShareModal tab)
function PublicShareInline({ file, token }) {
  const [loading,setLoading]=useState(false);
  const [link,setLink]=useState(null);
  const [expiry,setExpiry]=useState("");
  const [maxDl,setMaxDl]=useState("");
  const [password,setPassword]=useState("");
  const [copied,setCopied]=useState(false);
  const [error,setError]=useState("");
  const ap=apiFetch(token);
  const generate=async()=>{
    setLoading(true);setError("");
    try{
      const res=await ap(`/share/${file.hash}/public`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({expires_days:expiry?parseInt(expiry):null,max_downloads:maxDl?parseInt(maxDl):null,password:password||null})});
      const data=await res.json();
      if(!res.ok){setError(data.error||"Failed");return;}
      setLink(data.public_url);
    }catch(e){setError(e.message);}finally{setLoading(false);}
  };
  const copy=()=>{navigator.clipboard.writeText(link);setCopied(true);setTimeout(()=>setCopied(false),2000);};
  const inp={padding:"9px 12px",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,color:"#fff",fontSize:13,outline:"none",fontFamily:"inherit",width:"100%",boxSizing:"border-box"};
  return (
    <div>
      <div style={{background:"rgba(16,185,129,0.06)",border:"0.5px solid rgba(16,185,129,0.2)",borderRadius:8,padding:"9px 12px",marginBottom:12,fontSize:12,color:"rgba(255,255,255,0.5)"}}>
        🌐 Anyone with this link can download — <strong style={{color:"#10B981"}}>no account needed</strong>.
      </div>
      {error&&<div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"9px 12px",marginBottom:12,fontSize:13,color:"#FCA5A5"}}>{error}</div>}
      {!link?<>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <div><p style={{margin:"0 0 5px",fontSize:11,color:"rgba(255,255,255,0.4)"}}>Expires (days)</p><input type="number" placeholder="Never" value={expiry} onChange={e=>setExpiry(e.target.value)} style={inp}/></div>
          <div><p style={{margin:"0 0 5px",fontSize:11,color:"rgba(255,255,255,0.4)"}}>Max downloads</p><input type="number" placeholder="Unlimited" value={maxDl} onChange={e=>setMaxDl(e.target.value)} style={inp}/></div>
        </div>
        <div style={{marginBottom:12}}><p style={{margin:"0 0 5px",fontSize:11,color:"rgba(255,255,255,0.4)"}}>Password (optional)</p><input type="password" placeholder="No password" value={password} onChange={e=>setPassword(e.target.value)} style={inp}/></div>
        <button onClick={generate} disabled={loading} style={{width:"100%",padding:"9px",borderRadius:8,border:"none",background:loading?"rgba(59,130,246,0.35)":"#3B82F6",color:"#fff",fontSize:13,fontWeight:500,cursor:loading?"not-allowed":"pointer",fontFamily:"inherit"}}>
          {loading?"Generating…":"Generate public link"}
        </button>
      </>:<>
        <p style={{margin:"0 0 8px",fontSize:12,color:"rgba(255,255,255,0.5)"}}>Your public link:</p>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <input readOnly value={link} style={{...inp,color:"#60A5FA",fontSize:12,flex:1}}/>
          <button onClick={copy} style={{padding:"9px 14px",borderRadius:8,border:"none",background:copied?"rgba(16,185,129,0.2)":"rgba(59,130,246,0.15)",color:copied?"#34D399":"#60A5FA",fontSize:13,cursor:"pointer",fontFamily:"inherit",flexShrink:0,transition:"all 0.2s"}}>{copied?"✓":"Copy"}</button>
        </div>
        <button onClick={()=>window.open(link,"_blank")} style={{width:"100%",padding:"8px",borderRadius:8,border:"0.5px solid rgba(255,255,255,0.1)",background:"transparent",color:"rgba(255,255,255,0.6)",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Test link ↗</button>
      </>}
    </div>
  );
}

// ── Error modals ──────────────────────────────────────────────────────────────

function DuplicateError({filename,onClose}){return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}}onClick={onClose}><div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",border:"1px solid rgba(239,68,68,0.3)",borderRadius:16,padding:"1.5rem",width:420,maxWidth:"90vw"}}><h2 style={{margin:"0 0 12px",fontSize:15,fontWeight:500,color:"#fff"}}>⚠️ File already exists</h2><p style={{margin:"0 0 16px",fontSize:13,color:"#FCA5A5",lineHeight:1.6}}>You already have <strong style={{color:"#fff"}}>"{filename}"</strong> in this folder. Delete or rename it first.</p><button onClick={onClose} style={{width:"100%",padding:"9px",borderRadius:8,border:"none",background:"#3B82F6",color:"#fff",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>OK</button></div></div>);}

function QuotaError({message,onClose}){return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}}onClick={onClose}><div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",border:"1px solid rgba(239,68,68,0.3)",borderRadius:16,padding:"1.5rem",width:420,maxWidth:"90vw"}}><h2 style={{margin:"0 0 12px",fontSize:15,fontWeight:500,color:"#fff"}}>💾 Storage quota exceeded</h2><p style={{margin:"0 0 16px",fontSize:13,color:"#FCA5A5",lineHeight:1.6}}>{message}</p><button onClick={onClose} style={{width:"100%",padding:"9px",borderRadius:8,border:"none",background:"#3B82F6",color:"#fff",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>OK</button></div></div>);}

// ── WebSocket hook ────────────────────────────────────────────────────────────

function useP2P(token,{onFileAvailable}){
  const wsRef=useRef(null);
  const [myPeerId,setMyPeerId]=useState(null);
  const [myColor,setMyColor]=useState("#6B7280");
  const [peerCount,setPeerCount]=useState(0);
  const [wsStatus,setWsStatus]=useState("disconnected");
  const sendMsg=useCallback((msg)=>{if(wsRef.current?.readyState===WebSocket.OPEN)wsRef.current.send(JSON.stringify(msg));},[]);
  useEffect(()=>{
    if(!token)return;
    let ws,timer;
    const connect=()=>{
      setWsStatus("connecting");
      ws=new WebSocket(`${WS_URL}?token=${token}`);
      wsRef.current=ws;
      ws.onopen=()=>{setWsStatus("connected");ws.send(JSON.stringify({type:"register"}));};
      ws.onmessage=(e)=>{
        let msg;try{msg=JSON.parse(e.data);}catch{return;}
        if(msg.type==="welcome"){setMyPeerId(msg.peer_id);setMyColor(msg.color);}
        if(msg.type==="peers_updated"){setPeerCount((msg.peers||[]).length);}
        if(msg.type==="chunk_data"){wsRef.current?._chunkHandler?.(msg);}
        if(msg.type==="file_available"){onFileAvailable?.();}
      };
      ws.onclose=()=>{setWsStatus("disconnected");setMyPeerId(null);timer=setTimeout(connect,3000);};
      ws.onerror=()=>ws.close();
    };
    connect();
    const ping=setInterval(()=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:"ping"}));},25000);
    return()=>{clearTimeout(timer);clearInterval(ping);ws?.close();};
  },[token]); // eslint-disable-line
  return{ws:wsRef,myPeerId,myColor,peerCount,wsStatus,sendMsg};
}

// ── P2P Downloader ────────────────────────────────────────────────────────────

function P2PDownloader({file,sendMsg,wsRef,myColor,token,onClose,onHaveChunks}){
  const [chunks,setChunks]=useState({});const[status,setStatus]=useState("requesting");const[totalMs,setTotalMs]=useState(null);const[log,setLog]=useState([]);
  const startRef=useRef(Date.now());const{chunk_count:chunkCount,hash:fileId}=file;
  useEffect(()=>{
    if(!wsRef.current)return;
    wsRef.current._chunkHandler=(msg)=>{
      if(msg.file_id!==fileId)return;
      const bin=atob(msg.data);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
      const elapsed=Date.now()-startRef.current;
      setChunks(p=>({...p,[msg.chunk_index]:{from_peer:msg.from_peer,from_color:msg.from_color||myColor,elapsed}}));
      setLog(p=>[{idx:msg.chunk_index,peer:msg.from_peer,color:msg.from_color||"#6B7280",ms:elapsed},...p.slice(0,8)]);
    };
    return()=>{if(wsRef.current)wsRef.current._chunkHandler=null;};
  },[fileId,myColor,wsRef]);
  useEffect(()=>{startRef.current=Date.now();for(let i=0;i<chunkCount;i++)setTimeout(()=>sendMsg({type:"want",file_id:fileId,chunk_index:i}),i*5);},[fileId,chunkCount,sendMsg]);
  useEffect(()=>{
    if(Object.keys(chunks).length>0&&Object.keys(chunks).length>=chunkCount){
      setTotalMs(Date.now()-startRef.current);setStatus("done");
      fetch(`${API}/download/${fileId}`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.blob()).then(blob=>{const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=file.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);});
      onHaveChunks(fileId,Array.from({length:chunkCount},(_,i)=>i));
    }
  },[chunks,chunkCount,fileId,file,token,onHaveChunks]);
  const progress=chunkCount>0?Object.keys(chunks).length/chunkCount:0;
  const uniquePeers=[...new Set(Object.values(chunks).map(c=>c.from_peer))];
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}}onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#161616",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:560,maxWidth:"94vw",boxShadow:"0 32px 80px rgba(0,0,0,0.8)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div><h2 style={{margin:0,fontSize:16,fontWeight:500,color:"#fff"}}>{status==="done"?"✅ Download complete":"⬇️ P2P Download"}</h2><p style={{margin:"3px 0 0",fontSize:12,color:"rgba(255,255,255,0.4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:400}}>{file.filename}</p></div>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:18,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"rgba(255,255,255,0.35)",marginBottom:6}}><span>{Object.keys(chunks).length}/{chunkCount} chunks</span><span>{status==="done"?`✓ ${totalMs}ms`:`${uniquePeers.length} peer${uniquePeers.length!==1?"s":""} active`}</span></div>
          <div style={{height:6,background:"rgba(255,255,255,0.07)",borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",borderRadius:3,width:`${Math.round(progress*100)}%`,background:status==="done"?"#10B981":"linear-gradient(90deg,#8B5CF6,#3B82F6)",transition:"width 0.1s"}}/></div>
        </div>
        {uniquePeers.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>{uniquePeers.map(pid=>{const s=Object.values(chunks).find(c=>c.from_peer===pid);const col=s?.from_color||"#6B7280";const cnt=Object.values(chunks).filter(c=>c.from_peer===pid).length;return<div key={pid} style={{display:"flex",alignItems:"center",gap:5,background:`${col}22`,border:`1px solid ${col}`,borderRadius:6,padding:"3px 9px",fontSize:11,color:col}}><div style={{width:7,height:7,borderRadius:"50%",background:col}}/>{pid}<span style={{opacity:0.55}}>{cnt} chunks</span></div>;})}</div>}
        <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:12,maxHeight:130,overflowY:"auto",padding:"10px",background:"rgba(255,255,255,0.02)",borderRadius:8,border:"0.5px solid rgba(255,255,255,0.05)"}}>
          {Array.from({length:chunkCount},(_,i)=>{const c=chunks[i];return<div key={i} style={{width:22,height:22,borderRadius:4,background:c?c.from_color:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:"#fff",fontWeight:600,transition:"background 0.15s",opacity:c?1:0.3}}>{i+1}</div>;})}
        </div>
        <div style={{background:"rgba(0,0,0,0.4)",borderRadius:6,padding:"8px 10px",fontSize:11,fontFamily:"monospace",maxHeight:70,overflowY:"auto",border:"0.5px solid rgba(255,255,255,0.05)"}}>
          {log.length===0?<span style={{color:"rgba(255,255,255,0.2)"}}>waiting…</span>:log.map((l,i)=><div key={i} style={{color:i===0?"#fff":"rgba(255,255,255,0.3)",marginBottom:2}}><span style={{color:l.color}}>{l.peer}</span>{" → chunk "}<span style={{color:"rgba(255,255,255,0.6)"}}>{l.idx}</span>{" "}<span style={{color:"rgba(255,255,255,0.25)"}}>+{l.ms}ms</span></div>)}
        </div>
        {status==="done"&&<p style={{margin:"10px 0 0",fontSize:12,color:"#10B981",textAlign:"center"}}>All {chunkCount} chunks assembled ✓</p>}
      </div>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({stats,activeView,setActiveView,user,onSignOut,trashCount,folders,currentFolderId,onFolderClick,isAdmin,onAdminOpen}){
  const usedBytes=stats?.total_stored||0,quotaBytes=stats?.quota_bytes||(10*1024*1024*1024);
  const usedPct=Math.min(100,(usedBytes/quotaBytes)*100),quotaPct=stats?.quota_used_pct||0;
  const mlTrained=stats?.ml_models_trained||0,totalSaved=stats?(stats.total_original-stats.total_stored):0;
  const nav=[{id:"active",icon:"🗂️",label:"My Files"},{id:"shared",icon:"🔗",label:"Shared with me"},{id:"starred",icon:"⭐",label:"Starred"},{id:"trash",icon:"🗑️",label:"Trash",badge:trashCount}];
  return(
    <aside style={{width:215,flexShrink:0,padding:"1rem 0.75rem",borderRight:"0.5px solid rgba(255,255,255,0.07)",display:"flex",flexDirection:"column",gap:2,overflow:"hidden"}}>
      {nav.map(item=>(
        <button key={item.id} onClick={()=>setActiveView(item.id)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 12px",borderRadius:10,border:"none",cursor:"pointer",fontSize:13,textAlign:"left",fontFamily:"inherit",background:activeView===item.id&&currentFolderId==null?"rgba(255,255,255,0.08)":"transparent",color:activeView===item.id&&currentFolderId==null?"#fff":"rgba(255,255,255,0.55)",fontWeight:activeView===item.id&&currentFolderId==null?500:400,transition:"background 0.1s,color 0.1s"}}>
          <span style={{display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:16}}>{item.icon}</span>{item.label}</span>
          {item.badge>0&&<span style={{fontSize:10,background:"rgba(239,68,68,0.2)",color:"#FCA5A5",borderRadius:10,padding:"1px 7px",fontWeight:600}}>{item.badge}</span>}
        </button>
      ))}
      {folders.length>0&&activeView==="active"&&(
        <div style={{marginTop:4,paddingTop:4,borderTop:"0.5px solid rgba(255,255,255,0.06)"}}>
          {folders.map(f=><button key={f.id} onClick={()=>onFolderClick(f.id)} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,textAlign:"left",fontFamily:"inherit",width:"100%",background:currentFolderId===f.id?"rgba(255,255,255,0.08)":"transparent",color:currentFolderId===f.id?"#fff":"rgba(255,255,255,0.5)",transition:"background 0.1s"}}><span>📁</span><span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</span></button>)}
        </div>
      )}
      <div style={{marginTop:"auto",padding:"12px",background:"rgba(255,255,255,0.03)",borderRadius:12,border:"0.5px solid rgba(255,255,255,0.06)"}}>
        <p style={{margin:"0 0 8px",fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Storage</p>
        <div style={{height:4,background:"rgba(255,255,255,0.08)",borderRadius:2,marginBottom:8,overflow:"hidden"}}>
          <div style={{width:`${usedPct.toFixed(1)}%`,height:"100%",background:quotaPct>85?"#EF4444":"linear-gradient(90deg,#3B82F6,#8B5CF6)",borderRadius:2,transition:"width 0.3s"}}/>
        </div>
        <p style={{margin:0,fontSize:12,color:quotaPct>85?"#FCA5A5":"rgba(255,255,255,0.6)"}}>{fmt(usedBytes)} <span style={{color:"rgba(255,255,255,0.3)"}}>/ {fmt(quotaBytes)}</span></p>
        {stats&&<p style={{margin:"4px 0 0",fontSize:11,color:"#10B981"}}>{fmt(totalSaved)} saved</p>}
        <div style={{marginTop:6,paddingTop:6,borderTop:"0.5px solid rgba(255,255,255,0.06)"}}>
          <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.4)"}}>🤖 ML: <span style={{color:mlTrained>0?"#A78BFA":"rgba(255,255,255,0.25)"}}>{mlTrained>0?`${mlTrained} trained`:"collecting…"}</span></p>
        </div>
        {/* Feature 1 status */}
        <div style={{marginTop:4}}>
          <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.4)"}}>
            🌐 Browser compress: <span style={{color:zstdReady?"#10B981":"rgba(255,255,255,0.25)"}}>{zstdReady?"active":"loading…"}</span>
          </p>
        </div>
      </div>
      {isAdmin&&<button onClick={onAdminOpen} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderRadius:10,border:"0.5px solid rgba(239,68,68,0.3)",cursor:"pointer",fontSize:12,background:"rgba(239,68,68,0.08)",color:"#FCA5A5",fontFamily:"inherit",marginTop:4}}>⚡ Admin</button>}
      <div style={{padding:"10px 12px",borderTop:"0.5px solid rgba(255,255,255,0.07)",marginTop:4,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
        <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.5)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>{user?.email}</p>
        <button onClick={onSignOut} title="Sign out" style={{background:"none",border:"0.5px solid rgba(255,255,255,0.12)",borderRadius:7,padding:"4px 8px",cursor:"pointer",fontSize:11,color:"rgba(255,255,255,0.4)",flexShrink:0,fontFamily:"inherit"}}>↩</button>
      </div>
    </aside>
  );
}

// ── Top bar ───────────────────────────────────────────────────────────────────

function TopBar({wsStatus,myPeerId,myColor,peerCount,onUpload,onNewFolder,uploading,searchQuery,setSearchQuery,activeView,breadcrumb,onBreadcrumbClick}){
  const dotColor=wsStatus==="connected"?"#10B981":wsStatus==="connecting"?"#F59E0B":"#EF4444";
  return(
    <header style={{height:58,display:"flex",alignItems:"center",gap:12,padding:"0 1.25rem",borderBottom:"0.5px solid rgba(255,255,255,0.07)",background:"#0f0f0f",flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginRight:8}}>
        <div style={{width:28,height:28,borderRadius:8,background:"linear-gradient(135deg,#3B82F6,#8B5CF6)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>⬡</div>
        <span style={{fontSize:17,fontWeight:600,color:"#fff",letterSpacing:"-0.3px"}}>Nexus</span>
      </div>
      {breadcrumb.length>1?(
        <div style={{display:"flex",alignItems:"center",gap:4,fontSize:13,color:"rgba(255,255,255,0.5)"}}>
          {breadcrumb.map((c,i)=><span key={c.id||"root"} style={{display:"flex",alignItems:"center",gap:4}}>
            {i>0&&<span style={{opacity:0.3}}>/</span>}
            <button onClick={()=>onBreadcrumbClick(c.id)} style={{background:"none",border:"none",cursor:i<breadcrumb.length-1?"pointer":"default",color:i===breadcrumb.length-1?"#fff":"rgba(255,255,255,0.5)",fontSize:13,fontFamily:"inherit",padding:"2px 4px",borderRadius:4}}>{c.name}</button>
          </span>)}
        </div>
      ):(
        <div style={{flex:1,maxWidth:480,position:"relative"}}>
          <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"rgba(255,255,255,0.3)"}}>🔍</span>
          <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search files…"
            style={{width:"100%",padding:"8px 12px 8px 36px",background:"rgba(255,255,255,0.06)",border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:10,color:"#fff",fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
        </div>
      )}
      <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:6,background:"rgba(255,255,255,0.05)",border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:20,padding:"5px 12px",fontSize:12,color:"rgba(255,255,255,0.6)",flexShrink:0}}>
          <div style={{width:7,height:7,borderRadius:"50%",background:dotColor}}/>
          {wsStatus==="connected"?<span><span style={{color:myColor,fontWeight:500}}>{myPeerId}</span><span style={{color:"rgba(255,255,255,0.3)"}}> · {peerCount} peer{peerCount!==1?"s":""}</span></span>:<span style={{color:dotColor}}>{wsStatus}</span>}
        </div>
        {activeView==="active"&&<button onClick={onNewFolder} style={{background:"rgba(255,255,255,0.07)",border:"0.5px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"7px 14px",color:"rgba(255,255,255,0.7)",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>📁 New folder</button>}
        {activeView!=="trash"&&<button onClick={onUpload} disabled={uploading} style={{background:uploading?"rgba(59,130,246,0.3)":"#3B82F6",border:"none",borderRadius:10,padding:"8px 18px",color:"#fff",fontSize:13,fontWeight:500,cursor:uploading?"not-allowed":"pointer",fontFamily:"inherit",transition:"background 0.15s"}}>{uploading?"⏳ Uploading…":"⬆ Upload"}</button>}
      </div>
    </header>
  );
}

// ── File row ──────────────────────────────────────────────────────────────────

function FileRow({file,view,onStar,onTrash,onRestore,onDelete,onP2PDownload,onShare}){
  const p=file.original_size>0?Math.round(((file.original_size-file.stored_size)/file.original_size)*100):0;
  const color=catColor(file.category); const [hover,setHover]=useState(false); const days=daysLeft(file.deleted_at);
  return(
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",background:hover?"rgba(255,255,255,0.04)":"transparent",borderBottom:"0.5px solid rgba(255,255,255,0.05)",transition:"background 0.1s",fontSize:13}}>
      <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
        <div style={{width:32,height:32,borderRadius:8,flexShrink:0,background:`${color}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>{catIcon(file.category)}</div>
        <div style={{minWidth:0}}>
          <p style={{margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:file.deleted_at?"rgba(255,255,255,0.4)":"#fff",fontWeight:500}} title={file.filename}>{file.filename}</p>
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
      <span style={{color:"rgba(255,255,255,0.3)",fontSize:12}}>{view==="trash"?`deleted ${relTime(file.deleted_at)}`:relTime(file.upload_time)}</span>
      <div style={{display:"flex",gap:4}}>
        {(view==="active"||view==="starred")&&<>
          <button onClick={()=>onP2PDownload(file)} style={{background:"rgba(59,130,246,0.1)",border:"0.5px solid rgba(59,130,246,0.3)",borderRadius:7,padding:"5px 8px",cursor:"pointer",fontSize:12,color:"#60A5FA",fontFamily:"inherit"}}>⬇</button>
          {/* Share button now opens unified modal with private+public tabs */}
          <button onClick={()=>onShare(file)} title="Share" style={{background:"rgba(16,185,129,0.1)",border:"0.5px solid rgba(16,185,129,0.3)",borderRadius:7,padding:"5px 8px",cursor:"pointer",fontSize:12,color:"#34D399",fontFamily:"inherit"}}>🔗</button>
          <button onClick={()=>onStar(file.hash,file.starred)} style={{background:file.starred?"rgba(251,191,36,0.15)":"none",border:`0.5px solid ${file.starred?"rgba(251,191,36,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:7,padding:"5px 7px",cursor:"pointer",fontSize:12,color:file.starred?"#FCD34D":"rgba(255,255,255,0.35)",fontFamily:"inherit"}}>{file.starred?"★":"☆"}</button>
          <button onClick={()=>onTrash(file.hash)} style={{background:"none",border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:7,padding:"5px 7px",cursor:"pointer",fontSize:12,color:"rgba(255,255,255,0.3)",fontFamily:"inherit"}}>🗑</button>
        </>}
        {view==="trash"&&<>
          <button onClick={()=>onRestore(file.hash)} style={{background:"rgba(16,185,129,0.1)",border:"0.5px solid rgba(16,185,129,0.3)",borderRadius:7,padding:"5px 10px",cursor:"pointer",fontSize:12,color:"#34D399",fontFamily:"inherit"}}>↩ Restore</button>
          <button onClick={()=>onDelete(file.hash)} style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:7,padding:"5px 7px",cursor:"pointer",fontSize:12,color:"#FCA5A5",fontFamily:"inherit"}}>✕</button>
        </>}
      </div>
    </div>
  );
}

// ── Folder row ────────────────────────────────────────────────────────────────

function FolderRow({folder,onOpen,onDelete,onRename}){
  const [hover,setHover]=useState(false);const[renaming,setRenaming]=useState(false);const[newName,setNewName]=useState(folder.name);
  return(
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",background:hover?"rgba(255,255,255,0.04)":"transparent",borderBottom:"0.5px solid rgba(255,255,255,0.05)",transition:"background 0.1s",fontSize:13,cursor:"pointer"}}
      onClick={()=>onOpen(folder.id)}>
      <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
        <div style={{width:32,height:32,borderRadius:8,flexShrink:0,background:"rgba(251,191,36,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>📁</div>
        <div style={{minWidth:0}}>
          {renaming?(
            <input autoFocus value={newName} onChange={e=>setNewName(e.target.value)} onClick={e=>e.stopPropagation()}
              onKeyDown={e=>{if(e.key==="Enter"){onRename(folder.id,newName);setRenaming(false);}if(e.key==="Escape")setRenaming(false);}}
              onBlur={()=>{onRename(folder.id,newName);setRenaming(false);}}
              style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:5,color:"#fff",fontSize:13,padding:"2px 6px",fontFamily:"inherit",outline:"none"}}/>
          ):(
            <p style={{margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"#fff",fontWeight:500}}>{folder.name}</p>
          )}
          <p style={{margin:"2px 0 0",fontSize:11,color:"rgba(255,255,255,0.3)"}}>Folder</p>
        </div>
      </div>
      <span/><span/><span/><span/>
      <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
        <button onClick={()=>setRenaming(true)} style={{background:"none",border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:7,padding:"5px 7px",cursor:"pointer",fontSize:12,color:"rgba(255,255,255,0.4)",fontFamily:"inherit"}}>✏️</button>
        <button onClick={()=>onDelete(folder.id)} style={{background:"none",border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:7,padding:"5px 7px",cursor:"pointer",fontSize:12,color:"rgba(255,255,255,0.3)",fontFamily:"inherit"}}>🗑</button>
      </div>
    </div>
  );
}

// ── New folder modal ──────────────────────────────────────────────────────────

function NewFolderModal({token,parentId,onCreated,onClose}){
  const [name,setName]=useState("");const[loading,setLoading]=useState(false);const[error,setError]=useState("");
  const create=async()=>{
    if(!name.trim())return;setLoading(true);setError("");
    try{
      const res=await apiFetch(token)("/nexus/folders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim(),parent_id:parentId||null})});
      const data=await res.json();
      if(!res.ok){setError(data.error||"Failed");return;}
      onCreated(data);onClose();
    }catch(e){setError(e.message);}finally{setLoading(false);}
  };
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}}onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:380,maxWidth:"90vw"}}>
        <h2 style={{margin:"0 0 16px",fontSize:15,fontWeight:500,color:"#fff"}}>📁 New folder</h2>
        {error&&<div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"9px 12px",marginBottom:12,fontSize:13,color:"#FCA5A5"}}>{error}</div>}
        <input autoFocus type="text" placeholder="Folder name" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&create()}
          style={{width:"100%",padding:"11px 14px",boxSizing:"border-box",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,color:"#fff",fontSize:14,outline:"none",fontFamily:"inherit",marginBottom:12}}/>
        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{flex:1,padding:"9px",borderRadius:8,border:"0.5px solid rgba(255,255,255,0.12)",background:"transparent",color:"rgba(255,255,255,0.6)",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          <button onClick={create} disabled={loading||!name.trim()} style={{flex:1,padding:"9px",borderRadius:8,border:"none",background:loading||!name.trim()?"rgba(59,130,246,0.35)":"#3B82F6",color:"#fff",fontSize:13,fontWeight:500,cursor:loading||!name.trim()?"not-allowed":"pointer",fontFamily:"inherit"}}>Create</button>
        </div>
      </div>
    </div>
  );
}

// ── Shared-with-me view ───────────────────────────────────────────────────────

function SharedWithMeView({token,onP2PDownload}){
  const [items,setItems]=useState([]);const[loading,setLoading]=useState(true);
  useEffect(()=>{apiFetch(token)("/shared-with-me").then(r=>r.json()).then(d=>{if(Array.isArray(d))setItems(d);}).finally(()=>setLoading(false));},[token]);
  if(loading)return<p style={{color:"rgba(255,255,255,0.3)",fontSize:14,padding:"2rem 0"}}>Loading…</p>;
  if(items.length===0)return<div style={{textAlign:"center",padding:"4rem 0",color:"rgba(255,255,255,0.25)",fontSize:14}}>Nothing shared with you yet</div>;
  return(
    <div style={{background:"rgba(255,255,255,0.02)",border:"0.5px solid rgba(255,255,255,0.07)",borderRadius:14,overflow:"hidden"}}>
      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 70px 1fr auto",gap:12,padding:"8px 16px",borderBottom:"0.5px solid rgba(255,255,255,0.07)",fontSize:11,fontWeight:500,color:"rgba(255,255,255,0.3)",textTransform:"uppercase",letterSpacing:"0.05em"}}>
        <span>Name</span><span>Original</span><span>Stored</span><span>Saved</span><span>Shared</span><span/>
      </div>
      {items.map(item=>{
        const f=item.files||{};const p=f.original_size>0?Math.round(((f.original_size-f.stored_size)/f.original_size)*100):0;
        return<div key={item.share_token} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",borderBottom:"0.5px solid rgba(255,255,255,0.05)",fontSize:13}}>
          <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
            <div style={{width:32,height:32,borderRadius:8,background:`${catColor(f.category)}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>{catIcon(f.category)}</div>
            <p style={{margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"#fff",fontWeight:500}}>{f.filename}</p>
          </div>
          <span style={{color:"rgba(255,255,255,0.45)"}}>{fmt(f.original_size)}</span>
          <span style={{color:"rgba(255,255,255,0.45)"}}>{fmt(f.stored_size)}</span>
          <span style={{color:"#10B981",fontWeight:500}}>{p}%</span>
          <span style={{color:"rgba(255,255,255,0.3)",fontSize:12}}>{relTime(item.created_at)}</span>
          <button onClick={()=>onP2PDownload({...f,hash:f.hash,chunk_count:f.chunk_count})}
            style={{background:"rgba(59,130,246,0.1)",border:"0.5px solid rgba(59,130,246,0.3)",borderRadius:7,padding:"5px 8px",cursor:"pointer",fontSize:12,color:"#60A5FA",fontFamily:"inherit"}}>⬇</button>
        </div>;
      })}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [session,       setSession]       = useState(null);
  const [authReady,     setAuthReady]     = useState(false);
  const [files,         setFiles]         = useState([]);
  const [folders,       setFolders]       = useState([]);
  const [trashFiles,    setTrashFiles]    = useState([]);
  const [stats,         setStats]         = useState(null);
  const [uploading,     setUploading]     = useState(false);
  const [uploadProgress,setUploadProgress]= useState(null); // { pct, chunksUploaded, totalChunks, filename }
  const [uploadAbort,   setUploadAbort]   = useState(null); // AbortController
  const [result,        setResult]        = useState(null);
  const [dupError,      setDupError]      = useState(null);
  const [quotaError,    setQuotaError]    = useState(null);
  const [error,         setError]         = useState(null);
  const [p2pTarget,     setP2pTarget]     = useState(null);
  const [shareTarget,   setShareTarget]   = useState(null);
  const [activeView,    setActiveView]    = useState("active");
  const [currentFolderId,setCurrentFolderId]=useState(null);
  const [breadcrumb,    setBreadcrumb]    = useState([{id:null,name:"My Files"}]);
  const [searchQuery,   setSearchQuery]   = useState("");
  const [dragging,      setDragging]      = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const inputRef=useRef();

  const isAdmin = session?.user?.email===ADMIN_EMAIL;

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{setSession(session);setAuthReady(true);});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_,s)=>setSession(s));
    return()=>subscription.unsubscribe();
  },[]);

  const handleSignOut=async()=>{await supabase.auth.signOut();setSession(null);setFiles([]);setStats(null);setFolders([]);};
  const token=session?.access_token;
  const ap=useMemo(()=>token?apiFetch(token):null,[token]);

  const {ws,myPeerId,myColor,peerCount,wsStatus,sendMsg}=useP2P(token,{onFileAvailable:()=>refresh()});

  const refresh=useCallback(async()=>{
    if(!ap)return;
    try{
      const [fRes,tRes,sRes,folRes]=await Promise.all([
        ap(`/files?view=${activeView}${c
