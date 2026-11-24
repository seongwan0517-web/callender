/**
 * Time Schedule — Firestore → 구글 캘린더 동기화
 *
 * 웹앱(index.html)은 Firestore 에 일정을 저장하고,
 * 이 스크립트가 5분마다 Firestore 를 읽어 구글 캘린더에 "사본"을 만들어 둡니다.
 * (한쪽 방향: 캘린더에서 사본을 고쳐도 다음 동기화 때 Firestore 기준으로 되돌아갑니다)
 *
 * 처음 한 번:
 *   1) migrateFromCalendar 실행 — 예전 앱이 캘린더에 만든 일정을 Firestore 로 옮김
 *   2) setup 실행 — 5분마다 syncToCalendar 가 돌도록 트리거 등록
 *   3) setupReminders 실행 — 매일 아침 9시 푸시 알림(sendDailyReminders) 트리거 등록
 *      (시간이 정해진 협찬의 '1시간 전 알림'은 syncToCalendar 가 5분마다 함께 확인)
 *
 * 알림 테스트: sendTestPush 실행 → 관리자(내) 휴대폰으로 테스트 알림
 */

// ===================== 설정 =====================
const PROJECT_ID = "x-vector-455405-i9";
const CALENDAR_ID = "seongwan0517@gmail.com";   // 사본을 만들 구글 캘린더
const SYNC_PAST_DAYS = 90;      // 오늘 기준 이 기간 안의 일정만 캘린더와 맞춤
const SYNC_FUTURE_DAYS = 400;
const BLOG_CATEGORY = "블로그 협찬";
const CATEGORIES = ["회사 일정", "개인 일정", "블로그 협찬"];

const FS_BASE = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents";
const DAY = 24 * 3600 * 1000;

// ===================== 트리거 등록 =====================
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === "syncToCalendar"; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("syncToCalendar").timeBased().everyMinutes(5).create();
  syncToCalendar();
}

// ===================== 동기화 =====================
function syncToCalendar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 이전 실행이 아직 도는 중
  try {
    const cal = getCal();
    const winStart = new Date(Date.now() - SYNC_PAST_DAYS * DAY);
    const winEnd = new Date(Date.now() + SYNC_FUTURE_DAYS * DAY);

    // 캘린더에 이미 있는 사본 (fsId 태그로 구분)
    const copies = {};
    cal.getEvents(winStart, winEnd).forEach(function (ev) {
      const id = ev.getTag("fsId");
      if (!id) return;
      if (copies[id]) ev.deleteEvent(); // 혹시 생긴 중복은 정리
      else copies[id] = ev;
    });

    const seen = {};
    var created = 0, updated = 0, removed = 0;
    const docs = listDocs("events");

    docs.forEach(function (doc) {
      seen[doc.id] = true;
      const d = doc.data;
      const range = docRange(d);
      const copy = copies[doc.id];
      if (!range || range.start >= winEnd || range.end <= winStart) {
        if (copy) { copy.deleteEvent(); removed++; } // 기간 밖으로 옮겨진 일정
        return;
      }

      if (copy && copy.getTag("fsUpdated") === doc.updateTime) return; // 바뀐 게 없음

      if (copy) { copy.deleteEvent(); updated++; } else { created++; }
      createCopy(cal, doc, range);
    });

    Object.keys(copies).forEach(function (id) {
      if (!seen[id]) { copies[id].deleteEvent(); removed++; } // 앱에서 지운 일정
    });

    if (created || updated || removed) {
      console.log("동기화: 추가 " + created + ", 수정 " + updated + ", 삭제 " + removed);
    }

    // 5분마다 도는 김에 '약속 1시간 전' 알림도 확인 (실패해도 동기화에는 영향 없음)
    try { sendHourBeforeReminders(docs); } catch (e) { console.log("1시간 전 알림 실패: " + e.message); }
  } finally {
    lock.releaseLock();
  }
}

function docRange(d) {
  if (d.allDay) {
    const s = parseDay(d.start), e = parseDay(d.end);
    return s && e ? { start: s, end: e } : null;
  }
  const s = new Date(d.start), e = new Date(d.end);
  return isNaN(s) || isNaN(e) ? null : { start: s, end: e };
}

function createCopy(cal, doc, range) {
  const d = doc.data;
  const title = (d.done ? "✓ " : "") + d.title;
  var ev;
  if (d.allDay) {
    ev = (range.end - range.start) <= 26 * 3600 * 1000
      ? cal.createAllDayEvent(title, range.start)
      : cal.createAllDayEvent(title, range.start, range.end);
  } else {
    ev = cal.createEvent(title, range.start, range.end);
  }
  if (d.address) ev.setLocation(d.address);

  const lines = [];
  if (d.memo) lines.push(d.memo, "");
  lines.push("종류: " + (d.category || ""));
  if (d.done) lines.push("상태: 완료" + (d.doneAt ? " (" + d.doneAt + ")" : ""));
  if (d.platform) lines.push("플랫폼: " + d.platform);
  if (d.deadline) lines.push("제출 마감: " + d.deadline);
  if (d.contentTypes && d.contentTypes.length) lines.push("콘텐츠: " + d.contentTypes.join(", "));
  if (d.link) lines.push("캠페인 링크: " + d.link);
  if (d.productValue || d.adFee || d.myCost) {
    const won = function (n) { return Number(n || 0).toLocaleString("ko-KR") + "원"; };
    lines.push("상품 가치 " + won(d.productValue) + " / 광고비 " + won(d.adFee) + " / 지출 " + won(d.myCost));
  }
  lines.push("작성자: " + (d.authorName || "익명") + (d.authorEmail ? " (" + d.authorEmail + ")" : ""));
  lines.push("", "※ Time Schedule 앱에서 동기화된 일정입니다. 수정은 앱에서 하세요.");
  ev.setDescription(lines.join("\n"));
  if (d.category === BLOG_CATEGORY) ev.setColor(CalendarApp.EventColor.MAUVE);

  ev.setTag("fsId", doc.id);
  ev.setTag("fsUpdated", doc.updateTime);
}

// ===================== 예전 일정 옮기기 (한 번만) =====================
// 예전 앱(Apps Script 버전)이 캘린더에 만든 일정(category 태그가 있는 것)을 Firestore 로 복사합니다.
// 옮긴 일정은 캘린더의 원본이 그대로 "사본" 역할을 하므로 중복이 생기지 않습니다.
// 여러 번 실행해도 이미 옮긴 일정(fsId 태그)은 건너뜁니다.
function migrateFromCalendar() {
  const cal = getCal();
  const tz = Session.getScriptTimeZone();
  const from = new Date(); from.setFullYear(from.getFullYear() - 2);
  const to = new Date(); to.setFullYear(to.getFullYear() + 2);
  var moved = 0, skipped = 0;

  cal.getEvents(from, to).forEach(function (ev) {
    if (ev.getTag("fsId")) { skipped++; return; }
    var category = ev.getTag("category");
    if (!category) { skipped++; return; } // 앱에서 만든 일정이 아님 (개인 캘린더 일정)
    if (CATEGORIES.indexOf(category) === -1) category = "개인 일정";

    const allDay = ev.isAllDayEvent();
    const start = allDay ? ev.getAllDayStartDate() : ev.getStartTime();
    const end = allDay ? ev.getAllDayEndDate() : ev.getEndTime();
    var platform = category === BLOG_CATEGORY ? (ev.getTag("platform") || "기타") : "";
    const nowDate = new Date();

    const fields = {
      title: String(ev.getTitle() || "(제목 없음)").slice(0, 100),
      category: category,
      platform: platform.slice(0, 30),
      memo: String(ev.getDescription() || "").slice(0, 500),
      allDay: allDay,
      start: allDay ? Utilities.formatDate(start, tz, "yyyy-MM-dd") : start.toISOString(),
      end: allDay ? Utilities.formatDate(end, tz, "yyyy-MM-dd") : end.toISOString(),
      startTs: start,
      endTs: end,
      authorEmail: ev.getTag("authorEmail") || "",
      authorName: String(ev.getTag("author") || "익명").slice(0, 100),
      createdAt: nowDate,
      updatedAt: nowDate,
    };

    const doc = fsFetch("/events", { method: "post", payload: { fields: toFields(fields) } });
    ev.setTag("fsId", doc.name.split("/").pop());
    ev.setTag("fsUpdated", doc.updateTime);
    moved++;
  });

  console.log("옮긴 일정: " + moved + "개, 건너뜀: " + skipped + "개");
}

// ===================== 푸시 알림 =====================
// 매일 아침: 오늘 체험/일정 + 오늘·내일 제출 마감을 사람별로 묶어서 한 번 보냄
//  - 블로그 협찬: 알림을 켠 멤버 전원
//  - 회사/개인 일정: 등록한 사람
const REMINDER_HOUR = 9;
// firestore.rules / index.html 의 관리자와 같게 유지
const ADMIN_EMAILS = ["seongwan0517@gmail.com"];

// 알림 받을 기기: 지금 멤버(관리자 + config/access 목록)인 사람의 기기만
// (멤버에서 빠진 사람은 휴대폰에 토큰이 남아 있어도 알림을 받지 않음)
function activeTokens() {
  var members = ADMIN_EMAILS.slice();
  try {
    const doc = fsFetch("/config/access");
    const v = doc.fields && doc.fields.emails && doc.fields.emails.arrayValue;
    ((v && v.values) || []).forEach(function (x) { if (x.stringValue) members.push(x.stringValue.toLowerCase()); });
  } catch (e) { console.log("멤버 목록을 못 읽음: " + e.message); }
  return listDocs("pushTokens").filter(function (t) {
    return members.indexOf(String(t.data.email || "").toLowerCase()) !== -1;
  });
}

function setupReminders() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === "sendDailyReminders"; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendDailyReminders").timeBased()
    .atHour(REMINDER_HOUR).nearMinute(0).everyDays(1).inTimezone("Asia/Seoul").create();
}

function sendDailyReminders() {
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const tomorrow = Utilities.formatDate(new Date(Date.now() + DAY), tz, "yyyy-MM-dd");

  const tokens = activeTokens();
  if (!tokens.length) return;
  const everyone = unique(tokens.map(function (t) { return t.data.email; }));

  const perUser = {};
  function add(emails, kind, text) {
    emails.forEach(function (e) {
      if (!e) return;
      const u = perUser[e] || (perUser[e] = { visits: [], deadlines: [] });
      u[kind].push(text);
    });
  }

  listDocs("events").forEach(function (doc) {
    const d = doc.data;
    if (d.done) return;   // 완료한 협찬은 알리지 않음
    const to = d.category === BLOG_CATEGORY ? everyone : [d.authorEmail];
    if (coversDay(d, today, tz)) {
      const time = d.allDay ? "" : Utilities.formatDate(new Date(d.start), tz, "HH:mm") + " ";
      add(to, "visits", time + d.title + (d.address ? " · " + String(d.address).split(" ").slice(0, 3).join(" ") : ""));
    }
    if (d.category === BLOG_CATEGORY && d.deadline === today) add(to, "deadlines", "오늘 마감 · " + d.title);
    if (d.category === BLOG_CATEGORY && d.deadline === tomorrow) add(to, "deadlines", "내일 마감 · " + d.title);
  });

  var sent = 0, removed = 0;
  Object.keys(perUser).forEach(function (email) {
    const u = perUser[email];
    const parts = [];
    if (u.visits.length) parts.push("오늘 일정 " + u.visits.length + "개");
    if (u.deadlines.length) parts.push("마감 " + u.deadlines.length + "개");
    const items = u.deadlines.concat(u.visits);
    const body = items.slice(0, 4).join("\n") + (items.length > 4 ? "\n외 " + (items.length - 4) + "개" : "");
    tokens.filter(function (t) { return t.data.email === email; }).forEach(function (t) {
      const r = sendPush(t.id, "📅 " + parts.join(" · "), body, "daily-" + today);
      if (r === "sent") sent++;
      if (r === "invalid") { deleteDoc("pushTokens", t.id); removed++; }
    });
  });
  console.log("알림 발송 " + sent + "건, 만료 토큰 정리 " + removed + "건");
}

// 시간이 정해진 협찬 일정: 약속 1시간 전에 알림 (협찬이므로 알림을 켠 멤버 전원)
// syncToCalendar(5분마다)가 부르며, 같은 일정·같은 시각에는 한 번만 보냄 (시간을 바꾸면 다시 보냄)
const BEFORE_MINUTES = 60;

function sendHourBeforeReminders(docs) {
  const now = Date.now();
  const tz = Session.getScriptTimeZone();
  const props = PropertiesService.getScriptProperties();
  const sent = JSON.parse(props.getProperty("PRE_SENT") || "{}");
  var changed = false;
  Object.keys(sent).forEach(function (k) { if (sent[k] < now - 2 * DAY) { delete sent[k]; changed = true; } });

  const due = docs.filter(function (doc) {
    const d = doc.data;
    if (d.category !== BLOG_CATEGORY || d.allDay || d.done || !d.start) return false;
    const until = (new Date(d.start).getTime() - now) / 60000;
    return until > 0 && until <= BEFORE_MINUTES && !sent[doc.id + "|" + d.start];
  });

  if (due.length) {
    const tokens = activeTokens();
    due.forEach(function (doc) {
      const d = doc.data;
      const mins = Math.max(1, Math.round((new Date(d.start).getTime() - now) / 60000));
      const when = mins >= 55 ? "1시간" : mins + "분";
      const title = "⏰ " + when + " 뒤 협찬 일정";
      const body = Utilities.formatDate(new Date(d.start), tz, "HH:mm") + " " + d.title + (d.address ? "\n📍 " + d.address : "");
      tokens.forEach(function (t) {
        if (sendPush(t.id, title, body, "pre-" + doc.id) === "invalid") deleteDoc("pushTokens", t.id);
      });
      sent[doc.id + "|" + d.start] = now;
      changed = true;
      console.log("1시간 전 알림: " + d.title);
    });
  }
  if (changed) props.setProperty("PRE_SENT", JSON.stringify(sent));
}

// 테스트: 관리자(스크립트 소유자) 기기로 알림 한 번 보내기
function sendTestPush() {
  const me = Session.getEffectiveUser().getEmail();
  const mine = listDocs("pushTokens").filter(function (t) { return t.data.email === me; });
  if (!mine.length) { console.log(me + " 계정으로 알림을 켠 기기가 없습니다. 앱의 내 정보 → 알림 켜기를 먼저 해 주세요."); return; }
  mine.forEach(function (t) {
    console.log((t.data.platform || "").slice(0, 40) + " → " + sendPush(t.id, "🔔 테스트 알림", "Time Schedule 알림이 잘 도착했어요!", "test"));
  });
}

// 일정이 그 날짜(yyyy-MM-dd)에 걸쳐 있는지
function coversDay(d, day, tz) {
  if (!d.start || !d.end) return false;
  if (d.allDay) return d.start <= day && day < d.end;          // end 는 다음 날(exclusive)
  const s = Utilities.formatDate(new Date(d.start), tz, "yyyy-MM-dd");
  const e = Utilities.formatDate(new Date(d.end), tz, "yyyy-MM-dd");
  return s <= day && day <= e;
}

// FCM HTTP v1 으로 웹 푸시 1건 발송 → "sent" | "invalid"(만료/삭제된 기기) | "error"
function sendPush(token, title, body, tag) {
  const res = UrlFetchApp.fetch("https://fcm.googleapis.com/v1/projects/" + PROJECT_ID + "/messages:send", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "x-goog-user-project": PROJECT_ID },
    payload: JSON.stringify({
      message: {
        token: token,
        data: { title: title, body: body, url: "/", tag: tag || "time-schedule" },
        webpush: { headers: { Urgency: "high", TTL: "43200" } },
      },
    }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 200) return "sent";
  const text = res.getContentText();
  if (code === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text)) return "invalid";
  console.log("FCM 오류 " + code + ": " + text.slice(0, 300));
  return "error";
}

function unique(arr) {
  return arr.filter(function (v, i) { return v && arr.indexOf(v) === i; });
}

function deleteDoc(collection, id) {
  try { fsFetch("/" + collection + "/" + encodeURIComponent(id), { method: "delete" }); }
  catch (e) { console.log("삭제 실패: " + e.message); }
}

// ===================== Firestore REST =====================
function fsFetch(path, opt) {
  opt = opt || {};
  const params = {
    method: opt.method || "get",
    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken(),
      "x-goog-user-project": PROJECT_ID,
    },
    muteHttpExceptions: true,
  };
  if (opt.payload) {
    params.contentType = "application/json";
    params.payload = JSON.stringify(opt.payload);
  }
  const res = UrlFetchApp.fetch(FS_BASE + path, params);
  const code = res.getResponseCode();
  if (code >= 300) throw new Error("Firestore 오류 " + code + ": " + res.getContentText().slice(0, 500));
  return JSON.parse(res.getContentText() || "{}");
}

function listDocs(collection) {
  const out = [];
  var token = "";
  do {
    const r = fsFetch("/" + collection + "?pageSize=300" + (token ? "&pageToken=" + encodeURIComponent(token) : ""));
    (r.documents || []).forEach(function (doc) {
      out.push({ id: doc.name.split("/").pop(), updateTime: doc.updateTime, data: fromFields(doc.fields || {}) });
    });
    token = r.nextPageToken || "";
  } while (token);
  return out;
}

function toFields(obj) {
  const f = {};
  Object.keys(obj).forEach(function (k) {
    const v = obj[k];
    if (v instanceof Date) f[k] = { timestampValue: v.toISOString() };
    else if (typeof v === "boolean") f[k] = { booleanValue: v };
    else if (typeof v === "number") f[k] = { doubleValue: v };
    else if (v === null || v === undefined) f[k] = { nullValue: null };
    else f[k] = { stringValue: String(v) };
  });
  return f;
}

function fromFields(fields) {
  const o = {};
  Object.keys(fields).forEach(function (k) {
    const v = fields[k];
    if ("stringValue" in v) o[k] = v.stringValue;
    else if ("booleanValue" in v) o[k] = v.booleanValue;
    else if ("timestampValue" in v) o[k] = new Date(v.timestampValue);
    else if ("integerValue" in v) o[k] = Number(v.integerValue);
    else if ("doubleValue" in v) o[k] = v.doubleValue;
    else o[k] = null;
  });
  return o;
}

// ===================== 공통 =====================
function getCal() {
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) throw new Error("캘린더를 찾을 수 없습니다. CALENDAR_ID 를 확인하세요.");
  return cal;
}

function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
