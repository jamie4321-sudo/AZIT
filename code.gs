// ============================================================
//  Code.gs — Sprout Manager v5
// ============================================================

var CONFIG = {
  SPREADSHEET_ID: '14MvDfI2OcezzRhmXkq8LYTjTL5cIMg0DOeeAJ4M1mWY',

  SHEET: {
    CREW:      '크루',
    SPOTS:     '스팟목록',
    RECORDS:   '완료기록',
    SCHEDULE:  '오늘스케줄',
    ASSIGNEE:  '담당자배정',
  },

  CREW_COL:   { NAME:0, ROLE:1, PART:2, ACTIVE:3, IS_MANAGER:4, PIN:5 },
  SPOT_COL:   { ZONE:0, FLOOR:1, SECTION:2, NAME:3, QTY:4, NOTICE:5, ACTIVE:6, DETAIL:7 },  // H열: 상세내용(쉼표구분)
  RECORD_COL: { DATE:0, CREW:1, ZONE:2, FLOOR:3, SECTION:4, SPOT:5, DONE:6, TIME:7, MEMO:8, MEMO_WHO:9 },
  SCHEDULE_COL: { DATE:0, ZONE:1, FLOOR:2 },
  ASSIGNEE_COL: { DATE:0, ZONE:1, FLOOR:2, TEAM:3, CREWS:4 },

  TEAMS: ['조르디 웨스트','조르디 이스트','조르디 오아시스','라이언 웨스트','라이언 이스트','라이언 오아시스'],

  APP: { TITLE: 'Sprout Manager', KEEP_DAYS: 90 },
};

function getSpreadsheet(){ return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID); }
function getSheet(name){
  var s=getSpreadsheet().getSheetByName(name);
  if(!s) throw new Error('시트 없음: '+name);
  return s;
}
function safeReturn(fn){
  try{ return {success:true,data:fn()}; }
  catch(e){ Logger.log('ERROR: '+e.message); return {success:false,error:e.message}; }
}
function toKST(fmt){ return Utilities.formatDate(new Date(),'Asia/Seoul',fmt); }
function makeItemId(zone,floor,section,spot){
  var raw=[zone,floor,section,spot].join('-'),h=0;
  for(var i=0;i<raw.length;i++){ h=((h<<5)-h)+raw.charCodeAt(i); h|=0; }
  return 'id'+Math.abs(h);
}

function doGet(){
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(CONFIG.APP.TITLE)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport','width=device-width,initial-scale=1.0');
}

// ── API ────────────────────────────────────────────────────

function getCrewList(){
  return safeReturn(function(){ return _getCrewList(); });
}

/** PIN 검증 — 숫자 배열 또는 문자열 모두 처리 */
function verifyManagerPin(crewName, pin){
  return safeReturn(function(){
    var list=_getCrewList();
    for(var i=0;i<list.length;i++){
      if(list[i].name===crewName){
        if(!list[i].isManager) return {ok:false,reason:'매니저 아님'};
        var stored=String(list[i].pin||'').trim();
        // PIN 미설정이면 무조건 통과
        if(!stored) return {ok:true};
        var input=String(pin).trim();
        return {ok: stored===input};
      }
    }
    return {ok:false,reason:'크루 없음'};
  });
}

/**
 * 앱 초기 로드
 * - isManager: 서버에서 다시 확인 (클라이언트 신뢰 안 함)
 * - 크루: 스케줄 있으면 해당 층만, 없으면 전체 스팟 표시
 */
function loadAppData(crewName){
  return safeReturn(function(){
    var allSpots  = _getSpotsWithStatus(crewName);
    var schedule  = _getTodaySchedule();
    var assignees = _getTodayAssignees();
    var isManager = _isManager(crewName);
    var crewList  = _getCrewList();

    // 필터링 우선순위 (매니저 포함 공통):
    // 1) 크루: 담당자 배정이 있으면 → 본인 배정 층만
    // 2) 스케줄이 있으면 → 스케줄 층만 (매니저/크루 공통)
    // 3) 둘 다 없으면 → 전체 스팟
    var filteredSpots = allSpots;

    if(!isManager){
      // 크루: 담당자 배정 우선
      var myAssigned = assignees.filter(function(a){
        return a.crews.indexOf(crewName)>=0 || a.crews.indexOf('공동')>=0;
      });
      if(myAssigned.length>0){
        var assignSet={};
        myAssigned.forEach(function(a){ assignSet[a.zone+'|'+a.floor]=true; });
        var assignFiltered={};
        Object.keys(allSpots).forEach(function(z){
          Object.keys(allSpots[z].floors).forEach(function(f){
            if(assignSet[z+'|'+f]){
              if(!assignFiltered[z]) assignFiltered[z]={floors:{}};
              assignFiltered[z].floors[f]=allSpots[z].floors[f];
            }
          });
        });
        if(Object.keys(assignFiltered).length>0) filteredSpots=assignFiltered;
        else if(schedule.length>0){
          var sf=_filterBySchedule(allSpots,schedule);
          if(Object.keys(sf).length>0) filteredSpots=sf;
        }
      } else if(schedule.length>0){
        var sf2=_filterBySchedule(allSpots,schedule);
        if(Object.keys(sf2).length>0) filteredSpots=sf2;
      }
    } else {
      // 매니저도 스케줄이 있으면 스케줄 층만 표시
      if(schedule.length>0){
        var mgrFiltered=_filterBySchedule(allSpots,schedule);
        if(Object.keys(mgrFiltered).length>0) filteredSpots=mgrFiltered;
      }
    }

    return {
      spots:     filteredSpots,
      allSpots:  allSpots,
      schedule:  schedule,
      assignees: assignees,
      isManager: isManager,
      crewList:  crewList,
      teams:     CONFIG.TEAMS,
      today:     toKST('yyyy-MM-dd'),
    };
  });
}

function recordCheck(p){
  return safeReturn(function(){
    var sheet=getSheet(CONFIG.SHEET.RECORDS),col=CONFIG.RECORD_COL;
    var today=toKST('yyyy-MM-dd'),time=toKST('HH:mm:ss');
    var rows=sheet.getDataRange().getValues(),found=-1;
    for(var i=1;i<rows.length;i++){
      var r=rows[i];
      if(r[col.DATE]===today&&r[col.CREW]===p.crewName&&r[col.ZONE]===p.zone&&
         r[col.FLOOR]===p.floor&&r[col.SECTION]===p.section&&r[col.SPOT]===p.spot){found=i+1;break;}
    }
    var row=_buildRecordRow(today,time,p,p.checked);
    if(found>0) sheet.getRange(found,1,1,row.length).setValues([row]);
    else        sheet.appendRow(row);
    return {recorded:true,time:time};
  });
}

function recordFloorComplete(p){
  return safeReturn(function(){
    var sheet=getSheet(CONFIG.SHEET.RECORDS);
    var today=toKST('yyyy-MM-dd'),time=toKST('HH:mm:ss');
    _deleteTodayFloorRows(sheet,today,p.crewName,p.zone,p.floor);
    if(p.items.length>0){
      var newRows=p.items.map(function(item){
        return _buildRecordRow(today,time,{crewName:p.crewName,zone:p.zone,floor:p.floor,
          section:item.section,spot:item.spot,memo:item.memo||'',memoWho:item.memoWho||''},true);
      });
      sheet.getRange(sheet.getLastRow()+1,1,newRows.length,10).setValues(newRows);
    }
    return {recorded:true,count:p.items.length,time:time};
  });
}

function saveSchedule(p){
  return safeReturn(function(){
    var sheet=getSheet(CONFIG.SHEET.SCHEDULE),col=CONFIG.SCHEDULE_COL;
    var today=toKST('yyyy-MM-dd');
    // 날짜 비교 시 Date 객체 / 문자열 모두 처리
    var rows=sheet.getDataRange().getValues();
    for(var i=rows.length-1;i>=1;i--){
      if(_dateToStr(rows[i][col.DATE])===today) sheet.deleteRow(i+1);
    }
    if(p.items&&p.items.length>0){
      var nr=p.items.map(function(it){ return [today,it.zone,it.floor]; });
      sheet.getRange(sheet.getLastRow()+1,1,nr.length,3).setValues(nr);
    }
    return {saved:true,count:p.items?p.items.length:0};
  });
}

function saveAssignees(p){
  return safeReturn(function(){
    var sheet=getSheet(CONFIG.SHEET.ASSIGNEE),col=CONFIG.ASSIGNEE_COL;
    var today=toKST('yyyy-MM-dd');
    var rows=sheet.getDataRange().getValues();
    for(var i=rows.length-1;i>=1;i--){
      if(_dateToStr(rows[i][col.DATE])===today) sheet.deleteRow(i+1);
    }
    if(p.items&&p.items.length>0){
      var nr=p.items.map(function(it){
        return [today,it.zone,it.floor,it.team,(it.crews||[]).join(',')];
      });
      sheet.getRange(sheet.getLastRow()+1,1,nr.length,5).setValues(nr);
    }
    return {saved:true};
  });
}

/**
 * 월별 관리 내역 조회
 * year, month (1-based) 기준으로 해당 월 완료 기록 반환
 * returns: { "2025-06-03": [{crew,zone,floor,spot,time,memo}, ...], ... }
 */
function getMonthlyRecords(year, month){
  return safeReturn(function(){
    var sheet=getSheet(CONFIG.SHEET.RECORDS),col=CONFIG.RECORD_COL;
    var rows=sheet.getDataRange().getValues();
    var prefix=year+'-'+String(month).replace(/^(\d)$/,'0$1');
    var result={};
    for(var i=1;i<rows.length;i++){
      var r=rows[i];
      var d=String(r[col.DATE]||'');
      if(!d.startsWith(prefix)) continue;
      if(r[col.DONE]!==true&&r[col.DONE]!=='TRUE') continue;
      if(!result[d]) result[d]=[];
      result[d].push({
        crew:r[col.CREW], zone:r[col.ZONE], floor:r[col.FLOOR],
        spot:r[col.SPOT], time:r[col.TIME]||'', memo:r[col.MEMO]||''
      });
    }
    return result;
  });
}

// ── 내부 ────────────────────────────────────────────────────
function _getCrewList(){
  var rows=getSheet(CONFIG.SHEET.CREW).getDataRange().getValues(),col=CONFIG.CREW_COL,list=[];
  for(var i=1;i<rows.length;i++){
    var r=rows[i];
    if(!r[col.NAME]) continue;
    var active=r[col.ACTIVE];
    if(active===false||active==='FALSE'||active==='') continue;
    list.push({
      name:String(r[col.NAME]).trim(), role:String(r[col.ROLE]||'').trim(),
      part:String(r[col.PART]||'').trim(),
      isManager:r[col.IS_MANAGER]===true||r[col.IS_MANAGER]==='TRUE',
      pin:String(r[col.PIN]||'').trim(),
    });
  }
  return list;
}
function _isManager(n){
  var l=_getCrewList();
  for(var i=0;i<l.length;i++) if(l[i].name===n) return l[i].isManager;
  return false;
}
function _getTodaySchedule(){
  try{
    var sheet=getSheet(CONFIG.SHEET.SCHEDULE),col=CONFIG.SCHEDULE_COL;
    var today=toKST('yyyy-MM-dd'),rows=sheet.getDataRange().getValues(),list=[];
    for(var i=1;i<rows.length;i++){
      var r=rows[i];
      if(_dateToStr(r[col.DATE])===today) list.push({zone:String(r[col.ZONE]).trim(),floor:String(r[col.FLOOR]).trim()});
    }
    return list;
  }catch(e){Logger.log('schedule err:'+e.message);return [];}
}
function _dateToStr(val){
  if(val instanceof Date) return Utilities.formatDate(val,'Asia/Seoul','yyyy-MM-dd');
  return String(val||'').trim();
}
function _getTodayAssignees(){
  try{
    var sheet=getSheet(CONFIG.SHEET.ASSIGNEE),col=CONFIG.ASSIGNEE_COL;
    var today=toKST('yyyy-MM-dd'),rows=sheet.getDataRange().getValues(),list=[];
    for(var i=1;i<rows.length;i++){
      var r=rows[i];
      if(_dateToStr(r[col.DATE])===today){
        var crews=String(r[col.CREWS]||'').split(',').map(function(s){return s.trim();}).filter(Boolean);
        list.push({zone:String(r[col.ZONE]).trim(),floor:String(r[col.FLOOR]).trim(),
                   team:String(r[col.TEAM]).trim(),crews:crews});
      }
    }
    return list;
  }catch(e){Logger.log('assignees err:'+e.message);return [];}
}
function _filterBySchedule(allSpots,schedule){
  var set={};
  schedule.forEach(function(s){set[s.zone+'|'+s.floor]=true;});
  var r={};
  Object.keys(allSpots).forEach(function(z){
    Object.keys(allSpots[z].floors).forEach(function(f){
      if(set[z+'|'+f]){if(!r[z]) r[z]={floors:{}}; r[z].floors[f]=allSpots[z].floors[f];}
    });
  });
  return r;
}
function _getSpotsWithStatus(crewName){
  var spots=_readAllSpots(),records=_readTodayRecords(crewName),doneSet={};
  records.forEach(function(r){
    if(r.done===true||r.done==='TRUE')
      doneSet[[r.zone,r.floor,r.section,r.spot].join('|')]={done:true,memo:r.memo||'',memoWho:r.memoWho||''};
  });
  var result={};
  spots.forEach(function(spot){
    var z=spot.zone,fl=spot.floor,sec=spot.section;
    if(!result[z]) result[z]={floors:{}};
    if(!result[z].floors[fl]) result[z].floors[fl]={sections:{}};
    if(!result[z].floors[fl].sections[sec]) result[z].floors[fl].sections[sec]={name:sec,items:[]};
    var qty=parseInt(spot.qty)||1;
    for(var q=1;q<=qty;q++){
      var sn=qty>1?spot.name+' '+q+'번':spot.name, key=[z,fl,sec,sn].join('|');
      result[z].floors[fl].sections[sec].items.push({
        id:makeItemId(z,fl,sec,sn),name:sn,notice:spot.notice||null,
        detail:spot.detail||null,   // 상세내용
        checked:!!(doneSet[key]&&doneSet[key].done),
        memo:doneSet[key]?doneSet[key].memo:'',memoWho:doneSet[key]?doneSet[key].memoWho:'',
      });
    }
  });
  return result;
}
function _readAllSpots(){
  var rows=getSheet(CONFIG.SHEET.SPOTS).getDataRange().getValues(),col=CONFIG.SPOT_COL,list=[];
  for(var i=1;i<rows.length;i++){
    var r=rows[i];
    if(!r[col.ZONE]||!r[col.NAME]) continue;
    var active=r[col.ACTIVE];
    if(active===false||active==='FALSE'||active==='') continue;
    list.push({zone:String(r[col.ZONE]).trim(),floor:String(r[col.FLOOR]).trim(),
      section:String(r[col.SECTION]).trim(),name:String(r[col.NAME]).trim(),
      qty:r[col.QTY]||1,notice:String(r[col.NOTICE]||'').trim()||null,
      detail:String(r[col.DETAIL]||'').trim()||null});  // 상세내용
  }
  return list;
}
function _readTodayRecords(crewName){
  var rows=getSheet(CONFIG.SHEET.RECORDS).getDataRange().getValues(),col=CONFIG.RECORD_COL;
  var today=toKST('yyyy-MM-dd'),list=[];
  for(var i=1;i<rows.length;i++){
    var r=rows[i];
    if(r[col.DATE]!==today) continue;
    if(crewName&&r[col.CREW]!==crewName) continue;
    list.push({zone:r[col.ZONE],floor:r[col.FLOOR],section:r[col.SECTION],spot:r[col.SPOT],
      done:r[col.DONE],time:r[col.TIME],memo:r[col.MEMO]||'',memoWho:r[col.MEMO_WHO]||''});
  }
  return list;
}
function _buildRecordRow(today,time,p,isDone){
  var col=CONFIG.RECORD_COL,row=new Array(10).fill('');
  row[col.DATE]=today;row[col.CREW]=p.crewName;row[col.ZONE]=p.zone;row[col.FLOOR]=p.floor;
  row[col.SECTION]=p.section;row[col.SPOT]=p.spot;row[col.DONE]=isDone?'TRUE':'FALSE';
  row[col.TIME]=isDone?time:'';row[col.MEMO]=p.memo||'';row[col.MEMO_WHO]=p.memoWho||'';
  return row;
}
function _deleteTodayFloorRows(sheet,today,crewName,zone,floor){
  var col=CONFIG.RECORD_COL,rows=sheet.getDataRange().getValues();
  for(var i=rows.length-1;i>=1;i--){
    var r=rows[i];
    if(r[col.DATE]===today&&r[col.CREW]===crewName&&r[col.ZONE]===zone&&r[col.FLOOR]===floor)
      sheet.deleteRow(i+1);
  }
}

// ── SETUP ────────────────────────────────────────────────────
function setupSpreadsheet(){
  var ss=getSpreadsheet();
  _setupSheet(ss,'크루',['이름','역할','소속파트','활성여부','매니저여부','PIN'],
    [['김민준','팀리더','DS크루','TRUE','TRUE','1234'],
     ['이서연','가드너','DS크루','TRUE','FALSE',''],
     ['박지훈','가드너','DS크루','TRUE','FALSE',''],
     ['최수빈','가드너','DS크루','TRUE','FALSE','']]);
  _setupSheet(ss,'스팟목록',['구역','층','구역명(존)','스팟명','수량','주의사항','활성여부','상세내용'],[]);  // H열: 쉼표로 구분 (예: 대형플랜트박스 1,소파뒤 박스)
  _setupSheet(ss,'완료기록',['날짜','크루명','구역','층','구역명','스팟명','완료여부','완료시각','메모내용','메모작성자'],[]);
  _setupSheet(ss,'오늘스케줄',['날짜','구역','층'],[]);
  _setupSheet(ss,'담당자배정',['날짜','구역','층','팀명','크루목록'],[]);
  SpreadsheetApp.getUi().alert('세팅 완료!');
}
function _setupSheet(ss,name,headers,samples){
  var sheet=ss.getSheetByName(name)||ss.insertSheet(name);
  sheet.clearContents();
  sheet.getRange(1,1,1,headers.length).setValues([headers])
    .setBackground('#111').setFontColor('#fff').setFontWeight('bold');
  sheet.setFrozenRows(1);
  if(samples.length) sheet.getRange(2,1,samples.length,headers.length).setValues(samples);
}

// ════════════════════════════════════════════════════════════
//  실시간 동기화 — 오늘 전체 완료 현황 조회
// ════════════════════════════════════════════════════════════

/**
 * 오늘 완료된 모든 스팟의 itemId Set 반환
 * 크루 구분 없이 누군가 완료하면 공유됨
 * returns: { checkedIds: {itemId: {crew, time}}, ts: 타임스탬프 }
 */
function getAllTodayChecked(){
  return safeReturn(function(){
    var sheet = getSheet(CONFIG.SHEET.RECORDS);
    var col   = CONFIG.RECORD_COL;
    var rows  = sheet.getDataRange().getValues();
    var today = toKST('yyyy-MM-dd');
    var result = {};
    for(var i=1;i<rows.length;i++){
      var r = rows[i];
      if(_dateToStr(r[col.DATE]) !== today) continue;
      if(r[col.DONE] !== true && r[col.DONE] !== 'TRUE') continue;
      var id = makeItemId(
        String(r[col.ZONE]).trim(),
        String(r[col.FLOOR]).trim(),
        String(r[col.SECTION]).trim(),
        String(r[col.SPOT]).trim()
      );
      result[id] = {
        crew: String(r[col.CREW]||'').trim(),
        time: String(r[col.TIME]||'').trim()
      };
    }
    return { checkedIds: result, ts: toKST('HH:mm:ss') };
  });
}
function cleanOldRecords(){
  var sheet=getSheet(CONFIG.SHEET.RECORDS),rows=sheet.getDataRange().getValues(),col=CONFIG.RECORD_COL;
  var cutoff=new Date();cutoff.setDate(cutoff.getDate()-CONFIG.APP.KEEP_DAYS);
  var cutStr=Utilities.formatDate(cutoff,'Asia/Seoul','yyyy-MM-dd'),count=0;
  for(var i=rows.length-1;i>=1;i--){
    if(rows[i][col.DATE]&&rows[i][col.DATE]<cutStr){sheet.deleteRow(i+1);count++;}
  }
  Logger.log('삭제: '+count+'건');
}

// ════════════════════════════════════════════════════════════
//  근태기록 & 이슈 API
// ════════════════════════════════════════════════════════════

/**
 * 오늘 근태기록 저장/업데이트
 * p = { crewName, status, note }
 * status: 'present' | 'late' | 'absent' | 'half'
 */
function saveAttendance(p){
  return safeReturn(function(){
    var sheet = _getOrCreateSheet('근태기록', ['날짜','이름','상태','비고']);
    var today = p.date || toKST('yyyy-MM-dd');  // date 파라미터 지원
    var rows  = sheet.getDataRange().getValues();
    var found = -1;
    for(var i=1;i<rows.length;i++){
      if(_dateToStr(rows[i][0])===today && String(rows[i][1]).trim()===p.crewName){ found=i+1; break; }
    }
    var row = [today, p.crewName, p.status||'present', p.note||''];
    if(found>0) sheet.getRange(found,1,1,4).setValues([row]);
    else        sheet.appendRow(row);
    return {saved:true};
  });
}

/**
 * 오늘 이슈 저장
 * p = { crewName, content, tag }
 * tag: 'general' | 'plant' | 'safety' | 'request'
 */
function saveIssue(p){
  return safeReturn(function(){
    var sheet = _getOrCreateSheet('이슈기록', ['날짜','시각','작성자','태그','내용']);
    var today = toKST('yyyy-MM-dd');
    var time  = toKST('HH:mm');
    sheet.appendRow([today, time, p.crewName||'', p.tag||'general', p.content||'']);
    return {saved:true, time:time};
  });
}

/** 오늘 근태+이슈 로드 */
function loadTodayLog(){
  return safeReturn(function(){
    var today = toKST('yyyy-MM-dd');
    // 근태
    var attSheet = _getOrCreateSheet('근태기록', ['날짜','이름','상태','비고']);
    var attRows  = attSheet.getDataRange().getValues();
    var attendance = [];
    for(var i=1;i<attRows.length;i++){
      if(_dateToStr(attRows[i][0])===today)
        attendance.push({name:String(attRows[i][1]).trim(), status:String(attRows[i][2]).trim(), note:String(attRows[i][3]||'').trim()});
    }
    // 이슈
    var issSheet = _getOrCreateSheet('이슈기록', ['날짜','시각','작성자','태그','내용']);
    var issRows  = issSheet.getDataRange().getValues();
    var issues = [];
    for(var i=1;i<issRows.length;i++){
      if(_dateToStr(issRows[i][0])===today)
        issues.push({time:String(issRows[i][1]||'').trim(), author:String(issRows[i][2]||'').trim(), tag:String(issRows[i][3]||'general').trim(), content:String(issRows[i][4]||'').trim()});
    }
    return {attendance:attendance, issues:issues, today:today};
  });
}

/** 이슈 삭제 (행 인덱스 기준) */
function deleteIssue(p){
  return safeReturn(function(){
    var today = toKST('yyyy-MM-dd');
    var sheet = _getOrCreateSheet('이슈기록', ['날짜','시각','작성자','태그','내용']);
    var rows  = sheet.getDataRange().getValues();
    var count = 0;
    for(var i=rows.length-1;i>=1;i--){
      if(_dateToStr(rows[i][0])===today && rows[i][1]===p.time && rows[i][4]===p.content){
        sheet.deleteRow(i+1); count++; break;
      }
    }
    return {deleted:count>0};
  });
}


/** 특정 날짜의 이슈 조회 */
function getIssuesByDate(dateStr){
  return safeReturn(function(){
    var sheet=_getOrCreateSheet('이슈기록',['날짜','시각','작성자','태그','내용']);
    var rows=sheet.getDataRange().getValues();
    var list=[];
    for(var i=1;i<rows.length;i++){
      var r=rows[i];
      if(_dateToStr(r[0])===dateStr){
        list.push({time:String(r[1]||'').trim(),author:String(r[2]||'').trim(),
                   tag:String(r[3]||'general').trim(),content:String(r[4]||'').trim()});
      }
    }
    return {issues:list};
  });
}

/** 날짜별 근태 조회 */
function getAttendanceByDate(dateStr){
  return safeReturn(function(){
    var sheet=_getOrCreateSheet('근태기록',['날짜','이름','상태','비고']);
    var rows=sheet.getDataRange().getValues();
    var list=[];
    for(var i=1;i<rows.length;i++){
      var r=rows[i];
      if(_dateToStr(r[0])===dateStr){
        list.push({name:String(r[1]||'').trim(),status:String(r[2]||'').trim(),note:String(r[3]||'').trim()});
      }
    }
    return {attendance:list};
  });
}

function _getOrCreateSheet(name, headers){
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if(!sheet){
    sheet = ss.insertSheet(name);
    sheet.getRange(1,1,1,headers.length).setValues([headers])
      .setBackground('#111').setFontColor('#fff').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}
