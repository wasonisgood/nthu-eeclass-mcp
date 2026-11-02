/**
 * NTHU eeclass Copilot - 作業作答取得與評語成績填入 Agent (Homework Submission & Audit Agent)
 * 
 * 依據「預計要開發的功能.txt」：
 * - 第 2 項：自動匯出並維持繳交檔案或作答結果（作業打包下載、名單匯出）
 * - 第 3 項：自動同步匯入評語與成績
 * 
 * 以及指引：
 * - 「作業打包下載與匯出.md」：/homework/submitList/{homeworkId}（打包下載 ZIP、全部/已選擇匯出）
 * - 「評分作業的問答題_作業批改.md」：/homework/report/{reportId}（分數、富文字評語、anticsrf、值得觀摩、寄送通知）
 */

import permissionGuard, { Roles, Permissions } from '../auth/permissionGuard.js';

export class HomeworkSubmissionAuditAgent {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://eeclass.nthu.edu.tw';
  }

  /**
   * 解析已交名單頁 (/homework/submitList/{homeworkId})
   * 取得每位學生的繳交 ID (reportId)、學號、姓名、繳交時間、現有分數
   */
  parseSubmissionList(docOrHtml, homeworkId) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      const parser = new DOMParser();
      doc = parser.parseFromString(docOrHtml, 'text/html');
    }

    // 統計卡解析
    const summaryCards = doc.querySelectorAll('.stat-card, .fs-p span, .card-block');
    let totalStudents = 0;
    let submittedCount = 0;
    let delayedCount = 0;

    const bodyText = doc.body ? doc.body.textContent : '';
    const matchSubmitted = bodyText.match(/已繳交\s*[:：]?\s*(\d+)/);
    if (matchSubmitted) submittedCount = parseInt(matchSubmitted[1], 10);
    const matchDelayed = bodyText.match(/遲交\s*[:：]?\s*(\d+)/);
    if (matchDelayed) delayedCount = parseInt(matchDelayed[1], 10);

    const rows = [...doc.querySelectorAll('tr')].filter(r => r.querySelectorAll('td').length >= 5);
    const items = rows.map((tr, idx) => {
      // 取得 reportId：優先從 input.scoreInput[data-reportid]，其次從批改連結
      let reportId = null;
      const scoreInput = tr.querySelector('input.scoreInput, input[data-reportid]');
      if (scoreInput && scoreInput.dataset.reportid) {
        reportId = parseInt(scoreInput.dataset.reportid, 10);
      } else {
        const auditLink = tr.querySelector('a[href*="/homework/report/"]');
        if (auditLink) {
          const match = auditLink.getAttribute('href').match(/\/report\/(\d+)/);
          if (match) reportId = parseInt(match[1], 10);
        }
      }

      // 學生姓名與學號
      const nameEl = tr.querySelector('td:nth-child(3), td.col-name, a[data-toggle=popover]');
      let studentName = '';
      let studentId = '';
      if (nameEl) {
        const text = nameEl.textContent.trim();
        const idMatch = text.match(/\(([\w\d]+)\)|(\d{7,10})/);
        if (idMatch) {
          studentId = idMatch[1] || idMatch[2];
          studentName = text.replace(/\([^)]+\)/, '').replace(studentId, '').trim();
        } else {
          studentName = text;
        }
      }

      // 繳交標題（姓名_作業名稱）
      const titleLink = tr.querySelector('td:nth-child(4) a');
      const title = titleLink ? titleLink.textContent.trim() : '';

      // 繳交時間
      const timeEl = tr.querySelector('td:nth-child(5) span, td.col-date');
      const submitTime = timeEl ? timeEl.textContent.trim() : '';

      // 分數
      const scoreView = tr.querySelector('a.scoreView, td.col-score');
      const score = scoreView ? scoreView.textContent.trim() : '-';

      return {
        index: idx + 1,
        reportId,
        studentId,
        studentName,
        title,
        submitTime,
        score,
        isGraded: score !== '-' && score !== '',
        auditUrl: reportId ? `${this.baseUrl}/homework/report/${reportId}` : null
      };
    });

    return {
      homeworkId,
      totalStudents: totalStudents || items.length,
      submittedCount: submittedCount || items.length,
      delayedCount,
      items
    };
  }

  /**
   * 解析個別批改頁 (/homework/report/{reportId})
   * 包含附件清單、目前分數、富文字評語與表單 anticsrf
   */
  parseReportDetail(docOrHtml, reportId) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      const parser = new DOMParser();
      doc = parser.parseFromString(docOrHtml, 'text/html');
    }

    const titleEl = doc.querySelector('h1, .fs-title, .report-title');
    const attachments = [...doc.querySelectorAll('a[href^="/filedownload/"], a[href*="filedownload"]')].map(a => ({
      fileName: a.textContent.trim(),
      downloadUrl: a.getAttribute('href'),
      fullUrl: `${this.baseUrl}${a.getAttribute('href')}`
    }));

    // 表單元素讀取
    const scoreInput = doc.querySelector('input[name=auditScore]');
    const currentScore = scoreInput ? scoreInput.value : '';

    const anticsrfInput = doc.querySelector('input[name=anticsrf]');
    const anticsrf = anticsrfInput ? anticsrfInput.value : '';

    const nextNotAuditReportIdInput = doc.querySelector('input[name=nextNotAuditReportId]');
    const nextNotAuditReportId = nextNotAuditReportIdInput ? nextNotAuditReportIdInput.value : null;

    return {
      reportId,
      title: titleEl ? titleEl.textContent.trim() : '',
      attachments,
      currentScore,
      anticsrf,
      nextNotAuditReportId,
      selectors: {
        scoreInput: 'input[name=auditScore]',
        modelStudentCheck: 'input[type=checkbox][value=1]', // 第一個 checkbox
        richTextIframe: 'iframe.rte-editable',
        sendEmailCheck: 'input[type=checkbox][value=1]',     // 第二個 checkbox
        submitBtn: 'button[type=submit].submitAudit',
        continueBtn: 'button.continueAudit'
      }
    };
  }

  /**
   * 建立個別學生批改作業之 payload 與自動填寫腳本
   */
  buildAuditSubmissionPlan(reportId, auditData, anticsrf) {
    const {
      auditScore,
      commentHtml = '',
      isModelStudent = false,
      sendEmailNotification = false
    } = auditData;

    return {
      reportId,
      endpoint: `${this.baseUrl}/homework/report/${reportId}`,
      method: 'POST',
      formData: {
        reportId: String(reportId),
        auditScore: Number(auditScore),
        isModelStudent: isModelStudent ? '1' : '0',
        commentHtml,
        sendEmailNotification: sendEmailNotification ? '1' : '0',
        anticsrf
      },
      domActions: [
        { action: 'setValue', selector: 'input[name=auditScore]', value: String(auditScore) },
        { action: 'setCheckbox', selector: 'form input[type=checkbox]:nth-of-type(1)', checked: isModelStudent },
        { action: 'setIframeHtml', selector: 'iframe.rte-editable', html: commentHtml },
        { action: 'setCheckbox', selector: 'form input[type=checkbox]:nth-of-type(2)', checked: sendEmailNotification },
        { action: 'click', selector: 'button.submitAudit' }
      ]
    };
  }

  /**
   * 批次自動同步匯入評語與成績規劃
   */
  generateBatchImportPlan(homeworkId, batchItems, consentToken, role = Roles.ASSISTANT) {
    permissionGuard.assertPermission(role, Permissions.HOMEWORK_AUDIT);
    // 批次匯入成績為高危險動作，檢查 UI 許可
    permissionGuard.verifyAndConsumeConsent(consentToken, 'batch_import_scores', homeworkId);

    return {
      homeworkId,
      totalCount: batchItems.length,
      items: batchItems.map(item => ({
        studentId: item.studentId,
        reportId: item.reportId,
        auditScore: Number(item.auditScore),
        commentHtml: item.commentHtml || '',
        sendNotification: Boolean(item.sendNotification)
      }))
    };
  }
}

export const homeworkSubmissionAuditAgent = new HomeworkSubmissionAuditAgent();
export default homeworkSubmissionAuditAgent;
