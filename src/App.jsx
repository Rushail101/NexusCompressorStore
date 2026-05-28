import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = "https://hoqzrxxqczxwwnqimvxm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhvcXpyeHhxY3p4d3ducWltdnhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcyNzAzMzgsImV4cCI6MjA4Mjg0NjMzOH0.KWrM31jwQu98qevgPKbSzEIrsulKpjxiBQ1X4QlkHFc";
const supabase  = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const ADMIN_EMAIL        = "rushailharjai10@gmail.com";
const API                = import.meta.env.VITE_API_URL || "http://localhost:5000";
const WS_URL             = import.meta.env.VITE_WS_URL  || "ws://localhost:5000/ws";
const RESUMABLE_THRESHOLD = 10 * 1024 * 1024;  // 10 MB
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

const SKIP_COMPRESSION_EXTS = new Set([
  ".jpg",".jpeg",".png",".gif",".webp",".mp4",".mkv",".avi",".mov",
  ".mp3",".aac",".ogg",".flac",".zip",".gz",".tar",".rar",".7z",
  ".zst",".bz2",".webm",".heic",".avif"
]);

async function compressClientSide(file) {
  const ext = "." + file.name.split(".").pop().toLowerCase();
  if (SKIP_COMPRESSION_EXTS.has(ext)) return { compressed: null, skipped: true, reason: "already_compressed" };
  if (!window.ZstdCodec) return { compressed: null, skipped: true, reason: "wasm_unavailable" };

  try {
    const arrayBuffer = await file.arrayBuffer();
    const uint8       = new Uint8Array(arrayBuffer);
    const entropy     = computeEntropy(uint8);

    if (entropy > 7.5) return { compressed: null, skipped: true, reason: "high_entropy", entropy };

    return new Promise((resolve) => {
      window.ZstdCodec.run(zstd => {
        try {
          const simple     = new zstd.Simple();
          const compressed = simple.compress(uint8, 6);
          const ratio      = uint8.length / compressed.length;

          if (ratio < 1.05) {
            resolve({ compressed: null, skipped: true, reason: "no_benefit", entropy });
            return;
          }
          resolve({ compressed, originalSize: uint8.length, compressedSize: compressed.length, ratio, entropy, skipped: false });
        } catch (e) {
          resolve({ compressed: null, skipped: true, reason: "error", entropy: 0 });
        }
      });
    });
  } catch (e) {
    return { compressed: null, skipped: true, reason: "error" };
  }
}

async function resumableUpload(file, token, folderId, onProgress) {
  const ap = apiFetch(token);
  onProgress({ stage: "compressing", pct: 0 });
  const compResult = await compressClientSide(file);
  const useClientComp = !compResult.skipped;

  const uploadData     = useClientComp ? compResult.compressed : null;
  const totalSize      = useClientComp ? compResult.originalSize : file.size;
  const dataToChunk    = uploadData || await file.arrayBuffer().then(b => new Uint8Array(b));
  const totalChunks    = Math.ceil(dataToChunk.length / CHUNK_SIZE);

  onProgress({ stage: "compressing", pct: 100, saved: useClientComp ? totalSize - dataToChunk.length : 0 });

  onProgress({ stage: "initialising", pct: 0 });
  const initRes = await ap("/upload/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name, total_size: totalSize, total_chunks: totalChunks,
      folder_id: folderId || null, pre_compressed: useClientComp,
    }),
  });
  const initData = await initRes.json();
  if (!initRes.ok) return { error: initData.error || "Init failed", ...initData };
  const { session_id } = initData;

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
    }
    onProgress({ stage: "uploading", pct: Math.round(((i + 1) / totalChunks) * 100), chunk: i + 1, totalChunks });
  }

  onProgress({ stage: "finishing", pct: 100 });
  const finishRes = await ap("/upload/finish", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ session_id, entropy: compResult.entropy || null }),
  });
  return finishRes.json();
}

async function regularUpload(file, token, folderId, onProgress) {
  const compResult = await compressClientSide(file);
  const useClientComp = !compResult.skipped;
  onProgress({ stage: "uploading", pct: 50, saved: useClientComp ? (compResult.originalSize - compResult.compressedSize) : 0 });

  const fd = new FormData();
  if (useClientComp) fd.append("file", new Blob([compResult.compressed]), file.name);
  else fd.append("file", file);
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

// ── Modals, Auth, Progress readouts ───────────────────────────────

function UploadProgressModal({ filename, progress, onCancel }) {
  const stages = { compressing:"Compressing…", initialising:"Starting upload…", uploading:"Uploading…", finishing:"Finalising…", done:"Done!" };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}}>
      <div style={{background:"#161616",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:440,maxWidth:"90vw"}}>
        <h2 style={{margin:"0 0 4px",fontSize:15,fontWeight:500,color:"#fff"}}>⬆ Uploading</h2>
        <p style={{margin:"0 0 16px",fontSize:12,color:"rgba(255,255,255,0.4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{filename}</p>
        <div style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"rgba(255,255,255,0.4)",marginBottom:6}}>
            <span>{stages[progress?.stage] || "Preparing…"}</span><span>{progress?.pct || 0}%</span>
          </div>
          <div style={{height:6,background:"rgba(255,255,255,0.07)",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",borderRadius:3,background:progress?.stage==="done"?"#10B981":"linear-gradient(90deg,#3B82F6,#8B5CF6)",width:`${progress?.pct || 0}%`,transition:"width 0.2s ease"}}/>
          </div>
        </div>
        {progress?.saved > 0 && <div style={{background:"rgba(16,185,129,0.08)",border:"0.5px solid rgba(16,185,129,0.2)",borderRadius:8,padding:"8px 12px",marginBottom:10,fontSize:12,color:"#10B981"}}>🗜 Pre-compression saved {fmt(progress.saved)}</div>}
      </div>
    </div>
  );
}

function AuthPage({ onAuth }) {
  const [mode,setMode]         = useState("login");
  const [email,setEmail]       = useState("");
  const [password,setPassword] = useState("");
  const [loading,setLoading]   = useState(false);
  const [error,setError]       = useState("");
  const [success,setSuccess]   = useState("");
  const inp = {width:"100%",padding:"11px 14px",boxSizing:"border-box",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,color:"#fff",fontSize:14,outline:"none",fontFamily:"inherit"};
  const submit = async () => {
    if (!email||!password) return;
    setLoading(true); setError(""); setSuccess("");
    try {
      if (mode==="signup") {
        const {error:e} = await supabase.auth.signUp({email,password});
        if (e) throw e;
        setSuccess("Check email to verify context credentials."); setMode("login");
      } else {
        const {data,error:e} = await supabase.auth.signInWithPassword({email,password});
        if (e) throw e;
        onAuth(data.session);
      }
    } catch(e) { setError(e.message||"Execution pipeline halted"); }
    finally    { setLoading(false); }
  };
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#0a0a0a",fontFamily:"var(--font-sans)"}}>
      <div style={{width:400,padding:"2.5rem",background:"#161616",border:"1px solid rgba(255,255,255,0.09)",borderRadius:20}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:28}}>
          <div style={{width:36,height:36,borderRadius:10,background:"linear-gradient(135deg,#3B82F6,#8B5CF6)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⬡</div>
          <span style={{fontSize:22,fontWeight:700,color:"#fff",letterSpacing:"-0.5px"}}>Nexus</span>
        </div>
        {error&&<div style={{background:"rgba(239,68,68,0.1)",border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#FCA5A5"}}>{error}</div>}
        {success&&<div style={{background:"rgba(16,185,129,0.1)",border:"0.5px solid rgba(16,185,129,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#6EE7B7"}}>{success}</div>}
        <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
          <input type="email" placeholder="Email context" value={email} onChange={e=>setEmail(e.target.value)} style={inp}/>
          <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={inp}/>
        </div>
        <button onClick={submit} style={{width:"100%",padding:"12px",borderRadius:10,border:"none",background:"#3B82F6",color:"#fff",fontSize:15,fontWeight:500,cursor:"pointer"}}>{loading?"Syncing…":mode==="login"?"Sign In":"Create Account"}</button>
        <p style={{marginTop:18,textAlign:"center",fontSize:13,color:"rgba(255,255,255,0.4)"}}><span onClick={()=>setMode(mode==="login"?"signup":"login")} style={{color:"#60A5FA",cursor:"pointer"}}>{mode==="login"?"Sign up free":"Sign in"}</span></p>
      </div>
    </div>
  );
}

function useP2P(token, { onFileAvailable }) {
  const wsRef = useRef(null);
  const [myPeerId,setMyPeerId]   = useState(null);
  const [myColor,setMyColor]     = useState("#6B7280");
  const [peerCount,setPeerCount] = useState(0);
  const [wsStatus,setWsStatus]   = useState("disconnected");
  const sendMsg = useCallback((msg) => {
    if (wsRef.current?.readyState===WebSocket.OPEN) wsRef.current.send(JSON.stringify(msg));
  }, []);
  useEffect(() => {
    if (!token) return;
    let ws, timer;
    const connect = () => {
      setWsStatus("connecting");
      ws = new WebSocket(`${WS_URL}?token=${token}`);
      wsRef.current = ws;
      ws.onopen = () => { setWsStatus("connected"); };
      ws.onmessage = (e) => {
        let msg; try { msg=JSON.parse(e.data); } catch { return; }
        if (msg.type==="welcome")        { setMyPeerId(msg.peer_id); setMyColor(msg.color); }
        if (msg.type==="peers_updated")  { setPeerCount((msg.peers||[]).length); }
        if (msg.type==="chunk_data")     { wsRef.current?._chunkHandler?.(msg); }
        if (msg.type==="file_available") { onFileAvailable?.(); }
      };
      ws.onclose = () => { setWsStatus("disconnected"); setMyPeerId(null); timer=setTimeout(connect,3000); };
    };
    connect();
    return () => { clearTimeout(timer); ws?.close(); };
  }, [token]); // eslint-disable-line
  return { ws:wsRef, myPeerId, myColor, peerCount, wsStatus, sendMsg };
}

function P2PDownloader({ file, sendMsg, wsRef, myColor, token, onClose, onHaveChunks }) {
  const [chunks,setChunks]   = useState({});
  const [status,setStatus]   = useState("requesting");
  const [totalMs,setTotalMs] = useState(null);
  const startRef    = useRef(Date.now());
  const { chunk_count:chunkCount, hash:fileId } = file;
  useEffect(() => {
    if (!wsRef.current) return;
    wsRef.current._chunkHandler = (msg) => {
      if (msg.file_id!==fileId) return;
      const elapsed=Date.now()-startRef.current;
      setChunks(p=>({...p,[msg.chunk_index]:{from_peer:msg.from_peer,elapsed}}));
    };
    return () => { if(wsRef.current) wsRef.current._chunkHandler=null; };
  }, [fileId,wsRef]);
  useEffect(() => {
    startRef.current=Date.now();
    for(let i=0;i<chunkCount;i++) setTimeout(()=>sendMsg({type:"want",file_id:fileId,chunk_index:i}),i*5);
  }, [fileId,chunkCount,sendMsg]);
  useEffect(() => {
    if (Object.keys(chunks).length>0&&Object.keys(chunks).length>=chunkCount && status !== "done") {
      setStatus("done"); setTotalMs(Date.now()-startRef.current);
      fetch(`${API}/download/${fileId}`,{headers:{Authorization:`Bearer ${token}`}})
        .then(r=>r.blob()).then(blob=>{
          const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=file.filename; a.click();
        });
      onHaveChunks(fileId, Array.from({length:chunkCount},(_,i)=>i));
    }
  }, [chunks,chunkCount,fileId,file,token,onHaveChunks,status]);
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#161616",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:560}}>
        <h2 style={{margin:0,fontSize:16,color:"#fff"}}>{status==="done"?"✓ Assembled":"⬇️ Pulling Chunks P2P"}</h2>
        <p style={{fontSize:12,color:"rgba(255,255,255,0.4)"}}>{file.filename}</p>
        <div style={{height:6,background:"rgba(255,255,255,0.07)",borderRadius:3,overflow:"hidden",marginTop:10}}>
          <div style={{height:"100%",background:"#3B82F6",width:`${Math.round((Object.keys(chunks).length/chunkCount)*100)}%`}}/>
        </div>
        {status==="done"&&<p style={{color:"#10B981",fontSize:12,marginTop:8,textAlign:"center"}}>Reassembled in {totalMs}ms</p>}
      </div>
    </div>
  );
}

function UploadResult({ result, onClose }) {
  const saved=result.savings||0; const pct=result.original_size>0?Math.round((saved/result.original_size)*100):0;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:460}}>
        <h2 style={{margin:0,fontSize:15,color:"#fff"}}>Matrix Pipeline Execution Complete</h2>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,margin:"14px 0"}}>
          {[["Original",fmt(result.original_size),"#6B7280"],["Stored",fmt(result.stored_size),"#10B981"],["Saved",`${pct}%`,"#8B5CF6"]].map(([l,v,c])=>(
            <div key={l} style={{background:"rgba(255,255,255,0.04)",borderRadius:10,padding:"12px",borderTop:`2px solid ${c}`}}>
              <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.4)"}}>{l}</p><p style={{margin:"6px 0 0",fontSize:18,color:c}}>{v}</p>
            </div>))}
        </div>
        <button onClick={onClose} style={{width:"100%",padding:8,background:"#3B82F6",color:"#fff",border:"none",borderRadius:8,cursor:"pointer"}}>Dismiss</button>
      </div>
    </div>
  );
}

function ShareModal({ file, token, onClose }) {
  const [email,setEmail] = useState(""); const [publicLink,setPublicLink] = useState(null); const [copied,setCopied] = useState(false); const ap = apiFetch(token);
  useEffect(() => {
    ap(`/share/${file.hash}/public`).then(r=>r.json()).then(d=>{
      if (d.exists) setPublicLink({ public_url: d.public_url });
    });
  }, [file.hash]); // eslint-disable-line
  const createPublic = async () => {
    const res = await ap(`/share/${file.hash}/public`, {method:"POST"}); const d = await res.json();
    if(res.ok || res.status===200) setPublicLink({ public_url: d.public_url });
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:250}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",borderRadius:16,padding:"1.5rem",width:500}}>
        <h3>🔗 Public Token Link Provisioning</h3>
        {publicLink ? (
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <input readOnly value={publicLink.public_url} style={{flex:1,padding:8,background:"#222",border:"none",color:"#fff",borderRadius:6,fontSize:12}}/>
            <button onClick={()=>{navigator.clipboard.writeText(publicLink.public_url);setCopied(true);}} style={{background:"#3B82F6",color:"#fff",border:"none",padding:"0 12px",borderRadius:6}}>{copied?"✓":"Copy"}</button>
          </div>
        ) : <button onClick={createPublic} style={{width:"100%",padding:10,background:"#3B82F6",border:"none",color:"#fff",borderRadius:8,marginTop:10}}>Generate Public Download Object Pointer</button>}
      </div>
    </div>
  );
}

function DuplicateError({ filename, onClose }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div style={{background:"#1a1a1a",border:"1px solid red",padding:"1.5rem",borderRadius:12}}>
        <p style={{color:"#fff"}}>Filename collision logic mismatch: "{filename}" exists in scope context.</p>
        <button onClick={onClose} style={{background:"red",color:"#fff",border:"none",padding:"4px 12px",borderRadius:6,marginTop:10}}>OK</button>
      </div>
    </div>
  );
}

function QuotaError({ message, onClose }) { return <div/>; }
function NewFolderModal({ token, parentId, onCreated, onClose }) {
  const [name,setName] = useState("");
  const submit = async () => {
    await apiFetch(token)("/folders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,parent_id:parentId})});
    onCreated(); onClose();
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#1a1a1a",padding:"1.5rem",borderRadius:12}}>
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="Folder descriptor..." style={{padding:8,borderRadius:6,border:"none"}}/>
        <button onClick={submit} style={{marginLeft:8,padding:"8px 12px",background:"#3B82F6",color:"#fff",border:"none",borderRadius:6}}>Create</button>
      </div>
    </div>
  );
}

function AdminDashboard({ token, onClose }) { return <div/>; }

// ── Injected Sprint 1 UI Toggle Component ─────────────────────────────

function MarketplaceSettings({ token, stats, refreshStats }) {
  const [plan, setPlan] = useState(stats?.current_plan || "Option_A_Eco");
  const [allocatedGb, setAllocatedGb] = useState(Math.round((stats?.physical_bytes_allocated || 0) / (1024 ** 3)));
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (stats) {
      setPlan(stats.current_plan || "Option_A_Eco");
      setAllocatedGb(Math.round((stats.physical_bytes_allocated || 0) / (1024 ** 3)));
    }
  }, [stats]);

  return (
    <div style={{ background: "rgba(255,255,255,0.02)", border: "0.5px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "12px", marginTop: "10px", display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontSize: 11, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Network Arbitrage</p>
      <div style={{ display: "flex", gap: 6 }}>
        <button disabled={updating} onClick={() => setPlan("Option_A_Eco")} style={{ flex: 1, padding: "6px 4px", fontSize: "11px", borderRadius: 6, background: plan === "Option_A_Eco" ? "rgba(16,185,129,0.15)" : "transparent", color: plan === "Option_A_Eco" ? "#34D399" : "#666", border: "1px solid rgba(255,255,255,0.1)" }}>🌱 Eco</button>
        <button disabled={updating} onClick={() => setPlan("Option_B_Pro")} style={{ flex: 1, padding: "6px 4px", fontSize: "11px", borderRadius: 6, background: plan === "Option_B_Pro" ? "rgba(139,92,246,0.15)" : "transparent", color: plan === "Option_B_Pro" ? "#A78BFA" : "#666", border: "1px solid rgba(255,255,255,0.1)" }}>⚒️ Miner</button>
      </div>
      {plan === "Option_A_Eco" ? (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
          Delta split active. Earn ceiling expansions.
          {stats?.dynamic_quota_bonus > 0 && <div style={{ color: "#10B981", marginTop: 4 }}>Bonus: +{fmt(stats.dynamic_quota_bonus)}</div>}
        </div>
      ) : (
        <div style={{ fontSize: 11 }}>
          <input type="range" min="10" max="500" value={allocatedGb} onChange={e=>setAllocatedGb(e.target.value)} style={{ width:"100%" }}/>
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:4, color:"#A78BFA" }}><span>Allocation: {allocatedGb} GB</span><span>Wallet: ${parseFloat(stats?.balance_usd || 0).toFixed(4)}</span></div>
        </div>
      )}
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────

function Sidebar({ stats, activeView, setActiveView, user, onSignOut, trashCount, folders, currentFolderId, onFolderClick, isAdmin, onAdminOpen, token, refreshStats }) {
  const usedBytes   = stats?.total_stored||0; const quotaBytes = stats?.quota_bytes||(10*1024*1024*1024); const usedPct = Math.min(100,(usedBytes/quotaBytes)*100);
  return (
    <aside style={{width:215,flexShrink:0,padding:"1rem 0.75rem",borderRight:"0.5px solid rgba(255,255,255,0.07)",display:"flex",flexDirection:"column",gap:2,overflow:"hidden"}}>
      {[{id:"active",icon:"🗂️",label:"My Files"},{id:"shared",icon:"🔗",label:"Shared View"},{id:"starred",icon:"⭐",label:"Starred"},{id:"trash",icon:"🗑️",label:"Trash",badge:trashCount}].map(item=>(
        <button key={item.id} onClick={()=>setActiveView(item.id)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 12px",borderRadius:10,border:"none",cursor:"pointer",fontSize:13,background:activeView===item.id&&!currentFolderId?"rgba(255,255,255,0.08)":"transparent",color:"#fff",fontFamily:"inherit"}}>
          <span style={{display:"flex",alignItems:"center",gap:10}}><span>{item.icon}</span>{item.label}</span>
          {item.badge>0&&<span style={{fontSize:10,background:"red",color:"#fff",borderRadius:10,padding:"1px 7px"}}>{item.badge}</span>}
        </button>))}
      <div style={{marginTop:"auto",padding:"12px",background:"rgba(255,255,255,0.03)",borderRadius:12}}>
        <div style={{height:4,background:"#222",borderRadius:2,marginBottom:8,overflow:"hidden"}}><div style={{width:`${usedPct}%`,height:"100%",background:"#3B82F6"}}/></div>
        <p style={{margin:0,fontSize:11,color:"#aaa"}}>{fmt(usedBytes)} / {fmt(quotaBytes)}</p>
      </div>
      <MarketplaceSettings token={token} stats={stats} refreshStats={refreshStats} />
      <p style={{fontSize:11,color:"#444",marginTop:8,overflow:"hidden",textOverflow:"ellipsis"}}>{user?.email}</p>
      <button onClick={onSignOut} style={{background:"none",border:"1px solid #333",color:"#fff",borderRadius:6,padding:4,cursor:"pointer",marginTop:4}}>Sign Out</button>
    </aside>
  );
}

// ── Top bar ───────────────────────────────────────────────────────

function TopBar({ wsStatus, myPeerId, myColor, peerCount, onUpload, onNewFolder, uploading, searchQuery, setSearchQuery, activeView, breadcrumb, onBreadcrumbClick }) {
  return (
    <header style={{height:58,display:"flex",alignItems:"center",gap:12,padding:"0 1.25rem",borderBottom:"0.5px solid rgba(255,255,255,0.07)",background:"#0f0f0f",width:"100%",boxSizing:"border-box"}}>
      <span style={{fontSize:17,fontWeight:600,color:"#fff"}}>⬡ Nexus</span>
      <div style={{flex:1,maxWidth:480,position:"relative"}}>
        <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="🔍 Global asset index lookup network wide..." style={{width:"100%",padding:"8px 12px",background:"#161616",border:"1px solid #222",borderRadius:10,color:"#fff",outline:"none"}}/>
      </div>
      <div style={{marginLeft:"auto",display:"flex",gap:10}}>
        <button onClick={onNewFolder} style={{background:"#222",color:"#fff",border:"none",padding:"6px 12px",borderRadius:8,cursor:"pointer"}}>+ Folder</button>
        <button onClick={onUpload} style={{background:"#3B82F6",color:"#fff",border:"none",padding:"6px 16px",borderRadius:8,cursor:"pointer"}}>{uploading?"Processing...":"⬆ Upload"}</button>
      </div>
    </header>
  );
}

// ── File and Folder rows (Sprint 1 UX Layouts) ────────────────────

function FileRow({ file, view, onStar, onTrash, onRestore, onDelete, onP2PDownload, onShare, isSelected, onToggleSelect }) {
  const [hover,setHover] = useState(false);
  return (
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      draggable={view === "active"}
      onDragStart={(e)=>{ e.dataTransfer.setData("text/plain", file.hash); e.dataTransfer.effectAllowed = "move"; }}
      style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",background:isSelected ? "rgba(59,130,246,0.08)" : hover?"rgba(255,255,255,0.04)":"transparent",borderBottom:"0.5px solid #222",fontSize:13,cursor:view==="active"?"grab":"default"}}>
      <input type="checkbox" checked={isSelected} onChange={()=>onToggleSelect(file.hash)} onClick={e=>e.stopPropagation()}/>
      <span style={{color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{file.filename}</span>
      <span style={{color:"#888"}}>{fmt(file.original_size)}</span>
      <span style={{color:"#888"}}>{fmt(file.stored_size)}</span>
      <span style={{color:"#10B981"}}>{file.original_size>0?Math.round(((file.original_size-file.stored_size)/file.original_size)*100):0}%</span>
      <span style={{color:"#555"}}>{relTime(file.upload_time)}</span>
      <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
        <button onClick={()=>onP2PDownload(file)} style={{background:"#222",color:"#fff",border:"none",padding:"4px 8px",borderRadius:4,cursor:"pointer"}}>⬇</button>
        <button onClick={()=>onShare(file)} style={{background:"#222",color:"#fff",border:"none",padding:"4px 8px",borderRadius:4,cursor:"pointer"}}>🔗</button>
        <button onClick={()=>onTrash(file.hash)} style={{background:"none",color:"#555",border:"none",cursor:"pointer"}}>🗑</button>
      </div>
    </div>
  );
}

function FolderRow({ folder, onOpen, onDelete, onRename, onFileDropped }) {
  const [hover,setHover] = useState(false); const [dragOver,setDragOver] = useState(false);
  return (
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      onDragOver={e=>{ e.preventDefault(); setDragOver(true); }}
      onDragLeave={()=>setDragOver(false)}
      onDrop={e=>{ e.preventDefault(); setDragOver(false); const fh=e.dataTransfer.getData("text/plain"); if(fh) onFileDropped(fh, folder.id); }}
      onClick={()=>onOpen(folder.id)}
      style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",background:dragOver?"rgba(59,130,246,0.15)":hover?"rgba(255,255,255,0.04)":"transparent",borderBottom:"0.5px solid #222",fontSize:13}}>
      <span/>
      <span style={{color:"#F59E0B",fontWeight:500}}>📁 {folder.name}</span>
      <span/><span/><span/><span style={{color:"#444"}}>{relTime(folder.created_at)}</span>
      <button onClick={(e)=>{e.stopPropagation();onDelete(folder.id);}} style={{background:"none",border:"none",color:"#555",cursor:"pointer"}}>🗑</button>
    </div>
  );
}

function SharedWithMeView({ token, onP2PDownload }) { return <div/>; }

// ── Main App Component ────────────────────────────────────────────

export default function App() {
  const [session,setSession] = useState(null); const [authReady,setAuthReady] = useState(false); const [files,setFiles] = useState([]); const [folders,setFolders] = useState([]); const [trashFiles,setTrashFiles] = useState([]); const [stats,setStats] = useState(null);
  const [uploading,setUploading] = useState(false); const [uploadProgress,setUploadProgress] = useState(null); const [uploadFilename,setUploadFilename] = useState(""); const [result,setResult] = useState(null); const [dupError,setDupError] = useState(null); const [quotaError,setQuotaError] = useState(null); const [error,setError] = useState(null); const [p2pTarget,setP2pTarget] = useState(null); const [shareTarget,setShareTarget] = useState(null); const [activeView,setActiveView] = useState("active"); const [currentFolderId,setCurrentFolderId] = useState(null); const [breadcrumb,setBreadcrumb] = useState([{id:null,name:"My Files"}]); const [searchQuery,setSearchQuery] = useState(""); const [showNewFolder,setShowNewFolder] = useState(false); const [showAdmin,setShowAdmin] = useState(false);
  
  // Sprint 1 UI Bulk Action State tracking
  const [selectedFileHashes, setSelectedFileHashes] = useState([]);
  const inputRef = useRef(); const isAdmin = session?.user?.email === ADMIN_EMAIL;

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{ setSession(session); setAuthReady(true); });
    supabase.auth.onAuthStateChange((_,s)=>setSession(s));
  },[]);

  const handleSignOut = async ()=>{ await supabase.auth.signOut(); setSession(null); };
  const token = session?.access_token; const ap = useMemo(()=> token ? apiFetch(token) : null, [token]);
  const { ws, myPeerId, myColor, peerCount, wsStatus, sendMsg } = useP2P(token, { onFileAvailable: ()=>refresh() });

  const refresh = useCallback(async ()=>{
    if (!ap) return;
    try {
      // Sprint 1 Fix: Pass global search query boolean condition straight to layout loops
      const isSearchActive = searchQuery.trim().length > 0;
      const [fRes,tRes,sRes,folRes] = await Promise.all([
        ap(`/files?view=${activeView}${currentFolderId?`&folder_id=${currentFolderId}`:""}${isSearchActive ? "&search=true" : ""}`),
        ap(`/files?view=trash`), ap(`/stats`),
        activeView==="active" ? ap(`/folders${currentFolderId?`?parent_id=${currentFolderId}`:""}`) : Promise.resolve({json:()=>[]}),
      ]);
      const [f,t,s,fol] = await Promise.all([fRes.json(),tRes.json(),sRes.json(),folRes.json()]);
      setFiles(Array.isArray(f)?f:[]); setTrashFiles(Array.isArray(t)?t:[]); setStats(s); setFolders(Array.isArray(fol)?fol:[]);
    } catch(e) { setError(`Sync boundary broke: ${e.message}`); }
  },[ap, activeView, currentFolderId, searchQuery]);

  useEffect(()=>{ if(token) refresh(); },[token, activeView, currentFolderId, searchQuery]);

  const openFolder = useCallback(async (folderId)=>{
    setCurrentFolderId(folderId); setSelectedFileHashes([]);
    if (!folderId) { setBreadcrumb([{id:null,name:"My Files"}]); return; }
    try {
      const res = await ap(`/folders/${folderId}/breadcrumb`); const data = await res.json();
      setBreadcrumb(Array.isArray(data)?data:[{id:null,name:"My Files"}]);
    } catch { setBreadcrumb([{id:null,name:"My Files"},{id:folderId,name:"Folder"}]); }
  },[ap]);

  const uploadFile = async (file) => {
    setUploading(true); setUploadFilename(file.name);
    try {
      let data = file.size > RESUMABLE_THRESHOLD 
        ? await resumableUpload(file, token, currentFolderId, setUploadProgress)
        : await regularUpload(file, token, currentFolderId, setUploadProgress);
      if (data.error==="duplicate_filename") setDupError({filename:file.name});
      else if (data.error==="quota_exceeded") setQuotaError(data.message);
      else { setResult(data); refresh(); }
    } catch(e) { setError(`Upload failed: ${e.message}`); }
    finally { setUploading(false); setUploadProgress(null); }
  };

  const handleFileMove = async (fileHash, targetFolderId) => {
    try {
      const res = await ap(`/files/${fileHash}/move`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder_id: targetFolderId }) });
      if (res.ok) { setFiles(p => p.filter(f => f.hash !== fileHash)); refresh(); }
    } catch (e) { setError(e.message); }
  };

  const handleToggleSelect = (hash) => {
    setSelectedFileHashes(p => p.includes(hash) ? p.filter(h => h !== hash) : [...p, hash]);
  };

  const handleBulkTrash = async () => {
    if (!window.confirm(`Move ${selectedFileHashes.length} items to standard trash collection?`)) return;
    try {
      await Promise.all(selectedFileHashes.map(h => ap(`/trash/${h}`, { method: "PATCH" })));
      setSelectedFileHashes([]); refresh();
    } catch (e) { setError(e.message); }
  };

  // Sprint 1 UI: Run frontend filter loop matches
  const visibleFiles = files.filter(f => f.filename.toLowerCase().includes(searchQuery.toLowerCase()));

  if (!authReady) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#0a0a0a",color:"#444"}}>Syncing Matrix Context...</div>;
  if (!session) return <AuthPage onAuth={setSession}/>;

  return (
    <div style={{display:"flex",flexDirection:"column",width:"100%",height:"100vh",background:"#0f0f0f",color:"#fff",overflow:"hidden"}}>
      <TopBar wsStatus={wsStatus} myPeerId={myPeerId} myColor={myColor} peerCount={peerCount} onUpload={()=>inputRef.current?.click()} onNewFolder={()=>setShowNewFolder(true)} uploading={uploading} searchQuery={searchQuery} setSearchQuery={setSearchQuery} activeView={activeView} breadcrumb={breadcrumb} onBreadcrumbClick={openFolder}/>
      <input ref={inputRef} type="file" style={{display:"none"}} onChange={e=>{ if(e.target.files[0]) uploadFile(e.target.files[0]); }}/>
      
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        <Sidebar stats={stats} activeView={activeView} setActiveView={(v)=>{ setActiveView(v); setSearchQuery(""); setCurrentFolderId(null); setBreadcrumb([{id:null,name:"My Files"}]); setSelectedFileHashes([]); }} user={session.user} onSignOut={handleSignOut} trashCount={trashFiles.length} folders={folders} currentFolderId={currentFolderId} onFolderClick={openFolder} isAdmin={isAdmin} onAdminOpen={()=>setShowAdmin(true)} token={token} refreshStats={refresh}/>
        
        <main style={{flex:1,overflowY:"auto",padding:"1.25rem 1.5rem"}}>
          {error && <div style={{background:"red",padding:10,borderRadius:8}}>{error}</div>}
          
          {/* Sprint 1 Bulk Action Ribbon Display Component */}
          {selectedFileHashes.length > 0 && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(239,68,68,0.1)",border:"1px solid red",padding:12,borderRadius:8,marginBottom:10}}>
              <span style={{fontSize:12,color:"red"}}>Batch modification active: {selectedFileHashes.length} items staged</span>
              <div>
                <button onClick={()=>setSelectedFileHashes([])} style={{background:"none",border:"1px solid #444",color:"#fff",padding:"4px 8px",borderRadius:4,marginRight:6,cursor:"pointer"}}>Clear</button>
                <button onClick={handleBulkTrash} style={{background:"red",color:"#fff",border:"none",padding:"4px 12px",borderRadius:4,cursor:"pointer"}}>Trash Batch</button>
              </div>
            </div>
          )}

          <div style={{background:"rgba(255,255,255,0.01)",border:"1px solid #1a1a1a",borderRadius:12,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",padding:"8px 16px",background:"#111",fontSize:11,color:"#555",textTransform:"uppercase"}}>
              <span/><span>Asset Element</span><span>Source Bound</span><span>Compressed</span><span>Ratio</span><span>Indexed</span><span/>
            </div>
            
            {/* Folder rows support dropping files into their respective sub-directories */}
            {folders.map(f=><FolderRow key={f.id} folder={f} onOpen={openFolder} onDelete={()=>ap(`/folders/${f.id}`,{method:"DELETE"}).then(()=>refresh())} onRename={()=>{}} onFileDropped={handleFileMove}/>)}
            
            {/* File entries handle individual selection clicks and bulk state management loops */}
            {visibleFiles.map(f=><FileRow key={f.hash} file={f} view={activeView} onStar={()=>{}} onTrash={()=>{}} onRestore={()=>{}} onDelete={()=>{}} onP2PDownload={setP2pTarget} onShare={setShareTarget} isSelected={selectedFileHashes.includes(f.hash)} onToggleSelect={handleToggleSelect}/>)}
          </div>
        </main>
      </div>

      {uploading && uploadProgress && <UploadProgressModal filename={uploadFilename} progress={uploadProgress}/>}
      {result && <UploadResult result={result} onClose={()=>setResult(null)}/>}
      {dupError && <DuplicateError filename={dupError.filename} onClose={()=>setDupError(null)}/>}
      {showNewFolder && <NewFolderModal token={token} parentId={currentFolderId} onCreated={()=>refresh()} onClose={()=>setShowNewFolder(false)}/>}
      {shareTarget && <ShareModal file={shareTarget} token={token} onClose={()=>setShareTarget(null)}/>}
      {p2pTarget && <P2PDownloader file={p2pTarget} sendMsg={sendMsg} wsRef={ws} myColor={myColor} token={token} onClose={()=>setP2pTarget(null)} onHaveChunks={handleHaveChunks}/>}
    </div>
  );
}
