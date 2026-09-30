export const NAV = [
  ["dashboard", "แดชบอร์ด"],
  ["content", "คอนเทนต์"],
  ["generator", "AI สร้างคอนเทนต์"],
  ["studio", "สตูดิโอวิดีโอ"],
  ["calendar", "ปฏิทิน"],
  ["automation", "ระบบอัตโนมัติ"],
  ["accounts", "บัญชีโซเชียล"],
  ["publishing", "การเผยแพร่"],
  ["analytics", "สถิติ"],
  ["logs", "บันทึกระบบ"],
  ["settings", "ตั้งค่า"],
];

export const PLATFORMS = [
  ["tiktok", "TikTok", "TT"],
  ["instagram", "Instagram", "IG"],
  ["facebook", "Facebook", "FB"],
  ["youtube", "YouTube", "YT"],
];

const STATUS = {
  WAITING_APPROVAL: ["รออนุมัติ", "tag-neutral"],
  DRAFT: ["ร่าง", "tag-neutral"],
  SCHEDULED: ["ตั้งเวลา", "tag-accent"],
  PUBLISHED: ["เผยแพร่แล้ว", "tag-accent"],
  PARTIAL: ["บางส่วนล้มเหลว", "tag-outline"],
  FAILED: ["ล้มเหลว", "tag-outline"],
  READY: ["พร้อม", "tag-accent"],
  PROCESSING: ["กำลังทำ", "tag-outline"],
  GENERATING: ["กำลังสร้าง", "tag-outline"],
  PUBLISHING: ["กำลังเผยแพร่", "tag-outline"],
  CANCELLED: ["ยกเลิก", "tag-neutral"],
  SUCCESS: ["สำเร็จ", "tag-accent"],
  QUEUED: ["รอ", "tag-neutral"],
  TOKEN_EXPIRED: ["โทเคนหมดอายุ", "tag-outline"],
  CONNECTED: ["เชื่อมต่อแล้ว", "tag-accent"],
  DISCONNECTED: ["ไม่ได้เชื่อม", "tag-neutral"],
  NOT_SELECTED: ["ไม่ได้เลือก", "tag-neutral"],
  NONE: ["—", "tag-neutral"],
};

export function statusTag(status) {
  const [label, kind] = STATUS[status] || [status || "—", "tag-neutral"];
  return <span className={`tag ${kind}`}>{label}</span>;
}

export function platformName(id) {
  return PLATFORMS.find((item) => item[0] === id)?.[1] || id;
}

export function platformShort(id) {
  return PLATFORMS.find((item) => item[0] === id)?.[2] || id;
}

export function thaiDate(value, withYear = false) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    year: withYear ? "numeric" : undefined,
    timeZone: "Asia/Bangkok",
  }).format(new Date(value));
}

export function thaiTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Bangkok",
  }).format(new Date(value));
}

export function todayHeading(now = new Date()) {
  return new Intl.DateTimeFormat("th-TH", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  }).format(now);
}

export function dateKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(new Date(value));
}

export function Frame({ children, className = "" }) {
  return (
    <div className={`card blueprint ${className}`}>
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      {children}
    </div>
  );
}

export function parseHash() {
  const parts = (location.hash || "#/dashboard").replace(/^#\/?/, "").split("/").filter(Boolean);
  return { page: parts[0] || "dashboard", id: parts[1] || "" };
}

export function go(page, id) {
  location.hash = id ? `#/${page}/${id}` : `#/${page}`;
}
