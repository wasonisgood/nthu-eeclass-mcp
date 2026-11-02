/**
 * NTHU eeclass Copilot - 公告 CRUD 與寄信通知 Agent (Bulletin CRUD Agent)
 * 
 * 依據「助教老師要開發的功能及開發必要指引/助教、老師公告 CRUD的方法.md」：
 * - 列表頁面：/course/bulletin/{courseId}
 * - 表格欄位：tr 內 td.col-name (標題)、td.col-num (項次)、td.col-date (日期)
 * - 新增按鈕：span.text 文字「新增」，iframe /bulletin/editContent/0/
 * - 編輯選單：ul.dropdown-menu a 文字「編輯」，iframe /bulletin/editContent/{bulletinId}/
 * - 刪除選單：ul.dropdown-menu a 文字「刪除」，端點 /ajax/sys.app.bulletin/del/ (需 UI 許可)
 * - 寄信通知：ul.dropdown-menu a 文字「寄信通知」，端點 /ajax/sys.app.bulletin/setNotifyMessage/ (需 UI 許可)
 */

import permissionGuard, { Roles, Permissions } from '../auth/permissionGuard.js';

export class BulletinCrudAgent {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://eeclass.nthu.edu.tw';
  }

  /**
   * 解析公告列表頁面 (/course/bulletin/{courseId})
   * 取得每則公告的 ID、項次、標題、公告日期、是否置頂與草稿狀態
   */
  parseBulletinList(docOrHtml, courseId) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      const parser = new DOMParser();
      doc = parser.parseFromString(docOrHtml, 'text/html');
    }

    const rows = [...doc.querySelectorAll('tr')].filter(r => r.querySelector('td.col-name'));

    return rows.map(r => {
      const titleLink = r.querySelector('td.col-name a.fs-bulletin-item, td.col-name a');
      const numEl = r.querySelector('td.col-num');
      const dateEl = r.querySelector('td.col-date');
      const popularityEl = r.querySelector('td.col-char2');

      let bulletinId = null;
      if (titleLink) {
        // 從 data-url 或 href 讀取 bulletinId
        const url = titleLink.getAttribute('data-url') || titleLink.getAttribute('href') || '';
        const match = url.match(/\/bulletin\/(?:editContent|viewContent|content)\/(\d+)/);
        if (match) bulletinId = parseInt(match[1], 10);
      }

      // 檢查是否為置頂 HOT 或重要公告
      const isTopMost = Boolean(r.querySelector('.badge-danger, .hot-tag, [class*="topMost"]'));

      // 檢查是否為草稿
      const isDraft = /草稿|draft/i.test(r.textContent);

      return {
        courseId,
        bulletinId,
        num: numEl ? numEl.textContent.trim() : '',
        title: titleLink ? titleLink.textContent.trim() : '',
        date: dateEl ? dateEl.textContent.trim() : '',
        popularity: popularityEl ? popularityEl.textContent.trim() : '0',
        isTopMost,
        isDraft
      };
    });
  }

  /**
   * 產生建立公告之表單填寫指引與欄位定義
   */
  buildCreatePayload(params) {
    const {
      title,
      content = '',
      period_start,
      period_end = '',
      topMost = false,
      draft = false,
      attach_checkbox = false
    } = params;

    return {
      modalId: 'mod_bulletin_contentModal_course_{courseId}',
      iframeUrl: '/bulletin/editContent/0/',
      selectors: {
        type: 'input[type=hidden][name=type]',
        topMost: 'input[type=checkbox][value=topMost]',
        draft: 'input[type=checkbox][value=draft]',
        periodStart: 'input#period_start, input[name=period_start]',
        periodEnd: 'input#period_end, input[name=period_end]',
        title: 'input[name=title]',
        content: 'textarea[name=content]',
        fileInput: 'input[type=file][name="files[]"]',
        attachCheckbox: 'input[type=checkbox][name=attach_checkbox]',
        submitBtn: 'button[type=submit].btn-primary'
      },
      values: {
        title,
        content,
        period_start,
        period_end,
        topMost,
        draft,
        attach_checkbox
      }
    };
  }

  /**
   * 執行公告刪除防護與前置檢查
   */
  assertDeleteSafeguards(options) {
    const { role, consentToken, bulletinId } = options;

    // 1. 角色權限檢查（助教或老師）
    permissionGuard.assertPermission(role, Permissions.BULLETIN_DELETE);

    // 2. UI 許可 Token 驗證（刪除公告為不可逆行為）
    permissionGuard.verifyAndConsumeConsent(consentToken, 'delete_bulletin', bulletinId);

    return {
      canDelete: true,
      confirmed: true,
      endpoint: `/ajax/sys.app.bulletin/del/`,
      data: { id: bulletinId }
    };
  }

  /**
   * 執行寄信通知全體成員之高危險性防護與前置檢查
   */
  assertMailNotifySafeguards(options) {
    const { role, consentToken, bulletinId, courseId } = options;

    // 1. 角色權限檢查
    permissionGuard.assertPermission(role, Permissions.BULLETIN_NOTIFY);

    // 2. UI 許可 Token 驗證（發送全體郵件會寄送全班，包含老師與助教）
    permissionGuard.verifyAndConsumeConsent(consentToken, 'broadcast_email', bulletinId);

    return {
      canBroadcast: true,
      confirmed: true,
      endpoint: `/ajax/sys.app.bulletin/setNotifyMessage/`,
      dataParam: { sendEmailCourseAllUser: 1, courseId, bulletinId }
    };
  }
}

export const bulletinCrudAgent = new BulletinCrudAgent();
export default bulletinCrudAgent;
