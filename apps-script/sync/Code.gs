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

    listDocs("events").forEach(function (doc) {
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
  var ev;
  if (d.allDay) {
    ev = (range.end - range.start) <= 26 * 3600 * 1000
      ? cal.createAllDayEvent(d.title, range.start)
      : cal.createAllDayEvent(d.title, range.start, range.end);
  } else {
    ev = cal.createEvent(d.title, range.start, range.end);
  }

  const lines = [];
  if (d.memo) lines.push(d.memo, "");
  lines.push("종류: " + (d.category || ""));
  if (d.platform) lines.push("플랫폼: " + d.platform);
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
