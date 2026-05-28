import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = "https://hoqzrxxqczxwwnqimvxm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhvcXpyeHhxY3p4d3ducWltdnhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcyNzAzMzgsImV4cCI6MjA4Mjg0NjMzOH0.KWrM31jwQu98qevgPKbSzEIrsulKpjxiBQ1X4QlkHFc";
const supabase  = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const API                = import.meta.env.VITE_API_URL || "http://localhost:5000";
const WS_URL             = import.meta.env.VITE_WS_URL  || "ws://localhost:5000/ws";
const RESUMABLE_THRESHOLD = 10 * 1024 * 1024;
const CHUNK_SIZE          = 256 * 1024;

// ── Shared UI Metric Format Utilities ─────────────────────────────

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
const catIcon  = (c) => ({image:"🖼️",video:"🎬",audio:"🎵",document:"📄",archive:"📦",code:"💻",other:"📎"})[c]||"📎";
const catColor = (c) => ({image:"#F59E0B",video:"#EF4444",audio:"#8B5CF6",document:"#3B82F6",archive:"#F97316",code:"#10B981",other:"#6B7280"})[c]||"#6B7280";

const apiFetch = (token) => (path, opts={}) =>
  fetch(`${API}${path}`, { ...opts, headers:{ Authorization:`Bearer ${token}`, ...opts.headers }});

// ── Client Compression & Assembly Operations ──────────────────────

function computeEntropy(bytes) {
  const sample = bytes.slice(0, 4096); const counts = new Array(256).fill(0);
  for (let i = 0; i < sample.length; i++) counts[sample[i]]++;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (counts[i] === 0) continue;
    const p = counts[i] / sample.length; entropy -= p * Math.log2(p);
  }
  return entropy;
}

async function compressClientSide(file) {
  const ext = "." + file.name.split(".").pop().toLowerCase();
  if (new Set([".jpg",".jpeg",".png",".gif",".webp",".mp4",".mkv",".zip",".7z"]).has(ext)) return { compressed: null, skipped: true };
  if (!window.ZstdCodec) return { compressed: null, skipped: true };
  try {
    const uint8 = new Uint8Array(await file.arrayBuffer()); const entropy = computeEntropy(uint8);
    if (entropy > 7.5) return { compressed: null, skipped: true, entropy };
    return new Promise((resolve) => {
      window.ZstdCodec.run(zstd => {
        const compressed = new zstd.Simple().compress(uint8, 6);
        resolve({ compressed, originalSize: uint8.length, compressedSize: compressed.length, ratio: uint8.length/compressed.length, entropy, skipped: false });
      });
    });
  } catch(e) { return { compressed: null, skipped: true }; }
}

async function resumableUpload(file, token, folderId, onProgress) {
  const ap = apiFetch(token); onProgress({ stage: "compressing", pct: 50 });
  const compResult = await compressClientSide(file); const useComp = !compResult.skipped;
  const finalData = useComp ? compResult.compressed : new Uint8Array(await file.arrayBuffer());
  const totalChunks = Math.ceil(finalData.length / CHUNK_SIZE);

  const initRes = await ap("/upload/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, total_size: file.size, total_chunks: totalChunks, folder_id: folderId, pre_compressed: useComp })});
  const { session_id } = await initRes.json();

  for (let i = 0; i < totalChunks; i++) {
    const fd = new FormData(); fd.append("session_id", session_id); fd.append("chunk_index", String(i));
    fd.append("chunk", new Blob([finalData.slice(i*CHUNK_SIZE, (i+1)*CHUNK_SIZE)]));
    await ap("/upload/chunk", { method: "POST", body: fd });
    onProgress({ stage: "uploading", pct: Math.round(((i + 1) / totalChunks) * 100) });
  }
  const finishRes = await ap("/upload/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id, entropy: compResult.entropy || null })});
  return finishRes.json();
}

// ── Modals & Auxiliary Core Interfaces ────────────────────────────

function UploadProgressModal({ filename, progress }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}}>
      <div style={{background:"#111",border:"1px solid #222",borderRadius:16,padding:"1.5rem",width:400,fontFamily:"monospace"}}>
        <p style={{margin:"0 0 8px",color:"#EF4444"}}>⚡ TRANSFER_PROTOCOL_ACTIVE</p>
        <p style={{fontSize:12,color:"#666",overflow:"hidden",textOverflow:"ellipsis"}}>{filename}</p>
        <div style={{height:4,background:"#222",marginTop:12,borderRadius:2,overflow:"hidden"}}>
          <div style={{height:"100%",background:"#EF4444",width:`${progress?.pct || 0}%`,transition:"width 0.1s"}}/>
        </div>
      </div>
    </div>
  );
}

function P2PDownloader({ file, token, onClose }) {
  useEffect(() => {
    fetch(`${API}/download/${file.hash}`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.blob()).then(b=>{
      const url=URL.createObjectURL(b); const a=document.createElement("a"); a.href=url; a.download=file.filename; a.click(); onClose();
    });
  }, [file.hash]); // eslint-disable-line
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,fontFamily:"monospace",color:"#EF4444"}}>STREAM_INGEST: Reassembling encrypted node array blocks...</div>;
}

function NewFolderModal({ token, parentId, onCreated, onClose }) {
  const [name,setName] = useState("");
  const executeCreate = async () => {
    if(!name.trim()) return;
    await apiFetch(token)("/folders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim(),parent_id:parentId})});
    onCreated(); onClose();
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#111",padding:"1.5rem",borderRadius:12,border:"1px solid #222",fontFamily:"monospace"}}>
        <p style={{margin:"0 0 10px",color:"#fff",fontSize:12}}>ALLOCATE_NEW_DIRECTORY</p>
        <input autoFocus value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&executeCreate()} placeholder="Identifier..." style={{padding:10,background:"#161616",border:"1px solid #333",color:"#fff",borderRadius:6,outline:"none"}}/>
        <button onClick={executeCreate} style={{marginLeft:8,padding:"10px 16px",background:"#EF4444",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontWeight:600}}>Build</button>
      </div>
    </div>
  );
}

// ── Sprint 2 Share Panel with Restored Email Routing ─────────────────────────

function ShareModal({ file, token, onClose }) {
  const [email, setEmail] = useState(""); const [shares, setShares] = useState([]); const [publicLink, setPublicLink] = useState(null); const [copied, setCopied] = useState(false); const [success, setSuccess] = useState(""); const ap = useMemo(() => apiFetch(token), [token]);
  const loadData = () => {
    ap(`/share/${file.hash}`).then(r=>r.json()).then(d=>{ if(Array.isArray(d)) setShares(d); });
    ap(`/share/${file.hash}/public`).then(r=>r.json()).then(d=>{ if(d.exists) setPublicLink(d.public_url); });
  };
  useEffect(() => { loadData(); }, [file.hash]); // eslint-disable-line
  const handleShare = async () => {
    if(!email.trim()) return;
    const res = await ap(`/share/${file.hash}`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({email:email.trim().toLowerCase()})});
    if(res.ok) { setSuccess(`Channel link provisioned for ${email}`); setEmail(""); loadData(); }
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:250}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#111",borderRadius:14,padding:"1.5rem",width:460,border:"1px solid #222",fontFamily:"monospace"}}>
        <p style={{margin:0,color:"#fff",fontSize:14}}>🔗 TRANSACTIONAL_DISTRIBUTION_ROUTER</p>
        <p style={{fontSize:11,color:"#444",margin:"4px 0 16px"}}>{file.hash}</p>
        <div style={{background:"rgba(255,255,255,0.02)",padding:12,borderRadius:8,marginBottom:12,border:"1px solid #1a1a1a"}}>
          <p style={{margin:"0 0 6px",fontSize:11,color:"#666"}}>SECURE TARGET COURIER EMAIL</p>
          <div style={{display:"flex",gap:6}}>
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="courier@domain.context" style={{flex:1,padding:8,background:"#141414",border:"1px solid #222",color:"#fff",borderRadius:6,fontSize:12,fontFamily:"monospace"}}/>
            <button onClick={handleShare} style={{background:"#3B82F6",color:"#fff",border:"none",borderRadius:6,padding:"0 12px",cursor:"pointer"}}>Authorize</button>
          </div>
          {success && <p style={{color:"#10B981",fontSize:11,margin:"6px 0 0"}}>{success}</p>}
        </div>
        {publicLink ? (
          <div style={{display:"flex",gap:6}}>
            <input readOnly value={publicLink} style={{flex:1,padding:8,background:"#141414",border:"1px solid #222",color:"#666",borderRadius:6,fontSize:11,fontFamily:"monospace"}}/>
            <button onClick={()=>{navigator.clipboard.writeText(publicLink);setCopied(true);}} style={{background:"#222",color:"#fff",border:"1px solid #333",padding:"0 12px",borderRadius:6,cursor:"pointer"}}>{copied?"✓":"Copy"}</button>
          </div>
        ) : <button onClick={async()=>{ const r=await ap(`/share/${file.hash}/public`,{method:"POST"}); const d=await r.json(); setPublicLink(d.public_url); }} style={{width:"100%",padding:10,background:"#161616",border:"1px solid #222",color:"#3B82F6",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>Build Anonymous Gateway Access Link</button>}
        {shares.length > 0 && (
          <div style={{marginTop:14,maxHeight:100,overflowY:"auto"}}>
            <p style={{fontSize:10,color:"#333",margin:"0 0 4px"}}>PROVISIONED_TARGETS</p>
            {{shares.map(s => (
                <div key={s.shared_with} style={{ fontSize: 12, color: "#aaa", padding: "4px 0" }}>
                  • {s.shared_with} <span style={{ fontSize: 10, color: "#444" }}>({relTime(s.created_at)})</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sprint 2 Immutable Activity Feed Monitor ───────────────────────

function ActivityLogPanel({ token }) {
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    if(token) apiFetch(token)("/activity-logs").then(r=>r.json()).then(d => { if(Array.isArray(d)) setLogs(d); });
  }, [token]);
  return (
    <div style={{background:"rgba(255,255,255,0.01)",border:"1px solid #141414",padding:14,borderRadius:12,marginTop:14,fontFamily:"monospace"}}>
      <p style={{margin:"0 0 10px",fontSize:11,color:"#444",letterSpacing:"0.05em"}}>⚙️ KERNEL_AUDIT_TRAIL_FEED</p>
      <div style={{maxHeight:130,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
        {logs.length === 0 ? <p style={{fontSize:11,color:"#222"}}>Zero system state records returned.</p> : logs.map(l => (
          <div key={l.id} style={{display:"flex",justifyContent:"space-between",fontSize:11,borderBottom:"1px solid #0f0f0f",paddingBottom:2}}>
            <span style={{color:l.action_type==="UPLOAD"?"#10B981":l.action_type==="DELETE"?"#EF4444":"#3B82F6"}}>[{l.action_type}] {l.metadata?.filename || l.metadata?.destination}</span>
            <span style={{color:"#222"}}>{relTime(l.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shared UI Settings Component ──────────────────────────────────

function MarketplaceSettings({ token, stats, refreshStats }) {
  const [plan, setPlan] = useState("Option_A_Eco"); const [allocatedGb, setAllocatedGb] = useState(20);
  useEffect(() => { if(stats) { setPlan(stats.current_plan||"Option_A_Eco"); setAllocatedGb(Math.round((stats.physical_bytes_allocated||0)/(1024**3))); }}, [stats]);
  const syncPlan = async (p, gb) => {
    await fetch(`${API}/quota/allocate`, { method:"POST", headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"}, body:JSON.stringify({ plan:p, allocated_gb:parseInt(gb) })});
    refreshStats();
  };
  return (
    <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid #141414",borderRadius:10,padding:10,marginTop:10,fontFamily:"monospace"}}>
      <p style={{margin:"0 0 8px",fontSize:10,color:"#444"}}>NETWORK_ARBITRAGE</p>
      <div style={{display:"flex",gap:4}}>
        <button onClick={()=>{setPlan("Option_A_Eco");syncPlan("Option_A_Eco",0);}} style={{flex:1,padding:4,fontSize:10,background:plan==="Option_A_Eco"?"rgba(16,185,129,0.1)":"transparent",color:plan==="Option_A_Eco"?"#10B981":"#444",border:"1px solid #222",borderRadius:4,cursor:"pointer"}}>🌱 Eco</button>
        <button onClick={()=>{setPlan("Option_B_Pro");syncPlan("Option_B_Pro",allocatedGb);}} style={{flex:1,padding:4,fontSize:10,background:plan==="Option_B_Pro"?"rgba(139,92,246,0.1)":"transparent",color:plan==="Option_B_Pro"?"#A78BFA":"#444",border:"1px solid #222",borderRadius:4,cursor:"pointer"}}>⚒️ Miner</button>
      </div>
      {plan==="Option_A_Eco" ? (
        <p style={{fontSize:10,color:"#444",margin:"6px 0 0"}}>Quota bonus factor active. Earn empty block expansions.</p>
      ) : (
        <div style={{marginTop:6}}>
          <input type="range" min="10" max="500" value={allocatedGb} onChange={e=>setAllocatedGb(e.target.value)} onMouseUp={()=>syncPlan("Option_B_Pro",allocatedGb)} style={{width:"100%"}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#A78BFA",marginTop:2}}><span>Host: {allocatedGb}GB</span><span>Yield: ${parseFloat(stats?.balance_usd||0).toFixed(4)}</span></div>
        </div>
      )}
    </div>
  );
}

// ── Row Templates (With Restored Star / Delete Context Handles) ────

function FileRow({ file, view, onStar, onTrash, onDelete, onP2PDownload, onShare, isSelected, onToggleSelect }) {
  const [hover,setHover] = useState(false);
  return (
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      draggable={view === "active"}
      onDragStart={(e)=>{ e.dataTransfer.setData("text/plain", file.hash); e.dataTransfer.effectAllowed = "move"; }}
      style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",background:isSelected ? "rgba(239,68,68,0.04)" : hover?"rgba(255,255,255,0.03)":"transparent",borderBottom:"1px solid #141414",fontSize:13,fontFamily:"monospace",cursor:view==="active"?"grab":"default"}}>
      <input type="checkbox" checked={isSelected} onChange={()=>onToggleSelect(file.hash)} onClick={e=>e.stopPropagation()} style={{accentColor:"#EF4444"}}/>
      <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
        <span style={{fontSize:14}}>{catIcon(file.category)}</span>
        <span style={{color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{file.filename}</span>
        {file.version_number > 1 && <span style={{fontSize:9,background:"rgba(139,92,246,0.15)",color:"#A78BFA",padding:"1px 4px",borderRadius:4}}>v{file.version_number}</span>}
      </div>
      <span style={{color:"#555"}}>{fmt(file.original_size)}</span>
      <span style={{color:"#555"}}>{fmt(file.stored_size)}</span>
      <span style={{color:"#10B981"}}>{file.original_size>0?Math.round(((file.original_size-file.stored_size)/file.original_size)*100):0}%</span>
      <span style={{color:"#333"}}>{relTime(file.upload_time)}</span>
      <div style={{display:"flex",gap:8,alignItems:"center"}} onClick={e=>e.stopPropagation()}>
        <button onClick={()=>onP2PDownload(file)} title="Request Stream Chunk Assembler" style={{background:"none",border:"none",color:"#3B82F6",cursor:"pointer"}}>⬇</button>
        <button onClick={()=>onShare(file)} title="Routing Options" style={{background:"none",border:"none",color:"#10B981",cursor:"pointer"}}>🔗</button>
        <button onClick={()=>onStar(file.hash)} title="Toggle Priority Flag" style={{background:"none",border:"none",color:file.starred?"#FCD34D":"#222",cursor:"pointer"}}>{file.starred?"★":"☆"}</button>
        <button onClick={()=>onTrash(file.hash)} title="De-allocate to Trash" style={{background:"none",border:"none",color:"#444",cursor:"pointer"}}>🗑</button>
      </div>
    </div>
  );
}

function FolderRow({ folder, onOpen, onDelete, onFileDropped }) {
  const [hover,setHover] = useState(false); const [dragOver,setDragOver] = useState(false);
  return (
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      onDragOver={e=>{ e.preventDefault(); setDragOver(true); }}
      onDragLeave={()=>setDragOver(false)}
      onDrop={e=>{ e.preventDefault(); setDragOver(false); const fh=e.dataTransfer.getData("text/plain"); if(fh) onFileDropped(fh, folder.id); }}
      onClick={()=>onOpen(folder.id)}
      style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",background:dragOver?"rgba(239,68,68,0.08)":hover?"rgba(255,255,255,0.02)":"transparent",borderBottom:"1px solid #141414",fontSize:13,fontFamily:"monospace",cursor:"pointer"}}>
      <span/>
      <span style={{color:"#F59E0B"}}>📁 {folder.name}</span>
      <span/><span/><span/><span style={{color:"#333"}}>{relTime(folder.created_at)}</span>
      <button onClick={(e)=>{e.stopPropagation();onDelete(folder.id);}} style={{background:"none",border:"none",color:"#333",cursor:"pointer"}}>🗑</button>
    </div>
  );
}

// ── Primary View Assembly Component ───────────────────────────────

export default function App() {
  const [session,setSession] = useState(null); const [authReady,setAuthReady] = useState(false); const [files,setFiles] = useState([]); const [folders,setFolders] = useState([]); const [trashFiles,setTrashFiles] = useState([]); const [stats,setStats] = useState(null);
  const [uploading,setUploading] = useState(false); const [uploadProgress,setUploadProgress] = useState(null); const [uploadFilename,setUploadFilename] = useState(""); const [result,setResult] = useState(null); const [error,setError] = useState(null); const [p2pTarget,setP2pTarget] = useState(null); const [shareTarget,setShareTarget] = useState(null); const [activeView,setActiveView] = useState("active"); const [currentFolderId,setCurrentFolderId] = useState(null); const [searchQuery,setSearchQuery] = useState(""); const [showNewFolder,setShowNewFolder] = useState(false);
  const [selectedFileHashes, setSelectedFileHashes] = useState([]); const inputRef = useRef();

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{ setSession(session); setAuthReady(true); });
    supabase.auth.onAuthStateChange((_,s)=>setSession(s));
  },[]);

  const token = session?.access_token; const ap = useMemo(()=> token ? apiFetch(token) : null, [token]);
  useP2P(token, { onFileAvailable: ()=>refresh() });

  const refresh = useCallback(async ()=>{
    if (!ap) return;
    try {
      const isSearchActive = searchQuery.trim().length > 0;
      const [fRes,tRes,sRes,folRes] = await Promise.all([
        ap(`/files?view=${activeView}${currentFolderId?`&folder_id=${currentFolderId}`:""}${isSearchActive ? "&search=true" : ""}`),
        ap(`/files?view=trash`), ap(`/stats`),
        activeView==="active" ? ap(`/folders${currentFolderId?`?parent_id=${currentFolderId}`:""}`) : Promise.resolve({json:()=>[]}),
      ]);
      const [f,t,s,fol] = await Promise.all([fRes.json(),tRes.json(),sRes.json(),folRes.json()]);
      setFiles(Array.isArray(f)?f:[]); setTrashFiles(Array.isArray(t)?t:[]); setStats(s); setFolders(Array.isArray(fol)?fol:[]);
    } catch(e) { setError(e.message); }
  },[ap, activeView, currentFolderId, searchQuery]);

  useEffect(()=>{ if(token) refresh(); },[token, activeView, currentFolderId, searchQuery]);

  const uploadFile = async (file) => {
    setUploading(true); setUploadFilename(file.name); setUploadProgress({ pct: 50 });
    try {
      const fd = new FormData(); fd.append("file", file); if (currentFolderId) fd.append("folder_id", currentFolderId);
      const res = await fetch(`${API}/upload`, { method: "POST", body: fd, headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json(); setResult(data); refresh();
    } catch(e) { setError(e.message); }
    finally { setUploading(false); setUploadProgress(null); }
  };

  const handleFileMove = async (fileHash, targetFolderId) => {
    await ap(`/files/${fileHash}/move`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder_id: targetFolderId }) });
    refresh();
  };

  if (!authReady) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#0a0a0a",color:"#EF4444",fontFamily:"monospace"}}>boot_kernel_init_sequence...</div>;
  if (!session) return <AuthPage onAuth={setSession}/>;

  return (
    <div style={{display:"flex",flexDirection:"column",width:"100%",height:"100vh",background:"#0f0f0f",color:"#fff",overflow:"hidden"}}>
      <TopBar onUpload={()=>inputRef.current?.click()} onNewFolder={()=>setShowNewFolder(true)} uploading={uploading} searchQuery={searchQuery} setSearchQuery={setSearchQuery}/>
      <input ref={inputRef} type="file" style={{display:"none"}} onChange={e=>{ if(e.target.files[0]) uploadFile(e.target.files[0]); }}/>
      
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        <Sidebar stats={stats} activeView={activeView} setActiveView={(v)=>{ setActiveView(v); setSearchQuery(""); setCurrentFolderId(null); setSelectedFileHashes([]); }} user={session.user} onSignOut={async()=>await supabase.auth.signOut()} trashCount={trashFiles.length} folders={folders} currentFolderId={currentFolderId} onFolderClick={setCurrentFolderId} token={token} refreshStats={refresh}/>
        
        <main style={{flex:1,overflowY:"auto",padding:"1.25rem 1.5rem"}}>
          {selectedFileHashes.length > 0 && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(239,68,68,0.05)",border:"1px solid rgba(239,68,68,0.3)",padding:12,borderRadius:8,marginBottom:12,fontFamily:"monospace"}}>
              <span style={{fontSize:11,color:"#EF4444"}}>STAGED_MUTATION_QUEUE // {selectedFileHashes.length} OBJECTS</span>
              <div>
                <button onClick={()=>setSelectedFileHashes([])} style={{background:"none",border:"1px solid #333",color:"#fff",padding:"4px 8px",borderRadius:4,marginRight:6,cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>Clear</button>
                <button onClick={async()=>{ await Promise.all(selectedFileHashes.map(h => ap(`/trash/${h}`, { method: "PATCH" }))); setSelectedFileHashes([]); refresh(); }} style={{background:"#EF4444",color:"#fff",border:"none",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>Trash Batch</button>
              </div>
            </div>
          )}

          <div style={{background:"rgba(255,255,255,0.01)",border:"1px solid #141414",borderRadius:12,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",padding:"8px 16px",background:"#111",fontSize:11,color:"#444",fontFamily:"monospace",textTransform:"uppercase"}}>
              <span/><span>Identity Cluster</span><span>Raw Size</span><span>Mesh Footprint</span><span>Ratio</span><span>Committed</span><span/>
            </div>
            {folders.map(f=><FolderRow key={f.id} folder={f} onOpen={setCurrentFolderId} onDelete={()=>ap(`/folders/${f.id}`,{method:"DELETE"}).then(()=>refresh())} onFileDropped={handleFileMove}/>)}
            {files.filter(f=>f.filename.toLowerCase().includes(searchQuery.toLowerCase())).map(f=><FileRow key={f.hash} file={f} view={activeView} onStar={async(h)=>{ await ap(`/star/${h}`,{method:"PATCH"}); refresh(); }} onTrash={async(h)=>{ await ap(`/trash/${h}`,{method:"PATCH"}); refresh(); }} onP2PDownload={setP2pTarget} onShare={setShareTarget} isSelected={selectedFileHashes.includes(f.hash)} onToggleSelect={(h)=>setSelectedFileHashes(p=>p.includes(h)?p.filter(x=>x!==h):[...p,h])}/>)}
          </div>
          <ActivityLogPanel token={token} />
        </main>
      </div>

      {uploading && uploadProgress && <UploadProgressModal filename={uploadFilename} progress={uploadProgress}/>}
      {result && <UploadResult result={result} onClose={()=>setResult(null)}/>}
      {showNewFolder && <NewFolderModal token={token} parentId={currentFolderId} onCreated={()=>refresh()} onClose={()=>setShowNewFolder(false)}/>}
      {shareTarget && <ShareModal file={shareTarget} token={token} onClose={()=>setShareTarget(null)}/>}
      {p2pTarget && <P2PDownloader file={p2pTarget} token={token} onClose={()=>setP2pTarget(null)}/>}
    </div>
  );
}
