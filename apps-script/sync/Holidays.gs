// ===== 공휴일 (공공데이터포털 '한국천문연구원 특일 정보') =====
//  - syncToCalendar(5분마다)가 syncHolidays() 를 부르지만, 실제로 받아오는 건 12시간에 한 번
//  - 작년·올해·내년 공휴일을 받아 Firestore config/holidays 에 { days: { 'yyyy-MM-dd': '이름' } } 로 저장
//  - 인증키는 코드(공개 저장소)에 넣지 않고 Apps Script '스크립트 속성' HOLIDAY_API_KEY 에 보관
//  - 앱은 공공데이터포털을 직접 부르지 못함(브라우저 호출 차단) → 여기서 받아서 넘겨줌

const HOLIDAY_API = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";
const HOLIDAY_REFRESH_MS = 12 * 3600 * 1000;

function syncHolidays(force) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty("HOLIDAY_API_KEY");
  if (!key) return;   // 인증키가 아직 등록되지 않음
  const last = Number(props.getProperty("HOLIDAY_SYNCED_AT") || 0);
  if (!force && Date.now() - last < HOLIDAY_REFRESH_MS) return;

  const year = Number(Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy"));
  const days = {};
  [year - 1, year, year + 1].forEach(function (y) {
    fetchHolidayYear(key, y).forEach(function (it) {
      days[it.date] = days[it.date] ? days[it.date] + " · " + it.name : it.name;
    });
  });
  if (!Object.keys(days).length) throw new Error("공휴일을 하나도 받지 못함");

  fsPatch("config/holidays", { days: days, updatedAt: new Date() });
  props.setProperty("HOLIDAY_SYNCED_AT", String(Date.now()));
  console.log("공휴일 " + Object.keys(days).length + "일 저장");
}

function fetchHolidayYear(key, year) {
  const url = HOLIDAY_API + "?serviceKey=" + encodeURIComponent(key) +
    "&solYear=" + year + "&numOfRows=100&_type=json";
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("공휴일 API 오류 " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200));
  const data = JSON.parse(res.getContentText());
  const head = data.response && data.response.header;
  if (!head || head.resultCode !== "00") throw new Error("공휴일 API 응답 오류: " + JSON.stringify(head));
  const body = data.response.body || {};
  let list = body.items && body.items.item;
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];   // 한 건이면 배열이 아니라 객체로 옴
  return list
    .filter(function (it) { return it.isHoliday === "Y"; })
    .map(function (it) {
      const s = String(it.locdate);
      return { date: s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8), name: String(it.dateName) };
    });
}

// 에디터에서 직접 실행: 12시간 기다리지 않고 지금 바로 받아오기
function testHolidays() {
  syncHolidays(true);
}
