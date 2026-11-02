/**
 * NTHU eeclass Copilot - 資料權限許可與授權管理器 (Consent & Authorization Manager)
 * 
 * 功能：
 * 1. 貫徹「單次許可」與「永久許可」雙軌制：
 *    - 單次許可 (one_time)：僅限本次操作有效，執行完畢即銷毀，下次相同操作再度彈窗確認。
 *    - 永久許可 (permanent)：儲存於本機授權偏好中，下次相同課程與同類型操作自動放行。
 * 2. 精確載明操作細節（Impact & Payload Inspection）：
 *    - 影響課程（課程名稱、代碼、目前身分：助教 vs 學生）
 *    - 預計執行的動作（例如：出作業、批改給分、刪除作答紀錄、發布公告、發送信件）
 *    - 預計填入或修改的詳細內容（分數、評語、學號、標題、截止日等）
 * 3. 整合 Chrome Extension 許可彈窗 (consent.html) 進行雙向驗證。
 */

import { Roles, Permissions } from './permissionGuard.js';

export class ConsentManager {
  constructor() {
    // 永久許可清單：key 格式為 `${courseId || '*'}:${action}`
    this.permanentConsents = new Set();
    // 活躍的單次許可 Token 池
    this.activeConsents = new Map();
    // 等待使用者在 Chrome 點擊確認的 Pending Requests
    this.pendingRequests = new Map();
    // 課程身份快取：courseId -> { role: 'teacher'|'assistant'|'student', courseName, courseCode }
    this.courseIdentities = new Map();
  }

  /**
   * 註冊或更新課程身份快取
   */
  registerCourseIdentity(courseId, info) {
    this.courseIdentities.set(Number(courseId), {
      courseId: Number(courseId),
      courseName: info.courseName || `課程 ${courseId}`,
      courseCode: info.courseCode || `CRS${courseId}`,
      role: info.role || Roles.STUDENT,
      identityLabel: info.identityLabel || (info.role === Roles.TEACHER ? '授課教師' : info.role === Roles.ASSISTANT ? '助教' : '學生')
    });
  }

  /**
   * 批次載入課程清單並更新身份
   */
  loadCourseIdentities(courses = []) {
    courses.forEach(c => this.registerCourseIdentity(c.courseId, c));
  }

  /**
   * 取得使用者在某課程的身分
   */
  getCourseIdentity(courseId) {
    return this.courseIdentities.get(Number(courseId)) || {
      courseId: Number(courseId),
      courseName: `課程 ${courseId}`,
      courseCode: `CRS${courseId}`,
      role: Roles.STUDENT,
      identityLabel: '一般學生'
    };
  }

  /**
   * 檢查操作是否屬於高風險/敏感操作（需主動授權）
   */
  isSensitiveAction(action) {
    const sensitiveActions = [
      'homework:create',
      'homework:update',
      'homework:delete',
      'homework:grade',
      'homework:reject',
      'homework:copy',
      'exam:create',
      'exam:update',
      'exam:delete',
      'exam:reset_attempt',
      'exam:grade_essay',
      'bulletin:create',
      'bulletin:update',
      'bulletin:delete',
      'bulletin:broadcast_email',
      'grade:import_csv'
    ];
    return sensitiveActions.includes(action);
  }

  /**
   * 檢查是否已具備有效授權（永久或單次）
   */
  hasConsent(courseId, action, consentToken = '') {
    const courseKey = `${courseId}:${action}`;
    const wildcardKey = `*:${action}`;

    // 1. 檢查是否有永久授權
    if (this.permanentConsents.has(courseKey) || this.permanentConsents.has(wildcardKey)) {
      return { granted: true, mode: 'permanent', reason: '使用者已永久授權此項操作' };
    }

    // 2. 檢查是否有傳入有效的單次 Token
    if (consentToken && this.activeConsents.has(consentToken)) {
      const consent = this.activeConsents.get(consentToken);
      if (Date.now() <= consent.expiresAt && consent.action === action && Number(consent.targetCourseId) === Number(courseId)) {
        // 單次使用防重放：立即刪除
        this.activeConsents.delete(consentToken);
        return { granted: true, mode: 'one_time', reason: '單次許可驗證通過並已完成核銷' };
      }
    }

    return { granted: false, mode: 'none', reason: '尚未獲得授權或單次授權已過期' };
  }

  /**
   * 建立授權許可請求 (Create Consent Request)
   * 當操作尚未獲得永久授權時，由 MCP/外掛呼叫此方法產生結構化請求並喚醒 Chrome 彈出 consent.html
   */
  createConsentRequest({
    courseId,
    action,
    actionTitle,
    actionDescription,
    payload = {},
    requiresTaRole = false
  }) {
    const requestId = 'req_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    const courseInfo = this.getCourseIdentity(courseId);

    // 身份預檢：若該功能需助教身分但使用者為一般學生，立即在請求階段標明無權限
    let roleWarning = null;
    if (requiresTaRole && courseInfo.role === Roles.STUDENT) {
      roleWarning = `身分不符：您在【${courseInfo.courseName}】為「${courseInfo.identityLabel}」，此功能需要「助教」或「授課教師」權限！`;
    }

    const requestData = {
      requestId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 分鐘有效
      courseId: Number(courseId),
      courseName: courseInfo.courseName,
      courseCode: courseInfo.courseCode,
      userRole: courseInfo.role,
      userIdentityLabel: courseInfo.identityLabel,
      action,
      actionTitle,
      actionDescription,
      payload,
      roleWarning,
      requiresTaRole,
      status: 'PENDING'
    };

    this.pendingRequests.set(requestId, requestData);
    return requestData;
  }

  /**
   * 使用者在 Chrome 授權頁面點選授權結果 (Resolve Consent Decision)
   * @param {string} requestId - 請求 ID
   * @param {'one_time'|'permanent'|'reject'} decision - 決定：單次許可 / 永久許可 / 拒絕
   */
  resolveConsentDecision(requestId, decision) {
    const req = this.pendingRequests.get(requestId);
    if (!req) {
      throw new Error(`找不到對應的許可請求 [${requestId}] 或請求已過期`);
    }

    if (Date.now() > req.expiresAt) {
      this.pendingRequests.delete(requestId);
      throw new Error(`許可請求 [${requestId}] 已逾時過期，請重新發起`);
    }

    if (decision === 'reject') {
      req.status = 'REJECTED';
      this.pendingRequests.delete(requestId);
      return {
        granted: false,
        mode: 'rejected',
        message: '使用者已於擴充功能授權視窗中明確拒絕此項操作'
      };
    }

    // 產生授權 Token
    const token = 'cst_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    const expiresAt = Date.now() + 10 * 60 * 1000;

    if (decision === 'permanent') {
      const courseKey = `${req.courseId}:${req.action}`;
      this.permanentConsents.add(courseKey);
      req.status = 'GRANTED_PERMANENT';
    } else {
      req.status = 'GRANTED_ONE_TIME';
    }

    const consentRecord = {
      token,
      requestId,
      action: req.action,
      targetCourseId: req.courseId,
      mode: decision,
      expiresAt,
      createdAt: Date.now()
    };

    this.activeConsents.set(token, consentRecord);
    this.pendingRequests.delete(requestId);

    return {
      granted: true,
      mode: decision,
      token,
      message: decision === 'permanent' 
        ? `已成功賦予【${req.courseName}】此項操作之永久許可` 
        : `已核發單次操作許可權杖（有效期限 10 分鐘）`
    };
  }

  /**
   * 撤銷特定或全部永久許可
   */
  revokePermanentConsent(courseId, action) {
    if (courseId && action) {
      this.permanentConsents.delete(`${courseId}:${action}`);
    } else if (courseId) {
      for (const key of this.permanentConsents) {
        if (key.startsWith(`${courseId}:`)) this.permanentConsents.delete(key);
      }
    } else {
      this.permanentConsents.clear();
    }
  }

  /**
   * 導出目前授權清單摘要
   */
  exportConsentSummary() {
    return {
      permanentConsentsCount: this.permanentConsents.size,
      permanentConsentsList: Array.from(this.permanentConsents),
      activeConsentsCount: this.activeConsents.size,
      pendingRequestsCount: this.pendingRequests.size,
      trackedCoursesCount: this.courseIdentities.size,
      trackedCourses: Array.from(this.courseIdentities.values())
    };
  }
}

export const consentManager = new ConsentManager();
export default consentManager;
