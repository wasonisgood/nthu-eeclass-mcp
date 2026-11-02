/**
 * NTHU eeclass Copilot - 權限分類鑑權與使用者 UI 許可守衛 (Permission & Consent Guard)
 * 
 * 功能：
 * 1. 角色型權限存取控制 (RBAC)：教師 (teacher)、助教 (assistant)、學生 (student)、訪客 (guest)
 * 2. 資料權限分類：讀取 (read)、寫入 (write)、批改 (audit)、刪除 (delete)、廣播 (notify)
 * 3. 業務安全約束防護：
 *    - 作業刪除僅限未有繳交者 (submittedCount === 0)
 *    - 測驗刪除僅限未有測驗/繳交者 (testedCount === 0)
 * 4. 使用者 UI 許可機制 (User Consent Tokens)：高危險動作（刪除、全體寄信、批次成績覆寫）必須通過前端 UI 確認
 */

export const Roles = {
  TEACHER: 'teacher',
  ASSISTANT: 'assistant',
  STUDENT: 'student',
  GUEST: 'guest'
};

export const Permissions = {
  // 課程
  COURSE_READ: 'course:read',
  COURSE_MANAGE: 'course:manage',
  // 作業
  HOMEWORK_READ: 'homework:read',
  HOMEWORK_WRITE: 'homework:write',
  HOMEWORK_DELETE: 'homework:delete',
  HOMEWORK_AUDIT: 'homework:audit',
  HOMEWORK_EXPORT: 'homework:export',
  // 測驗
  EXAM_READ: 'exam:read',
  EXAM_WRITE: 'exam:write',
  EXAM_DELETE: 'exam:delete',
  EXAM_AUDIT: 'exam:audit',
  // 公告
  BULLETIN_READ: 'bulletin:read',
  BULLETIN_WRITE: 'bulletin:write',
  BULLETIN_DELETE: 'bulletin:delete',
  BULLETIN_NOTIFY: 'bulletin:notify'
};

const RolePermissionsMap = {
  [Roles.TEACHER]: Object.values(Permissions),
  [Roles.ASSISTANT]: Object.values(Permissions),
  [Roles.STUDENT]: [
    Permissions.COURSE_READ,
    Permissions.HOMEWORK_READ,
    Permissions.EXAM_READ,
    Permissions.BULLETIN_READ
  ],
  [Roles.GUEST]: [
    Permissions.COURSE_READ,
    Permissions.BULLETIN_READ
  ]
};

// 高危險性動作清單（必須具備 UI 許可 Token）
export const HighRiskActions = [
  'delete_homework',
  'delete_exam',
  'delete_bulletin',
  'broadcast_email',
  'batch_import_scores'
];

class PermissionGuard {
  constructor() {
    this.activeConsents = new Map(); // token -> { action, targetId, expiresAt, reason }
  }

  /**
   * 檢查角色是否具備指定權限
   */
  hasPermission(role, permission) {
    const perms = RolePermissionsMap[role] || [];
    return perms.includes(permission);
  }

  /**
   * 斷言權限，若無則拋出例外
   */
  assertPermission(role, permission) {
    if (!this.hasPermission(role, permission)) {
      const err = new Error(`[Permission Denied] 角色 "${role}" 未具備 "${permission}" 權限`);
      err.statusCode = 403;
      err.code = 'ERR_PERMISSION_DENIED';
      throw err;
    }
  }

  /**
   * 驗證作業刪除之業務安全約束（僅限未有繳交者）
   */
  assertHomeworkCanDelete(submittedCount) {
    if (submittedCount > 0) {
      const err = new Error(`[Conflict] 作業已有 ${submittedCount} 位學生繳交，系統依指引嚴格限制禁止刪除！`);
      err.statusCode = 409;
      err.code = 'ERR_HOMEWORK_HAS_SUBMISSIONS';
      throw err;
    }
    return true;
  }

  /**
   * 驗證測驗刪除之業務安全約束（僅限未有測驗/作答者）
   */
  assertExamCanDelete(testedCount) {
    if (testedCount > 0) {
      const err = new Error(`[Conflict] 測驗已有 ${testedCount} 位學生完成作答，系統依指引嚴格限制禁止刪除！`);
      err.statusCode = 409;
      err.code = 'ERR_EXAM_HAS_SUBMISSIONS';
      throw err;
    }
    return true;
  }

  /**
   * 簽發使用者 UI 許可 Token（通常由前端彈出確認對話框、使用者點擊同意後調用）
   */
  grantConsent(action, targetId, reason = '', ttlSeconds = 300) {
    const token = 'cst_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
    const expiresAt = Date.now() + (ttlSeconds * 1000);

    const consentData = {
      token,
      action,
      targetId: String(targetId),
      reason,
      expiresAt,
      createdAt: Date.now()
    };

    this.activeConsents.set(token, consentData);
    return consentData;
  }

  /**
   * 驗證使用者 UI 許可 Token（單次消費或有效期限內檢查）
   */
  verifyAndConsumeConsent(token, requiredAction, targetId) {
    if (!token) {
      const err = new Error(`[UI Consent Required] 此為重大/破壞性操作（${requiredAction}），必須先經由前端 UI 許可對話框確認後攜帶 Consent Token！`);
      err.statusCode = 403;
      err.code = 'ERR_UI_CONSENT_REQUIRED';
      throw err;
    }

    const consent = this.activeConsents.get(token);
    if (!consent) {
      const err = new Error(`[Invalid Consent Token] 提供之 UI 許可權杖不存在或已失效`);
      err.statusCode = 403;
      err.code = 'ERR_INVALID_CONSENT_TOKEN';
      throw err;
    }

    if (Date.now() > consent.expiresAt) {
      this.activeConsents.delete(token);
      const err = new Error(`[Expired Consent Token] UI 許可權杖已過期，請重新確認授權`);
      err.statusCode = 403;
      err.code = 'ERR_EXPIRED_CONSENT_TOKEN';
      throw err;
    }

    if (consent.action !== requiredAction || String(consent.targetId) !== String(targetId)) {
      const err = new Error(`[Consent Mismatch] 許可權杖用途（${consent.action} #${consent.targetId}）與目前請求不符`);
      err.statusCode = 403;
      err.code = 'ERR_CONSENT_MISMATCH';
      throw err;
    }

    // 驗證成功後刪除（防重放攻擊）
    this.activeConsents.delete(token);
    return true;
  }
}

export const permissionGuard = new PermissionGuard();
export default permissionGuard;
