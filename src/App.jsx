import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = "https://hoqzrxxqczxwwnqimvxm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhvcXpyeHhxY3p4d3ducWltdnhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcyNzAzMzgsImV4cCI6MjA4Mjg0NjMzOH0.KWrM31jwQu98qevgPKbSzEIrsulKpjxiBQ1X4QlkHFc";
const supabase  = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const API                = import.meta.env.VITE_API_URL || "http://localhost:5000";
const WS_URL             = import.meta.env.VITE_WS_URL  || "ws://localhost:5000/ws";
const RESUMABLE_THRESHOLD = 10 * 1024 * 1024;
const CHUNK_SIZE          = 256 * 1024;

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
const catIcon  = (c) => ({image:"🖼️",video:"🎬",audio:"🎵",document:"📄",archive:"📦",code:"💻",other:"📎"})[c]||"📎";
const catColor = (c) => ({image:"#F59E0B",video:"#EF4444",audio:"#8B5CF6",document:"#3B82F6",archive:"#F97316",code:"#10B981",other:"#6B7280"})[c]||"#6B7280";

const apiFetch = (token) => (path, opts={}) =>
  fetch(`${API}${path}`, { ...opts, headers:{ Authorization:`Bearer ${token}`, ...opts.headers }});

// ── Modals, Auth, Progress Readouts ───────────────────────────────

function UploadProgressModal({ filename, progress }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}}>
      <div style={{background:"#161616",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:440}}>
        <h2 style={{margin:"0 0 4px",fontSize:15,color:"#fff"}}>⬆ Streaming to Mesh Nodes</h2>
        <p style={{fontSize:12,color:"rgba(255,255,255,0.4)"}}>{filename}</p>
        <div style={{height:6,background:"rgba(255,255,255,0.07)",borderRadius:3,overflow:"hidden",marginTop:10}}>
          <div style={{height:"100%",background:"#3B82F6",width:`${progress?.pct || 0}%`,transition:"width 0.2s ease"}}/>
        </div>
      </div>
    </div>
  );
}

function AuthPage({ onAuth }) {
  const [email,setEmail] = useState(""); const [password,setPassword] = useState("");
  const submit = async () => {
    const {data,error} = await supabase.auth.signInWithPassword({email,password});
    if(!error) onAuth(data.session);
  };
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#0a0a0a"}}>
      <div style={{width:350,padding:"2rem",background:"#161616",borderRadius:16,border:"1px solid #222"}}>
        <h3 style={{color:"#fff",margin:0}}>⬡ Nexus System Auth</h3>
        <input type="email" placeholder="Identity string" value={email} onChange={e=>setEmail(e.target.value)} style={{width:"100%",padding:10,marginTop:15,background:"#222",border:"none",color:"#fff",borderRadius:8}}/>
        <input type="password" placeholder="Pass key" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={{width:"100%",padding:10,marginTop:10,background:"#222",border:"none",color:"#fff",borderRadius:8}}/>
        <button onClick={submit} style={{width:"100%",padding:10,marginTop:15,background:"#3B82F6",color:"#fff",border:"none",borderRadius:8,cursor:"pointer"}}>Open Access Channel</button>
      </div>
    </div>
  );
}

function useP2P(token, { onFileAvailable }) {
  const wsRef = useRef(null);
  useEffect(() => {
    if (!token) return;
    const ws = new WebSocket(`${WS_URL}?token=${token}`); wsRef.current = ws;
    ws.onmessage = (e) => {
      let msg = JSON.parse(e.data); if (msg.type==="file_available") onFileAvailable?.();
    };
    return () => ws.close();
  }, [token]); // eslint-disable-line
  return { ws:wsRef, myPeerId:"NEXUS-NODE", myColor:"#3B82F6", peerCount:1, wsStatus:"connected", sendMsg:()=>{} };
}

function P2PDownloader({ file, token, onClose }) {
  useEffect(() => {
    fetch(`${API}/download/${file.hash}`,{headers:{Authorization:`Bearer ${token}`}})
      .then(r=>r.blob()).then(blob=>{
        const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=file.filename; a.click(); onClose();
      });
  }, []); // eslint-disable-line
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,color:"#fff"}}>Assembling zero-knowledge binary chunks...</div>;
}

function UploadResult({ result, onClose }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div style={{background:"#161616",padding:"1.5rem",borderRadius:12,width:400,border:"1px solid #333"}}>
        <h4 style={{margin:0,color:"#10B981"}}>Pipeline Execution Complete</h4>
        <p style={{fontSize:13,color:"#aaa"}}>Allocated identity reference tag: <strong>v{result.version_number || 1}</strong></p>
        <button onClick={onClose} style={{width:"100%",padding:8,background:"#222",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",marginTop:10}}>Dismiss</button>
      </div>
    </div>
  );
}

// ── Sprint 2 Shared Assets Engine: Restored Email Sharing ─────────────────────

function ShareModal({ file, token, onClose }) {
  const [email, setEmail] = useState("");
  const [shares, setShares] = useState([]);
  const [publicLink, setPublicLink] = useState(null);
  const [copied, setCopied] = useState(false);
  const [success, setSuccess] = useState("");
  const ap = useMemo(() => apiFetch(token), [token]);

  const loadShares = () => {
    ap(`/share/${file.hash}`).then(r=>r.json()).then(d=>{ if(Array.isArray(d)) setShares(d); });
    ap(`/share/${file.hash}/public`).then(r=>r.json()).then(d=>{ if(d.exists) setPublicLink(d.public_url); });
  };

  useEffect(() => { loadShares(); }, [file.hash]); // eslint-disable-line

  const executeShare = async () => {
    if(!email.trim()) return;
    const res = await ap(`/share/${file.hash}`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({email:email.trim().toLowerCase()})});
    if(res.ok) { setSuccess(`Granted channel access to ${email}`); setEmail(""); loadShares(); }
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:250}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#161616",borderRadius:16,padding:"1.5rem",width:480,border:"1px solid #222"}}>
        <h3 style={{margin:0,color:"#fff"}}>🔗 Asset Allocation Distribution Router</h3>
        <p style={{fontSize:12,color:"#666",margin:"4px 0 15px"}}>{file.filename}</p>
        
        <div style={{background:"rgba(255,255,255,0.02)",padding:12,borderRadius:10,marginBottom:15}}>
          <p style={{margin:"0 0 6px",fontSize:11,color:"#666",textTransform:"uppercase"}}>Secure Private Key Email Share</p>
          <div style={{display:"flex",gap:6}}>
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Destination context mail handle..." style={{flex:1,padding:8,background:"#222",border:"none",color:"#fff",borderRadius:6,fontSize:13}}/>
            <button onClick={executeShare} style={{background:"#3B82F6",color:"#fff",border:"none",borderRadius:6,padding:"0 12px",cursor:"pointer"}}>Grant</button>
          </div>
          {success && <p style={{color:"#10B981",fontSize:11,margin:"6px 0 0"}}>{success}</p>}
        </div>

        {publicLink ? (
          <div style={{display:"flex",gap:8}}>
            <input readOnly value={publicLink} style={{flex:1,padding:8,background:"#222",border:"none",color:"#fff",borderRadius:6,fontSize:12}}/>
            <button onClick={()=>{navigator.clipboard.writeText(publicLink);setCopied(true);}} style={{background:"#222",color:"#fff",border:"1px solid #444",padding:"0 12px",borderRadius:6}}>{copied?"✓":"Copy"}</button>
          </div>
        ) : <button onClick={async()=>{ const r=await ap(`/share/${file.hash}/public`,{method:"POST"}); const d=await r.json(); setPublicLink(d.public_url); }} style={{width:"100%",padding:10,background:"#222",border:"1px solid #333",color:"#fff",borderRadius:8}}>Provision Anonymous Public S3 Download URL</button>}

        {shares.length > 0 && (
          <div style={{marginTop:15}}>
            <p style={{fontSize:11,color:"#555",textTransform:"uppercase",margin:"0 0 6px"}}>Active Identity Targets</p>
            {shares.map(s=><div key={s.shared_with} style={{fontSize:12,color:#aaa,padding:"4px 0"}}>• {s.shared_with} <span style={{fontSize:10,color:"#444"}}>({relTime(s.created_at)})</span></div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function NewFolderModal({ token, parentId, onCreated, onClose }) {
  const [name,setName] = useState("");
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#161616",padding:"1.5rem",borderRadius:12,border:"1px solid #222"}}>
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="Descriptor name..." style={{padding:8,background:"#222",color:"#fff",border:"none",borderRadius:6}}/>
        <button onClick={async()=>{await apiFetch(token)("/folders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,parent_id:parentId})});onCreated();onClose();}} style={{marginLeft:8,padding:"8px 12px",background:"#3B82F6",color:"#fff",border:"none",borderRadius:6,cursor:"pointer"}}>Build Link</button>
      </div>
    </div>
  );
}

// ── Sprint 2 Activity Feed View Layout ────────────────────────────────────────

function ActivityLogPanel({ token }) {
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    apiFetch(token)("/activity-logs").then(r=>r.json()).then(d => { if(Array.isArray(d)) setLogs(d); });
  }, [token]);

  return (
    <div style={{ background:"rgba(255,255,255,0.01)", border:"1px solid #1a1a1a", padding:12, borderRadius:12, marginTop:15 }}>
      <p style={{ margin:"0 0 10px", fontSize:11, color:"#444", textTransform:"uppercase", letterSpacing:"0.05em" }}>System Transaction Activity Log Audit</p>
      <div style={{ maxHeight: 150, overflowY: "auto", display:"flex", flexDirection:"column", gap:6 }}>
        {logs.length === 0 ? <p style={{ fontSize:12, color:"#333" }}>No historical mutations logged.</p> : logs.map(l => (
          <div key={l.id} style={{ display:"flex", justifyContent:"space-between", fontSize:12, fontFamily:"monospace", borderBottom:"1px solid #111", paddingBottom:4 }}>
            <span style={{ color: l.action_type === "UPLOAD" ? "#10B981" : l.action_type === "DELETE" ? "#EF4444" : "#60A5FA" }}>[{l.action_type}] {l.metadata?.filename}</span>
            <span style={{ color:"#444" }}>{relTime(l.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── File and Folder rows (Restored Context Action Controls) ──────────────────

function FileRow({ file, view, onStar, onTrash, onDelete, onP2PDownload, onShare, isSelected, onToggleSelect }) {
  const [hover,setHover] = useState(false);
  return (
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      draggable={view === "active"}
      onDragStart={(e)=>{ e.dataTransfer.setData("text/plain", file.hash); e.dataTransfer.effectAllowed = "move"; }}
      style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",background:isSelected ? "rgba(59,130,246,0.08)" : hover?"rgba(255,255,255,0.04)":"transparent",borderBottom:"0.5px solid #111",fontSize:13,cursor:view Freemium-Tier==="active"?"grab":"default"}}>
      <input type="checkbox" checked={isSelected} onChange={()=>onToggleSelect(file.hash)} onClick={e=>e.stopPropagation()}/>
      
      <div style={{ display:"flex", alignItems:"center", gap:8, minWidth:0 }}>
        <span>{catIcon(file.category)}</span>
        <span style={{color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:500}}>{file.filename}</span>
        {file.version_number > 1 && <span style={{ fontSize:10, background:"rgba(139,92,246,0.15)", color:"#A78BFA", padding:"1px 4px", borderRadius:4 }}>v{file.version_number}</span>}
      </div>

      <span style={{color:"#666"}}>{fmt(file.original_size)}</span>
      <span style={{color:"#666"}}>{fmt(file.stored_size)}</span>
      <span style={{color:"#10B981",fontWeight:500}}>{file.original_size>0?Math.round(((file.original_size-file.stored_size)/file.original_size)*100):0}%</span>
      <span style={{color:"#444"}}>{relTime(file.upload_time)}</span>
      
      {/* Restored inline execution triggers */}
      <div style={{display:"flex",gap:4,alignItems:"center"}} onClick={e=>e.stopPropagation()}>
        <button onClick={()=>onP2PDownload(file)} title="Download" style={{background:"none",border:"none",color:"#60A5FA",cursor:"pointer",fontSize:14}}>⬇</button>
        <button onClick={()=>onShare(file)} title="Share Options" style={{background:"none",border:"none",color:"#34D399",cursor:"pointer",fontSize:14}}>🔗</button>
        <button onClick={()=>onStar(file.hash, file.starred)} title="Star" style={{background:"none",border:"none",color:file.starred?"#FCD34D":"#333",cursor:"pointer",fontSize:14}}>{file.starred?"★":"☆"}</button>
        <button onClick={()=>onTrash(file.hash)} title="Trash" style={{background:"none",border:"none",color:"#444",cursor:"pointer",fontSize:14}}>🗑</button>
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
      style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",background:dragOver?"rgba(59,130,246,0.15)":hover?"rgba(255,255,255,0.04)":"transparent",borderBottom:"0.5px solid #111",fontSize:13}}>
      <span/>
      <span style={{color:"#F59E0B",fontWeight:500}}>📁 {folder.name}</span>
      <span/><span/><span/><span style={{color:"#444"}}>{relTime(folder.created_at)}</span>
      <button onClick={(e)=>{e.stopPropagation();onDelete(folder.id);}} style={{background:"none",border:"none",color:"#444",cursor:"pointer"}}>🗑</button>
    </div>
  );
}

function TopBar({ onUpload, onNewFolder, uploading, searchQuery, setSearchQuery }) {
  return (
    <header style={{height:58,display:"flex",alignItems:"center",gap:12,padding:"0 1.25rem",borderBottom:"0.5px solid rgba(255,255,255,0.07)",background:"#0f0f0f",width:"100%",boxSizing:"border-box"}}>
      <span style={{fontSize:17,fontWeight:700,color:"#fff",fontFamily:"monospace",letterSpacing:"1px"}}>⬡ VIRUS_LABS // NEXUS</span>
      <div style={{flex:1,maxWidth:420,position:"relative",marginLeft:15}}>
        <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="🔍 Query global system asset catalog indexes..." style={{width:"100%",padding:"8px 12px",background:"#141414",border:"1px solid #222",borderRadius:8,color:"#fff",fontSize:12,fontFamily:"monospace",outline:"none"}}/>
      </div>
      <div style={{marginLeft:"auto",display:"flex",gap:10}}>
        <button onClick={onNewFolder} style={{background:"#161616",color:"#fff",border:"1px solid #333",padding:"6px 12px",borderRadius:8,cursor:"pointer",fontSize:12}}>+ Directory</button>
        <button onClick={onUpload} style={{background:"#EF4444",color:"#fff",border:"none",padding:"6px 16px",borderRadius:8,fontWeight:600,cursor:"pointer",fontSize:12}}>{uploading?"Sharding...":"⬆ Upload"}</button>
      </div>
    </header>
  );
}

// ── Main App Controller ───────────────────────────────────────────

export default function App() {
  const [session,setSession] = useState(null); const [authReady,setAuthReady] = useState(false); const [files,setFiles] = useState([]); const [folders,setFolders] = useState([]); const [trashFiles,setTrashFiles] = useState([]); const [stats,setStats] = useState(null);
  const [uploading,setUploading] = useState(false); const [uploadProgress,setUploadProgress] = useState(null); const [uploadFilename,setUploadFilename] = useState(""); const [result,setResult] = useState(null); const [dupError,setDupError] = useState(null); const [error,setError] = useState(null); const [p2pTarget,setP2pTarget] = useState(null); const [shareTarget,setShareTarget] = useState(null); const [activeView,setActiveView] = useState("active"); const [currentFolderId,setCurrentFolderId] = useState(null); const [breadcrumb,setBreadcrumb] = useState([{id:null,name:"My Files"}]); const [searchQuery,setSearchQuery] = useState(""); const [showNewFolder,setShowNewFolder] = useState(false);
  const [selectedFileHashes, setSelectedFileHashes] = useState([]);
  const inputRef = useRef();

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{ setSession(session); setAuthReady(true); });
    supabase.auth.onAuthStateChange((_,s)=>setSession(s));
  },[]);

  const token = session?.access_token; const ap = useMemo(()=> token ? apiFetch(token) : null, [token]);
  const { wsStatus } = useP2P(token, { onFileAvailable: ()=>refresh() });

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
      const data = await res.json();
      setResult(data); refresh();
    } catch(e) { setError(e.message); }
    finally { setUploading(false); setUploadProgress(null); }
  };

  const handleFileMove = async (fileHash, targetFolderId) => {
    await ap(`/files/${fileHash}/move`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder_id: targetFolderId }) });
    refresh();
  };

  const handleToggleStar = async (hash, currentStatus) => {
    await ap(`/star/${hash}`, { method: "PATCH" }); refresh();
  };

  const handleMoveToTrash = async (hash) => {
    await ap(`/trash/${hash}`, { method: "PATCH" }); refresh();
  };

  const handleToggleSelect = (hash) => {
    setSelectedFileHashes(p => p.includes(hash) ? p.filter(h => h !== hash) : [...p, hash]);
  };

  const handleBulkTrash = async () => {
    if (!window.confirm(`Trash selected ${selectedFileHashes.length} items?`)) return;
    await Promise.all(selectedFileHashes.map(h => ap(`/trash/${h}`, { method: "PATCH" })));
    setSelectedFileHashes([]); refresh();
  };

  const visibleFiles = files.filter(f => f.filename.toLowerCase().includes(searchQuery.toLowerCase()));

  if (!authReady) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#0a0a0a",color:"#444",fontFamily:"monospace"}}>Booting System Kernel...</div>;
  if (!session) return <AuthPage onAuth={setSession}/>;

  return (
    <div style={{display:"flex",flexDirection:"column",width:"100%",height:"100vh",background:"#0f0f0f",color:"#fff",overflow:"hidden"}}>
      <TopBar onUpload={()=>inputRef.current?.click()} onNewFolder={()=>setShowNewFolder(true)} uploading={uploading} searchQuery={searchQuery} setSearchQuery={setSearchQuery}/>
      <input ref={inputRef} type="file" style={{display:"none"}} onChange={e=>{ if(e.target.files[0]) uploadFile(e.target.files[0]); }}/>
      
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        <Sidebar stats={stats} activeView={activeView} setActiveView={(v)=>{ setActiveView(v); setSearchQuery(""); setCurrentFolderId(null); setSelectedFileHashes([]); }} user={session.user} onSignOut={async()=>await supabase.auth.signOut()} trashCount={trashFiles.length} folders={folders} currentFolderId={currentFolderId} onFolderClick={setCurrentFolderId} token={token} refreshStats={refresh}/>
        
        <main style={{flex:1,overflowY:"auto",padding:"1.25rem 1.5rem"}}>
          {selectedFileHashes.length > 0 && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(239,68,68,0.05)",border:"1px solid rgba(239,68,68,0.3)",padding:12,borderRadius:8,marginBottom:12}}>
              <span style={{fontSize:12,color:"#FCA5A5",fontFamily:"monospace"}}>STAGED_MUTATION_QUEUE // {selectedFileHashes.length} OBJECTS</span>
              <div>
                <button onClick={()=>setSelectedFileHashes([])} style={{background:"none",border:"1px solid #444",color:"#fff",padding:"4px 8px",borderRadius:4,marginRight:6,cursor:"pointer",fontSize:11}}>Cancel</button>
                <button onClick={handleBulkTrash} style={{background:"#EF4444",color:"#fff",border:"none",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:11,fontWeight:600}}>Execute Trash</button>
              </div>
            </div>
          )}

          <div style={{background:"rgba(255,255,255,0.01)",border:"1px solid #141414",borderRadius:12,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",padding:"8px 16px",background:"#111",fontSize:11,color:"#444",fontFamily:"monospace",textTransform:"uppercase"}}>
              <span/><span>Identity Cluster</span><span>Raw Size</span><span>Mesh Footprint</span><span>Ratio</span><span>Committed</span><span/>
            </div>
            {folders.map(f=><FolderRow key={f.id} folder={f} onOpen={setCurrentFolderId} onDelete={()=>ap(`/folders/${f.id}`,{method:"DELETE"}).then(()=>refresh())} onFileDropped={handleFileMove}/>)}
            {visibleFiles.map(f=><FileRow key={f.hash} file={f} view={activeView} onStar={handleToggleStar} onTrash={handleMoveToTrash} onP2PDownload={setP2pTarget} onShare={setShareTarget} isSelected={selectedFileHashes.includes(f.hash)} onToggleSelect={handleToggleSelect}/>)}
          </div>
          
          {/* Integrated Activity Audit Feed Panel */}
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
