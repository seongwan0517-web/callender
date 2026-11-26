// =====================================================================
// 가계부 (예산 보기) — 타임 스케줄과는 완전히 별개
//  - 시트 → 앱: 총괄/수입/지출/고정비용 탭을 읽어 Firestore budget/summary 에 요약 저장
//  - 앱 → 시트: 앱에서 넣은 보너스·카드값·관리비(budgetEdits, status=pending)를 시트 칸에 반영
//  - 앱은 BUDGET_EDITABLE 에 적힌 칸에만 쓰고, 수식이 있는 칸은 절대 바꾸지 않음
//  - syncToCalendar(5분마다)가 syncBudget() 을 부름
// =====================================================================
const BUDGET_SHEET_ID = "19z2iQpS194QSZwUcuK-gFkiNldqJgAmQ3jei20e-_AM";   // 구글 드라이브 '가계부'
const BUDGET_TABS = {
  summary: "총괄 표지(최종)",
  income: "수입(최종)",
  spend: "지출(최종)",
  fixed: "고정비용(최종)",
};
// 자산(예적금·비트·주식·IRP 등)은 정확하지 않아서 앱으로 가져오지 않음 — '계산서 총괄' 탭은 읽지 않는다
const BUDGET_PEOPLE = ["다훈", "성완"];
const BUDGET_EDITABLE = {
  bonus:   { tab: "income", items: { "다훈": ["보너스(회사)"], "성완": ["보너스(회사)"] } },
  card:    { tab: "spend",  items: { "다훈": ["삼성카드", "신한카드", "백화점카드"], "성완": ["신한카드", "국민카드", "삼성카드(주유)"] } },
  utility: { tab: "fixed",  items: { "다훈": ["관리비", "가스비"] } },
};

// 테스트할 때만 스크립트 속성 BUDGET_SHEET_ID 로 사본 시트를 가리킬 수 있음
function budgetSheetId() {
  return PropertiesService.getScriptProperties().getProperty("BUDGET_SHEET_ID") || BUDGET_SHEET_ID;
}

function syncBudget() {
  const ss = SpreadsheetApp.openById(budgetSheetId());
  const applied = processBudgetEdits(ss);
  writeBudgetSummary(ss, applied);
}

// ---------- 시트 탭 → 표 모델 ----------
// 머리글(병합 셀)을 펼쳐서 칸마다 { group: '다훈'|'성완'|'특별예산'..., label: '신한카드' } 를 붙이고,
// 데이터 줄마다 { ym: '2025-08', r: 0부터 센 행 번호 } 를 붙인다.
function readBudgetTab(ss, key) {
  const name = BUDGET_TABS[key];
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error("시트에 '" + name + "' 탭이 없습니다.");
  const range = sh.getDataRange();
  const values = range.getValues();
  const formulas = range.getFormulas();

  // 데이터 줄: B열이 'N월', A열(병합)은 'YYYY년'
  const rows = [];
  var year = null, firstData = -1;
  for (var r = 0; r < values.length; r++) {
    const a = String(values[r][0] || "").trim();
    const b = String(values[r][1] || "").trim();
    const yy = /^(\d{4})년$/.exec(a);
    if (yy) year = Number(yy[1]);
    const mm = /^(\d{1,2})월$/.exec(b);
    if (mm && year) {
      if (firstData < 0) firstData = r;
      rows.push({ r: r, ym: year + "-" + ("0" + mm[1]).slice(-2) });
    }
  }
  if (firstData < 0) throw new Error("'" + name + "' 탭에서 월 데이터를 찾지 못했습니다.");

  // 사람/묶음 머리글 줄: 데이터 위에서 '다훈'이나 '성완'이 있는 줄
  var groupRow = -1;
  for (var h = 0; h < firstData; h++) {
    const hasPerson = values[h].some(function (v) { return BUDGET_PEOPLE.indexOf(String(v).trim()) !== -1; });
    if (hasPerson) { groupRow = h; break; }
  }
  const nCols = values[0].length;
  const cols = [];
  var lastGroup = "";
  for (var c = 0; c < nCols; c++) {
    var g = groupRow >= 0 ? String(values[groupRow][c] || "").trim() : "";
    if (g) lastGroup = g; else g = lastGroup;
    // 칸 이름: 머리글 줄 중 가장 아래의 값 (병합돼서 비어 있으면 그 위 값)
    var label = "";
    for (var hh = firstData - 1; hh >= 0; hh--) {
      if (hh === groupRow) continue;
      const v = String(values[hh][c] || "").trim();
      if (v) { label = v; break; }
    }
    cols.push({ c: c, group: groupRow >= 0 ? g : "", label: cleanBudgetLabel(label) });
  }
  return { name: name, sheet: sh, values: values, formulas: formulas, rows: rows, cols: cols };
}

// 줄바꿈 정리 + 계좌번호 같은 긴 숫자는 지움
function cleanBudgetLabel(s) {
  return String(s || "").replace(/\s+/g, " ").replace(/\d{6,}/g, "").replace(/\(\s*\)/g, "").trim();
}

function budgetNum(v) {
  if (typeof v === "number") return v;
  const n = Number(String(v || "").replace(/[^\d.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function findBudgetCol(m, person, item) {
  return m.cols.filter(function (x) { return x.group === person && x.label === item; })[0]
      || m.cols.filter(function (x) { return x.group === person && x.label.indexOf(item) === 0; })[0];
}

// ---------- 앱 입력 → 시트 ----------
function processBudgetEdits(ss) {
  const pending = fsQueryEq("budgetEdits", "status", "pending");
  if (!pending.length) return 0;
  const models = {};
  var applied = 0;
  pending.sort(function (a, b) { return String(a.data.createdAt).localeCompare(String(b.data.createdAt)); });
  pending.forEach(function (doc) {
    const e = doc.data;
    try {
      const rule = BUDGET_EDITABLE[e.kind];
      if (!rule) throw new Error("앱에서 고칠 수 없는 종류입니다.");
      if ((rule.items[e.person] || []).indexOf(e.item) === -1) throw new Error("앱에서 고칠 수 없는 칸입니다: " + e.person + " " + e.item);
      const m = models[rule.tab] || (models[rule.tab] = readBudgetTab(ss, rule.tab));

      const row = m.rows.filter(function (x) { return x.ym === e.ym; })[0];
      if (!row) throw new Error("시트 '" + m.name + "' 에 " + e.ym + " 줄이 없습니다. 시트에 그 달 줄을 먼저 만들어 주세요.");
      const col = findBudgetCol(m, e.person, e.item);
      if (!col) throw new Error("시트 '" + m.name + "' 에서 " + e.person + " · " + e.item + " 칸을 찾지 못했습니다.");
      if (m.formulas[row.r][col.c]) throw new Error("수식이 있는 칸이라 앱에서 바꾸지 않았습니다. 시트에서 직접 고쳐 주세요.");

      const prev = budgetNum(m.values[row.r][col.c]);
      const amount = Number(e.amount) || 0;
      const next = e.mode === "add" ? prev + amount : amount;
      m.sheet.getRange(row.r + 1, col.c + 1).setValue(next);
      m.values[row.r][col.c] = next;
      fsPatch("budgetEdits/" + doc.id, {
        status: "done", prev: prev, result: next,
        cell: m.name + "!" + colLetter(col.c) + (row.r + 1), doneAt: new Date(),
      });
      applied++;
    } catch (err) {
      fsPatch("budgetEdits/" + doc.id, { status: "error", error: String(err.message || err).slice(0, 200), doneAt: new Date() });
    }
  });
  if (applied) SpreadsheetApp.flush();
  console.log("가계부 입력 반영 " + applied + "건 / 대기 " + pending.length + "건");
  return applied;
}

function colLetter(c) {
  var s = "", n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------- 시트 → 앱 요약 ----------
function writeBudgetSummary(ss) {
  const sum = readBudgetTab(ss, "summary");
  const income = readBudgetTab(ss, "income");
  const spend = readBudgetTab(ss, "spend");
  const fixed = readBudgetTab(ss, "fixed");

  function val(m, r, label) {
    const c = m.cols.filter(function (x) { return x.label === label; })[0];
    return c ? budgetNum(m.values[r][c.c]) : 0;
  }

  // 월별 총괄
  const months = sum.rows.map(function (row) {
    return {
      ym: row.ym,
      income: val(sum, row.r, "수입"),
      fixed: val(sum, row.r, "고정비용"),
      spend: val(sum, row.r, "지출"),
      settle: val(sum, row.r, "월말 정산"),
    };
  }).filter(function (m) { return m.income || m.fixed || m.spend; });

  // 탭별 상세: { ym: { 묶음: { 칸: 금액 } } } — 숫자가 있는 칸만
  function detail(m) {
    const out = {};
    m.rows.forEach(function (row) {
      const g = {};
      m.cols.forEach(function (col) {
        if (col.c < 3 || !col.label) return;              // 연도·월·총합 열 제외
        const v = m.values[row.r][col.c];
        if (typeof v !== "number") return;
        const grp = col.group || "기타";
        (g[grp] = g[grp] || {})[col.label] = v;
      });
      if (Object.keys(g).length) out[row.ym] = g;
    });
    return out;
  }

  // 앱 입력창에 보여줄 현재 값 (고칠 수 있는 칸만) — "YYYY-MM|종류|사람|칸" → { v: 금액, f: 수식 여부 }
  const editable = {};
  Object.keys(BUDGET_EDITABLE).forEach(function (kind) {
    const rule = BUDGET_EDITABLE[kind];
    const m = { income: income, spend: spend, fixed: fixed }[rule.tab];
    m.rows.forEach(function (row) {
      Object.keys(rule.items).forEach(function (person) {
        rule.items[person].forEach(function (item) {
          const col = findBudgetCol(m, person, item);
          if (!col) return;
          editable[row.ym + "|" + kind + "|" + person + "|" + item] = {
            v: budgetNum(m.values[row.r][col.c]), f: !!m.formulas[row.r][col.c],
          };
        });
      });
    });
  });

  fsPatch("budget/summary", {
    updatedAt: new Date(),
    months: months,
    income: detail(income),
    spend: detail(spend),
    fixed: detail(fixed),
    assets: {},          // 예전에 저장한 자산 정보 비우기
    editable: editable,
  });
}

// 진단용: 시트 구조와 앱 입력 칸 위치·수식 여부를 로그로 확인 (시트는 바꾸지 않음)
function inspectBudgetSheet() {
  const ss = SpreadsheetApp.openById(budgetSheetId());
  console.log("시트: " + ss.getName());
  Object.keys(BUDGET_TABS).forEach(function (key) {
    const m = readBudgetTab(ss, key);
    console.log("[" + m.name + "] 데이터 " + m.rows.length + "줄 (" + (m.rows[0] || {}).ym + " ~ " + (m.rows[m.rows.length - 1] || {}).ym + ")");
    console.log("  칸: " + m.cols.filter(function (c) { return c.label; }).map(function (c) {
      return colLetter(c.c) + "=" + (c.group ? c.group + "/" : "") + c.label;
    }).join(", "));
  });
  Object.keys(BUDGET_EDITABLE).forEach(function (kind) {
    const rule = BUDGET_EDITABLE[kind];
    const m = readBudgetTab(ss, rule.tab);
    Object.keys(rule.items).forEach(function (person) {
      rule.items[person].forEach(function (item) {
        const col = findBudgetCol(m, person, item);
        if (!col) { console.log("  ✗ " + kind + " " + person + " " + item + " → 칸 없음"); return; }
        const withFormula = m.rows.filter(function (x) { return !!m.formulas[x.r][col.c]; }).length;
        console.log("  ✓ " + kind + " " + person + " " + item + " → " + m.name + " " + colLetter(col.c) + "열, 수식 있는 줄 " + withFormula + "/" + m.rows.length);
      });
    });
  });
}

// ---------- Firestore REST 보조 ----------
function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") {
    const f = {};
    Object.keys(v).forEach(function (k) { f[k] = toFsValue(v[k]); });
    return { mapValue: { fields: f } };
  }
  return { stringValue: String(v) };
}

// 문서의 일부 필드만 덮어쓰기 (없으면 새로 만듦)
function fsPatch(path, obj) {
  const fields = {};
  Object.keys(obj).forEach(function (k) { fields[k] = toFsValue(obj[k]); });
  const mask = Object.keys(obj).map(function (k) { return "updateMask.fieldPaths=" + encodeURIComponent(k); }).join("&");
  return fsFetch("/" + path + "?" + mask, { method: "patch", payload: { fields: fields } });
}

// 필드 == 값 인 문서 찾기
function fsQueryEq(collection, field, value) {
  const res = UrlFetchApp.fetch(FS_BASE + ":runQuery", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "x-goog-user-project": PROJECT_ID },
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: toFsValue(value) } },
      limit: 50,
    } }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error("Firestore 조회 오류 " + res.getResponseCode() + ": " + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText())
    .filter(function (x) { return x.document; })
    .map(function (x) { return { id: x.document.name.split("/").pop(), data: fromFields(x.document.fields || {}) }; });
}

// 진단용: 특정 달의 수입·고정비용 줄을 칸 이름과 함께 그대로 로그로 보여줌 (시트는 바꾸지 않음)
function debugBudgetMonths() {
  const yms = ["2026-10", "2026-11", "2026-12"];
  const ss = SpreadsheetApp.openById(budgetSheetId());
  ["income", "fixed"].forEach(function (key) {
    const m = readBudgetTab(ss, key);
    console.log("[" + m.name + "] 월 줄: " + m.rows.map(function (x) { return x.ym + "@" + (x.r + 1); }).join(", "));
    m.rows.filter(function (x) { return yms.indexOf(x.ym) !== -1; }).forEach(function (row) {
      const cells = m.cols.filter(function (c) { return c.c >= 2; }).map(function (c) {
        const v = m.values[row.r][c.c], f = m.formulas[row.r][c.c];
        return colLetter(c.c) + "(" + (c.group ? c.group + "/" : "") + c.label + ")=" + JSON.stringify(v) + (f ? " 수식" : "");
      });
      console.log("  " + row.ym + " (" + (row.r + 1) + "행): " + cells.join(" | "));
    });
  });
}
