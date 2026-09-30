import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import {
  Frame,
  PLATFORMS,
  dateKey,
  go,
  platformName,
  platformShort,
  statusTag,
  thaiDate,
  thaiTime,
  todayHeading,
} from "./format.jsx";

export function Screen({ page, id, notify }) {
  if (page === "dashboard") return <Dashboard notify={notify} />;
  if (page === "content") return <Content id={id} notify={notify} />;
  if (page === "generator") return <Generator notify={notify} />;
  if (page === "studio") return <Studio id={id} notify={notify} />;
  if (page === "calendar") return <Calendar notify={notify} />;
  if (page === "automation") return <Automation notify={notify} />;
  if (page === "accounts") return <Accounts notify={notify} />;
  if (page === "publishing") return <Publishing id={id} notify={notify} />;
  if (page === "analytics") return <Analytics notify={notify} />;
  if (page === "logs") return <Logs notify={notify} />;
  return <Settings id={id} notify={notify} />;
}

function useLoad(loader, notify, key = "") {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  const notifyRef = useRef(notify);
  loaderRef.current = loader;
  notifyRef.current = notify;
  useEffect(() => {
    let alive = true;
    loaderRef.current()
      .then((value) => { if (alive) setData(value); })
      .catch((error) => notifyRef.current(error));
    return () => { alive = false; };
  }, [tick, key]);
  return [data, () => setTick((value) => value + 1)];
}

function Dashboard({ notify }) {
  const [data, reload] = useLoad(() => api.summary(), notify);
  if (!data) return <p className="hint">กำลังโหลด…</p>;
  const preview = data.today_preview;
  return (
    <>
      <div className="row">
        <h1 className="page-title">วันนี้ · {todayHeading()}</h1>
        <span className="grow" />
        <button className="btn btn-secondary" onClick={() => go("calendar")}>ดูปฏิทิน</button>
        <button className="btn btn-primary" onClick={() => go("generator")}>+ สร้างคอนเทนต์</button>
      </div>
      <div className="grid-5">
        <Frame><span className="card-kicker">วิดีโอวันนี้</span><span className="metric">{data.counts.videos_today}</span></Frame>
        <Frame><span className="card-kicker">ตั้งเวลาแล้ว</span><span className="metric">{data.counts.scheduled}</span></Frame>
        <Frame><span className="card-kicker">เผยแพร่แล้ว</span><span className="metric">{data.counts.published}</span></Frame>
        <Frame><span className="card-kicker">ล้มเหลว</span><span className="metric">{data.counts.failed}</span></Frame>
        <Frame><span className="card-kicker">บัญชีที่เชื่อม</span><span className="metric">{data.counts.connected_accounts}/{data.counts.account_slots}</span></Frame>
      </div>
      <div className="grid-dash">
        <Frame>
          <span className="card-kicker">โพสต์ถัดไป · {preview ? thaiTime(preview.scheduled_at) : "—"}</span>
          <div className="preview-916">ตัวอย่างวิดีโอ 9:16</div>
          <span className="card-title">{preview?.topic || "ยังไม่มีคิว"}</span>
          <div className="tags">{(preview?.platforms || []).map((item) => <span key={item} className="tag tag-accent">{platformShort(item)}</span>)}</div>
        </Frame>
        <Frame>
          <span className="card-kicker">สถานะรายแพลตฟอร์ม</span>
          <table className="table"><tbody>
            {data.platforms.map((row) => (
              <tr key={row.platform}>
                <td>{platformName(row.platform)}</td>
                <td>{statusTag(row.status)}</td>
                <td style={{ fontSize: 12 }}>{row.last_success_at ? thaiTime(row.last_success_at) : "—"}</td>
              </tr>
            ))}
          </tbody></table>
          {data.recent_errors[0] && (
            <>
              <span className="card-kicker">ข้อผิดพลาดล่าสุด</span>
              <div style={{ fontSize: 13 }}>#{data.recent_errors[0].public_no || ""} {data.recent_errors[0].platform} · {data.recent_errors[0].message}</div>
              <div className="row">
                <button className="btn btn-secondary" onClick={() => go("accounts")}>เชื่อมต่อใหม่</button>
                <button className="btn btn-ghost" onClick={() => go("publishing")}>ลองอีกครั้ง</button>
              </div>
            </>
          )}
        </Frame>
        <Frame>
          <span className="card-kicker">กิจกรรมล่าสุด</span>
          <div className="activity">
            {data.recent_activity.map((row) => (
              <div key={row.id}><span className="time">{thaiTime(row.created_at)}</span><span>{row.message}</span></div>
            ))}
          </div>
        </Frame>
      </div>
      <button className="btn btn-ghost" onClick={reload}>รีเฟรช</button>
    </>
  );
}

function Content({ id, notify }) {
  const [rows, reload] = useLoad(() => api.content(), notify);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [menu, setMenu] = useState("");
  const [editing, setEditing] = useState(null);
  const [scheduling, setScheduling] = useState(null);
  const selected = rows?.find((row) => row.id === id);

  const visible = (rows || []).filter((row) => {
    if (filter === "FAILED") return row.status === "FAILED" || row.status === "PARTIAL";
    if (filter !== "ALL" && row.status !== filter) return false;
    return !q || row.topic.toLowerCase().includes(q.toLowerCase());
  });

  async function act(row, action) {
    setMenu("");
    try {
      if (action === "open") go("content", row.id);
      if (action === "edit") setEditing(row);
      if (action === "duplicate") { await api.duplicateContent(row.id); reload(); }
      if (action === "video") { await api.video(row.id); go("studio", row.id); }
      if (action === "schedule") setScheduling(row);
      if (action === "publish") { await api.publish(row.id); reload(); }
      if (action === "cancel") { await api.cancelContent(row.id); reload(); }
      if (action === "delete") { await api.deleteContent(row.id); if (id === row.id) go("content"); reload(); }
    } catch (error) { notify(error); }
  }

  if (selected) {
    return (
      <ContentDetail
        row={selected}
        onBack={() => go("content")}
        onEdit={() => setEditing(selected)}
        onSchedule={() => setScheduling(selected)}
        notify={notify}
        reload={reload}
        editing={editing}
        setEditing={setEditing}
        scheduling={scheduling}
        setScheduling={setScheduling}
      />
    );
  }

  const counts = {
    ALL: rows?.length || 0,
    DRAFT: rows?.filter((row) => row.status === "DRAFT").length || 0,
    SCHEDULED: rows?.filter((row) => row.status === "SCHEDULED").length || 0,
    PUBLISHED: rows?.filter((row) => row.status === "PUBLISHED").length || 0,
    FAILED: rows?.filter((row) => row.status === "FAILED" || row.status === "PARTIAL").length || 0,
  };

  return (
    <>
      <div className="row">
        <h1 className="page-title">คอนเทนต์</h1>
        <span className="grow" />
        <input className="input" style={{ width: 240 }} placeholder="ค้นหาหัวข้อ…" value={q} onChange={(event) => setQ(event.target.value)} />
        <button className="btn btn-primary" onClick={() => go("generator")}>+ สร้างใหม่</button>
      </div>
      <div className="seg filters" role="tablist">
        {[["ALL", `ทั้งหมด ${counts.ALL}`], ["DRAFT", `ร่าง ${counts.DRAFT}`], ["SCHEDULED", `ตั้งเวลา ${counts.SCHEDULED}`], ["PUBLISHED", `เผยแพร่ ${counts.PUBLISHED}`], ["FAILED", `ล้มเหลว ${counts.FAILED}`]].map(([key, label]) => (
          <button key={key} className="seg-opt" style={filter === key ? { background: "var(--color-accent-100)" } : undefined} onClick={() => setFilter(key)}>{label}</button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>ID</th><th></th><th>หัวข้อ</th><th>สถานะ</th><th>วันที่</th><th>เวลา</th><th>แพลตฟอร์ม</th><th>สร้างเมื่อ</th><th></th></tr></thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id}>
                <td>#{row.public_no}</td>
                <td><div className="thumb" /></td>
                <td>{row.topic}</td>
                <td>{statusTag(row.status)}</td>
                <td>{thaiDate(row.scheduled_at)}</td>
                <td>{row.scheduled_at ? thaiTime(row.scheduled_at) : "—"}</td>
                <td>{(row.platforms || []).map(platformShort).join(" ")}</td>
                <td>{thaiDate(row.created_at)}</td>
                <td className="menu-pop">
                  <button className="btn btn-ghost" onClick={() => act(row, "open")}>เปิด</button>
                  <button className="btn btn-ghost" aria-expanded={menu === row.id} onClick={() => setMenu(menu === row.id ? "" : row.id)}>⋯</button>
                  {menu === row.id && (
                    <div className="menu-list">
                      {[["edit", "แก้ไข"], ["duplicate", "ทำสำเนา"], ["video", "สร้างวิดีโอ"], ["schedule", "ตั้งเวลา"], ["publish", "เผยแพร่ทันที"], ["cancel", "ยกเลิก"], ["delete", "ลบ"]].map(([action, label]) => (
                        <button key={action} className="btn btn-ghost" onClick={() => act(row, action)}>{label}</button>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!visible.length && <p className="hint">ไม่พบคอนเทนต์</p>}
      {editing && <EditDialog row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} notify={notify} />}
      {scheduling && <ScheduleDialog row={scheduling} onClose={() => setScheduling(null)} onSaved={() => { setScheduling(null); reload(); }} notify={notify} />}
    </>
  );
}

function ContentDetail({ row, onBack, onEdit, onSchedule, notify, reload, editing, setEditing, scheduling, setScheduling }) {
  return (
    <>
      <button className="btn btn-ghost" onClick={onBack}>← คอนเทนต์</button>
      <div className="detail">
        <div>
          <h1 className="page-title">#{row.public_no} {row.topic}</h1>
          <div className="row">{statusTag(row.status)}</div>
          <div className="row">
            <button className="btn btn-secondary" onClick={onEdit}>แก้ไข</button>
            <button className="btn btn-secondary" onClick={async () => { await api.duplicateContent(row.id); reload(); }}>ทำสำเนา</button>
            <button className="btn btn-secondary" onClick={async () => { try { await api.video(row.id); go("studio", row.id); } catch (error) { notify(error); } }}>สร้างวิดีโอ</button>
            <button className="btn btn-secondary" onClick={onSchedule}>ตั้งเวลา</button>
            <button className="btn btn-primary" onClick={async () => { try { await api.publish(row.id); reload(); } catch (error) { notify(error); } }}>เผยแพร่ทันที</button>
          </div>
          <Field k="Hook" v={row.hook} />
          <Field k="สคริปต์" v={row.script} />
          <Field k="เสียงพากย์" v={row.voice_script} />
          <Field k="แคปชัน" v={row.caption} />
          <Field k="แฮชแท็ก" v={(row.hashtags || []).join(" ")} />
          <Field k="CTA" v={row.cta} />
          <div className="grid-5">
            <Field k="ความยาว" v={row.duration_seconds ? `${row.duration_seconds} วิ` : "—"} />
            <Field k="ภาษา" v={row.language} />
            <Field k="โทน" v={row.tone} />
            <Field k="กลุ่มเป้าหมาย" v={row.target_audience} />
          </div>
        </div>
        <div>
          <div className="preview-916 blueprint">วิดีโอ</div>
          <div className="card-kicker k">ประวัติการเผยแพร่</div>
          {(row.publishing || []).map((item) => (
            <div key={`${item.platform}:${item.account_id || ""}`} className="row">
              <span>{platformName(item.platform)}{item.account_name ? ` · ${item.account_name}` : ""}</span>{statusTag(item.status)}
            </div>
          ))}
        </div>
      </div>
      {editing && <EditDialog row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} notify={notify} />}
      {scheduling && <ScheduleDialog row={scheduling} onClose={() => setScheduling(null)} onSaved={() => { setScheduling(null); reload(); }} notify={notify} />}
    </>
  );
}

// Destination accounts per selected platform. Nothing ticked on a platform = its default account.
function AccountPicker({ platforms, value, onChange }) {
  const [accounts, setAccounts] = useState(null);
  useEffect(() => { api.accounts().then(setAccounts).catch(() => setAccounts([])); }, []);
  if (!accounts) return <p className="hint">กำลังโหลดบัญชี…</p>;
  const chosen = new Set(value || []);
  const toggle = (id) => onChange(chosen.has(id) ? [...chosen].filter((item) => item !== id) : [...chosen, id]);
  return (
    <div className="account-picker">
      {PLATFORMS.filter(([pid]) => platforms.includes(pid)).map(([pid, label]) => {
        const mine = accounts.filter((row) => row.platform === pid);
        const fallback = mine.find((row) => row.is_default) || mine[0];
        const picked = mine.filter((row) => chosen.has(row.id));
        return (
          <div key={pid} className="account-picker-row">
            <span className="card-kicker">{label}</span>
            {mine.length === 0 ? (
              <span className="hint">ยังไม่มีบัญชี <a href="#accounts">เชื่อมต่อ</a></span>
            ) : (
              <div className="tags">
                {mine.map((row) => (
                  <button type="button" key={row.id} className={`tag ${chosen.has(row.id) ? "tag-accent" : "tag-neutral"}`} onClick={() => toggle(row.id)} aria-pressed={chosen.has(row.id)}>
                    {chosen.has(row.id) ? "✓ " : ""}{row.account_name || label}{row.status !== "CONNECTED" ? " (ไม่ได้เชื่อม)" : ""}
                  </button>
                ))}
                {!picked.length && fallback && <span className="hint">ไม่ได้เลือก → ใช้ค่าเริ่มต้น: {fallback.account_name}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Field({ k, v }) {
  return <div className="k"><div className="card-kicker">{k}</div><div>{v || "—"}</div></div>;
}

function EditDialog({ row, onClose, onSaved, notify }) {
  const [form, setForm] = useState({ ...row, hashtags: (row.hashtags || []).join(" ") });
  async function save(event) {
    event.preventDefault();
    try {
      await api.updateContent(row.id, {
        topic: form.topic, hook: form.hook, script: form.script, voice_script: form.voice_script,
        caption: form.caption, cta: form.cta, visual_prompt: form.visual_prompt,
        hashtags: String(form.hashtags || "").split(/\s+/).filter(Boolean),
        tone: form.tone, language: form.language, target_audience: form.target_audience,
        duration_seconds: Number(form.duration_seconds || 45),
      });
      onSaved();
    } catch (error) { notify(error); }
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="dialog" onSubmit={save} role="dialog" aria-label="แก้ไขคอนเทนต์">
        <div className="dialog-title">แก้ไข #{row.public_no}</div>
        {["topic", "hook", "script", "caption", "hashtags", "cta"].map((key) => (
          <div className="field" key={key}><label>{key}</label><input className="input" value={form[key] || ""} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></div>
        ))}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
          <button className="btn btn-primary" type="submit">บันทึก</button>
        </div>
      </form>
    </div>
  );
}

function ScheduleDialog({ row, onClose, onSaved, notify }) {
  const initial = row.scheduled_at ? new Date(row.scheduled_at) : new Date();
  const local = new Date(initial.getTime() - initial.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [when, setWhen] = useState(local);
  const [platforms, setPlatforms] = useState(row.platforms || PLATFORMS.map((item) => item[0]));
  const [accountIds, setAccountIds] = useState(row.account_ids || []);
  async function save(event) {
    event.preventDefault();
    try {
      await api.schedule(row.id, { scheduled_at: new Date(when).toISOString(), platforms, account_ids: accountIds });
      onSaved();
    } catch (error) { notify(error); }
  }
  return (
    <div className="dialog-backdrop">
      <form className="dialog" onSubmit={save} role="dialog" aria-label="ตั้งเวลา">
        <div className="dialog-title">ตั้งเวลา #{row.public_no}</div>
        <div className="field"><label>วันและเวลา</label><input className="input" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} /></div>
        <div className="tags">
          {PLATFORMS.map(([pid, label]) => (
            <button type="button" key={pid} className={`tag ${platforms.includes(pid) ? "tag-accent" : "tag-neutral"}`} onClick={() => setPlatforms(platforms.includes(pid) ? platforms.filter((item) => item !== pid) : [...platforms, pid])}>{label}</button>
          ))}
        </div>
        <div className="field"><label>บัญชีปลายทาง</label><AccountPicker platforms={platforms} value={accountIds} onChange={setAccountIds} /></div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
          <button className="btn btn-primary" type="submit">บันทึก</button>
        </div>
      </form>
    </div>
  );
}

function Generator({ notify }) {
  const [form, setForm] = useState({
    topic: "", niche: "", language: "th", duration_seconds: 45, tone: "friendly",
    count: 1, cta: "กดติดตามเพื่อดูตอนต่อไป", style: "", target_audience: "",
    platforms: PLATFORMS.map((item) => item[0]),
    account_ids: [],
  });
  const [result, setResult] = useState(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const concept = result?.concepts?.[index];

  function set(key, value) { setForm((current) => ({ ...current, [key]: value })); }

  async function generate() {
    setBusy(true);
    try {
      const data = await api.generate(form);
      setResult(data);
      setIndex(0);
    } catch (error) { notify(error); }
    finally { setBusy(false); }
  }

  async function save(mode) {
    if (!concept) return;
    try {
      const created = await api.createContent({ ...form, ...concept, status: "DRAFT" });
      if (mode === "queue") {
        const when = new Date();
        when.setDate(when.getDate() + 1);
        when.setHours(9, 0, 0, 0);
        await api.schedule(created.id, { scheduled_at: when.toISOString(), platforms: form.platforms, account_ids: form.account_ids });
      }
      go("content");
    } catch (error) { notify(error); }
  }

  return (
    <div className="gen-layout">
      <div className="gen-form">
        <h1 className="page-title">AI สร้างคอนเทนต์</h1>
        <div className="field"><label>หัวข้อ</label><input className="input" value={form.topic} onChange={(event) => set("topic", event.target.value)} /></div>
        <div className="field"><label>นิช</label><input className="input" value={form.niche} onChange={(event) => set("niche", event.target.value)} /></div>
        <div className="grid-2">
          <div className="field"><label>ภาษา</label><input className="input" value={form.language} onChange={(event) => set("language", event.target.value)} /></div>
          <div className="field"><label>ความยาว (วินาที)</label><input className="input" type="number" value={form.duration_seconds} onChange={(event) => set("duration_seconds", Number(event.target.value))} /></div>
          <div className="field"><label>โทน</label><input className="input" value={form.tone} onChange={(event) => set("tone", event.target.value)} /></div>
          <div className="field"><label>จำนวนไอเดีย</label><input className="input" type="number" min="1" max="5" value={form.count} onChange={(event) => set("count", Number(event.target.value))} /></div>
        </div>
        <div className="field"><label>สไตล์</label><input className="input" value={form.style} onChange={(event) => set("style", event.target.value)} /></div>
        <div className="field"><label>CTA</label><input className="input" value={form.cta} onChange={(event) => set("cta", event.target.value)} /></div>
        <div className="field"><label>กลุ่มเป้าหมาย</label><input className="input" value={form.target_audience} onChange={(event) => set("target_audience", event.target.value)} /></div>
        <div className="field"><label>แพลตฟอร์ม</label>
          <div className="tags">{PLATFORMS.map(([pid, label]) => (
            <button type="button" key={pid} className={`tag ${form.platforms.includes(pid) ? "tag-accent" : "tag-neutral"}`} onClick={() => set("platforms", form.platforms.includes(pid) ? form.platforms.filter((item) => item !== pid) : [...form.platforms, pid])}>{label}</button>
          ))}</div>
        </div>
        <div className="field"><label>บัญชีปลายทาง</label><AccountPicker platforms={form.platforms} value={form.account_ids} onChange={(ids) => set("account_ids", ids)} /></div>
        <button className="btn btn-primary" disabled={busy} onClick={generate}>{busy ? "กำลังสร้าง…" : "สร้าง"}</button>
        <p className="hint">ไม่มีคีย์ API จะใช้ตัวสร้างจำลอง ไม่มีการเรียก Claude</p>
      </div>
      <div className="gen-out">
        {result && (
          <div className="row">
            <div className="seg">{result.concepts.map((item, itemIndex) => (
              <button key={item.title} className="seg-opt" style={itemIndex === index ? { background: "var(--color-accent-100)" } : undefined} onClick={() => setIndex(itemIndex)}>ไอเดีย {itemIndex + 1}</button>
            ))}</div>
            <span className="grow" />
            <span className="tag tag-neutral">{result.provider}</span>
            <button className="btn btn-ghost" onClick={generate}>สร้างใหม่</button>
          </div>
        )}
        {concept && (
          <Frame>
            <Field k="ชื่อเรื่อง" v={concept.title} />
            <Field k="Hook" v={concept.hook} />
            <Field k="Shot list" v={concept.shot_list} />
            <Field k="Visual prompts" v={concept.visual_prompt} />
            <Field k="สคริปต์เสียงพากย์" v={concept.voice_script} />
            <Field k="แคปชัน" v={concept.caption} />
            <Field k="แฮชแท็ก" v={concept.hashtags.join(" ")} />
            <div className="row">
              <span className="grow" />
              <button className="btn btn-secondary" onClick={() => save("draft")}>บันทึกเป็นร่าง</button>
              <button className="btn btn-primary" onClick={() => save("queue")}>เพิ่มเข้าคิว</button>
            </div>
          </Frame>
        )}
        {!concept && <p className="hint">กรอกหัวข้อแล้วกดสร้าง ผลลัพธ์จะอยู่ฝั่งนี้</p>}
      </div>
    </div>
  );
}

function Studio({ id, notify }) {
  const [rows, reload] = useLoad(() => api.content(), notify);
  const [busy, setBusy] = useState(false);
  if (!rows) return <p className="hint">กำลังโหลด…</p>;
  const current = rows.find((row) => row.id === id) || rows.find((row) => row.assets?.length) || rows[0];
  const asset = current?.assets?.[0];
  if (!current) return <p className="hint">ยังไม่มีคอนเทนต์</p>;
  const pipeline = asset?.pipeline || {};
  return (
    <>
      <div className="row">
        <h1 className="page-title">สตูดิโอวิดีโอ</h1>
        <select className="input" style={{ width: 280 }} value={current.id} onChange={(event) => go("studio", event.target.value)}>
          {(rows || []).map((row) => <option key={row.id} value={row.id}>#{row.public_no} {row.topic}</option>)}
        </select>
      </div>
      <div className="pipe">
        {[["script", "01 สคริปต์"], ["tts", "02 เสียง TTS"], ["visuals", "03 ภาพ"], ["ffmpeg", "04 FFmpeg"], ["subtitles", "05 ซับไตเติล"]].map(([key, label]) => (
          <div key={key}><div className="card-kicker">{label}</div><b>{pipeline[key] || "รอ"}</b></div>
        ))}
      </div>
      <div className="studio">
        <div className="blueprint player">
          <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
          {asset?.storage_path ? (
            <video key={asset.id} className="player-video" src={`/api/media/${asset.id}`} controls playsInline preload="metadata" />
          ) : (
            <>
              <div className="player-stage">{asset ? `เพลเยอร์ ${asset.width || 1080}×${asset.height || 1920}` : "ยังไม่มีวิดีโอ"}</div>
              <div className="scrub">▶<div className="bar"><span /></div>{asset ? `0:00 / 0:${String(asset.duration_seconds || 0).padStart(2, "0")}` : "—"}</div>
            </>
          )}
        </div>
        <div>
          <div className="card-kicker">#{current.public_no}</div>
          <h1 className="page-title">{current.topic}</h1>
          <table className="table"><tbody>
            <tr><td>ความยาว</td><td>{asset?.duration_seconds || current.duration_seconds || "—"} วิ</td></tr>
            <tr><td>ความละเอียด</td><td>{asset ? `${asset.width} × ${asset.height}` : "—"}</td></tr>
            <tr><td>FPS</td><td>{asset?.fps || "—"}</td></tr>
            <tr><td>เสียง</td><td>{asset?.audio_status === "SILENT" ? "ไม่มีเสียงพากย์" : statusTag(asset?.audio_status === "READY" ? "READY" : "NONE")}</td></tr>
            <tr><td>ซับไตเติล</td><td>{asset?.subtitle_status || "—"}</td></tr>
            <tr><td>การประมวลผล</td><td>{asset?.provider || "—"} · {asset?.status || "ยังไม่สร้าง"}</td></tr>
          </tbody></table>
          <div className="row">
            <button className="btn btn-secondary" disabled={busy} onClick={async () => {
              setBusy(true);
              try { const result = await api.video(current.id); if (result.asset?.note) notify(result.asset.note); reload(); } catch (error) { notify(error); } finally { setBusy(false); }
            }}>{busy ? "กำลังเรนเดอร์… (อาจใช้เวลาหลายนาที)" : asset ? "เรนเดอร์ใหม่" : "สร้างวิดีโอ"}</button>
            {asset?.storage_path && <a className="btn btn-ghost" href={`/api/media/${asset.id}`} download>ดาวน์โหลด MP4</a>}
            <button className="btn btn-primary" onClick={() => go("content", current.id)}>ตั้งเวลาเผยแพร่</button>
          </div>
          {asset?.provider === "mock" && <p className="hint">ยังไม่มีไฟล์ MP4 จริง เพราะเครื่องนี้ไม่พบ FFmpeg ข้อมูลความละเอียดเป็นค่าเป้าหมาย 1080×1920</p>}
          {asset?.note && asset.provider !== "mock" && <p className="hint">{asset.note}</p>}
        </div>
      </div>
    </>
  );
}

function Calendar({ notify }) {
  const [rows, reload] = useLoad(() => api.calendar(), notify);
  const [cursor, setCursor] = useState(() => { const now = new Date(); return { year: now.getFullYear(), month: now.getMonth() }; });
  const [mode, setMode] = useState("month");
  const [drag, setDrag] = useState("");
  const label = new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric" }).format(new Date(cursor.year, cursor.month, 1));
  const cells = useMemo(() => monthCells(cursor.year, cursor.month), [cursor]);

  async function dropOn(day) {
    const row = (rows || []).find((item) => item.id === drag);
    if (!row || !day) return;
    const time = row.scheduled_at
      ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Bangkok" }).format(new Date(row.scheduled_at))
      : "09:00";
    const [hour, minute] = time.split(":").map(Number);
    const scheduled = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), hour - 7, minute));
    try {
      await api.schedule(row.id, { scheduled_at: scheduled.toISOString(), platforms: row.platforms });
      reload();
    } catch (error) { notify(error); }
  }

  return (
    <>
      <div className="row">
        <h1 className="page-title">{label}</h1>
        <button className="btn btn-ghost" onClick={() => setCursor(shiftMonth(cursor, -1))}>‹</button>
        <button className="btn btn-ghost" onClick={() => setCursor(shiftMonth(cursor, 1))}>›</button>
        <span className="grow" />
        <div className="seg">
          <button className="seg-opt" style={mode === "month" ? { background: "var(--color-accent-100)" } : undefined} onClick={() => setMode("month")}>เดือน</button>
          <button className="seg-opt" style={mode === "week" ? { background: "var(--color-accent-100)" } : undefined} onClick={() => setMode("week")}>สัปดาห์</button>
        </div>
      </div>
      {mode === "month" ? (
        <div className="calendar">
          {["จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส.", "อา."].map((day) => <div key={day} className="card-kicker cal-head">{day}</div>)}
          {cells.map((day, index) => {
            const key = day ? dateKey(day) : "";
            const items = (rows || []).filter((row) => row.scheduled_at && dateKey(row.scheduled_at) === key);
            return (
              <div key={index} className={!day ? "muted" : undefined} onDragOver={(event) => event.preventDefault()} onDrop={() => dropOn(day)}>
                {day ? day.getDate() : ""}
                {items.map((row) => (
                  <button key={row.id} className={`cal-card ${row.status === "PARTIAL" ? "bad" : ""}`} draggable onDragStart={() => setDrag(row.id)} onClick={() => go("content", row.id)}>
                    {thaiTime(row.scheduled_at)} {row.topic}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="week">
          {weekDays().map((day) => {
            const key = dateKey(day);
            const items = (rows || []).filter((row) => row.scheduled_at && dateKey(row.scheduled_at) === key);
            return (
              <article key={key} onDragOver={(event) => event.preventDefault()} onDrop={() => dropOn(day)}>
                <div className="card-kicker">{new Intl.DateTimeFormat("th-TH", { weekday: "short", day: "numeric" }).format(day)}</div>
                {items.map((row) => (
                  <Frame key={row.id}>
                    <button className="btn btn-ghost" draggable onDragStart={() => setDrag(row.id)} onClick={() => go("content", row.id)}>{thaiTime(row.scheduled_at)} {row.topic}</button>
                    {statusTag(row.status)}
                  </Frame>
                ))}
                {!items.length && <div className="hint">ว่าง</div>}
              </article>
            );
          })}
        </div>
      )}
      <p className="hint">ลากการ์ดเพื่อเปลี่ยนวัน · คลิกเพื่อเปิด</p>
    </>
  );
}

function monthCells(year, month) {
  const first = new Date(year, month, 1);
  const start = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: start }, () => null);
  for (let day = 1; day <= days; day += 1) cells.push(new Date(year, month, day));
  while (cells.length % 7) cells.push(null);
  return cells;
}

function shiftMonth(cursor, delta) {
  const date = new Date(cursor.year, cursor.month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

function weekDays() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
}

function Automation({ notify }) {
  const [data, reload] = useLoad(() => api.automation(), notify);
  const [form, setForm] = useState(null);
  useEffect(() => { if (data) setForm(data); }, [data]);
  if (!form) return <p className="hint">กำลังโหลด…</p>;
  function set(key, value) { setForm({ ...form, [key]: value }); }
  async function save() {
    try {
      await api.saveAutomation({
        enabled: form.enabled,
        timezone: form.timezone,
        daily_quantity: Number(form.daily_quantity),
        publish_time: form.publish_time,
        generation_lead_hours: Number(form.generation_lead_hours),
        retry_count: Number(form.retry_count),
        retry_backoff_seconds: Number(form.retry_backoff_seconds),
        max_concurrent_jobs: 1,
        platforms: form.platforms,
        account_ids: form.account_ids || [],
      });
      reload();
    } catch (error) { notify(error); }
  }
  return (
    <>
      <div className="row">
        <h1 className="page-title">ระบบอัตโนมัติ</h1>
        <span className="grow" />
        <div className="seg">
          <button className="seg-opt" style={form.enabled ? { background: "var(--color-accent)", color: "var(--color-bg)" } : undefined} onClick={() => set("enabled", true)}>เปิด</button>
          <button className="seg-opt" style={!form.enabled ? { background: "var(--color-accent)", color: "var(--color-bg)" } : undefined} onClick={() => set("enabled", false)}>ปิด</button>
        </div>
      </div>
      <div className="grid-2" style={{ maxWidth: 720 }}>
        <div className="field"><label>เขตเวลา</label><input className="input" value={form.timezone || ""} onChange={(event) => set("timezone", event.target.value)} /></div>
        <div className="field"><label>จำนวนต่อวัน</label><input className="input" type="number" value={form.daily_quantity} onChange={(event) => set("daily_quantity", event.target.value)} /></div>
        <div className="field"><label>เวลาเผยแพร่</label><input className="input" value={form.publish_time || ""} onChange={(event) => set("publish_time", event.target.value)} /></div>
        <div className="field"><label>สร้างคอนเทนต์ล่วงหน้า (ชั่วโมง)</label><input className="input" type="number" value={form.generation_lead_hours} onChange={(event) => set("generation_lead_hours", event.target.value)} /></div>
        <div className="field"><label>จำนวนครั้งที่ลองใหม่</label><input className="input" type="number" value={form.retry_count} onChange={(event) => set("retry_count", event.target.value)} /></div>
        <div className="field"><label>หน่วงก่อนลองใหม่ (วินาที)</label><input className="input" type="number" value={form.retry_backoff_seconds} onChange={(event) => set("retry_backoff_seconds", event.target.value)} /></div>
        <div className="field"><label>งานพร้อมกันสูงสุด</label><input className="input" value="1" disabled /></div>
        <div className="field"><label>แพลตฟอร์ม</label><div className="tags">{PLATFORMS.map(([pid, label]) => (
          <button type="button" key={pid} className={`tag ${(form.platforms || []).includes(pid) ? "tag-accent" : "tag-neutral"}`} onClick={() => {
            const current = form.platforms || [];
            set("platforms", current.includes(pid) ? current.filter((item) => item !== pid) : [...current, pid]);
          }}>{label}</button>
        ))}</div></div>
        <div className="field"><label>บัญชีปลายทางของคอนเทนต์อัตโนมัติ</label><AccountPicker platforms={form.platforms || []} value={form.account_ids || []} onChange={(ids) => set("account_ids", ids)} /></div>
      </div>
      <p className="hint">งานหนักทีละ 1 รายการ n8n เรียก /api/automation/run-now ตามเวลาที่ตั้ง</p>
      <div className="row">
        <button className="btn btn-primary" onClick={save}>บันทึก</button>
        <button className="btn btn-secondary" onClick={async () => { try { await api.runAutomation(); reload(); } catch (error) { notify(error); } }}>รันทดสอบ</button>
      </div>
    </>
  );
}

function Accounts({ notify }) {
  const [rows, reload] = useLoad(() => api.accounts(), notify);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [externalId, setExternalId] = useState("");
  const [platform, setPlatform] = useState("facebook");

  useEffect(() => {
    // The OAuth callback redirects to /?connected=…&count=… or /?oauth_error=… then #accounts.
    const params = new URLSearchParams(window.location.search);
    const error = params.get("oauth_error");
    const connected = params.get("connected");
    if (error) notify(new Error(`เชื่อมต่อไม่สำเร็จ: ${error}`));
    else if (connected) notify(`เชื่อมต่อ ${platformName(connected)} สำเร็จ ${params.get("count") || 1} บัญชี`);
    if (error || connected) window.history.replaceState(null, "", `/${window.location.hash}`);
  }, []);

  async function startOauth(pid) {
    try {
      const result = await api.connect(pid, {});
      if (result.authorize_url) window.location.href = result.authorize_url;
      else reload();
    } catch (error) { notify(error); }
  }

  async function act(fn, done) {
    try { await fn(); if (done) notify(done); reload(); } catch (error) { notify(error); }
  }

  if (!rows) return <p className="hint">กำลังโหลด…</p>;
  return (
    <>
      <h1 className="page-title">บัญชีโซเชียล</h1>
      <p className="hint">แต่ละแพลตฟอร์มมีได้หลายบัญชี บัญชี "ค่าเริ่มต้น" ใช้เมื่อคอนเทนต์ไม่ได้เลือกบัญชีปลายทางเอง</p>
      {PLATFORMS.map(([pid, label]) => {
        const mine = rows.filter((row) => row.platform === pid);
        return (
          <Frame key={pid}>
            <div className="row">
              <span className="card-title grow">{label}</span>
              <span className="hint">{mine.length} บัญชี</span>
              <button className="btn btn-primary" onClick={() => startOauth(pid)}>+ เพิ่มบัญชี</button>
            </div>
            {mine.length === 0 && <p className="hint">ยังไม่ได้เชื่อมบัญชี</p>}
            {mine.map((row) => (
              <div key={row.id} className="account-row">
                <div className="row">
                  <b className="grow">{row.account_name || "ไม่มีชื่อ"}</b>
                  {row.is_default && <span className="tag tag-accent">ค่าเริ่มต้น</span>}
                  {statusTag(row.status)}
                </div>
                <div className="grid-5">
                  <Field k="ID บนแพลตฟอร์ม" v={row.external_account_id} />
                  <Field k="ต้องเชื่อมใหม่ภายใน" v={row.expires_at ? thaiDate(row.expires_at, true) : "—"} />
                  <Field k="สำเร็จล่าสุด" v={row.last_success_at ? `${thaiDate(row.last_success_at)} ${thaiTime(row.last_success_at)}` : "—"} />
                </div>
                <div className="row">
                  {row.status === "CONNECTED" ? (
                    <button className="btn btn-secondary" onClick={() => act(() => api.testAccount(row.id), `${row.account_name}: เชื่อมต่อได้`)}>ทดสอบ</button>
                  ) : (
                    <button className="btn btn-primary" onClick={() => startOauth(pid)}>เชื่อมต่อใหม่</button>
                  )}
                  {!row.is_default && <button className="btn btn-secondary" onClick={() => act(() => api.setDefaultAccount(row.id))}>ตั้งเป็นค่าเริ่มต้น</button>}
                  <button className="btn btn-ghost" onClick={() => {
                    const next = window.prompt("ชื่อที่แสดง", row.account_name || "");
                    if (next && next.trim()) act(() => api.renameAccount(row.id, next.trim()));
                  }}>เปลี่ยนชื่อ</button>
                  {row.status !== "DISCONNECTED" && <button className="btn btn-ghost" onClick={() => act(() => api.disconnect(row.id))}>ตัดการเชื่อมต่อ</button>}
                  <button className="btn btn-ghost" onClick={() => {
                    if (window.confirm(`ลบบัญชี ${row.account_name} ออกจากระบบ? (บัญชีที่เคยมีโพสต์จะลบไม่ได้ ให้ใช้ตัดการเชื่อมต่อแทน)`)) act(() => api.deleteAccount(row.id));
                  }}>ลบ</button>
                </div>
              </div>
            ))}
          </Frame>
        );
      })}
      <Frame>
        <span className="card-kicker">เพิ่มบัญชีด้วยโทเคนที่คัดลอกมาเอง (ทางเลือกสำรอง)</span>
        <div className="grid-2">
          <div className="field"><label>แพลตฟอร์ม</label>
            <select className="input" value={platform} onChange={(event) => setPlatform(event.target.value)}>
              {PLATFORMS.map(([pid, label]) => <option key={pid} value={pid}>{label}</option>)}
            </select>
          </div>
          <div className="field"><label>ชื่อบัญชี</label><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></div>
          <div className="field"><label>Access token</label><input className="input" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></div>
          <div className="field"><label>{platform === "facebook" ? "Page ID" : platform === "instagram" ? "Instagram user ID" : "Account ID (ไม่บังคับ)"}</label><input className="input" value={externalId} onChange={(event) => setExternalId(event.target.value)} /></div>
        </div>
        <button className="btn btn-primary" disabled={!token} onClick={async () => {
          try {
            await api.connect(platform, { account_name: name || platformName(platform), access_token: token, external_account_id: externalId || null });
            setToken("");
            setName("");
            setExternalId("");
            reload();
          } catch (error) { notify(error); }
        }}>บันทึกโทเคน</button>
        <p className="hint">ปกติให้กด "+ เพิ่มบัญชี" ระบบจะพาไปหน้า OAuth ของแพลตฟอร์ม Facebook/Instagram จะให้ติ๊กเลือก Page ได้หลาย Page ในครั้งเดียว ส่วน YouTube และ TikTok ให้ล็อกอินทีละบัญชี (ออกจากระบบบัญชีเดิมในเว็บนั้นก่อน หรือใช้หน้าต่างไม่ระบุตัวตน) ดู docs/13-oauth-setup.md</p>
      </Frame>
    </>
  );
}

function Publishing({ id, notify }) {
  const [rows, reload] = useLoad(() => api.publishing(), notify);
  const selected = rows?.find((row) => row.id === id) || rows?.find((row) => row.status === "PARTIAL") || rows?.[0];
  if (!rows) return <p className="hint">กำลังโหลด…</p>;
  const failed = selected?.publishing?.find((item) => item.status === "FAILED");
  const failedLabel = failed ? `${platformName(failed.platform)}${failed.account_name ? ` · ${failed.account_name}` : ""}` : "";
  return (
    <>
      <h1 className="page-title">การเผยแพร่</h1>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>คอนเทนต์</th><th>เวลา</th>{PLATFORMS.map(([pid, label]) => <th key={pid}>{label}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} style={selected?.id === row.id ? { background: "var(--color-accent-100)" } : undefined} onClick={() => go("publishing", row.id)}>
                <td>#{row.public_no} {row.topic}</td>
                <td>{row.scheduled_at ? `${thaiDate(row.scheduled_at)} ${thaiTime(row.scheduled_at)}` : "—"}</td>
                {PLATFORMS.map(([pid]) => {
                  const items = (row.publishing || []).filter((entry) => entry.platform === pid);
                  if (items.length <= 1) return <td key={pid}>{statusTag(items[0]?.status || "NONE")}</td>;
                  return (
                    <td key={pid}>
                      {items.map((entry) => (
                        <div key={entry.account_id || "none"} className="pub-cell">{statusTag(entry.status)}<span className="hint">{entry.account_name}</span></div>
                      ))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <Frame>
          <span className="card-kicker">#{selected.public_no} · {failed ? `${failedLabel} · ลองแล้ว ${failed.attempts}` : selected.topic}</span>
          <span className="card-title">{failed?.error_message || selected.topic}</span>
          {failed?.request_id && <div className="mono">request_id {failed.request_id}</div>}
          <div className="row">
            <button className="btn btn-primary" onClick={() => go("accounts")}>เชื่อมต่อใหม่</button>
            {failed && <button className="btn btn-secondary" onClick={async () => { try { await api.retryPlatform(selected.id, failed.platform, failed.account_id); reload(); } catch (error) { notify(error); } }}>ลองอีกครั้ง</button>}
          </div>
        </Frame>
      )}
    </>
  );
}

function Analytics({ notify }) {
  const [data] = useLoad(() => api.analytics(), notify);
  const [range, setRange] = useState(30);
  if (!data) return <p className="hint">กำลังโหลด…</p>;
  return (
    <>
      <div className="row">
        <h1 className="page-title">สถิติ</h1>
        <span className="grow" />
        <div className="seg">{[7, 30, 90].map((days) => (
          <button key={days} className="seg-opt" style={range === days ? { background: "var(--color-accent-100)" } : undefined} onClick={() => setRange(days)}>{days} วัน</button>
        ))}</div>
      </div>
      <div className="grid-5">
        <Frame><span className="card-kicker">สร้างวิดีโอ</span><span className="metric">{data.videos_generated}</span></Frame>
        <Frame><span className="card-kicker">เผยแพร่</span><span className="metric">{data.videos_published}</span></Frame>
        <Frame><span className="card-kicker">ล้มเหลว</span><span className="metric">{data.failed_publishes}</span></Frame>
        <Frame><span className="card-kicker">อัตราสำเร็จ</span><span className="metric">{data.success_rate == null ? "—" : `${data.success_rate}%`}</span></Frame>
      </div>
      <div className="card">
        <span className="card-kicker">ยอดวิวรายวัน</span>
        <p className="hint">ยังไม่มีซีรีส์วิว เพราะ API ของแพลตฟอร์มยังไม่ส่งตัวเลขกลับมา ระบบจะไม่แสดงตัวเลขที่ไม่มีแหล่งที่มา</p>
      </div>
      <table className="table">
        <thead><tr><th>แพลตฟอร์ม</th><th>วิว</th><th>ไลก์</th><th>คอมเมนต์</th><th>แชร์</th><th>Engagement</th></tr></thead>
        <tbody>
          {data.platforms.map((row) => (
            <tr key={row.platform}>
              <td>{platformName(row.platform)}</td>
              <td>{metric(row.views)}</td>
              <td>{metric(row.likes)}</td>
              <td>{metric(row.comments)}</td>
              <td>{metric(row.shares)}</td>
              <td>{metric(row.engagement_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function metric(value) {
  return value == null ? "API ไม่ให้ข้อมูล" : value;
}

function Logs({ notify }) {
  const [level, setLevel] = useState("");
  const [job, setJob] = useState("");
  const [platform, setPlatform] = useState("");
  const [requestId, setRequestId] = useState("");
  const query = new URLSearchParams({ ...(level ? { level } : {}), ...(job ? { job } : {}), ...(platform ? { platform } : {}), ...(requestId ? { request_id: requestId } : {}) }).toString();
  const [rows] = useLoad(() => api.logs(query ? `?${query}` : ""), notify, query);
  return (
    <>
      <h1 className="page-title">บันทึกระบบ</h1>
      <div className="grid-5">
        <select className="input" value={level} onChange={(event) => setLevel(event.target.value)}>
          <option value="">ระดับ: ทั้งหมด</option>
          {["DEBUG", "INFO", "WARNING", "ERROR"].map((item) => <option key={item}>{item}</option>)}
        </select>
        <input className="input" placeholder="งาน" value={job} onChange={(event) => setJob(event.target.value)} />
        <input className="input" placeholder="แพลตฟอร์ม" value={platform} onChange={(event) => setPlatform(event.target.value)} />
        <input className="input" placeholder="Request ID" value={requestId} onChange={(event) => setRequestId(event.target.value)} />
      </div>
      <div className="table-wrap">
        <table className="table mono">
          <thead><tr><th>เวลา</th><th>ระดับ</th><th>งาน</th><th>คอนเทนต์</th><th>แพลตฟอร์ม</th><th>ข้อความ</th><th>Request ID</th></tr></thead>
          <tbody>
            {(rows || []).map((row) => (
              <tr key={row.id}>
                <td>{thaiTime(row.created_at)}</td>
                <td>{row.level}</td>
                <td>{row.job || "—"}</td>
                <td>{row.public_no ? `#${row.public_no}` : "—"}</td>
                <td>{row.platform || "—"}</td>
                <td>{row.message}</td>
                <td>{String(row.request_id || "").slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const SETTING_NAV = [
  ["general", "ทั่วไป"],
  ["ai", "AI"],
  ["video", "วิดีโอ"],
  ["storage", "พื้นที่จัดเก็บ"],
  ["social", "โซเชียล"],
  ["automation", "อัตโนมัติ"],
  ["security", "ความปลอดภัย"],
  ["notifications", "การแจ้งเตือน"],
];

function Settings({ id, notify }) {
  const section = SETTING_NAV.some(([key]) => key === id) ? id : "general";
  const [data, reload] = useLoad(() => api.settings(), notify);
  const [form, setForm] = useState({});
  useEffect(() => { if (data) setForm(data[section] || {}); }, [data, section]);
  if (!data) return <p className="hint">กำลังโหลด…</p>;
  const fields = {
    general: [["app_name", "ชื่อระบบ"], ["timezone", "เขตเวลา"], ["ui_language", "ภาษา UI"]],
    ai: [["model", "โมเดล"], ["default_language", "ภาษาเริ่มต้น"], ["default_tone", "โทนเริ่มต้น"], ["monthly_budget_usd", "งบประมาณต่อเดือน (USD)"]],
    video: [["width", "กว้าง"], ["height", "สูง"], ["fps", "FPS"], ["subtitle_mode", "ซับไตเติล"]],
    storage: [["media_root", "โฟลเดอร์"], ["max_video_size_mb", "ขนาดไฟล์สูงสุด (MB)"]],
    notifications: [["daily_digest_time", "สรุปรายวัน"]],
    security: [],
    social: [],
  }[section] || [];

  return (
    <div className="settings-layout">
      <div className="subnav">
        {SETTING_NAV.map(([key, label]) => (
          <button key={key} className="sub-btn" aria-current={section === key ? "page" : undefined} onClick={() => go("settings", key)}>{label}</button>
        ))}
      </div>
      <div>
        <h1 className="page-title">{SETTING_NAV.find(([key]) => key === section)?.[1]}</h1>
        {section === "ai" && <p className="hint">คีย์ Anthropic แยกจากบัญชี Claude Pro ระบบไม่แสดงคีย์ที่บันทึกไว้ สถานะ: {data.ai?.api_key_set ? "ตั้งแล้ว" : "ยังไม่ตั้ง"}</p>}
        {section === "ai" && (
          <div className="field"><label>Anthropic API key</label><input className="input" type="password" placeholder="วางคีย์ใหม่ถ้าต้องการเปลี่ยน" value={form.api_key || ""} onChange={(event) => setForm({ ...form, api_key: event.target.value })} /></div>
        )}
        {section === "security" && <p className="hint">โทเคนถูกเข้ารหัสด้วย APP_SECRET ก่อนเก็บใน PostgreSQL รหัสผ่านผู้ดูแลถูกแฮชด้วย scrypt</p>}
        {section === "social" && <p className="hint">ตั้งค่า OAuth client ที่ฝั่งเซิร์ฟเวอร์ผ่านตัวแปรสภาพแวดล้อม ไม่เก็บความลับในหน้าเว็บ</p>}
        {section === "automation" && <button className="btn btn-secondary" onClick={() => go("automation")}>เปิดหน้าตั้งค่าระบบอัตโนมัติ</button>}
        {fields.map(([key, label]) => (
          <div className="field" key={key}><label>{label}</label><input className="input" value={form[key] ?? ""} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></div>
        ))}
        {section === "notifications" && (
          <label className="radio"><input type="checkbox" checked={Boolean(form.email_on_error)} onChange={(event) => setForm({ ...form, email_on_error: event.target.checked })} /> อีเมลเมื่อมี ERROR</label>
        )}
        {section !== "automation" && section !== "social" && section !== "security" && (
          <div className="row">
            <button className="btn btn-primary" onClick={async () => { try {
              const patch = { ...form };
              if (!patch.api_key) delete patch.api_key;
              await api.saveSettings(section, patch);
              reload();
            } catch (error) { notify(error); } }}>บันทึก</button>
            {section === "ai" && <button className="btn btn-secondary" onClick={async () => { try { await api.testAi(); } catch (error) { notify(error); } }}>ทดสอบการเชื่อมต่อ</button>}
          </div>
        )}
      </div>
    </div>
  );
}
