/**
 * NTHU eeclass Copilot - 測驗本身 CRUD 功能寫作 Agent (Exam CRUD Agent)
 * 
 * 依據「預計要開發的功能.txt」第 1 項：
 * 「自動新增/編輯/刪除作業與測驗（刪除僅限未有繳交者）」
 * 
 * 以及「總論/eeclass-功能定位總表.md」與「助教、老師測驗評分 CRUD的方法（第二階段補充）.md」：
 * - 列表頁面：/course/examList/{courseId}
 * - 詳細頁面：/course/exam/{examId}（以 dt/dd 呈現設定）
 * - ID 對照：測驗 ID (examId) 與 作答 ID (kexamId) 雙軌管理
 * - 刪除守衛：嚴格檢查 testedCount === 0，否則拋出 409 Conflict，並強制驗證 UI 許可 Token
 */

import permissionGuard, { Roles, Permissions } from '../auth/permissionGuard.js';

export class ExamCrudAgent {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://eeclass.nthu.edu.tw';
  }

  /**
   * 解析測驗列表頁面 (/course/examList/{courseId})
   * 取得 examId、kexamId、測驗標題、已測驗人數與 canDelete 標記
   */
  parseExamList(docOrHtml, courseId) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      const parser = new DOMParser();
      doc = parser.parseFromString(docOrHtml, 'text/html');
    }

    const rows = [...doc.querySelectorAll('tr')].filter(r => r.querySelector('a[href*="/course/exam/"]') || r.querySelector('a[href*="/kexam/"]'));

    return rows.map((tr, index) => {
      // 測驗 ID
      let examId = null;
      let title = '';
      const examLink = tr.querySelector('a[href*="/course/exam/"]');
      if (examLink) {
        const match = examLink.getAttribute('href').match(/\/exam\/(\d+)/);
        if (match) examId = parseInt(match[1], 10);
        title = examLink.textContent.trim();
      }

      // 作答 ID (kexamId) 與已測驗人數
      let kexamId = null;
      let testedCount = 0;
      const testedLink = tr.querySelector('a[href*="/kexam/"][href*="membersRecord"]');
      if (testedLink) {
        const match = testedLink.getAttribute('href').match(/\/kexam\/(\d+)/);
        if (match) kexamId = parseInt(match[1], 10);
        const countMatch = testedLink.textContent.match(/\d+/);
        if (countMatch) testedCount = parseInt(countMatch[0], 10);
      }

      return {
        courseId,
        examId,
        kexamId,
        index: index + 1,
        title,
        testedCount,
        // 核心安全約束：僅限未有測驗/作答者 (testedCount === 0) 可刪除
        canDelete: testedCount === 0,
        examUrl: examId ? `${this.baseUrl}/course/exam/${examId}` : null,
        membersRecordUrl: kexamId ? `${this.baseUrl}/kexam/${kexamId}/membersRecord` : null
      };
    });
  }

  /**
   * 解析測驗設定頁面 (/course/exam/{examId})
   * 依照指引以 dt/dd 成對結構讀取完整測驗規則
   */
  parseExamDetail(docOrHtml, examId) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      const parser = new DOMParser();
      doc = parser.parseFromString(docOrHtml, 'text/html');
    }

    const dts = [...doc.querySelectorAll('dt')];
    const data = {
      examId,
      title: doc.querySelector('h1.title, h2, .exam-title')?.textContent.trim() || '',
      startTime: '',
      endTime: '',
      weight: 0,
      fullScore: 100,
      passScore: 60,
      timeLimit: 0,
      testLimit: 0,
      windowLock: '無限制',
      testType: 0,
      subjectType: 0,
      assignScoreType: 1,
      optOrder: 0,
      displayType: 0,
      testRecord: 0,
      answerDisplayTime: 4,
      showStatistics: 1,
      description: '',
      rawPairs: {}
    };

    dts.forEach(dt => {
      const key = dt.textContent.trim();
      const dd = dt.nextElementSibling;
      const val = dd ? dd.textContent.trim() : '';
      data.rawPairs[key] = val;

      if (key.includes('測驗期間')) {
        const parts = val.split('~').map(s => s.trim());
        data.startTime = parts[0] || '';
        data.endTime = parts[1] || '';
      } else if (key.includes('成績比重')) {
        data.weight = parseInt(val.replace(/[^\d]/g, '') || '0', 10);
      } else if (key.includes('滿分')) {
        data.fullScore = parseInt(val.replace(/[^\d]/g, '') || '100', 10);
      } else if (key.includes('及格')) {
        data.passScore = parseInt(val.replace(/[^\d]/g, '') || '60', 10);
      } else if (key.includes('時間限制')) {
        data.timeLimit = parseInt(val.replace(/[^\d]/g, '') || '0', 10);
      } else if (key.includes('次數限制')) {
        data.testLimit = parseInt(val.replace(/[^\d]/g, '') || '0', 10);
      } else if (key.includes('視窗控制')) {
        data.windowLock = val;
      } else if (key.includes('說明')) {
        data.description = val;
      }
    });

    return data;
  }

  /**
   * 產生測驗建立/編輯表單的 DOM 選擇器與欄位定義
   */
  getExamFormMapping() {
    return {
      modalSelector: '#lgIframeModalId',
      iframeSelector: 'iframe.fs-modal-iframe, iframe',
      fields: {
        title: 'input[name=title]',
        description: 'textarea[name=description]',
        startTimeDate: '#startTime_date',
        startTimeTime: '#startTime_time',
        endTimeDate: '#endTime_date',
        endTimeTime: '#endTime_time',
        weight: 'input[name=weight]',
        fullScore: 'input[name=fullScore]',
        passScore: 'input[name=passScore]',
        timeLimit: 'input[name=timeLimit]',
        testLimit: 'input[name=testLimit]',
        windowLock: 'input[name=windowLock]',
        testType: 'input[name=testType]',
        subjectType: 'input[name=subjectType]',
        assignScoreType: 'input[name=assignScoreType]',
        optOrder: 'input[name=optOrder]',
        displayType: 'input[name=displayType]',
        testRecord: 'input[name=testRecord]',
        answerDisplayTime: 'input[name=answerDisplayTime]',
        showStatistics: 'input[name=showStatistics]',
        submitBtn: 'button[type=submit], input[type=submit]'
      }
    };
  }

  /**
   * 執行測驗刪除防護與前置檢查
   */
  assertDeleteSafeguards(options) {
    const { role, testedCount, consentToken, examId } = options;

    // 1. 角色權限檢查
    permissionGuard.assertPermission(role, Permissions.EXAM_DELETE);

    // 2. 業務規則核心檢查：刪除僅限未有測驗/繳交者
    permissionGuard.assertExamCanDelete(testedCount);

    // 3. 使用者 UI 許可 Token 驗證
    permissionGuard.verifyAndConsumeConsent(consentToken, 'delete_exam', examId);

    return {
      canDelete: true,
      confirmed: true,
      endpoint: `/ajax/sys.pages.course_examList/deleteExamMsg/`
    };
  }
}

export const examCrudAgent = new ExamCrudAgent();
export default examCrudAgent;
