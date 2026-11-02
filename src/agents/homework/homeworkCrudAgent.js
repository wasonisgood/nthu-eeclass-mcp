/**
 * NTHU eeclass Copilot - 作業本身 CRUD 功能寫作 Agent (Homework CRUD Agent)
 * 
 * 依據「預計要開發的功能.txt」第 1 項：
 * 「自動新增/編輯/刪除作業與測驗（刪除僅限未有繳交者）」
 * 
 * 以及「助教老師要開發的功能及開發必要指引/助教、老師設定作業CRUD的方法.md」：
 * - 列表頁面：/course/homeworkList/{courseId}
 * - 詳細頁面：/course/homework/{homeworkId}（以 dt/dd 結構呈現）
 * - 編輯表單：iframe 內表單（包含 title, description, files[], allowDelay, weight, auditMode, anticsrf 等）
 * - 刪除守衛：嚴格檢查 submittedCount === 0，否則拋出 409 Conflict，並強制驗證 UI 許可 Token
 */

import permissionGuard, { Roles, Permissions } from '../auth/permissionGuard.js';

export class HomeworkCrudAgent {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://eeclass.nthu.edu.tw';
  }

  /**
   * 解析作業列表頁面 (/course/homeworkList/{courseId})
   * 取得每筆作業的 ID、名稱、繳交人數、評分人數與 canDelete 旗標
   */
  parseHomeworkList(docOrHtml, courseId) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      const parser = new DOMParser();
      doc = parser.parseFromString(docOrHtml, 'text/html');
    }

    const rows = [...doc.querySelectorAll('tr')].filter(r => r.querySelector('td.col-no') || r.querySelector('a[href*="/course/homework/"]'));

    return rows.map((tr, index) => {
      const link = tr.querySelector('a[href*="/course/homework/"]');
      let homeworkId = null;
      let title = '';

      if (link) {
        const match = link.getAttribute('href').match(/\/homework\/(\d+)/);
        if (match) homeworkId = parseInt(match[1], 10);
        title = link.textContent.trim();
      }

      // 繳交 / 評分統計欄（例如 "4 / 0"）
      let submittedCount = 0;
      let gradedCount = 0;
      const countEl = tr.querySelector('td:nth-child(5), a[href*="submitList"]');
      if (countEl) {
        const text = countEl.textContent.trim();
        const countMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
        if (countMatch) {
          submittedCount = parseInt(countMatch[1], 10);
          gradedCount = parseInt(countMatch[2], 10);
        }
      }

      // 取得日期區間
      const dateCells = tr.querySelectorAll('td.col-date, td:nth-child(6), td:nth-child(7)');
      const startDate = dateCells[0] ? dateCells[0].textContent.trim() : '';
      const deadline = dateCells[1] ? dateCells[1].textContent.trim() : '';

      // 檢查是否為分組作業
      const isGroup = /是|分組/.test(tr.querySelector('td:nth-child(4)')?.textContent || '');

      return {
        courseId,
        homeworkId,
        index: index + 1,
        title,
        isGroup,
        submittedCount,
        gradedCount,
        startDate,
        deadline,
        // 核心安全約束：僅限未有繳交者 (submittedCount === 0) 可刪除
        canDelete: submittedCount === 0,
        detailUrl: `${this.baseUrl}/course/homework/${homeworkId}`
      };
    });
  }

  /**
   * 解析作業詳細頁 (/course/homework/{homeworkId})
   * 依照指引以 dt/dd 成對結構讀取
   */
  parseHomeworkDetail(docOrHtml, homeworkId) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      const parser = new DOMParser();
      doc = parser.parseFromString(docOrHtml, 'text/html');
    }

    const dts = [...doc.querySelectorAll('dt')];
    const data = {
      homeworkId,
      title: doc.querySelector('h1.title, .fs-banner-courseTitle, h2')?.textContent.trim() || '',
      type: 'personal',
      startDate: '',
      deadline: '',
      allowDelay: false,
      weight: 0,
      auditMode: 1,
      gradeSearch: 2,
      view: 2,
      description: '',
      rawPairs: {}
    };

    dts.forEach(dt => {
      const key = dt.textContent.trim();
      const dd = dt.nextElementSibling;
      const val = dd ? dd.textContent.trim() : '';
      data.rawPairs[key] = val;

      if (key.includes('類型')) {
        data.type = val.includes('分組') ? 'group' : val.includes('AI') ? 'ai_gradable' : 'personal';
      } else if (key.includes('開放繳交')) {
        data.startDate = val;
      } else if (key.includes('繳交期限')) {
        data.deadline = val;
      } else if (key.includes('允許遲交')) {
        data.allowDelay = val.includes('是');
      } else if (key.includes('成績比重')) {
        data.weight = parseInt(val.replace(/[^\d]/g, '') || '0', 10);
      } else if (key.includes('評分方式')) {
        data.auditMode = val.includes('評分表') ? 2 : 1;
      } else if (key.includes('成績查詢')) {
        data.gradeSearch = val.includes('結束後開放') ? 1 : 2;
      } else if (key.includes('作業觀摩')) {
        data.view = val.includes('開放') ? 1 : val.includes('截止後') ? 3 : 2;
      } else if (key.includes('說明')) {
        data.description = val;
      }
    });

    return data;
  }

  /**
   * 產生建立個人作業之表單 payload 與 DOM 填寫指引
   */
  buildCreatePayload(params) {
    const {
      title,
      description = '',
      startDate,
      deadline,
      allowDelay = 2, // 1=是, 2=否
      weight = 10,
      auditMode = 1,  // 1=直接打分數, 2=使用評分表
      gradeSearch = 2,// 1=結束後開放, 2=不開放
      view = 2,       // 1=開放, 2=不開放, 3=截止後開放
      isDraft = false
    } = params;

    // 將日期字串拆分為 date 與 time
    const [startDatePart, startTimePart] = (startDate || '').split(/\s+/);
    const [deadlineDatePart, deadlineTimePart] = (deadline || '').split(/\s+/);

    return {
      selectors: {
        draft: 'input[type=checkbox][value=1]',
        title: 'input[name=title]',
        description: 'textarea[name=description]',
        fileInput: 'input[name="files[]"]',
        startDate: 'input#homeworkStartTime_date',
        startTime: 'input#homeworkStartTime_time',
        deadlineDate: 'input#homeworkDeadline_date',
        deadlineTime: 'input#homeworkDeadline_time',
        allowDelay: 'input[type=radio][name=allowDelay]',
        weight: 'input[type=number][name=weight]',
        auditMode: 'input[type=radio][name=auditMode]',
        gradeSearch: 'input[type=radio][name=gradeSearch]',
        view: 'input[type=radio][name=view]',
        csrf: 'input[type=hidden][name=anticsrf]',
        submitBtn: 'button[type=submit]'
      },
      values: {
        isDraft,
        title,
        description,
        startDatePart,
        startTimePart: startTimePart || '09:00',
        deadlineDatePart,
        deadlineTimePart: deadlineTimePart || '23:59',
        allowDelay: String(allowDelay),
        weight: Number(weight),
        auditMode: String(auditMode),
        gradeSearch: String(gradeSearch),
        view: String(view)
      }
    };
  }

  /**
   * 執行作業刪除防護與前置檢查
   * @param {Object} options - { role, submittedCount, consentToken, homeworkId }
   */
  assertDeleteSafeguards(options) {
    const { role, submittedCount, consentToken, homeworkId } = options;

    // 1. 角色權限檢查（必須為助教或老師）
    permissionGuard.assertPermission(role, Permissions.HOMEWORK_DELETE);

    // 2. 業務規則核心檢查：刪除僅限未有繳交者
    permissionGuard.assertHomeworkCanDelete(submittedCount);

    // 3. 使用者 UI 許可 Token 驗證
    permissionGuard.verifyAndConsumeConsent(consentToken, 'delete_homework', homeworkId);

    return {
      canDelete: true,
      confirmed: true,
      endpoint: `/ajax/sys.pages.course_homeworkList/deleteHomeworkMsg/`
    };
  }
}

export const homeworkCrudAgent = new HomeworkCrudAgent();
export default homeworkCrudAgent;
