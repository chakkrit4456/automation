import { useEffect, useState } from "react";
import { api } from "./api.js";
import { NAV, go, parseHash } from "./format.jsx";
import { Screen } from "./screens.jsx";

export function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState(parseHash());
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      setMenu(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function notify(error) {
    setToast(error?.message || String(error));
  }

  if (!ready) return null;
  if (!user) return <Login onSuccess={setUser} />;

  const page = NAV.some(([id]) => id === route.page) ? route.page : "dashboard";

  return (
    <div className="shell">
      <nav className="side" aria-label="หลัก">
        <div className="brand">SOCIAL / AUTO</div>
        {NAV.map(([id, label]) => (
          <button key={id} className="nav-btn" aria-current={page === id ? "page" : undefined} onClick={() => go(id)}>
            {label}
          </button>
        ))}
        <div className="side-status"><span className="dot" />ระบบปกติ · Asia/Bangkok</div>
      </nav>
      <main className="main">
        <Screen page={page} id={route.id} notify={notify} />
      </main>
      <nav className="bottom-nav" aria-label="มือถือ">
        <button aria-current={page === "dashboard" ? "page" : undefined} onClick={() => go("dashboard")}>หน้าหลัก</button>
        <button aria-current={page === "content" ? "page" : undefined} onClick={() => go("content")}>คอนเทนต์</button>
        <button aria-current={page === "calendar" ? "page" : undefined} onClick={() => go("calendar")}>ปฏิทิน</button>
        <button aria-current={page === "publishing" ? "page" : undefined} onClick={() => go("publishing")}>เผยแพร่</button>
        <button aria-current={menu ? "page" : undefined} onClick={() => setMenu(true)}>เมนู</button>
      </nav>
      {menu && (
        <div className="sheet" role="dialog" aria-label="เมนู">
          <div className="row"><b className="page-title">เมนู</b><span className="grow" /><button className="btn btn-ghost" onClick={() => setMenu(false)}>ปิด</button></div>
          {NAV.map(([id, label]) => (
            <button key={id} className="nav-btn" onClick={() => go(id)}>{label}</button>
          ))}
          <button className="btn btn-secondary" onClick={async () => { await api.logout(); setUser(null); }}>ออกจากระบบ</button>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}<button className="btn btn-ghost" onClick={() => setToast("")}>ปิด</button></div>}
    </div>
  );
}

function Login({ onSuccess }) {
  const [email, setEmail] = useState("admin@localhost");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      const user = await api.login({ email, password });
      onSuccess(user);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login">
      <form className="card blueprint" onSubmit={submit}>
        <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
        <div className="brand">SOCIAL / AUTO</div>
        <h1 className="page-title">เข้าสู่ระบบ</h1>
        <div className="field"><label htmlFor="email">อีเมล</label><input id="email" className="input" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></div>
        <div className="field"><label htmlFor="password">รหัสผ่าน</label><input id="password" className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></div>
        {error && <div className="hint">{error}</div>}
        <button className="btn btn-primary" type="submit">เข้าสู่ระบบ</button>
        <p className="hint">เครื่องพัฒนากำหนดบัญชีใน ADMIN_EMAIL และ ADMIN_PASSWORD</p>
      </form>
    </div>
  );
}
