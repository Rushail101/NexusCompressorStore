import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = "https://hoqzrxxqczxwwnqimvxm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhvcXpyeHhxY3p4d3ducWltdnhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcyNzAzMzgsImV4cCI6MjA4Mjg0NjMzOH0.KWrM31jwQu98qevgPKbSzEIrsulKpjxiBQ1X4QlkHFc";
const supabase  = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const API                = import.meta.env.VITE_API_URL || "http://localhost:5000";
const WS_URL             = import.meta.env.VITE_WS_URL  || "ws://localhost:5000/ws";
const RESUMABLE_THRESHOLD = 10 * 1024 * 1024;
const CHUNK_SIZE          = 256 * 1024;

// ── Shared UI Format Utilities ────────────────────────────────────

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
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}}>
      <div style={{background:"#161616",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"1.5rem",width:440,boxShadow:"0 24px 60px rgba(0,0,0,0.8)"}}>
        <h2 style={{margin:"0 0 4px",fontSize:14,fontWeight:600,color:"#fff",fontFamily:"monospace"}}>⬆ SYSTEM_INGEST_PIPELINE</h2>
        <p style={{fontSize:12,color:"rgba(255,255,255,0.4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"monospace"}}>{filename}</p>
        <div style={{height:6,background:"rgba(255,255,255,0.07)",borderRadius:3,overflow:"hidden",marginTop:14}}>
          <div style={{height:"100%",background:"linear-gradient(90deg,#3B82F6,#8B5CF6)",width:`${progress?.pct || 0}%`,transition:"width 0.2s ease"}}/>
        </div>
      </div>
    </div>
  );
}

function P2PDownloader({ file, token, onClose }) {
  useEffect(() => {
    fetch(`${API}/download/${file.hash}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => { if (!res.ok) throw new Error(); return res.blob(); })
      .then(blob => {
        const url = URL.createObjectURL(blob); const a = document.createElement("a");
        a.href = url; a.download = file.filename; a.click(); URL.revokeObjectURL(url); onClose();
      }).catch(() => onClose());
  }, [file.hash, token, file.filename, onClose]);
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,fontFamily:"monospace",color:"#3B82F6",fontSize:13}}>INGEST_STREAM: Pulling unsegmented mesh blocks...</div>;
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
      <div onClick={e=>e.stopPropagation()} style={{background:"#161616",padding:"1.5rem",borderRadius:16,border:"1px solid rgba(255,255,255,0.1)",width:380}}>
        <h3 style={{margin:"0 0 16px",fontSize:14,color:"#fff",fontFamily:"monospace"}}>📁 ALLOCATE_NEW_DIRECTORY</h3>
        <input autoFocus value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&executeCreate()} placeholder="Directory handle identifier..." style={{width:"100%",padding:11,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",color:"#fff",borderRadius:10,fontSize:13,outline:"none",boxSizing:"border-box",marginBottom:14}}/>
        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{flex:1,padding:9,borderRadius:8,background:"transparent",border:"1px solid rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.6)",cursor:"pointer"}}>Cancel</button>
          <button onClick={executeCreate} style={{flex:1,padding:9,borderRadius:8,background:"#3B82F6",border:"none",color:"#fff",cursor:"pointer",fontWeight:500}}>Build Matrix Link</button>
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
      <div style={{width:380,padding:"2.5rem",background:"#161616",borderRadius:20,border:"1px solid rgba(255,255,255,0.09)",boxShadow:"0 32px 80px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:24}}>
          <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#3B82F6,#8B5CF6)"}}/>
          <span style={{fontSize:20,fontWeight:700,color:"#fff",letterSpacing:"-0.5px"}}>Nexus Kernel</span>
        </div>
        <input type="email" placeholder="Identity mail handle" value={email} onChange={e=>setEmail(e.target.value)} style={{width:"100%",padding:12,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",color:"#fff",borderRadius:10,marginBottom:12,outline:"none"}}/>
        <input type="password" placeholder="Pass key" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={{width:"100%",padding:12,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",color:"#fff",borderRadius:10,marginBottom:18,outline:"none"}}/>
        <button onClick={submit} style={{width:"100%",padding:12,background:"#3B82F6",color:"#fff",border:"none",borderRadius:10,fontWeight:500,cursor:"pointer"}}>Open Secure Channel</button>
      </div>
    </div>
  );
}

// ── Shared Distribution Router Components ─────────────────────────

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
    if(res.ok) { setSuccess(`Channel access authorized for ${email}`); setEmail(""); loadData(); }
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:250}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#161616",borderRadius:16,padding:"1.5rem",width:480,border:"1px solid rgba(255,255,255,0.1)",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}}>
        <h3 style={{margin:0,fontSize:15,fontWeight:500,color:"#fff"}}>🔗 Share file</h3>
        <p style={{fontSize:12,color:"rgba(255,255,255,0.4)",margin:"4px 0 16px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{file.filename}</p>
        
        <div style={{background:"rgba(255,255,255,0.03)",padding:14,borderRadius:10,marginBottom:16,border:"0.5px solid rgba(255,255,255,0.07)"}}>
          <p style={{margin:"0 0 6px",fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase"}}>Public link</p>
          {publicLink ? (
            <div style={{display:"flex",gap:8}}>
              <input readOnly value={publicLink} style={{flex:1,padding:9,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",color:"rgba(255,255,255,0.6)",borderRadius:8,fontSize:11,outline:"none"}}/>
              <button onClick={()=>{navigator.clipboard.writeText(publicLink);setCopied(true);}} style={{background:"rgba(59,130,246,0.12)",border:"0.5px solid rgba(59,130,246,0.3)",color:"#60A5FA",padding:"0 14px",borderRadius:8,cursor:"pointer",fontSize:12}}>{copied?"✓":"Copy"}</button>
            </div>
          ) : <button onClick={async()=>{ const r=await ap(`/share/${file.hash}/public`,{method:"POST"}); const d=await r.json(); setPublicLink(d.public_url); }} style={{width:"100%",padding:9,background:"rgba(59,130,246,0.12)",border:"0.5px solid rgba(59,130,246,0.3)",color:"#60A5FA",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:500}}>Create public link</button>}
        </div>

        <div style={{background:"rgba(255,255,255,0.03)",padding:14,borderRadius:10,border:"0.5px solid rgba(255,255,255,0.07)"}}>
          <p style={{margin:"0 0 6px",fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase"}}>Share with user</p>
          <div style={{display:"flex",gap:8}}>
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Recipient email address..." style={{flex:1,padding:9,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",color:"#fff",borderRadius:8,fontSize:13,outline:"none"}}/>
            <button onClick={handleShare} style={{background:"#3B82F6",color:"#fff",border:"none",borderRadius:8,padding:"0 14px",cursor:"pointer",fontSize:12,fontWeight:500}}>Share</button>
          </div>
          {success && <p style={{color:"#10B981",fontSize:11,margin:"6px 0 0"}}>{success}</p>}
        </div>

        {shares.length > 0 && (
          <div style={{marginTop:16,maxHeight:120,overflowY:"auto"}}>
            <p style={{fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",margin:"0 0 6px"}}>Shared with</p>
            {shares.map(s=><div key={s.shared_with} style={{fontSize:12,color:"#fff",padding:"4px 0",display:"flex",justify_content:"space-between"}}><span>{s.shared_with}</span><span style={{color:"rgba(255,255,255,0.3)",fontSize:11}}>{relTime(s.created_at)}</span></div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityLogPanel({ token }) {
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    if(token) apiFetch(token)("/activity-logs").then(r=>r.json()).then(d => { if(Array.isArray(d)) setLogs(d); });
  }, [token]);
  return (
    <div style={{background:"rgba(255,255,255,0.02)",border:"0.5px solid rgba(255,255,255,0.07)",padding:14,borderRadius:14,marginTop:14}}>
      <p style={{margin:"0 0 10px",fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Activity Log</p>
      <div style={{maxHeight:120,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
        {logs.map(l => (
          <div key={l.id} style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"rgba(255,255,255,0.6)",borderBottom:"0.5px solid rgba(255,255,255,0.05)",paddingBottom:3}}>
            <span style={{color:l.action_type Freemium-Tier==="UPLOAD"?"#10B981":l.action_type==="DELETE"?"#EF4444":"#3B82F6"}}>[{l.action_type}] {l.metadata?.filename || l.metadata?.destination}</span>
            <span style={{color:"rgba(255,255,255,0.2)"}}>{relTime(l.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Marketplace Settings Dials ────────────────────────────────────

function MarketplaceSettings({ token, stats, refreshStats }) {
  const [plan, setPlan] = useState("Option_A_Eco"); const [allocatedGb, setAllocatedGb] = useState(20);
  useEffect(() => { if(stats) { setPlan(stats.current_plan||"Option_A_Eco"); setAllocatedGb(Math.round((stats.physical_bytes_allocated||0)/(1024**3))); }}, [stats]);
  const syncAllocation = async (p, gb) => {
    await fetch(`${API}/quota/allocate`, { method:"POST", headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"}, body:JSON.stringify({ plan:p, allocated_gb:parseInt(gb) })});
    refreshStats();
  };
  return (
    <div style={{background:"rgba(255,255,255,0.03)",border:"0.5px solid rgba(255,255,255,0.06)",borderRadius:12,padding:12,marginTop:10}}>
      <div style={{display:"flex",gap:6}}>
        <button onClick={()=>{setPlan("Option_A_Eco");syncAllocation("Option_A_Eco",0);}} style={{flex:1,padding:"6px 4px",fontSize:11,background:plan==="Option_A_Eco"?"rgba(16,185,129,0.15)":"transparent",color:plan==="Option_A_Eco"?"#34D399":"rgba(255,255,255,0.4)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:6,cursor:"pointer"}}>🌱 Eco Mode</button>
        <button onClick={()=>{setPlan("Option_B_Pro");syncAllocation("Option_B_Pro",allocatedGb);}} style={{flex:1,padding:"6px 4px",fontSize:11,background:plan==="Option_B_Pro"?"rgba(139,92,246,0.15)":"transparent",color:plan==="Option_B_Pro"?"#A78BFA":"rgba(255,255,255,0.4)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:6,cursor:"pointer"}}>⚒️ Pro Miner</button>
      </div>
      {plan==="Option_A_Eco" ? (
        <p style={{fontSize:11,color:"rgba(255,255,255,0.4)",margin:"8px 0 0",lineHeight:1.4}}>50/50 Data Arbitrage active. Saved file space expands account allowance lines.</p>
      ) : (
        <div style={{marginTop:8}}>
          <input type="range" min="10" max="500" value={allocatedGb} onChange={e=>setAllocatedGb(e.target.value)} onMouseUp={()=>syncAllocation("Option_B_Pro",allocatedGb)} style={{width:"100%",accentColor:"#8B5CF6"}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#A78BFA",marginTop:4}}><span>Host: {allocatedGb} GB</span><span>Yield: ${parseFloat(stats?.balance_usd||0).toFixed(4)}</span></div>
        </div>
      )}
    </div>
  );
}

// ── Sidebar Framework ─────────────────────────────────────────────

function Sidebar({ stats, activeView, setActiveView, user, onSignOut, trashCount, folders, token, refreshStats }) {
  const usedBytes   = stats?.total_stored||0; const quotaBytes = stats?.quota_bytes||(10*1024*1024*1024); const usedPct = Math.min(100,(usedBytes/quotaBytes)*100);
  const totalSaved  = stats ? (stats.total_original - stats.total_stored) : 0;
  return (
    <aside style={{width:215,flexShrink:0,padding:"1rem 0.75rem",borderRight:"0.5px solid rgba(255,255,255,0.07)",display:"flex",flexDirection:"column",gap:2,overflow:"hidden"}}>
      {[{id:"active",icon:"🗂️",label:"My Files"},{id:"trash",icon:"🗑️",label:"Trash",badge:trashCount}].map(item=>(
        <button key={item.id} onClick={()=>setActiveView(item.id)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 12px",borderRadius:10,border:"none",cursor:"pointer",fontSize:13,background:activeView===item.id?"rgba(255,255,255,0.08)":"transparent",color:activeView===item.id?"#fff":"rgba(255,255,255,0.55)"}}>
          <span style={{display:"flex",alignItems:"center",gap:10}}><span>{item.icon}</span>{item.label}</span>
          {item.badge>0&&<span style={{fontSize:10,background:"rgba(239,68,68,0.2)",color:"#FCA5A5",borderRadius:10,padding:"1px 7px"}}>{item.badge}</span>}
        </button>
      ))}
      
      <div style={{marginTop:"auto",padding:"12px",background:"rgba(255,255,255,0.03)",borderRadius:12,border:"0.5px solid rgba(255,255,255,0.06)"}}>
        <p style={{margin:"0 0 8px",fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase"}}>Storage</p>
        <div style={{height:4,background:"rgba(255,255,255,0.08)",borderRadius:2,marginBottom:8,overflow:"hidden"}}>
          <div style={{width:`${usedPct}%`,height:"100%",background:"linear-gradient(90deg,#3B82F6,#8B5CF6)",borderRadius:2}}/>
        </div>
        <p style={{margin:0,fontSize:12,color:"rgba(255,255,255,0.6)"}}>{fmt(usedBytes)} <span style={{color:"rgba(255,255,255,0.3)"}}>/ {fmt(quotaBytes)}</span></p>
        <p style={{margin:"4px 0 0",fontSize:11,color:"#10B981"}}>{fmt(totalSaved)} saved</p>
      </div>

      <MarketplaceSettings token={token} stats={stats} refreshStats={refreshStats} />
      
      <div style={{padding:"10px 12px",borderTop:"0.5px solid rgba(255,255,255,0.07)",marginTop:6,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
        <p style={{margin:0,fontSize:11,color:"rgba(255,255,255,0.5)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user?.email}</p>
        <button onClick={onSignOut} style={{background:"none",border:"0.5px solid rgba(255,255,255,0.12)",borderRadius:7,padding:"4px 8px",cursor:"pointer",fontSize:11,color:"rgba(255,255,255,0.4)"}}>↩</button>
      </div>
    </aside>
  );
}

function TopBar({ onUpload, onNewFolder, uploading, searchQuery, setSearchQuery }) {
  return (
    <header style={{height:58,display:"flex",alignItems:"center",gap:12,padding:"0 1.25rem",borderBottom:"0.5px solid rgba(255,255,255,0.07)",background:"#0f0f0f",width:"100%",boxSizing:"border-box"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginRight:8}}>
        <div style={{width:28,height:28,borderRadius:8,background:"linear-gradient(135deg,#3B82F6,#8B5CF6)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>⬡</div>
        <span style={{fontSize:17,fontWeight:600,color:"#fff",letterSpacing:"-0.3px"}}>Nexus</span>
      </div>
      <div style={{flex:1,maxWidth:480,position:"relative"}}>
        <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search files…" style={{width:"100%",padding:"8px 12px 8px 36px",background:"rgba(255,255,255,0.06)",border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:10,color:"#fff",fontSize:13,outline:"none",boxSizing:"border-box"}}/>
      </div>
      <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:10}}>
        <button onClick={onNewFolder} style={{background:"rgba(255,255,255,0.07)",border:"0.5px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"7px 14px",color:"rgba(255,255,255,0.7)",fontSize:13,cursor:"pointer"}}>📁 New folder</button>
        <button onClick={onUpload} style={{background:uploading?"rgba(59,130,246,0.3)":"#3B82F6",border:"none",borderRadius:10,padding:"8px 18px",color:"#fff",fontSize:13,fontWeight:500,cursor:"pointer"}}>{uploading?"⏳ Uploading…":"⬆ Upload"}</button>
      </div>
    </header>
  );
}

// ── Restored High-Contrast Grid Rows ──────────────────────────────

function FileRow({ file, view, onStar, onTrash, onP2PDownload, onShare, isSelected, onToggleSelect }) {
  const [hover,setHover] = useState(false);
  const p = file.original_size>0?Math.round(((file.original_size-file.stored_size)/file.original_size)*100):0;
  return (
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      draggable={view === "active"}
      onDragStart={(e)=>{ e.dataTransfer.setData("text/plain", file.hash); }}
      style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",background:isSelected?"rgba(59,130,246,0.05)":hover?"rgba(255,255,255,0.04)":"transparent",borderBottom:"0.5px solid rgba(255,255,255,0.05)",fontSize:13,transition:"background 0.1s",cursor:view==="active"?"grab":"default"}}>
      <input type="checkbox" checked={isSelected} onChange={()=>onToggleSelect(file.hash)} onClick={e=>e.stopPropagation()} style={{accentColor:"#3B82F6"}}/>
      <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
        <div style={{width:32,height:32,borderRadius:8,background:`${catColor(file.category)}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>{catIcon(file.category)}</div>
        <div style={{minWidth:0}}>
          <p style={{margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"#fff",fontWeight:500}}>{file.filename}</p>
          <div style={{display:"flex",gap:6,marginTop:2}}>
            {file.version_number > 1 && <span style={{fontSize:9,background:"rgba(139,92,246,0.15)",color:"#A78BFA",padding:"1px 4px",borderRadius:4}}>v{file.version_number}</span>}
            {file.starred && <span style={{fontSize:10,color:"#FCD34D"}}>★</span>}
          </div>
        </div>
      </div>
      <span style={{color:"rgba(255,255,255,0.45)"}}>{fmt(file.original_size)}</span>
      <span style={{color:"rgba(255,255,255,0.45)"}}>{fmt(file.stored_size)}</span>
      <span style={{color:"#10B981",fontWeight:500}}>{p}%</span>
      <span style={{color:"rgba(255,255,255,0.3)"}}>{relTime(file.upload_time)}</span>
      <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
        <button onClick={()=>onP2PDownload(file)} style={{background:"rgba(59,130,246,0.1)",border:"0.5px solid rgba(59,130,246,0.3)",borderRadius:7,padding:"5px 8px",cursor:"pointer",color:"#60A5FA"}}>⬇</button>
        <button onClick={()=>onShare(file)} style={{background:"rgba(16,185,129,0.1)",border:"0.5px solid rgba(16,185,129,0.3)",borderRadius:7,padding:"5px 8px",cursor:"pointer",color:"#34D399"}}>🔗</button>
        <button onClick={()=>onStar(file.hash)} style={{background:file.starred?"rgba(251,191,36,0.15)":"none",border:`0.5px solid ${file.starred?"rgba(251,191,36,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:7,padding:"5px 7px",cursor:"pointer",color:file.starred?"#FCD34D":"rgba(255,255,255,0.35)"}}>{file.starred?"★":"☆"}</button>
        <button onClick={()=>onTrash(file.hash)} style={{background:"none",border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:7,padding:"5px 7px",cursor:"pointer",color:"rgba(255,255,255,0.3)"}}>🗑</button>
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
      style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",alignItems:"center",gap:12,padding:"10px 16px",background:dragOver?"rgba(59,130,246,0.15)":hover?"rgba(255,255,255,0.04)":"transparent",borderBottom:"0.5px solid rgba(255,255,255,0.05)",fontSize:13,cursor:"pointer"}}>
      <span/>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{width:32,height:32,borderRadius:8,background:"rgba(251,191,36,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>📁</div>
        <span style={{color:"#fff",fontWeight:500}}>{folder.name}</span>
      </div>
      <span/><span/><span/><span style={{color:"rgba(255,255,255,0.3)"}}>{relTime(folder.created_at)}</span>
      <button onClick={(e)=>{e.stopPropagation();onDelete(folder.id);}} style={{background:"none",border:"0.5px solid rgba(255,255,255,0.1)",borderRadius:7,padding:"5px 7px",cursor:"pointer",color:"rgba(255,255,255,0.3)"}}>🗑</button>
    </div>
  );
}

// ── Main App Controller Thread ────────────────────────────────────

export default function App() {
  const [session,setSession] = useState(null); const [authReady,setAuthReady] = useState(false); const [files,setFiles] = useState([]); const [folders,setFolders] = useState([]); const [trashFiles,setTrashFiles] = useState([]); const [stats,setStats] = useState(null);
  const [uploading,setUploading] = useState(false); const [uploadProgress,setUploadProgress] = useState(null); const [uploadFilename,setUploadFilename] = useState(""); const [result,setResult] = useState(null); const [error,setError] = useState(null); const [p2pTarget,setP2pTarget] = useState(null); const [shareTarget,setShareTarget] = useState(null); const [activeView,setActiveView] = useState("active"); const [currentFolderId,setCurrentFolderId] = useState(null); const [searchQuery,setSearchQuery] = useState(""); const [showNewFolder,setShowNewFolder] = useState(false);
  const [selectedFileHashes, setSelectedFileHashes] = useState([]); const inputRef = useRef();

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{ setSession(session); setAuthReady(true); });
    supabase.auth.onAuthStateChange((_,s)=>setSession(s));
  },[]);

  const token = session?.access_token; const ap = useMemo(()=> token ? apiFetch(token) : null, [token]);

  const refresh = useCallback(async () => {
    if (!ap) return;
    try {
      const isSearchActive = searchQuery.trim().length > 0;
      const [fRes, tRes, sRes, folRes] = await Promise.all([
        ap(`/files?view=${activeView}${currentFolderId?`&folder_id=${currentFolderId}`:""}${isSearchActive ? "&search=true" : ""}`),
        ap(`/files?view=trash`), ap(`/stats`),
        activeView==="active" ? ap(`/folders${currentFolderId?`?parent_id=${currentFolderId}`:""}`) : Promise.resolve({json:()=>[]}),
      ]);
      const [f, t, s, fol] = await Promise.all([fRes.json(), tRes.json(), sRes.json(), folRes.json()]);
      setFiles(Array.isArray(f)?f:[]); setTrashFiles(Array.isArray(t)?t:[]); setStats(s); setFolders(Array.isArray(fol)?fol:[]);
    } catch(e) { setError(e.message); }
  }, [ap, activeView, currentFolderId, searchQuery]);

  useEffect(()=>{ if(token) refresh(); },[token, activeView, currentFolderId, searchQuery]);

  const uploadFile = async (file) => {
    setUploading(true); setUploadFilename(file.name); setUploadProgress({ pct: 50 });
    try {
      const fd = new FormData(); fd.append("file", file); if (currentFolderId) fd.append("folder_id", currentFolderId);
      const res = await fetch(`${API}/upload`, { method: "POST", body: fd, headers: { Authorization: `Bearer ${token}` } });
      setResult(await res.json()); refresh();
    } catch(e) { setError(e.message); }
    finally { setUploading(false); setUploadProgress(null); }
  };

  const handleFileMove = async (fileHash, targetFolderId) => {
    await ap(`/files/${fileHash}/move`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder_id: targetFolderId }) });
    refresh();
  };

  if (!authReady) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#0f0f0f",color:"rgba(255,255,255,0.3)",fontSize:13}}>Establishing context pipeline connection...</div>;
  if (!session) return <AuthPage onAuth={setSession}/>;

  return (
    <div style={{display:"flex",flexDirection:"column",width:"100%",height:"100vh",background:"#0f0f0f",color:"#fff",overflow:"hidden"}}>
      <TopBar onUpload={()=>inputRef.current?.click()} onNewFolder={()=>setShowNewFolder(true)} uploading={uploading} searchQuery={searchQuery} setSearchQuery={setSearchQuery}/>
      <input ref={inputRef} type="file" style={{display:"none"}} onChange={e=>{ if(e.target.files[0]) uploadFile(e.target.files[0]); }}/>
      
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        <Sidebar stats={stats} activeView={activeView} setActiveView={(v)=>{ setActiveView(v); setSearchQuery(""); setCurrentFolderId(null); setSelectedFileHashes([]); }} user={session.user} onSignOut={async()=>await supabase.auth.signOut()} trashCount={trashFiles.length} folders={folders} onFolderClick={setCurrentFolderId} token={token} refreshStats={refresh}/>
        
        <main style={{flex:1,overflowY:"auto",padding:"1.25rem 1.5rem"}}>
          {selectedFileHashes.length > 0 && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(239,68,68,0.04)",border:"0.5px solid rgba(239,68,68,0.2)",padding:12,borderRadius:10,marginBottom:12}}>
              <span style={{fontSize:12,color:"#FCA5A5",fontWeight:500}}>Staged Selection: {selectedFileHashes.length} items</span>
              <div>
                <button onClick={()=>setSelectedFileHashes([])} style={{background:"none",border:"0.5px solid rgba(255,255,255,0.15)",color:"rgba(255,255,255,0.6)",padding:"4px 10px",borderRadius:6,cursor:"pointer",marginRight:6}}>Clear</button>
                <button onClick={async()=>{ await Promise.all(selectedFileHashes.map(h => ap(`/trash/${h}`, { method: "PATCH" }))); setSelectedFileHashes([]); refresh(); }} style={{background:"#EF4444",color:"#fff",border:"none",padding:"5px 14px",borderRadius:6,cursor:"pointer",fontWeight:600}}>Trash Selected</button>
              </div>
            </div>
          )}

          <div style={{background:"rgba(255,255,255,0.02)",border:"0.5px solid rgba(255,255,255,0.07)",borderRadius:14,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"40px 2fr 1fr 1fr 70px 1fr auto",padding:"8px 16px",background:"rgba(255,255,255,0.02)",borderBottom:"0.5px solid rgba(255,255,255,0.07)",fontSize:11,color:"rgba(255,255,255,0.3)",textTransform:"uppercase",letterSpacing:"0.05em"}}>
              <span/><span>Name</span><span>Original</span><span>Stored</span><span>Saved</span><span>Modified</span><span/>
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
