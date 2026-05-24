import { useState, useEffect, useCallback, useRef } from "react";

const API = "http://localhost:5000";

const fmt = (bytes) => {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B","KB","MB","GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

const categoryIcon = (cat) => ({
  image:"🖼️", video:"🎬", audio:"🎵", document:"📄",
  archive:"📦", code:"💻", other:"📎"
})[cat] || "📎";

const categoryColor = (cat) => ({
  image:"#8B5CF6", video:"#EF4444", audio:"#F59E0B",
  document:"#3B82F6", archive:"#6B7280", code:"#10B981", other:"#6B7280"
})[cat] || "#6B7280";

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background:"var(--color-background-primary)",
      border:"0.5px solid var(--color-border-tertiary)",
      borderRadius:"var(--border-radius-lg)",
      padding:"1rem 1.25rem",
      borderTop: accent ? `3px solid ${accent}` : undefined,
    }}>
      <p style={{margin:0, fontSize:12, color:"var(--color-text-secondary)", letterSpacing:"0.05em", textTransform:"uppercase"}}>{label}</p>
      <p style={{margin:"0.4rem 0 0", fontSize:22, fontWeight:500, color:"var(--color-text-primary)"}}>{value}</p>
      {sub && <p style={{margin:"0.2rem 0 0", fontSize:12, color:"var(--color-text-secondary)"}}>{sub}</p>}
    </div>
  );
}

function ChunkVisual({ chunks, filename }) {
  if (!chunks || chunks.length === 0) return null;
  const peers = Math.min(chunks.length, 8);
  return (
    <div style={{marginTop:16}}>
      <p style={{margin:"0 0 8px", fontSize:12, color:"var(--color-text-secondary)", fontWeight:500}}>
        P2P chunk distribution — {chunks.length} chunk{chunks.length>1?"s":""} across {peers} peers
      </p>
      <div style={{display:"flex", gap:4, flexWrap:"wrap"}}>
        {chunks.map((c,i) => (
          <div key={c.id} title={`Chunk ${c.index} · ${fmt(c.size)} · ID: ${c.id}`} style={{
            width:28, height:28, borderRadius:6,
            background:`hsl(${(i*47)%360},60%,55%)`,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:10, color:"#fff", fontWeight:600, cursor:"default",
            opacity:0.85,
          }}>{i+1}</div>
        ))}
      </div>
      <p style={{margin:"6px 0 0", fontSize:11, color:"var(--color-text-secondary)"}}>
        Each block would be served by a different peer simultaneously, multiplying download speed.
      </p>
    </div>
  );
}

function UploadResult({ result, onClose }) {
  const saved = result.savings;
  const ratio = result.ratio;
  const pct   = Math.round((saved / result.original_size) * 100);
  const isDupe = result.status === "deduplicated";

  return (
    <div style={{
      position:"fixed", inset:0, background:"rgba(0,0,0,0.45)",
      display:"flex", alignItems:"center", justifyContent:"center", zIndex:100,
    }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{
        background:"var(--color-background-primary)",
        border:"0.5px solid var(--color-border-tertiary)",
        borderRadius:"var(--border-radius-lg)",
        padding:"1.5rem", width:480, maxWidth:"90vw",
      }}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16}}>
          <h2 style={{margin:0, fontSize:16, fontWeight:500}}>
            {isDupe ? "⚡ Deduplicated" : "✅ Uploaded"}
          </h2>
          <button onClick={onClose} style={{background:"none", border:"none", cursor:"pointer", fontSize:18, color:"var(--color-text-secondary)"}}>✕</button>
        </div>

        {isDupe && (
          <div style={{background:"var(--color-background-info)", borderRadius:8, padding:"10px 14px", marginBottom:16, fontSize:13, color:"var(--color-text-info)"}}>
            This file already exists in storage. No new data written — instant deduplication saved {fmt(saved)}.
          </div>
        )}

        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:16}}>
          <StatCard label="Original" value={fmt(result.original_size)} />
          <StatCard label="Stored" value={fmt(result.stored_size)} accent="#10B981" />
          <StatCard label="Saved" value={`${pct}%`} sub={fmt(saved)} accent="#8B5CF6" />
        </div>

        <div style={{background:"var(--color-background-secondary)", borderRadius:8, padding:"10px 14px", marginBottom:16}}>
          <div style={{display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:6}}>
            <span style={{color:"var(--color-text-secondary)"}}>Compression ratio</span>
            <span style={{fontWeight:500}}>{ratio}×</span>
          </div>
          <div style={{display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:6}}>
            <span style={{color:"var(--color-text-secondary)"}}>ML-chosen level</span>
            <span style={{fontWeight:500}}>zstd level {result.level}</span>
          </div>
          <div style={{display:"flex", justifyContent:"space-between", fontSize:13}}>
            <span style={{color:"var(--color-text-secondary)"}}>File category</span>
            <span style={{fontWeight:500}}>{categoryIcon(result.category)} {result.category}</span>
          </div>
        </div>

        <ChunkVisual chunks={result.chunks} filename={result.filename} />
      </div>
    </div>
  );
}

function FileRow({ file, onDelete, onDownload }) {
  const pct = Math.round(((file.original_size - file.stored_size) / file.original_size) * 100);
  return (
    <div style={{
      display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr auto",
      alignItems:"center", gap:12, padding:"12px 16px",
      borderBottom:"0.5px solid var(--color-border-tertiary)",
      fontSize:13,
    }}>
      <div style={{display:"flex", alignItems:"center", gap:8, minWidth:0}}>
        <span style={{fontSize:16}}>{categoryIcon(file.category)}</span>
        <span style={{overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"var(--color-text-primary)"}} title={file.filename}>
          {file.filename}
        </span>
      </div>
      <span style={{color:"var(--color-text-secondary)"}}>{fmt(file.original_size)}</span>
      <span style={{color:"var(--color-text-secondary)"}}>{fmt(file.stored_size)}</span>
      <div style={{display:"flex", alignItems:"center", gap:6}}>
        <div style={{flex:1, height:4, background:"var(--color-background-tertiary)", borderRadius:2}}>
          <div style={{width:`${pct}%`, height:"100%", background:"#10B981", borderRadius:2}} />
        </div>
        <span style={{color:"#10B981", fontWeight:500, minWidth:32}}>{pct}%</span>
      </div>
      <div style={{display:"flex", gap:6}}>
        <button onClick={()=>onDownload(file.hash, file.filename)} title="Download" style={{
          background:"none", border:"0.5px solid var(--color-border-secondary)",
          borderRadius:6, padding:"4px 8px", cursor:"pointer", fontSize:12, color:"var(--color-text-secondary)",
        }}>↓</button>
        <button onClick={()=>onDelete(file.hash)} title="Delete" style={{
          background:"none", border:"0.5px solid var(--color-border-secondary)",
          borderRadius:6, padding:"4px 8px", cursor:"pointer", fontSize:12, color:"var(--color-text-secondary)",
        }}>✕</button>
      </div>
    </div>
  );
}

export default function App() {
  const [files, setFiles]       = useState([]);
  const [stats, setStats]       = useState(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult]     = useState(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError]       = useState(null);
  const inputRef = useRef();

  const refresh = useCallback(async () => {
    try {
      const [fRes, sRes] = await Promise.all([
        fetch(`${API}/files`), fetch(`${API}/stats`)
      ]);
      setFiles(await fRes.json());
      setStats(await sRes.json());
    } catch { setError("Cannot reach backend — is the Python server running?"); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const uploadFile = async (file) => {
    setUploading(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/upload`, { method:"POST", body:fd });
      const data = await res.json();
      setResult(data);
      refresh();
    } catch { setError("Upload failed — is the Python server running?"); }
    finally { setUploading(false); }
  };

  const handleDrop = (e) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  };

  const handleDownload = async (id, name) => {
    const a = document.createElement("a");
    a.href = `${API}/download/${id}`;
    a.download = name;
    a.click();
  };

  const handleDelete = async (id) => {
    await fetch(`${API}/delete/${id}`, { method:"DELETE" });
    refresh();
  };

  const totalSaved = stats ? stats.total_original - stats.total_stored : 0;

  return (
    <div style={{maxWidth:760, margin:"0 auto", padding:"2rem 1rem", fontFamily:"var(--font-sans)"}}>
      <h2 style={{margin:"0 0 0.25rem", fontSize:22, fontWeight:500, color:"var(--color-text-primary)"}}>
        Nexus POC
      </h2>
      <p style={{margin:"0 0 1.5rem", fontSize:14, color:"var(--color-text-secondary)"}}>
        Compression · Deduplication · P2P chunking · ML optimizer
      </p>

      {error && (
        <div style={{background:"var(--color-background-danger)", border:"0.5px solid var(--color-border-danger)", borderRadius:8, padding:"10px 14px", marginBottom:16, fontSize:13, color:"var(--color-text-danger)"}}>
          {error}
        </div>
      )}

      <div
        onDrop={handleDrop}
        onDragOver={e=>{e.preventDefault();setDragging(true)}}
        onDragLeave={()=>setDragging(false)}
        onClick={()=>inputRef.current?.click()}
        style={{
          border:`1.5px dashed ${dragging?"#8B5CF6":"var(--color-border-secondary)"}`,
          borderRadius:"var(--border-radius-lg)",
          padding:"2rem",
          textAlign:"center",
          cursor:"pointer",
          marginBottom:"1.5rem",
          background: dragging ? "rgba(139,92,246,0.05)" : "var(--color-background-secondary)",
          transition:"all 0.15s",
        }}
      >
        <input ref={inputRef} type="file" style={{display:"none"}} onChange={e=>{ if(e.target.files[0]) uploadFile(e.target.files[0]); }} />
        {uploading
          ? <p style={{margin:0, color:"var(--color-text-secondary)", fontSize:14}}>⏳ Compressing and chunking…</p>
          : <>
              <p style={{margin:"0 0 6px", fontSize:15, fontWeight:500, color:"var(--color-text-primary)"}}>Drop a file here or click to upload</p>
              <p style={{margin:0, fontSize:13, color:"var(--color-text-secondary)"}}>Any file type — the ML optimizer picks the best compression level</p>
            </>
        }
      </div>

      {stats && (
        <div style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:"1.5rem"}}>
          <StatCard label="Files stored" value={stats.total_files} accent="#3B82F6" />
          <StatCard label="Total original" value={fmt(stats.total_original)} accent="#6B7280" />
          <StatCard label="Actually stored" value={fmt(stats.total_stored)} accent="#F59E0B" />
          <StatCard label="Space saved" value={fmt(totalSaved)} sub={stats.total_stored > 0 ? `${stats.overall_ratio}× ratio` : ""} accent="#10B981" />
        </div>
      )}

      {files.length > 0 && (
        <div style={{
          background:"var(--color-background-primary)",
          border:"0.5px solid var(--color-border-tertiary)",
          borderRadius:"var(--border-radius-lg)",
          overflow:"hidden",
        }}>
          <div style={{
            display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr auto",
            gap:12, padding:"10px 16px",
            borderBottom:"0.5px solid var(--color-border-tertiary)",
            fontSize:11, fontWeight:500, color:"var(--color-text-secondary)",
            textTransform:"uppercase", letterSpacing:"0.05em",
            background:"var(--color-background-secondary)",
          }}>
            <span>File</span>
            <span>Original</span>
            <span>Stored</span>
            <span>Saved</span>
            <span></span>
          </div>
          {files.map(f => (
            <FileRow key={f.hash} file={f} onDelete={handleDelete} onDownload={handleDownload} />
          ))}
        </div>
      )}

      {files.length === 0 && !uploading && (
        <div style={{textAlign:"center", padding:"3rem 0", color:"var(--color-text-secondary)", fontSize:14}}>
          No files yet — upload something to see compression and chunking in action
        </div>
      )}

      {result && <UploadResult result={result} onClose={()=>setResult(null)} />}
    </div>
  );
}
