/**
 * Nexus – Phase 7
 * ================
 * Based on Phase 6 (document 3) — all starred/trash/restore features kept.
 * New in Phase 7:
 *   - Duplicate filename error: shows a clear inline error on upload
 *   - ML badge on upload result modal showing model version + entropy
 *   - Supabase DB is now the source of truth (server handles this)
 *   - upload_time field from DB is ISO string — relativeTime handles both
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = "https://hoqzrxxqczxwwnqimvxm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhvcXpyeHhxY3p4d3ducWltdnhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcyNzAzMzgsImV4cCI6MjA4Mjg0NjMzOH0.KWrM31jwQu98qevgPKbSzEIrsulKpjxiBQ1X4QlkHFc";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const API    = "http://localhost:5000";
const WS_URL = "ws://localhost:5000/ws";

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (bytes) => {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024, sizes = ["B","KB","MB","GB","TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

const relativeTime = (ts) => {
  if (!ts) return "—";
  // handles both unix float (from old local meta) and ISO string (from Supabase DB)
  const t    = typeof ts === "string" ? new Date(ts).getTime() / 1000 : ts;
  const diff = Date.now() / 1000 - t;
  if (diff < 60)    return "just now";
  if (diff < 3600)  return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
};

const daysLeft = (deletedAt) => {
  if (!deletedAt) return null;
  const t   = typeof deletedAt === "string" ? new Date(deletedAt).getTime() / 1000 : deletedAt;
  const rem = 7 - (Date.now() / 1000 - t) / 86400;
  return Math.max(0, Math.ceil(rem));
};

const categoryIcon  = (c) => ({image:"🖼️",video:"🎬",audio:"🎵",document:"📄",archive:"📦",code:"💻",other:"📎"})[c]||"📎";
const categoryColor = (c) => ({image:"#F59E0B",video:"#EF4444",audio:"#8B5CF6",document:"#3B82F6",archive:"#F97316",code:"#10B981",other:"#6B7280"})[c]||"#6B7280";

// ── API ───────────────────────────────────────────────────────────────────────

const authFetch = (token) => (path, opts={}) =>
  fetch(`${API}${path}`, {
    ...opts,
    headers: { Authorization:`Bearer ${token}`, ...opts.headers },
  });

// ── Auth page ─────────────────────────────────────────────────────────────────

function AuthPage({ onAuth }) {
  const [mode,setMode]         = useState("login");
  const [email,setEmail]       = useState("");
  const [password,setPassword] = useState("");
  const [loading,setLoading]   = useState(false);
  const [error,setError]       = useState("");
  const [success,setSuccess]   = useState("");

  const submit = async () => {
    if (!email || !password) return;
    setLoading(true); setError(""); setSuccess("");
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setSuccess("Account created! Check your email to confirm, then sign in.");
        setMode("login");
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onAuth(data.session);
      }
    } catch (e) { setError(e.message || "Something went wrong"); }
    finally     { setLoading(false); }
  };

  const inp = {
    width:"100%", padding:"11px 14px", boxSizing:"border-box",
    background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.12)",
    borderRadius:10, color:"#fff", fontSize:14, outline:"none", fontFamily:"inherit",
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
          {mode==="login" ? "Welcome back" : "Create account"}
        </h2>
        <p style={{margin:"0 0 24px",fontSize:14,color:"rgba(255,255,255,0.4)"}}>
          {mode==="login" ? "Sign in to your account" : "Start with 5 GB free storage"}
        </p>

        {error   && <div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#FCA5A5"}}>{error}</div>}
        {success && <div style={{background:"rgba(16,185,129,0.1)",border:"0.5px solid rgba(16,185,129,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#6EE7B7"}}>{success}</div>}

        <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
          <input type="email"    placeholder="Email address"          value={email}    onChange={e=>setEmail(e.target.value)}    onKeyDown={e=>e.key==="Enter"&&submit()} style={inp}/>
          <input type="password" placeholder="Password (min 6 chars)" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={inp}/>
        </div>

        <button onClick={submit} disabled={loading||!email||!password} style={{
          width:"100%",padding:"12px",borderRadius:10,border:"none",fontFamily:"inherit",
          background:loading||!email||!password?"rgba(59,130,246,0.35)":"#3B82F6",
          color:"#fff",fontSize:15,fontWeight:500,
          cursor:loading?"wait":!email||!password?"not-allowed":"pointer",transition:"background 0.15s",
        }}>{loading?"Please wait…":mode==="login"?"Sign in":"Create account"}</button>

        <p style={{margin:"18px 0 0",textAlign:"center",fontSize:13,color:"rgba(255,255,255,0.4)"}}>
          {mode==="login"?"No account? ":"Already have one? "}
          <span onClick={()=>{setMode(mode==="login"?"signup":"login");setError("");setSuccess("");}}
            style={{color:"#60A5FA",cursor:"pointer",fontWeight:500}}>
            {mode==="login"?"Sign up free":"Sign in"}
          </span>
        </p>
      </div>
    </div>
  );
}

// ── WebSocket hook ────────────────────────────────────────────────────────────

function useP2PSocket(token, { onChunkData, onFileAvailable }) {
  const wsRef      = useRef(null);
  const [myPeerId, setMyPeerId]  = useState(null);
  const [myColor,  setMyColor]   = useState("#6B7280");
  const [peerCount,setPeerCount] = useState(0);
  const [wsStatus, setWsStatus]  = useState("disconnected");

  const sendMsg = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    if (!token) return;
    let ws, timer;
    function connect() {
      setWsStatus("connecting");
      ws = new WebSocket(`${WS_URL}?token=${token}`);
      wsRef.current = ws;
      ws.onopen    = () => { setWsStatus("connected"); ws.send(JSON.stringify({type:"register"})); };
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type==="welcome")        { setMyPeerId(msg.peer_id); setMyColor(msg.color); }
        if (msg.type==="peers_updated")  { setPeerCount((msg.peers||[]).length); }
        if (msg.type==="chunk_data")     { onChunkData?.(msg); wsRef.current?._chunkHandler?.(msg); }
        if (msg.type==="file_available") { onFileAvailable?.(); }
      };
      ws.onclose = () => { setWsStatus("disconnected"); setMyPeerId(null); timer=setTimeout(connect,3000); };
      ws.onerror = () => ws.close();
    }
    connect();
    const ping = setInterval(()=>{ if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:"ping"})); },25000);
    return ()=>{ clearTimeout(timer); clearInterval(ping); ws?.close(); };
  }, [token]); // eslint-disable-line

  return { ws: wsRef, myPeerId, myColor, peerCount, wsStatus, sendMsg };
}

// ── P2P Downloader modal ──────────────────────────────────────────────────────

function P2PDownloader({ file, sendMsg, wsRef, myColor, token, onClose, onHaveChunks }) {
  const [chunks,setChunks]   = useState({});
  const [status,setStatus]   = useState("requesting");
  const [totalMs,setTotalMs] = useState(null);
  const [log,setLog]         = useState([]);
  const startRef    = useRef(Date.now());
  const assemblyRef = useRef([]);
  const { chunk_count: chunkCount, hash: fileId } = file;

  useEffect(() => {
    if (!wsRef.current) return;
    wsRef.current._chunkHandler = (msg) => {
      if (msg.file_id !== fileId) return;
      const bin = atob(msg.data); const bytes = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      assemblyRef.current[msg.chunk_index] = bytes;
      const elapsed = Date.now() - startRef.current;
      setChunks(p=>({...p,[msg.chunk_index]:{from_peer:msg.from_peer,from_color:msg.from_color||myColor,elapsed}}));
      setLog(p=>[{idx:msg.chunk_index,peer:msg.from_peer,color:msg.from_color||"#6B7280",ms:elapsed},...p.slice(0,8)]);
    };
    return () => { if(wsRef.current) wsRef.current._chunkHandler = null; };
  }, [fileId,myColor,wsRef]);

  useEffect(() => {
    startRef.current = Date.now();
    for (let i=0;i<chunkCount;i++)
      setTimeout(()=>sendMsg({type:"want",file_id:fileId,chunk_index:i}),i*5);
  }, [fileId,chunkCount,sendMsg]);

  useEffect(() => {
    if (Object.keys(chunks).length>0 && Object.keys(chunks).length>=chunkCount) {
      setTotalMs(Date.now()-startRef.current); setStatus("done");
      fetch(`${API}/download/${fileId}`,{headers:{Authorization:`Bearer ${token}`}})
        .then(r=>r.blob()).then(blob=>{
          const url = URL.createObjectURL(blob);
          const a   = document.createElement("a"); a.href=url; a.download=file.filename; a.click();
          setTimeout(()=>URL.revokeObjectURL(url),10000);
        });
      onHaveChunks(fileId, Array.from({length:chunkCount},(_,i)=>i));
    }
  }, [chunks,chunkCount,fileId,file,token,onHaveChunks]);

  const progress    = chunkCount>0 ? Object.keys(chunks).length/chunkCount : 0;
  const uniquePeers = [...new Set(Object.values(chunks).map(c=>c.from_peer))];

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#161616",border:"1px solid rgba(255,255,255,0.1)",
        borderRadius:16,padding:"1.5rem",width:560,maxWidth:"94vw",boxShadow:"0 32px 80px rgba(0,0,0,0.8)"}}>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div>
            <h2 style={{margin:0,fontSize:16,fontWeight:500,color:"#fff"}}>
              {status==="done"?"✅ Download complete":"⬇️ P2P Download"}
            </h2>
            <p style={{margin:"3px 0 0",fontSize:12,color:"rgba(255,255,255,0.4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:400}}>{file.filename}</p>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:18,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>

        <div style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"rgba(255,255,255,0.35)",marginBottom:6}}>
            <span>{Object.keys(chunks).length} / {chunkCount} chunks</span>
            <span>{status==="done"?`✓ ${totalMs}ms`:`${uniquePeers.length} peer${uniquePeers.length!==1?"s":""} active`}</span>
          </div>
          <div style={{height:6,background:"rgba(255,255,255,0.07)",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",borderRadius:3,width:`${Math.round(progress*100)}%`,
              background:status==="done"?"#10B981":"linear-gradient(90deg,#8B5CF6,#3B82F6)",transition:"width 0.1s"}}/>
          </div>
        </div>

        {uniquePeers.length>0&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
            {uniquePeers.map(pid=>{
              const s=Object.values(chunks).find(c=>c.from_peer===pid);
              const col=s?.from_color||"#6B7280";
              const cnt=Object.values(chunks).filter(c=>c.from_peer===pid).length;
              return <div key={pid} style={{display:"flex",alignItems:"center",gap:5,background:`${col}22`,
                border:`1px solid ${col}`,borderRadius:6,padding:"3px 9px",fontSize:11,color:col}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:col}}/>{pid}
                <span style={{opacity:0.55}}>{cnt} chunks</span>
              </div>;
            })}
          </div>
        )}

        <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:12,maxHeight:140,overflowY:"auto",
          padding:"10px",background:"rgba(255,255,255,0.02)",borderRadius:8,border:"0.5px solid rgba(255,255,255,0.05)"}}>
          {Array.from({length:chunkCount},(_,i)=>{
            const c=chunks[i];
            return <div key={i} title={c?`Chunk ${i} · ${c.from_peer} · +${c.elapsed}ms`:`Chunk ${i} pending`}
              style={{width:22,height:22,borderRadius:4,background:c?c.from_color:"rgba(255,255,255,0.05)",
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:"#fff",fontWeight:600,
                transition:"background 0.15s,transform 0.1s",transform:c?"scale(1)":"scale(0.8)",opacity:c?1:0.3}}>
              {i+1}
            </div>;
          })}
        </div>

        <div style={{background:"rgba(0,0,0,0.4)",borderRadius:6,padding:"8px 10px",fontSize:11,
          fontFamily:"monospace",maxHeight:70,overflowY:"auto",border:"0.5px solid rgba(255,255,255,0.05)"}}>
          {log.length===0?<span style={{color:"rgba(255,255,255,0.2)"}}>waiting for chunks…</span>
            :log.map((l,i)=><div key={i} style={{color:i===0?"#fff":"rgba(255,255,255,0.3)",marginBottom:2}}>
              <span style={{color:l.color}}>{l.peer}</span>{" → chunk "}
              <span style={{color:"rgba(255,255,255,0.6)"}}>{l.idx}</span>{" "}
              <span style={{color:"rgba(255,255,255,0.25)"}}>+{l.ms}ms</span>
            </div>)
          }
        </div>
        {status==="done"&&<p style={{margin:"10px 0 0",fontSize:12,color:"#10B981",textAlign:"center"}}>All {chunkCount} chunks assembled ✓</p>}
      </div>
    </div>
  );
}

// ── Upload result modal ───────────────────────────────────────────────────────

function UploadResult({ result, onClose }) {
  const saved  = result.savings||0;
  const pct    = result.original_size>0?Math.round((saved/result.original_size)*100):0;
  const isDupe = result.status==="deduplicated";
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",border:"1px solid rgba(255,255,255,0.1)",
        borderRadius:16,padding:"1.5rem",width:460,maxWidth:"90vw",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <h2 style={{margin:0,fontSize:15,fontWeight:500,color:"#fff"}}>{isDupe?"⚡ Deduplicated":"✅ Uploaded"}</h2>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>

        {isDupe
          ?<div style={{background:"rgba(59,130,246,0.1)",border:"0.5px solid rgba(59,130,246,0.3)",borderRadius:8,
              padding:"10px 14px",marginBottom:14,fontSize:13,color:"#93C5FD"}}>
              Exact duplicate — <strong>{result.ref_count}× referenced</strong>. Saved {fmt(result.dedup_bytes_saved)}.
            </div>
          :<div style={{background:"rgba(16,185,129,0.06)",border:"0.5px solid rgba(16,185,129,0.2)",
              borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.6}}>
              <span style={{color:"#10B981",fontWeight:500}}>Pipeline:</span> plaintext → SHA-256 → zstd → AES-256-GCM → chunk → Supabase Storage + P2P
            </div>
        }

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
          {[["Original",fmt(result.original_size),"#6B7280"],
            ["Stored",fmt(result.stored_size),"#10B981"],
            ["Saved",`${pct}%`,"#8B5CF6"]].map(([l,v,c])=>(
            <div key={l} style={{background:"rgba(255,255,255,0.04)",borderRadius:10,padding:"12px",borderTop:`2px solid ${c}`}}>
              <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.05em"}}>{l}</p>
              <p style={{margin:"6px 0 0",fontSize:18,fontWeight:500,color:c}}>{v}</p>
            </div>
          ))}
        </div>

        <div style={{background:"rgba(255,255,255,0.03)",borderRadius:8,padding:"10px 14px",fontSize:12}}>
          {[["Ratio",`${result.ratio}×`],
            ["zstd level",`level ${result.level}`],
            ["Category",`${categoryIcon(result.category)} ${result.category}`],
            ["Chunks",`${result.chunk_count||"—"} × 256 KB`],
            ...(result.entropy!=null?[["Entropy",`${result.entropy} bits`]]:[] ),
            ...(result.ml_model_version!=null?[["ML model",`v${result.ml_model_version}${result.ml_model_version===0?" (heuristic)":""}`]]:[] ),
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

// ── Duplicate file error modal ────────────────────────────────────────────────

function DuplicateFileError({ filename, existingId, onClose, onViewFile }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",border:"1px solid rgba(239,68,68,0.3)",
        borderRadius:16,padding:"1.5rem",width:420,maxWidth:"90vw",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <h2 style={{margin:0,fontSize:15,fontWeight:500,color:"#fff"}}>⚠️ File already exists</h2>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:"rgba(255,255,255,0.4)"}}>✕</button>
        </div>
        <div style={{background:"rgba(239,68,68,0.08)",border:"0.5px solid rgba(239,68,68,0.25)",
          borderRadius:10,padding:"12px 14px",marginBottom:16}}>
          <p style={{margin:0,fontSize:13,color:"#FCA5A5",lineHeight:1.6}}>
            You already have a file named <strong style={{color:"#fff"}}>"{filename}"</strong> in your storage.
          </p>
          <p style={{margin:"8px 0 0",fontSize:12,color:"rgba(255,255,255,0.4)"}}>
            To upload again, either delete the existing file first or rename this one before uploading.
          </p>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{
            flex:1,padding:"9px",borderRadius:9,border:"0.5px solid rgba(255,255,255,0.12)",
            background:"transparent",color:"rgba(255,255,255,0.6)",fontSize:13,
            cursor:"pointer",fontFamily:"inherit",
          }}>Cancel</button>
          <button onClick={()=>{onClose();onViewFile&&onViewFile(existingId);}} style={{
            flex:1,padding:"9px",borderRadius:9,border:"none",
            background:"#3B82F6",color:"#fff",fontSize:13,fontWeight:500,
            cursor:"pointer",fontFamily:"inherit",
          }}>View existing file</button>
        </div>
      </div>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ stats, totalSaved, activeView, setActiveView, user, onSignOut, trashCount }) {
  const usedBytes = stats?.total_stored||0;
  const usedPct   = Math.min(100,(usedBytes/(5*1024*1024*1024))*100);
  const mlTrained = stats?.ml_models_trained||0;

  const nav = [
    { id:"active",  icon:"🗂️", label:"My Files"  },
    { id:"starred", icon:"⭐", label:"Starred"    },
    { id:"trash",   icon:"🗑️", label:"Trash", badge: trashCount },
  ];

  return (
    <aside style={{width:210,flexShrink:0,padding:"1rem 0.75rem",
      borderRight:"0.5px solid rgba(255,255,255,0.07)",display:"flex",flexDirection:"column",gap:2,overflow:"hidden"}}>

      {nav.map(item=>(
        <button key={item.id} onClick={()=>setActiveView(item.id)} style={{
          display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"9px 12px",borderRadius:10,border:"none",cursor:"pointer",
          fontSize:13,textAlign:"left",fontFamily:"inherit",
          background:activeView===item.id?"rgba(255,255,255,0.08)":"transparent",
          color:activeView===item.id?"#fff":"rgba(255,255,255,0.55)",
          fontWeight:activeView===item.id?500:400,transition:"background 0.1s,color 0.1s",
        }}>
          <span style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:16}}>{item.icon}</span>{item.label}
          </span>
          {item.badge>0&&(
            <span style={{fontSize:10,background:"rgba(239,68,68,0.2)",color:"#FCA5A5",
              borderRadius:10,padding:"1px 7px",fontWeight:600}}>{item.badge}</span>
          )}
        </button>
      ))}

      {/* Storage gauge */}
      <div style={{marginTop:"auto",padding:"12px",background:"rgba(255,255,255,0.03)",
        borderRadius:12,border:"0.5px solid rgba(255,255,255,0.06)"}}>
        <p style={{margin:"0 0 8px",fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Storage</p>
        <div style={{height:4,background:"rgba(255,255,255,0.08)",borderRadius:2,marginBottom:8,overflow:"hidden"}}>
          <div style={{width:`${usedPct.toFixed(1)}%`,height:"100%",background:"linear-gradient(90deg,#3B82F6,#8B5CF6)",borderRadius:2}}/>
        </div>
        <p style={{margin:0,fontSize:12,color:"rgba(255,255,255,0.6)"}}>
          {fmt(usedBytes)} <span style={{color:"rgba(255,255,255,0.3)"}}>/ 5 GB</span>
        </p>
        {stats&&<p style={{margin:"6px 0 0",fontSize:11,color:"#10B981"}}>{fmt(totalSaved)} saved</p>}

        {/* ML status */}
        <div style={{marginTop:8,paddingTop:8,borderTop:"0.5px solid rgba(255,255,255,0.06)"}}>
          <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.4)"}}>
            🤖 ML models: <span style={{color:mlTrained>0?"#A78BFA":"rgba(255,255,255,0.25)"}}>
              {mlTrained>0?`${mlTrained} trained`:"collecting data…"}
            </span>
          </p>
        </div>
      </div>

      {/* User + sign out */}
      <div style={{padding:"10px 12px",borderTop:"0.5px solid rgba(255,255,255,0.07)",marginTop:8,
        display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
        <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.5)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>
          {user?.email}
        </p>
        <button onClick={onSignOut} title="Sign out" style={{
          background:"none",border:"0.5px solid rgba(255,255,255,0.12)",borderRadius:7,
          padding:"4px 8px",cursor:"pointer",fontSize:11,color:"rgba(255,255,255,0.4)",
          flexShrink:0,fontFamily:"inherit",
        }}>↩</button>
      </div>
    </aside>
  );
}

// ── Top bar ───────────────────────────────────────────────────────────────────

function TopBar({ wsStatus, myPeerId, myColor, peerCount, onUpload, uploading, searchQuery, setSearchQuery, activeView }) {
  const dotColor = wsStatus==="connected"?"#10B981":wsStatus==="connecting"?"#F59E0B":"#EF4444";
  return (
    <header style={{height:58,display:"flex",alignItems:"center",gap:12,
      padding:"0 1.25rem",borderBottom:"0.5px solid rgba(255,255,255,0.07)",
      background:"#0f0f0f",flexShrink:0}}>

      <div style={{display:"flex",alignItems:"center",gap:8,marginRight:8}}>
        <div style={{width:28,height:28,borderRadius:8,background:"linear-gradient(135deg,#3B82F6,#8B5CF6)",
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>⬡</div>
        <span style={{fontSize:17,fontWeight:600,color:"#fff",letterSpacing:"-0.3px"}}>Nexus</span>
      </div>

      <div style={{flex:1,maxWidth:520,position:"relative"}}>
        <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"rgba(255,255,255,0.3)"}}>🔍</span>
        <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
          placeholder="Search files…"
          style={{width:"100%",padding:"8px 12px 8px 36px",background:"rgba(255,255,255,0.06)",
            border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:10,color:"#fff",
            fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
      </div>

      <div style={{display:"flex",alignItems:"center",gap:6,background:"rgba(255,255,255,0.05)",
        border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:20,padding:"5px 12px",
        fontSize:12,color:"rgba(255,255,255,0.6)",flexShrink:0}}>
        <div style={{width:7,height:7,borderRadius:"50%",background:dotColor}}/>
        {wsStatus==="connected"
          ?<span><span style={{color:myColor,fontWeight:500}}>{myPeerId}</span>
              <span style={{color:"rgba(255,255,255,0.3)"}}> · {peerCount} peer{peerCount!==1?"s":""}</span></span>
          :<span style={{color:dotColor}}>{wsStatus}</span>
        }
      </div>

      {activeView!=="trash"&&(
        <button onClick={onUpload} disabled={uploading} style={{
          display:"flex",alignItems:"center",gap:7,
          background:uploading?"rgba(59,130,246,0.3)":"#3B82F6",
          border:"none",borderRadius:10,padding:"8px 18px",color:"#fff",fontSize:13,
          fontWeight:500,cursor:uploading?"not-allowed":"pointer",flexShrink:0,
          fontFamily:"inherit",transition:"background 0.15s",
        }}>{uploading?"⏳ Uploading…":"⬆ Upload"}</button>
      )}
    </header>
  );
}

// ── File row ──────────────────────────────────────────────────────────────────

function FileRow({ file, view, onStar, onTrash, onRestore, onDelete, onP2PDownload }) {
  const pct   = file.original_size>0?Math.round(((file.original_size-file.stored_size)/file.original_size)*100):0;
  const color = categoryColor(file.category);
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
          {categoryIcon(file.category)}
        </div>
        <div style={{minWidth:0}}>
          <p style={{margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
            color:file.deleted_at?"rgba(255,255,255,0.4)":"#fff",fontWeight:500}} title={file.filename}>
            {file.filename}
          </p>
          <div style={{display:"flex",gap:5,marginTop:3,flexWrap:"wrap"}}>
            {file.encrypted&&<span style={{fontSize:10,color:"#10B981"}}>🔒</span>}
            {file.starred&&<span style={{fontSize:10,color:"#FCD34D"}}>★</span>}
            {(file.ref_count||1)>1&&<span style={{fontSize:10,color:"#A78BFA"}}>×{file.ref_count}</span>}
            {file.ml_model_version>0&&<span style={{fontSize:10,color:"#8B5CF6"}}>🤖v{file.ml_model_version}</span>}
            {view==="trash"&&days!=null&&(
              <span style={{fontSize:10,color:days<=2?"#FCA5A5":"rgba(255,255,255,0.3)"}}>
                {days}d left
              </span>
            )}
          </div>
        </div>
      </div>

      <span style={{color:"rgba(255,255,255,0.45)"}}>{fmt(file.original_size)}</span>
      <span style={{color:"rgba(255,255,255,0.45)"}}>{fmt(file.stored_size)}</span>
      <span style={{color:"#10B981",fontWeight:500}}>{pct}%</span>
      <span style={{color:"rgba(255,255,255,0.3)",fontSize:12}}>
        {view==="trash"?`deleted ${relativeTime(file.deleted_at)}`:relativeTime(file.upload_time)}
      </span>

      <div style={{display:"flex",gap:5}}>
        {(view==="active"||view==="starred")&&<>
          <button onClick={()=>onP2PDownload(file)}
            style={{background:"rgba(59,130,246,0.1)",border:"0.5px solid rgba(59,130,246,0.3)",
              borderRadius:7,padding:"5px 9px",cursor:"pointer",fontSize:12,color:"#60A5FA",fontFamily:"inherit"}}>⬇</button>
          <button onClick={()=>onStar(file.hash,file.starred)} title={file.starred?"Unstar":"Star"}
            style={{background:file.starred?"rgba(251,191,36,0.15)":"none",
              border:`0.5px solid ${file.starred?"rgba(251,191,36,0.4)":"rgba(255,255,255,0.1)"}`,
              borderRadius:7,padding:"5px 8px",cursor:"pointer",fontSize:12,
              color:file.starred?"#FCD34D":"rgba(255,255,255,0.35)",fontFamily:"inherit"}}>
            {file.starred?"★":"☆"}
          </button>
          <button onClick={()=>onTrash(file.hash)}
            style={{background:"none",border:"0.5px solid rgba(255,255,255,0.1)",
              borderRadius:7,padding:"5px 8px",cursor:"pointer",fontSize:12,
              color:"rgba(255,255,255,0.3)",fontFamily:"inherit"}}>🗑</button>
        </>}
        {view==="trash"&&<>
          <button onClick={()=>onRestore(file.hash)}
            style={{background:"rgba(16,185,129,0.1)",border:"0.5px solid rgba(16,185,129,0.3)",
              borderRadius:7,padding:"5px 10px",cursor:"pointer",fontSize:12,color:"#34D399",fontFamily:"inherit"}}>↩ Restore</button>
          <button onClick={()=>onDelete(file.hash)}
            style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",
              borderRadius:7,padding:"5px 8px",cursor:"pointer",fontSize:12,color:"#FCA5A5",fontFamily:"inherit"}}>✕</button>
        </>}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [session,      setSession]      = useState(null);
  const [authReady,    setAuthReady]    = useState(false);
  const [files,        setFiles]        = useState([]);
  const [trashFiles,   setTrashFiles]   = useState([]);
  const [stats,        setStats]        = useState(null);
  const [uploading,    setUploading]    = useState(false);
  const [result,       setResult]       = useState(null);
  const [dupError,     setDupError]     = useState(null);  // { filename, existingId }
  const [error,        setError]        = useState(null);
  const [p2pTarget,    setP2pTarget]    = useState(null);
  const [activeView,   setActiveView]   = useState("active");
  const [searchQuery,  setSearchQuery]  = useState("");
  const [dragging,     setDragging]     = useState(false);
  const inputRef = useRef();

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{ setSession(session); setAuthReady(true); });
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_,s)=>setSession(s));
    return ()=>subscription.unsubscribe();
  },[]);

  const handleSignOut = async ()=>{ await supabase.auth.signOut(); setSession(null); setFiles([]); setStats(null); };
  const token = session?.access_token;
  const api   = useMemo(()=> token ? authFetch(token) : null, [token]);

  const { ws, myPeerId, myColor, peerCount, wsStatus, sendMsg } = useP2PSocket(token, {
    onChunkData:()=>{}, onFileAvailable:()=>refresh(),
  });

  const refresh = useCallback(async ()=>{
    if (!api) return;
    try {
      const [fRes, tRes, sRes] = await Promise.all([
        api(`/files?view=${activeView}`),
        api(`/files?view=trash`),
        api(`/stats`),
      ]);
      if (fRes.status===401) { setError("Session expired — please sign in again."); return; }
      const [f, t, s] = await Promise.all([fRes.json(), tRes.json(), sRes.json()]);
      setFiles(Array.isArray(f)?f:[]);
      setTrashFiles(Array.isArray(t)?t:[]);
      setStats(s);
    } catch(e) { setError(`Cannot reach backend: ${e.message}`); }
  },[api, activeView]);

  useEffect(()=>{ if(token) refresh(); },[token, activeView]); // eslint-disable-line

  const uploadFile = async (file)=>{
    setUploading(true); setError(null); setDupError(null);
    try {
      const fd = new FormData(); fd.append("file", file);
      const res  = await api("/upload",{method:"POST",body:fd});
      const data = await res.json();

      if (res.status === 409 && data.error === "duplicate_filename") {
        // Show the dedicated duplicate filename modal
        setDupError({ filename: data.message.match(/"(.+)"/)?.[1] || file.name, existingId: data.existing_id });
        return;
      }
      if (!res.ok) {
        setError(`Upload failed: ${data.error||res.statusText}`);
        return;
      }
      setResult(data);
      refresh();
    } catch(e) { setError(`Upload failed: ${e.message}`); }
    finally    { setUploading(false); }
  };

  const handleStar    = async (h,cur)=>{ await api(`/star/${h}`,{method:"PATCH"}); setFiles(p=>p.map(f=>f.hash===h?{...f,starred:!cur}:f)); if(activeView==="starred"&&cur) refresh(); };
  const handleTrash   = async (h)=>{ await api(`/trash/${h}`,{method:"PATCH"}); setFiles(p=>p.filter(f=>f.hash!==h)); refresh(); };
  const handleRestore = async (h)=>{ await api(`/restore/${h}`,{method:"PATCH"}); setFiles(p=>p.filter(f=>f.hash!==h)); refresh(); };
  const handleDelete  = async (h)=>{
    if (!window.confirm("Permanently delete this file? This cannot be undone.")) return;
    await api(`/delete/${h}`,{method:"DELETE"});
    setFiles(p=>p.filter(f=>f.hash!==h)); refresh();
  };
  const handleHaveChunks = useCallback((fid,idxs)=>{ sendMsg({type:"have",file_id:fid,chunks:idxs}); },[sendMsg]);

  const visibleFiles = files.filter(f=>f.filename.toLowerCase().includes(searchQuery.toLowerCase()));
  const totalSaved   = stats ? stats.total_original - stats.total_stored : 0;
  const viewTitle    = {active:"My Files",starred:"Starred",trash:"Trash"}[activeView];

  if (!authReady) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",
      height:"100vh",background:"#0a0a0a",color:"rgba(255,255,255,0.3)",fontSize:14}}>Loading…</div>
  );
  if (!session) return <AuthPage onAuth={s=>setSession(s)}/>;

  return (
    <div style={{display:"flex",flexDirection:"column",width:"100%",height:"100vh",
      background:"#0f0f0f",color:"#fff",fontFamily:"var(--font-sans)",overflow:"hidden"}}>

      <TopBar wsStatus={wsStatus} myPeerId={myPeerId} myColor={myColor} peerCount={peerCount}
        onUpload={()=>inputRef.current?.click()} uploading={uploading}
        searchQuery={searchQuery} setSearchQuery={setSearchQuery} activeView={activeView}/>

      <input ref={inputRef} type="file" style={{display:"none"}}
        onChange={e=>{ if(e.target.files[0]) uploadFile(e.target.files[0]); }}/>

      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        <Sidebar stats={stats} totalSaved={totalSaved}
          activeView={activeView}
          setActiveView={(v)=>{setActiveView(v);setSearchQuery("");}}
          user={session.user} onSignOut={handleSignOut}
          trashCount={trashFiles.length}/>

        <main style={{flex:1,overflowY:"auto",padding:"1.25rem 1.5rem",minWidth:0}}>
          {error&&(
            <div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",
              borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#FCA5A5"}}>
              {error}
              <button onClick={()=>setError(null)} style={{float:"right",background:"none",border:"none",
                cursor:"pointer",color:"#FCA5A5",fontSize:14}}>✕</button>
            </div>
          )}

          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
            <div>
              <h2 style={{margin:"0 0 2px",fontSize:18,fontWeight:500}}>{viewTitle}</h2>
              <p style={{margin:0,fontSize:12,color:"rgba(255,255,255,0.35)"}}>
                {visibleFiles.length} file{visibleFiles.length!==1?"s":""}
                {activeView==="active"&&stats?` · ${fmt(stats.total_stored||0)} stored`:""}
                {activeView==="trash"?" · files are permanently deleted after 7 days":""}
              </p>
            </div>
          </div>

          {activeView==="active"&&files.length===0&&(
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
              <p style={{margin:0,fontSize:13,color:"rgba(255,255,255,0.35)"}}>Compressed · encrypted · chunked · P2P distributed · stored in Supabase</p>
            </div>
          )}

          {visibleFiles.length===0&&activeView!=="active"&&(
            <div style={{textAlign:"center",padding:"4rem 0",color:"rgba(255,255,255,0.25)",fontSize:14}}>
              {activeView==="starred"?"No starred files — click ☆ on any file to star it":"Trash is empty"}
            </div>
          )}

          {visibleFiles.length>0&&(
            <div
              onDrop={e=>{if(activeView!=="trash"){e.preventDefault();setDragging(false);if(e.dataTransfer.files[0])uploadFile(e.dataTransfer.files[0]);}}}
              onDragOver={e=>{if(activeView!=="trash"){e.preventDefault();setDragging(true);}}}
              onDragLeave={()=>setDragging(false)}
              style={{position:"relative"}}>
              {dragging&&activeView!=="trash"&&(
                <div style={{position:"absolute",inset:0,zIndex:10,background:"rgba(139,92,246,0.15)",
                  border:"2px dashed #8B5CF6",borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <p style={{fontSize:16,fontWeight:500,color:"#A78BFA"}}>Drop to upload</p>
                </div>
              )}
              <div style={{background:"rgba(255,255,255,0.02)",border:"0.5px solid rgba(255,255,255,0.07)",borderRadius:14,overflow:"hidden"}}>
                <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 70px 1fr auto",
                  gap:12,padding:"8px 16px",borderBottom:"0.5px solid rgba(255,255,255,0.07)",
                  fontSize:11,fontWeight:500,color:"rgba(255,255,255,0.3)",
                  textTransform:"uppercase",letterSpacing:"0.05em"}}>
                  <span>Name</span><span>Original</span><span>Stored</span>
                  <span>Saved</span>
                  <span>{activeView==="trash"?"Deleted":"Modified"}</span>
                  <span/>
                </div>
                {visibleFiles.map(f=>(
                  <FileRow key={f.hash||f.id} file={f} view={activeView}
                    onStar={handleStar} onTrash={handleTrash}
                    onRestore={handleRestore} onDelete={handleDelete}
                    onP2PDownload={setP2pTarget}/>
                ))}
              </div>
            </div>
          )}

          {visibleFiles.length===0&&searchQuery&&(
            <div style={{textAlign:"center",padding:"3rem 0",color:"rgba(255,255,255,0.3)",fontSize:14}}>
              No files match "{searchQuery}"
            </div>
          )}
        </main>
      </div>

      {result    &&<UploadResult result={result} onClose={()=>setResult(null)}/>}
      {dupError  &&<DuplicateFileError
        filename={dupError.filename}
        existingId={dupError.existingId}
        onClose={()=>setDupError(null)}
        onViewFile={(id)=>{ setActiveView("active"); setSearchQuery(""); }}
      />}
      {p2pTarget&&(
        <P2PDownloader file={p2pTarget} sendMsg={sendMsg} wsRef={ws} myColor={myColor}
          token={token} onClose={()=>setP2pTarget(null)} onHaveChunks={handleHaveChunks}/>
      )}
    </div>
  );
}