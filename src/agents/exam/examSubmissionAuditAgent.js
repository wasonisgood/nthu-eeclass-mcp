/**
 * NTHU eeclass Copilot - 測驗作答取得與問答題評分評語填入 Agent (Exam Submission & Audit Agent)
 * 
 * 依據「預計要開發的功能.txt」：
 * - 第 2 項：自動匯出並維持繳交檔案或作答結果
 * - 第 3 項：自動同步匯入評語與成績
 * 
 * 以及指引「助教、老師測驗評分 CRUD的方法（第二階段補充）.md」：
 * - 名單頁面：/kexam/{kexamId}/membersRecord（篩選：已完成、未完成、測驗中、待批改、異常紀錄）
 * - 個別作答頁：/kexam/{kexamId}/record?recordID={recordId}
 * - 題型結構：
 *   - 選擇題：div.kques-item 內 input[type=radio]、自動批改配分、✓/×
 *   - 問答題：人工批改，div.auditShowArea（分數與評語檢視）與 div.auditEditArea（分數文字框、iframe.rte-editable 富文字評語、隱藏 textarea[name^=essay_audit]）
 */

import permissionGuard, { Roles, Permissions } from '../auth/permissionGuard.js';

export class ExamSubmissionAuditAgent {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://eeclass.nthu.edu.tw';
  }

  /**
   * 解析測驗成員作答名單頁面 (/kexam/{kexamId}/membersRecord)
   * 取得每位學生的作答紀錄 ID (recordID)、姓名、學號、交卷時間、分數、狀態與測驗次數
   */
  parseMembersRecord(docOrHtml, kexamId) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      const parser = new DOMParser();
      doc = parser.parseFromString(docOrHtml, 'text/html');
    }

    const rows = [...doc.querySelectorAll('tr')].filter(r => r.querySelector('td') && r.querySelectorAll('td').length >= 5);

    return rows.map((tr, idx) => {
      // 學生姓名與學號
      const studentEl = tr.querySelector('td:nth-child(2), .student-info');
      let studentName = '';
      let studentId = '';
      if (studentEl) {
        const text = studentEl.textContent.trim();
        const match = text.match(/\(([\w\d]+)\)|(\d{7,10})/);
        if (match) {
          studentId = match[1] || match[2];
          studentName = text.replace(/\([^)]+\)/, '').replace(studentId, '').trim();
        } else {
          studentName = text;
        }
      }

      // 分數（通常帶有超連結到個別紀錄）
      const scoreEl = tr.querySelector('td:nth-child(3), a.score-link');
      const scoreText = scoreEl ? scoreEl.textContent.trim() : '';
      const score = parseFloat(scoreText) || (scoreText === '0' ? 0 : null);

      // 作答紀錄 ID (recordID)
      let recordId = null;
      const scoreLink = tr.querySelector('td:nth-child(3) a, a[href*="recordID="]');
      if (scoreLink) {
        const href = scoreLink.getAttribute('href') || '';
        const matchRecord = href.match(/recordID=(\d+)/);
        if (matchRecord) recordId = parseInt(matchRecord[1], 10);
      }

      // 交卷時間
      const timeEl = tr.querySelector('td:nth-child(4), .submit-time');
      const submittedTime = timeEl ? timeEl.textContent.trim() : '';

      // 狀態（例如「已完成」、「未完成」、「待批改」）
      const statusEl = tr.querySelector('td:nth-child(5), .status-tag');
      const status = statusEl ? statusEl.textContent.trim() : '';

      // 測驗次數
      const countEl = tr.querySelector('td:nth-child(6), .attempt-count');
      const attemptCount = countEl ? parseInt(countEl.textContent.trim() || '1', 10) : 1;

      return {
        kexamId,
        recordId,
        index: idx + 1,
        studentName,
        studentId,
        score,
        submittedTime,
        status,
        attemptCount,
        recordUrl: recordId ? `${this.baseUrl}/kexam/${kexamId}/record?recordID=${recordId}` : null
      };
    });
  }

  /**
   * 解析個別作答紀錄頁面 (/kexam/{kexamId}/record?recordID={recordId})
   * 精準分離選擇題（自動批改）與問答題（人工評分與評語）
   */
  parseExamRecordDetail(docOrHtml, recordId) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      const parser = new DOMParser();
      doc = parser.parseFromString(docOrHtml, 'text/html');
    }

    const header = doc.querySelector('.record-header, .fs-title, h1');
    const headerText = header ? header.textContent : '';

    const questionItems = [...doc.querySelectorAll('div.kques-item')].map((item, idx) => {
      const isChoice = Boolean(item.querySelector('input[type=radio]'));
      const isEssay = Boolean(item.querySelector('div.scoreShow, textarea[name^=essay_audit]'));

      const questionTextEl = item.querySelector('.question, .kques-title, div:first-child');
      const questionText = questionTextEl ? questionTextEl.textContent.trim() : '';

      // 滿分
      const scoreEl = item.querySelector('div.score, .full-score');
      let maxScore = 0;
      if (scoreEl) {
        const m = scoreEl.textContent.match(/\d+(\.\d+)?/);
        if (m) maxScore = parseFloat(m[0]);
      }

      if (isChoice) {
        // 選擇題
        const studentRadio = item.querySelector('input[type=radio]:checked');
        const studentSelected = studentRadio ? (studentRadio.nextElementSibling?.textContent.trim() || studentRadio.value) : '';
        const isCorrect = Boolean(item.querySelector('.fa-check, .correct-mark, [class*="fa-check"]'));
        const rightAnswerEl = item.querySelector('.right-answer, .answer-text');

        return {
          questionIndex: idx + 1,
          type: 'choice',
          questionText,
          maxScore,
          givenScore: isCorrect ? maxScore : 0,
          studentAnswer: studentSelected,
          systemModelAnswer: rightAnswerEl ? rightAnswerEl.textContent.trim() : '',
          isAutoGraded: true,
          canManualAudit: false
        };
      } else {
        // 問答題
        const essayAuditTextarea = item.querySelector('textarea[name^="essay_audit"]');
        const questionId = essayAuditTextarea ? essayAuditTextarea.getAttribute('name') : `essay_q${idx + 1}`;

        // 現有評分與評語（顯示模式 auditShowArea）
        const showArea = item.querySelector('div.auditShowArea');
        let currentGivenScore = null;
        let currentComment = '';

        if (showArea) {
          const scoreMatch = showArea.textContent.match(/分數[:：]\s*(\d+(\.\d+)?)/);
          if (scoreMatch) currentGivenScore = parseFloat(scoreMatch[1]);
          const commentMatch = showArea.textContent.match(/說明[:：]\s*(.+)$/s);
          if (commentMatch) currentComment = commentMatch[1].trim();
        }

        // 參考解答（系統擬答 / 老師解答）
        const explainEl = item.querySelector('div.explaination');
        const modelAnswer = explainEl ? explainEl.textContent.replace(/^擬答[:：]\s*/, '').trim() : '';

        // 學生作答
        const answerArea = item.querySelector('div.customContent > div.essay-answer-area, .essay-answer');
        const studentAnswer = answerArea ? answerArea.textContent.trim() : '';

        return {
          questionIndex: idx + 1,
          questionId,
          type: 'essay',
          questionText,
          maxScore,
          givenScore: currentGivenScore,
          studentAnswer,
          systemModelAnswer: modelAnswer,
          comment: currentComment,
          isAutoGraded: false,
          canManualAudit: true,
          selectors: {
            editButton: 'div.auditShowArea a', // 文字「修改」
            scoreInput: 'div.auditEditArea input[type=text]',
            richTextIframe: 'div.auditEditArea iframe.rte-editable',
            syncTextarea: `textarea[name="${questionId}"]`,
            submitBtn: 'div.auditEditArea a.btn.btn-primary', // 文字「送出」
            cancelBtn: 'div.auditEditArea a.btn' // 文字「取消」
          }
        };
      }
    });

    return {
      recordId,
      headerText,
      questions: questionItems
    };
  }

  /**
   * 產生問答題人工批改的 DOM 填寫與送出規劃
   */
  buildEssayAuditPlan(questionId, score, commentHtml = '') {
    return {
      questionId,
      score: Number(score),
      commentHtml,
      domSequence: [
        { action: 'click', description: '點擊問答題「修改」按鈕切換至 auditEditArea', selector: 'div.auditShowArea a' },
        { action: 'setValue', description: '輸入新分數', selector: 'div.auditEditArea input[type=text]', value: String(score) },
        { action: 'setIframeHtml', description: '輸入富文字評語', selector: 'div.auditEditArea iframe.rte-editable', html: commentHtml },
        { action: 'syncValue', description: '同步至隱藏 textarea[name^=essay_audit]', selector: `textarea[name="${questionId}"]`, value: `<div>${commentHtml}</div>` },
        { action: 'click', description: '點擊「送出」按鈕送出評分', selector: 'div.auditEditArea a.btn.btn-primary' }
      ]
    };
  }

  /**
   * 批次自動同步匯入測驗問答題評分與評語規劃
   */
  generateBatchAuditPlan(examId, items, consentToken, role = Roles.ASSISTANT) {
    permissionGuard.assertPermission(role, Permissions.EXAM_AUDIT);
    // 批次覆寫成績需 UI 許可驗證
    permissionGuard.verifyAndConsumeConsent(consentToken, 'batch_import_scores', examId);

    return {
      examId,
      itemCount: items.length,
      plan: items.map(it => ({
        recordId: it.recordId,
        studentId: it.studentId,
        questionId: it.questionId,
        score: Number(it.score),
        commentHtml: it.commentHtml || ''
      }))
    };
  }
}

export const examSubmissionAuditAgent = new ExamSubmissionAuditAgent();
export default examSubmissionAuditAgent;
