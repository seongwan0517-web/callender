// ===================== 설정 =====================
const CALENDAR_ID = "seongwan0517@gmail.com";
// index.html 의 data-client_id 와 같아야 합니다 (토큰의 aud 검증용)
const CLIENT_ID = "478451428995-2crtpdco8bt3mnm9vp19upqabeqbtj89.apps.googleusercontent.com";

// 접근을 허용할 구글 계정. 비워두면 "구글 로그인만 하면 누구나" 가능 → 팀원 이메일을 꼭 넣으세요.
const ALLOWED_EMAILS = [
  // "seongwan0517@gmail.com",
  // "teammate@gmail.com",
];

// 모든 일정을 수정/삭제할 수 있는 관리자
const ADMIN_EMAILS = [CALENDAR_ID];
// true 로 바꾸면 '블로그 협찬(공통 일정)'은 누구나 수정/삭제 가능
const BLOG_EDITABLE_BY_ALL = false;

const CATEGORIES = ["회사 일정", "개인 일정", "블로그 협찬"];
const BLOG_CATEGORY = "블로그 협찬";
const BLOG_COLOR = "#9b59b6";      // 블로그 협찬 공통 색
const NEUTRAL_COLOR = "#808080";   // 작성자를 알 수 없는 일정

// 로그인한 순서대로 아래 색이 한 명씩 '고정' 배정됩니다 (한 번 배정되면 바뀌지 않음)
const USER_PALETTE = ["#2d7ff9", "#22c55e", "#f97316", "#ec4899", "#eab308", "#06b6d4", "#a16207", "#e5e7eb"];
// 특정 사람의 색을 직접 지정하고 싶으면 여기에 (예: "abc@gmail.com": "#2d7ff9")
const FIXED_USER_COLORS = {
  // "seongwan0517@gmail.com": "#2d7ff9",
};

// ===================== 엔트리 포인트 =====================
function doGet() {
  return json({ ok: true, message: "NetCalendar API" });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const user = verifyToken(body.idToken);
    registerUser(user);

    switch (body.action) {
      case "getEvents": {
        const r = getEvents(body.start, body.end, user);
        return json({ success: true, events: r.events, legend: r.legend });
      }
      case "addEvent":
        addEvent(body, user);
        return json({ success: true });
      case "updateEvent":
        updateEvent(body, user);
        return json({ success: true });
      case "deleteEvent":
        deleteEvent(body, user);
        return json({ success: true });
      default:
        throw new Error("알 수 없는 action 입니다.");
    }
  } catch (err) {
    return json({ success: false, error: String(err.message || err) });
  }
}

// ===================== 인증 =====================
function verifyToken(idToken) {
  if (!idToken) throw new Error("AUTH: 로그인이 필요합니다.");

  const cache = CacheService.getScriptCache();
  const key = "tok_" + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
  );
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  const res = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) throw new Error("AUTH: 유효하지 않거나 만료된 로그인입니다.");

  const info = JSON.parse(res.getContentText());
  if (info.aud !== CLIENT_ID) throw new Error("AUTH: 허용되지 않은 클라이언트입니다.");
  if (["accounts.google.com", "https://accounts.google.com"].indexOf(info.iss) === -1)
    throw new Error("AUTH: 잘못된 토큰 발급자입니다.");
  if (Number(info.exp) * 1000 < Date.now()) throw new Error("AUTH: 로그인이 만료되었습니다.");
  if (String(info.email_verified) !== "true") throw new Error("AUTH: 이메일 인증이 안 된 계정입니다.");
  if (ALLOWED_EMAILS.length && ALLOWED_EMAILS.indexOf(info.email) === -1)
    throw new Error("AUTH: 접근 권한이 없는 계정입니다.");

  const user = { email: info.email, name: info.name || info.email };
  const ttl = Math.min(300, Math.floor(Number(info.exp) - Date.now() / 1000));
  if (ttl > 0) cache.put(key, JSON.stringify(user), ttl);
  return user;
}

// ===================== 사용자별 고정 색상 =====================
function loadRegistry() {
  const raw = PropertiesService.getScriptProperties().getProperty("USER_REGISTRY");
  return raw ? JSON.parse(raw) : {};
}

// 처음 접속한 사람에게 아직 안 쓰인 색을 배정하고 저장 (이후 영구 고정)
function registerUser(user) {
  const known = loadRegistry()[user.email];
  const fixed = FIXED_USER_COLORS[user.email];
  if (known && known.name === user.name && (!fixed || fixed === known.color)) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const reg = loadRegistry();
    let entry = reg[user.email];
    if (!entry) {
      const used = Object.keys(reg).map(function (k) { return reg[k].color; })
        .concat(Object.keys(FIXED_USER_COLORS).map(function (k) { return FIXED_USER_COLORS[k]; }));
      const free = USER_PALETTE.filter(function (c) { return used.indexOf(c) === -1; });
      entry = { color: free.length ? free[0] : USER_PALETTE[Object.keys(reg).length % USER_PALETTE.length], name: user.name };
    }
    entry.name = user.name;
    if (fixed) entry.color = fixed;
    reg[user.email] = entry;
    PropertiesService.getScriptProperties().setProperty("USER_REGISTRY", JSON.stringify(reg));
  } finally {
    lock.releaseLock();
  }
}

function userColor(email, name, reg) {
  if (email) {
    if (FIXED_USER_COLORS[email]) return FIXED_USER_COLORS[email];
    if (reg[email]) return reg[email].color;
    return NEUTRAL_COLOR;
  }
  // 예전에 등록된 일정(이메일 없이 이름만 있음)은 이름으로 찾아봄
  const keys = Object.keys(reg);
  for (var i = 0; i < keys.length; i++) {
    if (reg[keys[i]].name === name) return userColor(keys[i], name, reg);
  }
  return NEUTRAL_COLOR;
}

function buildLegend(reg) {
  return Object.keys(reg).map(function (email) {
    return { name: reg[email].name, color: userColor(email, reg[email].name, reg) };
  });
}

// ===================== 권한 =====================
function canEdit(ev, user) {
  if (ADMIN_EMAILS.indexOf(user.email) !== -1) return true;
  if (BLOG_EDITABLE_BY_ALL && ev.getTag("category") === BLOG_CATEGORY) return true;
  return ev.getTag("authorEmail") === user.email;
}

function getEditableEvent(id, user) {
  if (!id) throw new Error("일정 ID가 없습니다.");
  const ev = getCal().getEventById(id);
  if (!ev) throw new Error("일정을 찾을 수 없습니다. (이미 삭제되었을 수 있어요)");
  if (!canEdit(ev, user)) throw new Error("수정/삭제 권한이 없습니다. 작성자 본인만 가능합니다.");
  return ev;
}

// ===================== 조회 =====================
function getCal() {
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) throw new Error("캘린더를 찾을 수 없습니다. CALENDAR_ID 와 권한을 확인하세요.");
  return cal;
}

function getEvents(startStr, endStr, user) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (isNaN(start) || isNaN(end)) throw new Error("조회 기간이 올바르지 않습니다.");

  const tz = Session.getScriptTimeZone();
  const reg = loadRegistry();

  const events = getCal().getEvents(start, end).map(function (ev) {
    const category = ev.getTag("category") || "개인 일정";
    const authorName = ev.getTag("author") || "익명";
    const authorEmail = ev.getTag("authorEmail") || "";
    const allDay = ev.isAllDayEvent();
    // 블로그 협찬 = 공통 색 / 그 외 = 작성자별 고정 색
    const color = category === BLOG_CATEGORY ? BLOG_COLOR : userColor(authorEmail, authorName, reg);

    return {
      id: ev.getId(),
      title: ev.getTitle(),
      allDay: allDay,
      start: allDay ? Utilities.formatDate(ev.getAllDayStartDate(), tz, "yyyy-MM-dd") : ev.getStartTime().toISOString(),
      end: allDay ? Utilities.formatDate(ev.getAllDayEndDate(), tz, "yyyy-MM-dd") : ev.getEndTime().toISOString(),
      backgroundColor: color,
      borderColor: color,
      extendedProps: {
        category: category,
        author: authorName,
        platform: ev.getTag("platform") || "",
        memo: (ev.getDescription() || "").slice(0, 1000),
        canEdit: canEdit(ev, user),
      },
    };
  });

  return { events: events, legend: buildLegend(reg) };
}

// ===================== 입력 검증 =====================
function parseDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const p = s.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]); // 스크립트 타임존 기준 자정
  }
  const d = new Date(s);
  if (isNaN(d)) throw new Error("날짜 형식이 올바르지 않습니다.");
  return d;
}

function parseFields(data) {
  const title = String(data.title || "").trim();
  if (!title) throw new Error("제목을 입력하세요.");
  if (title.length > 100) throw new Error("제목은 100자 이하여야 합니다.");

  const category = data.category;
  if (CATEGORIES.indexOf(category) === -1) throw new Error("카테고리가 올바르지 않습니다.");

  var platform = "";
  if (category === BLOG_CATEGORY) {
    platform = String(data.platform || "").trim();
    if (!platform) throw new Error("협찬 플랫폼을 선택하거나 입력하세요.");
    if (platform.length > 30) throw new Error("플랫폼 이름은 30자 이하여야 합니다.");
  }

  const memo = String(data.memo || "").trim();
  if (memo.length > 500) throw new Error("메모는 500자 이하여야 합니다.");

  const allDay = !!data.allDay;
  const start = parseDate(data.start);
  var end = parseDate(data.end);
  if (end < start) throw new Error("종료 시간이 시작보다 빠릅니다.");
  if (allDay) {
    // 프론트는 '포함' 종료일을 보내므로 +1일 해서 exclusive 로 변환
    end = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  } else if (end.getTime() === start.getTime()) {
    throw new Error("종료 시간이 시작과 같습니다.");
  }

  return { title: title, category: category, platform: platform, memo: memo, allDay: allDay, start: start, end: end };
}

function writeFields(ev, f) {
  ev.setTitle(f.title);
  ev.setDescription(f.memo);
  ev.setTag("category", f.category);
  if (f.platform) ev.setTag("platform", f.platform);
  else ev.deleteTag("platform");
}

// ===================== 등록 / 수정 / 삭제 =====================
function addEvent(data, user) {
  const f = parseFields(data);
  const cal = getCal();
  const ev = f.allDay
    ? cal.createAllDayEvent(f.title, f.start, f.end)
    : cal.createEvent(f.title, f.start, f.end);

  writeFields(ev, f);
  ev.setTag("author", user.name);        // 클라이언트 값이 아닌 검증된 토큰의 정보
  ev.setTag("authorEmail", user.email);
}

function updateEvent(data, user) {
  const ev = getEditableEvent(data.id, user);
  const f = parseFields(data);

  if (f.allDay) {
    const oneDay = (f.end.getTime() - f.start.getTime()) <= 26 * 3600 * 1000;
    if (oneDay && typeof ev.setAllDayDate === "function") ev.setAllDayDate(f.start);
    else if (typeof ev.setAllDayDates === "function") ev.setAllDayDates(f.start, f.end);
    else throw new Error("이 환경에서는 종일 일정의 기간 수정을 지원하지 않습니다.");
  } else {
    ev.setTime(f.start, f.end);
  }
  writeFields(ev, f);
}

function deleteEvent(data, user) {
  getEditableEvent(data.id, user).deleteEvent();
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 권한 승인용 (에디터에서 한 번만 실행)
function authorize() {
  UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=test", { muteHttpExceptions: true });
  CalendarApp.getCalendarById(CALENDAR_ID);
  PropertiesService.getScriptProperties().getProperty("USER_REGISTRY");
  LockService.getScriptLock();
}
