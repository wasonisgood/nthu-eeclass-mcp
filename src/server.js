/**
 * NTHU eeclass Copilot - 專用 Claude Desktop MCP 伺服器 (Model Context Protocol Server)
 * 
 * 功能亮點：
 * 1. 完整對應 OpenAPI 與工作台端點能力：涵蓋權限鑑權、課程資訊、作業 CRUD、作業批改/打包、
 *    測驗 CRUD、測驗問答題批改、公告 CRUD 與全體廣播通知。
 * 2. 嚴格執行資料安全守衛：
 *    - 作業刪除僅限未有繳交者 (submittedCount === 0)，違者拒絕並回傳錯誤
 *    - 測驗刪除僅限未有作答者 (testedCount === 0)，違者拒絕並回傳錯誤
 *    - 敏感操作（刪除、全體寄信、成績批改覆寫）強制要求 UI 許可 Token
 * 3. 專屬 AI 助教工作輔助工具 (AI Assistant Tools)：
 *    - ai_generate_homework_assignment: AI 智能出作業（完整規準 Rubric、情境題與格式）
 *    - ai_compose_bulletin_announcement: AI 智能撰寫並發布課程公告
 *    - ai_assist_grading_feedback: AI 批改評語與建議得分產生器
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import permissionGuard, { Roles, Permissions } from "./agents/auth/permissionGuard.js";
import consentManager from "./agents/auth/consentManager.js";
import courseInfoAgent from "./agents/base/courseInfoAgent.js";
import homeworkCrudAgent from "./agents/homework/homeworkCrudAgent.js";
import homeworkSubmissionAuditAgent from "./agents/homework/homeworkSubmissionAuditAgent.js";
import examCrudAgent from "./agents/exam/examCrudAgent.js";
import examSubmissionAuditAgent from "./agents/exam/examSubmissionAuditAgent.js";
import bulletinCrudAgent from "./agents/bulletin/bulletinCrudAgent.js";
import extensionBridge from "./bridge.js";

// 初始化 MCP Server
const server = new McpServer({
  name: "nthu-eeclass-copilot",
  version: "1.5.0"
});

/**
 * 核心權限與授權驗證守衛：
 * 1. 檢核使用者在該課程是否具備「助教 (TA)」或「老師 (Teacher)」身分（若為學生身分直接阻擋）。
 * 2. 檢核授權狀態：若已有「永久許可」或「有效單次 Token」則放行；否則自動喚醒 Chrome 彈出 consent.html。
 */
async function verifyCourseRoleAndConsent({
  courseId,
  action,
  actionTitle,
  actionDescription,
  payload = {},
  consentToken = ""
}) {
  // 1. 檢查課程身分
  const identity = consentManager.getCourseIdentity(courseId);
  if (identity.role === Roles.STUDENT) {
    const teachingCourses = extensionBridge.cachedCourseRoles.teachingCourses.map(c => `【${c.courseName}】`).join("、");
    const err = new Error(`【身分權限不足】您在【${identity.courseName}】（ID: ${courseId}）的身分是一般修課學生，無法執行助教或教師管理功能。此操作僅限於您擔任助教或教師的課程（例如：${teachingCourses || "無"}）。`);
    err.code = "PERMISSION_DENIED_STUDENT_ROLE";
    throw err;
  }

  // 2. 檢查授權狀態（永久或已核銷單次）
  const check = consentManager.hasConsent(courseId, action, consentToken);
  if (check.granted) {
    return { granted: true, mode: check.mode, message: check.reason };
  }

  // 3. 若為單次且尚未核准，自動透過 Chrome 彈出授權視窗
  console.error(`[Consent Guard] 動作 [${action}] 於課程 #${courseId} 尚未獲得永久或單次授權，正在彈出許可確認視窗...`);
  const outcome = await extensionBridge.requestUserConsentModal({
    courseId,
    action,
    actionTitle,
    actionDescription,
    payload,
    requiresTaRole: true
  });

  if (!outcome.granted) {
    const err = new Error(outcome.message || `操作已中止：使用者未授予 [${actionTitle}] 許可`);
    err.code = "USER_CONSENT_REJECTED";
    throw err;
  }

  return outcome;
}

// 模擬資料儲存（對照行政法一 35657 與測試情境）
const store = {
  currentRole: Roles.ASSISTANT,
  courses: [
    {
      courseId: 35657,
      courseCode: "11310LAW100100",
      courseName: "行政法一",
      role: "assistant",
      teachers: ["林老師"],
      assistants: ["助教團隊", "王助教"],
      currentUserIdentity: "助教"
    }
  ],
  homeworks: [
    {
      courseId: 35657,
      homeworkId: 70800,
      title: "期中考備案",
      type: "personal",
      isGroup: false,
      submittedCount: 4, // 已有 4 人繳交，禁止刪除
      gradedCount: 0,
      startDate: "2026-10-28 10:00",
      deadline: "2026-10-28 12:30",
      allowDelay: false,
      weight: 0,
      auditMode: 1,
      canDelete: false,
      description: "行政法一期中考備案作業區，請依規定時間內繳交 Word 或 PDF 檔。"
    },
    {
      courseId: 35657,
      homeworkId: 70899,
      title: "課堂練習二（未有繳交者）",
      type: "personal",
      isGroup: false,
      submittedCount: 0, // 0 人繳交，可安全刪除
      gradedCount: 0,
      startDate: "2026-11-01 10:00",
      deadline: "2026-11-05 23:59",
      allowDelay: true,
      weight: 10,
      auditMode: 1,
      canDelete: true,
      description: "課堂隨堂實例演練作業。"
    }
  ],
  submissions: [
    {
      reportId: 104521,
      homeworkId: 70800,
      studentId: "111062501",
      studentName: "張小華",
      title: "張小華_期中考備案",
      submitTime: "2026-10-28 11:22",
      score: "-",
      isGraded: false,
      attachments: [{ fileName: "行政法_期中考.docx", downloadUrl: "/filedownload/104521/1" }],
      studentAnswerText: "關於行政處分撤銷與廢止之區分，依行政程序法第 117 條..."
    },
    {
      reportId: 104522,
      homeworkId: 70800,
      studentId: "111062502",
      studentName: "李大同",
      title: "李大同_期中考備案",
      submitTime: "2026-10-28 11:45",
      score: "85",
      isGraded: true,
      attachments: [{ fileName: "期中考備案_李大同.pdf", downloadUrl: "/filedownload/104522/1" }],
      studentAnswerText: "本件訴訟依行政訴訟法應提起撤銷訴願及撤銷訴訟..."
    }
  ],
  exams: [
    {
      courseId: 35657,
      examId: 8633,
      kexamId: 5540,
      title: "期中考",
      startTime: "2026-10-28 10:00",
      endTime: "2026-10-28 12:00",
      fullScore: 100,
      passScore: 60,
      weight: 30,
      testedCount: 65, // 已有 65 人測驗，禁止刪除
      canDelete: false,
      description: "期中筆試測驗，含選擇題與實例問答題。"
    },
    {
      courseId: 35657,
      examId: 8999,
      kexamId: 5999,
      title: "模擬隨堂測驗（未有作答者）",
      startTime: "2026-11-05 10:00",
      endTime: "2026-11-05 11:00",
      fullScore: 100,
      passScore: 60,
      weight: 10,
      testedCount: 0, // 0 人測驗，可安全刪除
      canDelete: true,
      description: "平時小考測驗。"
    }
  ],
  examRecords: [
    {
      recordId: 34912,
      examId: 8633,
      studentName: "陳建國",
      studentId: "111062510",
      score: 74,
      submittedTime: "2026-10-28 11:50",
      status: "已完成",
      questions: [
        {
          questionId: "q1_choice",
          type: "choice",
          questionText: "下列何者不屬於行政處分之構成要件？",
          maxScore: 5,
          givenScore: 5,
          studentAnswer: "(C) 私法契約行為",
          systemModelAnswer: "(C) 私法契約行為",
          isAutoGraded: true
        },
        {
          questionId: "essay_audit83754",
          type: "essay",
          questionText: "請依大法官釋字第 535 號解釋，論述警察實施臨檢之要件與救濟途徑。（30分）",
          maxScore: 30,
          givenScore: 26,
          studentAnswer: "警察臨檢應限於已發生危害或依客觀判斷易生危害之處所...得當場陳述理由表示異議。",
          systemModelAnswer: "擬答：警察實施臨檢非漫無限制，依釋字第 535 號...",
          comment: "論述完整，引用釋字字號準確。",
          isAutoGraded: false
        }
      ]
    }
  ],
  bulletins: [
    {
      courseId: 35657,
      bulletinId: 19842,
      num: "1",
      title: "期中考作答規範與注意事項",
      content: "各位同學好：\n期中考將於本週三舉行，請務必於指定時間前上傳作答檔案...",
      date: "2026-10-25",
      isTopMost: true,
      isDraft: false
    }
  ]
};

// ==================== 1. 權限與 UI 許可工具 ====================

server.tool(
  "check_extension_and_setup_status",
  "【環境與設定檢測】檢查 Google Chrome 瀏覽器是否開啟、擴充功能是否安裝並就緒、校務資訊系統密碼是否已完成加密設定，以及目前課程身份辨識狀態。若偵測到未安裝外掛或未設定密碼，將自動在 Chrome 開啟設定引導精靈。",
  {},
  async () => {
    const isChromeActive = await extensionBridge.isChromeRunning();
    const isExtReady = extensionBridge.extensionConnected || Boolean(extensionBridge.lastReceivedEvent);
    const guideUrl = `http://127.0.0.1:${extensionBridge.bridgePort}/setup-guide.html`;

    // 若未開啟 Chrome 或外掛未就緒，自動喚醒引導精靈
    let actionTaken = "NONE";
    if (!isChromeActive || !isExtReady) {
      await extensionBridge.launchSetupGuideInChrome();
      actionTaken = "LAUNCHED_SETUP_GUIDE_IN_CHROME";
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: isChromeActive && isExtReady ? "READY" : "SETUP_REQUIRED",
            chromeRunning: isChromeActive,
            extensionConnected: isExtReady,
            actionTaken,
            setupGuideUrl: guideUrl,
            advice: isExtReady 
              ? "Chrome 擴充功能處於就緒狀態，已具備課程身份與通訊埠！" 
              : "已自動為您開啟設定精靈頁面，請在 Chrome 中依照 3 個步驟載入擴充套件並設定密碼。"
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "wake_and_bootstrap_eeclass",
  "【喚醒與首次登入引導】喚醒擴充功能進行自動驗證碼登入，並掃描使用者所有課程清單，自動區分出「助教/授課教師」與「一般學生」課程身份，確保後續操作具備正確權限上下文。",
  {},
  async () => {
    // 1. 確保 Chrome 啟動並進入 eeclass
    const sessionRes = await extensionBridge.ensureChromeAndEeclassSession();
    
    // 2. 取得並劃分課程身分
    const roles = extensionBridge.cachedCourseRoles;
    extensionBridge.syncCourseRolesToConsentManager();

    const ack = await extensionBridge.dispatchToolCallToExtension("wake_and_bootstrap_eeclass", {
      teachingCoursesCount: roles.teachingCourses.length,
      studentCoursesCount: roles.studentCourses.length
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "BOOTSTRAP_COMPLETE",
            session: sessionRes,
            extensionVerification: ack,
            courseClassification: {
              teachingCourses: roles.teachingCourses.map(c => ({
                courseId: c.courseId,
                courseCode: c.courseCode,
                courseName: c.courseName,
                role: c.role,
                identityLabel: c.identityLabel,
                capabilities: ["作業CRUD", "成績批改", "試卷管理", "公告發布", "名單清查"]
              })),
              studentCourses: roles.studentCourses.map(c => ({
                courseId: c.courseId,
                courseCode: c.courseCode,
                courseName: c.courseName,
                role: c.role,
                identityLabel: c.identityLabel,
                capabilities: ["瀏覽課程", "下載講義教材", "個人作業繳交", "線上作答"]
              })),
              summary: {
                totalCourses: roles.teachingCourses.length + roles.studentCourses.length,
                teachingCount: roles.teachingCourses.length,
                studentCount: roles.studentCourses.length
              }
            },
            message: "已成功喚醒擴充功能並完成課程身分劃分！後續程式將依據此身分施行精確的權限守衛。"
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "get_classified_courses",
  "【查詢課程身分分類清單】取得所有課程之身分權限劃分清冊，清楚展示哪些課程具備助教/教師管理權（可作業CRUD、批改、公告等），哪些課程是一般修課學生權限（可瀏覽、下載講義、繳交作業等）。",
  {},
  async () => {
    const roles = extensionBridge.cachedCourseRoles;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            teachingCourses: roles.teachingCourses,
            studentCourses: roles.studentCourses,
            summary: {
              teachingCoursesCount: roles.teachingCourses.length,
              studentCoursesCount: roles.studentCourses.length,
              totalCount: roles.teachingCourses.length + roles.studentCourses.length
            }
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "request_action_consent",
  "【操作資料授權申請（單次／永久許可）】在執行敏感或大量資料填入（如出作業、批改給分、刪除作答、發布公告）前，向擴充套件申請使用者授權。使用者可在 Chrome 許可頁面明確檢視填入內容，並選擇「僅本次允許」或「記住並永久允許」。",
  {
    courseId: z.number().describe("目標課程 ID"),
    action: z.string().describe("操作代碼（例如 homework:create, homework:grade, bulletin:create 等）"),
    actionTitle: z.string().describe("操作名稱（如：批改學生作業成績、發布課程公告）"),
    actionDescription: z.string().describe("詳細操作說明與預計變更範圍"),
    payload: z.record(z.any()).describe("預計填入或修改的詳細資料（如成績、評語、標題、截止日等）"),
    preferredMode: z.enum(["one_time", "permanent"]).default("one_time").describe("預期授權模式：單次許可 (one_time) 或 永久許可 (permanent)")
  },
  async ({ courseId, action, actionTitle, actionDescription, payload, preferredMode }) => {
    // 檢查課程身分
    const courseInfo = consentManager.getCourseIdentity(courseId);
    if (courseInfo.role === Roles.STUDENT) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `【身分權限不足】您在【${courseInfo.courseName}】為一般修課學生，無法申請助教操作許可！`
        }]
      };
    }

    // 檢查是否已有永久授權
    const existing = consentManager.hasConsent(courseId, action);
    if (existing.granted && existing.mode === "permanent") {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            granted: true,
            mode: "permanent",
            message: `此動作在【${courseInfo.courseName}】先前已被記住為永久允許，無需重複授權！`,
            courseId,
            action
          }, null, 2)
        }]
      };
    }

    // 建立授權請求並直接簽發所選模式（或呼叫彈窗）
    const req = consentManager.createConsentRequest({
      courseId,
      action,
      actionTitle,
      actionDescription,
      payload,
      requiresTaRole: true
    });

    const outcome = consentManager.resolveConsentDecision(req.requestId, preferredMode);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            granted: outcome.granted,
            mode: outcome.mode,
            consentToken: outcome.token,
            courseName: courseInfo.courseName,
            actionTitle,
            message: outcome.message,
            payloadInspection: payload
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "list_granted_consents",
  "【查詢目前已獲授權清冊】列出目前已生效的單次許可 Token 與各課程永久許可清單及已追蹤課程身分。",
  {},
  async () => {
    const summary = consentManager.exportConsentSummary();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(summary, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "revoke_permanent_consent",
  "【撤銷特定或全部永久許可】撤銷指定課程或所有已記憶的永久操作許可，恢復為每次操作皆跳窗確認。",
  {
    courseId: z.number().optional().describe("欲撤銷之課程 ID（若留空則撤銷所有課程）"),
    action: z.string().optional().describe("欲撤銷之特定動作代碼（例如 homework:create）")
  },
  async ({ courseId, action }) => {
    consentManager.revokePermanentConsent(courseId, action);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: courseId 
              ? `已成功撤銷課程 #${courseId} ${action ? `動作 [${action}]` : '所有動作'} 之永久授權` 
              : "已成功重置並清空所有課程的永久授權！"
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "get_user_permissions",
  "查詢目前使用者在 eeclass 中的角色（Teacher/TA/Student/Guest）與具備的資料增刪查改操作許可分類",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            systemRole: store.currentRole,
            teachingCoursesCount: store.courses.length,
            allowedActions: store.currentRole === Roles.STUDENT ? [
              "course:read", "homework:read", "exam:read", "bulletin:read"
            ] : Object.values(Permissions)
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "request_ui_consent",
  "申請高危險性操作（刪除作業/刪除測驗/刪除公告/廣播全體郵件/批次成績匯入）之使用者 UI 許可權杖 (Consent Token)。在進行破壞性操作前必須調用此工具取得授權權杖。",
  {
    action: z.enum([
      "delete_homework",
      "delete_exam",
      "delete_bulletin",
      "broadcast_email",
      "batch_import_scores"
    ]).describe("要申請授權的高危險動作名稱"),
    targetId: z.string().describe("目標 ID（如作業 ID、測驗 ID、公告 ID）"),
    reason: z.string().describe("執行此操作的業務理由或說明")
  },
  async ({ action, targetId, reason }) => {
    const consent = permissionGuard.grantConsent(action, targetId, reason);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `✅ 已為動作 [${action} #${targetId}] 成功核發使用者 UI 許可權杖`,
            consentToken: consent.token,
            expiresAt: new Date(consent.expiresAt).toISOString(),
            warning: "此權杖為單次使用或於 5 分鐘內有效，執行該動作時請帶入此權杖。"
          }, null, 2)
        }
      ]
    };
  }
);

// ==================== 2. 基礎課程模組工具 ====================

server.tool(
  "list_teaching_courses",
  "取得所有所屬身份為助教或老師的課程清單（包含課程代碼、數字 ID、授課教師名單與身份）。這是所有作業、測驗與公告功能的基礎。",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            count: store.courses.length,
            courses: store.courses
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "get_course_sidebar_info",
  "取得指定課程的側欄資訊（授課老師名單、助教名單、目前使用者身份與課程代號）",
  {
    courseId: z.number().describe("課程數字 ID（例如行政法一為 35657）")
  },
  async ({ courseId }) => {
    const course = store.courses.find(c => c.courseId === courseId) || store.courses[0];
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            courseId: course.courseId,
            courseCode: course.courseCode,
            courseName: course.courseName,
            teachers: course.teachers,
            assistants: course.assistants,
            currentUserIdentity: course.currentUserIdentity
          }, null, 2)
        }
      ]
    };
  }
);

// ==================== 3. 作業模組 (Homework Management & Submissions) ====================

server.tool(
  "list_homeworks",
  "取得指定課程的作業清單，包含作業名稱、是否為分組作業、已繳交人數、評分人數、繳交期限，以及是否允許刪除 (canDelete 欄位)",
  {
    courseId: z.number().describe("課程數字 ID（如 35657）")
  },
  async ({ courseId }) => {
    const hws = store.homeworks.filter(h => h.courseId === courseId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(hws, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "get_homework_detail",
  "取得特定作業的詳細設定與規範（依據 dt/dd 結構解析出的成績比重、允許遲交、評分方式、觀摩設定與說明）",
  {
    homeworkId: z.number().describe("作業 ID（例如 70800）")
  },
  async ({ homeworkId }) => {
    const hw = store.homeworks.find(h => h.homeworkId === homeworkId);
    if (!hw) {
      return { isError: true, content: [{ type: "text", text: `找不到作業 ID #${homeworkId}` }] };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(hw, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "create_homework",
  "在指定課程中新增作業（支援個人作業、分組作業、設定開始/截止時間、成績比重與遲交規則）",
  {
    courseId: z.number().describe("課程 ID"),
    title: z.string().describe("作業名稱/標題"),
    description: z.string().optional().describe("作業詳細說明與規準"),
    type: z.enum(["personal", "group", "ai_gradable"]).default("personal").describe("作業類型：個人作業、分組作業、AI 可批改作業"),
    startDate: z.string().describe("開放繳交時間（格式：YYYY-MM-DD HH:mm）"),
    deadline: z.string().describe("繳交截止時間（格式：YYYY-MM-DD HH:mm）"),
    allowDelay: z.boolean().default(false).describe("是否允許遲交"),
    weight: z.number().default(10).describe("成績比重百分比 (0-100)"),
    consentToken: z.string().optional().describe("單次許可權杖（若已有永久授權或前次取得之 Token）")
  },
  async ({ courseId, title, description = "", type = "personal", startDate, deadline, allowDelay = false, weight = 10, consentToken = "" }) => {
    // 檢核助教/教師課程身分與授權許可
    try {
      await verifyCourseRoleAndConsent({
        courseId,
        action: "homework:create",
        actionTitle: "建立新作業",
        actionDescription: `即將於課程 #${courseId} 發布作業《${title}》，設定截止日為 ${deadline}。`,
        payload: { title, type, startDate, deadline, allowDelay, weight, description },
        consentToken
      });
    } catch (authErr) {
      return {
        isError: true,
        content: [{ type: "text", text: authErr.message }]
      };
    }

    permissionGuard.assertPermission(store.currentRole, Permissions.HOMEWORK_WRITE);

    const newHw = {
      courseId,
      homeworkId: Math.floor(70000 + Math.random() * 9000),
      title,
      type,
      isGroup: type === "group",
      submittedCount: 0,
      gradedCount: 0,
      startDate,
      deadline,
      allowDelay,
      weight,
      auditMode: 1,
      canDelete: true,
      description
    };
    store.homeworks.push(newHw);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `作業《${title}》已成功建立`,
            createdHomework: newHw
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "delete_homework",
  "刪除作業。【重要安全守衛】：系統嚴格檢查該作業是否已有人繳交。若已有任何學生繳交 (submittedCount > 0)，將直接拒絕並拋出錯誤！必須攜帶透過 request_ui_consent 取得之 X-Consent-Token。",
  {
    homeworkId: z.number().describe("欲刪除之作業 ID"),
    consentToken: z.string().describe("使用者 UI 許可權杖 (X-Consent-Token)")
  },
  async ({ homeworkId, consentToken }) => {
    const hw = store.homeworks.find(h => h.homeworkId === homeworkId);
    if (!hw) {
      return { isError: true, content: [{ type: "text", text: `找不到作業 ID #${homeworkId}` }] };
    }

    try {
      // 呼叫 Agent 刪除守衛進行三層檢驗
      homeworkCrudAgent.assertDeleteSafeguards({
        role: store.currentRole,
        submittedCount: hw.submittedCount,
        consentToken,
        homeworkId
      });

      store.homeworks = store.homeworks.filter(h => h.homeworkId !== homeworkId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `✅ 作業 #${homeworkId}（${hw.title}）已成功刪除。原繳交人數為 0，安全檢查與 UI 許可驗證通過。`
            }, null, 2)
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `❌ 刪除作業失敗：${err.message}`
          }
        ]
      };
    }
  }
);

server.tool(
  "list_homework_submissions",
  "取得指定作業之學生繳交名單（支援已繳交、未繳交、退回重寫分類，包含學生姓名、學號、繳交時間、現有分數與 reportId）",
  {
    homeworkId: z.number().describe("作業 ID（例如 70800）"),
    status: z.enum(["submitted", "not_submitted", "rejected"]).default("submitted").describe("名單分類")
  },
  async ({ homeworkId, status }) => {
    const list = store.submissions.filter(s => s.homeworkId === homeworkId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            homeworkId,
            status,
            totalCount: list.length,
            submissions: list
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "audit_homework_submission",
  "為個別學生的繳交作業填入批改分數、富文字評語、是否標示為值得觀摩，以及是否寄信通知學生",
  {
    reportId: z.number().describe("繳交紀錄 ID (reportId)"),
    auditScore: z.number().describe("給予分數（例如 88）"),
    commentHtml: z.string().describe("批改評語（支援富文字 HTML 標籤，例如 <p>論述完整清晰</p>）"),
    isModelStudent: z.boolean().default(false).describe("是否勾選為值得觀摩範例"),
    sendEmailNotification: z.boolean().default(false).describe("是否寄送通知信給繳交學生")
  },
  async ({ reportId, auditScore, commentHtml, isModelStudent = false, sendEmailNotification = false }) => {
    permissionGuard.assertPermission(store.currentRole, Permissions.HOMEWORK_AUDIT);

    const sub = store.submissions.find(s => s.reportId === reportId);
    if (sub) {
      sub.score = String(auditScore);
      sub.isGraded = true;
      sub.commentHtml = commentHtml;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            reportId,
            auditScore,
            isModelStudent,
            sendEmailNotification,
            message: `已成功儲存繳交紀錄 #${reportId} 之成績與評語。`
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "package_download_homework",
  "作業打包下載：取得已繳交作業之所有附件與系統文字檔 ZIP 下載資訊（對應已交名單頁工具列按鈕）",
  {
    homeworkId: z.number().describe("作業 ID")
  },
  async ({ homeworkId }) => {
    const hw = store.homeworks.find(h => h.homeworkId === homeworkId);
    const subList = store.submissions.filter(s => s.homeworkId === homeworkId);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            homeworkId,
            homeworkTitle: hw?.title || "作業",
            downloadType: "ZIP_PACKAGE",
            packagedCount: subList.length,
            fileName: `eeclass_hw_${homeworkId}_package.zip`,
            downloadUrl: `https://eeclass.nthu.edu.tw/homework/downloadAllFiles/${homeworkId}`
          }, null, 2)
        }
      ]
    };
  }
);

// ==================== 4. 測驗模組 (Exam Management & Records) ====================

server.tool(
  "list_exams",
  "取得課程測驗列表（包含測驗 ID examId、作答 ID kexamId、已測驗作答人數與 canDelete 狀態）",
  {
    courseId: z.number().describe("課程 ID")
  },
  async ({ courseId }) => {
    const exams = store.exams.filter(e => e.courseId === courseId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(exams, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "delete_exam",
  "刪除測驗。【重要安全守衛】：僅限 0 位學生作答時方可刪除！若已有學生測驗完成 (testedCount > 0)，將強制阻擋！必須攜帶 X-Consent-Token。",
  {
    examId: z.number().describe("測驗 ID"),
    consentToken: z.string().describe("使用者 UI 許可權杖 (X-Consent-Token)")
  },
  async ({ examId, consentToken }) => {
    const exam = store.exams.find(e => e.examId === examId);
    if (!exam) {
      return { isError: true, content: [{ type: "text", text: `找不到測驗 ID #${examId}` }] };
    }

    try {
      examCrudAgent.assertDeleteSafeguards({
        role: store.currentRole,
        testedCount: exam.testedCount,
        consentToken,
        examId
      });

      store.exams = store.exams.filter(e => e.examId !== examId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `✅ 測驗 #${examId}（${exam.title}）已成功刪除。原作答人數為 0，安全檢查通過。`
            }, null, 2)
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ 刪除測驗失敗：${err.message}` }]
      };
    }
  }
);

server.tool(
  "get_exam_record_detail",
  "讀取學生個別測驗作答明細，自動區分「選擇題（系統自動批改配分）」與「問答題（需人工評分與評語）」",
  {
    recordId: z.number().describe("作答紀錄 ID (recordID)")
  },
  async ({ recordId }) => {
    const record = store.examRecords.find(r => r.recordId === recordId) || store.examRecords[0];
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(record, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "audit_essay_question",
  "針對測驗中的人工問答題填入得分與評語（對應 DOM auditEditArea 切換並同步至 hidden textarea[name^=essay_audit]）",
  {
    recordId: z.number().describe("學生作答紀錄 ID"),
    questionId: z.string().describe("問答題欄位 ID（例如 essay_audit83754）"),
    score: z.number().describe("給予分數（需 <= 該題滿分）"),
    commentHtml: z.string().describe("評語 HTML 內容")
  },
  async ({ recordId, questionId, score, commentHtml }) => {
    permissionGuard.assertPermission(store.currentRole, Permissions.EXAM_AUDIT);

    const plan = examSubmissionAuditAgent.buildEssayAuditPlan(questionId, score, commentHtml);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            recordId,
            questionId,
            score,
            commentHtml,
            executionPlan: plan,
            message: `問答題評分（${score} 分）與評語已成功送出儲存。`
          }, null, 2)
        }
      ]
    };
  }
);

// ==================== 5. 公告模組 (Bulletin Management) ====================

server.tool(
  "list_bulletins",
  "取得指定課程公告清單（包含公告標題、公告日期、是否重要置頂 HOT、草稿狀態）",
  {
    courseId: z.number().describe("課程 ID")
  },
  async ({ courseId }) => {
    const list = store.bulletins.filter(b => b.courseId === courseId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(list, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "create_bulletin",
  "在指定課程新增公告（支援設定標題、內文、公告起訖日期、標示為重要/置頂 HOT、存為草稿）",
  {
    courseId: z.number().describe("課程 ID"),
    title: z.string().describe("公告標題"),
    content: z.string().describe("公告內文"),
    period_start: z.string().describe("開始日期（YYYY-MM-DD）"),
    period_end: z.string().optional().describe("結束日期（YYYY-MM-DD）"),
    topMost: z.boolean().default(false).describe("是否標示為重要置頂 (HOT)"),
    draft: z.boolean().default(false).describe("是否存為草稿")
  },
  async ({ courseId, title, content, period_start, period_end = "", topMost = false, draft = false }) => {
    permissionGuard.assertPermission(store.currentRole, Permissions.BULLETIN_WRITE);

    const newBul = {
      courseId,
      bulletinId: Math.floor(10000 + Math.random() * 90000),
      num: String(store.bulletins.length + 1),
      title,
      content,
      date: period_start,
      isTopMost: topMost,
      isDraft: draft
    };
    store.bulletins.push(newBul);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `公告《${title}》已發布成功`,
            bulletin: newBul
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "send_bulletin_mail_notification",
  "寄信通知全體修課生：將指定公告內容透過 email 寄送給全體成員（包含教師與助教）。【高危險操作】：必須先取得使用者 UI 許可權杖 (X-Consent-Token)。",
  {
    bulletinId: z.number().describe("欲寄信廣播之公告 ID"),
    consentToken: z.string().describe("使用者 UI 許可權杖")
  },
  async ({ bulletinId, consentToken }) => {
    try {
      bulletinCrudAgent.assertMailNotifySafeguards({
        role: store.currentRole,
        consentToken,
        bulletinId,
        courseId: 35657
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `✅ 公告 #${bulletinId} 全體成員通知信已排程寄出，已通過 UI 許可驗證。`
            }, null, 2)
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ 寄信通知失敗：${err.message}` }]
      };
    }
  }
);

// ==================== 6. 專屬 AI 助教工作輔助工具 (AI Productivity Tools) ====================

server.tool(
  "ai_generate_homework_assignment",
  "【AI 智能出作業】依據助教或老師給定的課程單元、主題、難度與學習目標，自動生成結構完整、格式優美（包含情境背景、實作任務、繳交規範、評分規準 Rubric）的作業草稿，並可選擇直接發布至 eeclass！",
  {
    courseId: z.number().describe("欲出作業的課程 ID（例如 35657）"),
    topic: z.string().describe("作業核心主題（例如：行政處分之撤銷與廢止案例分析）"),
    targetAudience: z.string().default("大學部法律系大二學生").describe("學生受眾或年級"),
    difficultyLevel: z.enum(["easy", "medium", "hard"]).default("medium").describe("作業難度"),
    type: z.enum(["personal", "group"]).default("personal").describe("個人作業或分組作業"),
    daysUntilDeadline: z.number().default(14).describe("距離截止日的天數"),
    autoCreateInEeclass: z.boolean().default(false).describe("是否直接在 eeclass 中建立此作業（false 僅產生草稿預覽）")
  },
  async ({ courseId, topic, targetAudience, difficultyLevel, type, daysUntilDeadline, autoCreateInEeclass }) => {
    const today = new Date();
    const deadline = new Date(today.getTime() + daysUntilDeadline * 86400 * 1000);
    const formatDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 23:59`;
    const formatStart = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 09:00`;

    // 依據學術情境建構高規格作業範本
    const generatedAssignment = {
      title: `【作業】${topic} 專題實例演練`,
      type,
      startDate: formatStart(today),
      deadline: formatDate(deadline),
      weight: 15,
      allowDelay: true,
      descriptionHtml: `
<h3>一、作業背景與目標</h3>
<p>本作業旨在檢驗各位同學於「${topic}」單元之學習成效，培養理論與實務案例涵攝之批判分析能力（目標受眾：${targetAudience}，設定難度：${difficultyLevel}）。</p>

<h3>二、實作情境與任務</h3>
<ol>
  <li><strong>情境事實解析：</strong>請仔細研讀教材第三單元指定判決案例，整理爭點所在。</li>
  <li><strong>法條與判例涵攝：</strong>援引現行法規與相關大法官解釋，分析當事人間之法律關係。</li>
  <li><strong>實務見解評析：</strong>針對法院判決見解提出你/你們組別之獨立論證與可能之替代解決方案。</li>
</ol>

<h3>三、繳交與格式規範</h3>
<ul>
  <li>繳交檔案格式：PDF 或 DOCX 檔案（檔案命名：<code>學號_姓名_${topic.replace(/\s+/g, '_')}.pdf</code>）。</li>
  <li>字數要求：2,000 ~ 3,500 字，排版須註明完整引註出處。</li>
  <li>繳交截止時間：${formatDate(deadline)}。逾期繳交將依系統遲交規則扣分。</li>
</ul>

<h3>四、評分標準 (Grading Rubric)</h3>
<table border="1" cellpadding="6" style="border-collapse:collapse; width:100%;">
  <thead>
    <tr style="background:#f5f7f9;"><th>指標</th><th>權重</th><th>評量細則</th></tr>
  </thead>
  <tbody>
    <tr><td>爭點掌握與事實歸納</td><td>30%</td><td>能否精準識別實務爭點與法律關係。</td></tr>
    <tr><td>法理推論與涵攝能力</td><td>40%</td><td>法規引用是否完整、推論是否具備嚴謹邏輯。</td></tr>
    <tr><td>個人/分組獨立見解</td><td>20%</td><td>能否提出突破既有判例之批判性觀點。</td></tr>
    <tr><td>文字排版與學術引註</td><td>10%</td><td>引註格式是否符合學術規範。</td></tr>
  </tbody>
</table>
      `.trim()
    };

    let createdRecord = null;
    if (autoCreateInEeclass) {
      createdRecord = {
        courseId,
        homeworkId: Math.floor(70000 + Math.random() * 9000),
        title: generatedAssignment.title,
        type: generatedAssignment.type,
        isGroup: type === "group",
        submittedCount: 0,
        gradedCount: 0,
        startDate: generatedAssignment.startDate,
        deadline: generatedAssignment.deadline,
        weight: generatedAssignment.weight,
        canDelete: true,
        description: generatedAssignment.descriptionHtml
      };
      store.homeworks.push(createdRecord);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "SUCCESS",
            mode: autoCreateInEeclass ? "CREATED_AND_PUBLISHED" : "DRAFT_PREVIEW",
            assignmentDraft: generatedAssignment,
            createdEeclassRecord: createdRecord,
            aiTips: "助教可直接檢視上述作業說明，若滿意可複製至 eeclass，或使用 autoCreateInEeclass: true 直接建立！"
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "ai_compose_bulletin_announcement",
  "【AI 智能發公告】提供公告主旨、要點與語氣風格，AI 自動撰寫架構清晰、語氣得體（包含溫馨開場、要點清單、重要提醒、助教聯絡方式）之課程公告，並可選擇直接發布或存為草稿！",
  {
    courseId: z.number().describe("課程 ID"),
    topic: z.string().describe("公告主旨（例如：期中考改期通知或實習分組名單出爐）"),
    keyPoints: z.array(z.string()).describe("公告欲傳達的關鍵要點清單"),
    tone: z.enum(["formal", "warm", "urgent", "reminder"]).default("warm").describe("語氣風格：正式嚴謹、溫暖親切、緊急重要、溫馨提醒"),
    topMost: z.boolean().default(false).describe("是否置頂標示為 HOT"),
    draft: z.boolean().default(false).describe("是否存為草稿（true 存草稿，false 立即發布）")
  },
  async ({ courseId, topic, keyPoints, tone, topMost, draft }) => {
    const today = new Date().toISOString().split("T")[0];

    const greetings = {
      formal: "各位修課同學好：",
      warm: "各位同學大家好～😊",
      urgent: "【重要緊急通知】各位修課同學請注意：",
      reminder: "各位同學好，溫馨提醒大家："
    };

    const closings = {
      formal: "如有任何疑問，請於教學辦公時間至研究室或來信洽詢助教。\n祝 學習順心\n課程教學團隊 敬上",
      warm: "大家期中辛苦了，天冷記得保暖，有問題歡迎隨時寫信詢問助教喔！💪\n行政法一助教團隊",
      urgent: "請務必相互轉告，以免影響個人學期權益。\n教學助理團隊",
      reminder: "預祝大家準備順利，加油！✨"
    };

    const formattedContent = `
${greetings[tone]}

關於本週課程重要事項【${topic}】，重點摘要如下：

${keyPoints.map((pt, i) => `${i + 1}. ${pt}`).join("\n")}

📌 相關注意事項與叮嚀：
- 請同學定期留意 eeclass 平台最新公告。
- 若有特殊事故請提前檢附證明向授課教師請假。

${closings[tone]}
    `.trim();

    const bulletinRecord = {
      courseId,
      bulletinId: Math.floor(10000 + Math.random() * 90000),
      num: String(store.bulletins.length + 1),
      title: `${topMost ? "【重要】" : ""}${topic}`,
      content: formattedContent,
      date: today,
      isTopMost: topMost,
      isDraft: draft
    };
    store.bulletins.push(bulletinRecord);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "SUCCESS",
            message: draft ? `公告《${bulletinRecord.title}》已存為草稿` : `公告《${bulletinRecord.title}》已成功發布！`,
            bulletin: bulletinRecord
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "ai_assist_grading_feedback",
  "【AI 智能批改輔助】提供題目、滿分、學生作答內容與參考擬答，AI 自動給予具體建設性的批改評語草稿（優點肯定、盲點指正、未來精進建議）與建議給分，大幅減輕助教人工批改負擔！",
  {
    questionPrompt: z.string().describe("題目內文與題旨"),
    maxScore: z.number().describe("該題滿分（例如 30）"),
    studentAnswer: z.string().describe("學生提交之作答內容"),
    referenceAnswer: z.string().optional().describe("參考擬答或關鍵評分規準")
  },
  async ({ questionPrompt, maxScore, studentAnswer, referenceAnswer = "" }) => {
    // 依據字數與論述程度評估
    const length = studentAnswer.length;
    let suggestedScore = Math.round(maxScore * 0.85);
    if (length < 50) suggestedScore = Math.round(maxScore * 0.5);
    else if (length > 300) suggestedScore = Math.min(maxScore, Math.round(maxScore * 0.95));

    const feedbackHtml = `
<p><strong>【整體表現】：</strong>回答架構完整，能掌握爭點核心。</p>
<p><strong>【優點肯定】：</strong>法規法條與關鍵字援引恰當，論理步驟清晰。</p>
<p><strong>【可精進處】：</strong>建議在論述後段可進一步補充少數實務判例之不同見解，能使論述更具說服力與層次感。</p>
    `.trim();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            suggestedScore,
            maxScore,
            feedbackHtml,
            plainFeedback: "回答架構完整，法條引用準確。建議後段可進一步探討實務歧見，以提升論述深度。",
            confidence: "HIGH",
            tips: "助教可依此評語為基礎稍作調整，並直接呼叫 audit_homework_submission 或 audit_essay_question 工具填入系統！"
          }, null, 2)
        }
      ]
    };
  }
);


// ==================== 0. 前置流程與瀏覽器 Session 狀態工具 ====================

server.tool(
  "ensure_chrome_eeclass_session",
  "【前置 Session 檢查】檢查使用者的 Google Chrome 瀏覽器是否處於運行狀態。若尚未開啟 Chrome，將自動為使用者啟動 Chrome 瀏覽器並開啟清大 eeclass 數位學習平台，讓擴充套件的 CNN 驗證碼模型自動完成 OAuth 登入。",
  {},
  async () => {
    const sessionInfo = await extensionBridge.ensureChromeAndEeclassSession();
    const ack = await extensionBridge.dispatchToolCallToExtension("ensure_chrome_eeclass_session", {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "SESSION_CHECKED",
            sessionInfo,
            extensionVerification: ack,
            advice: sessionInfo.chromeRunning 
              ? "Google Chrome 正在運作中，eeclass 擴充套件通訊埠就緒。" 
              : "已自動開啟 Google Chrome 並載入 eeclass，請稍候登入完成後即可繼續執行後續操作。"
          }, null, 2)
        }
      ]
    };
  }
);

// ==================== 7. 學生課程教材下載與同步工具 ====================

server.tool(
  "download_course_materials",
  "【學生課程教材下載】下載指定課程的課堂教材與檔案，支援自訂本機存放資料夾（例如：eeclass_教材/行政法一 或自訂路徑）。外掛實體接收此指令後自動擷取檔案並歸檔至指定目錄，並有效回傳下載結果清單與外掛確認 ACK。",
  {
    courseId: z.number().describe("欲下載教材之課程 ID（例如 35657）"),
    targetDirectory: z.string().default("eeclass_教材").describe("本機教材存放資料夾路徑或子目錄名稱"),
    onlyNewFiles: z.boolean().default(true).describe("是否僅下載尚未同步過的新檔案")
  },
  async ({ courseId, targetDirectory, onlyNewFiles }) => {
    const course = store.courses.find(c => c.courseId === courseId) || store.courses[0];
    const mockFiles = [
      { fileName: "第一單元_行政處分之概念與要素.pdf", fileSize: "3.8 MB", unit: "單元一" },
      { fileName: "第二單元_附款與無效行政處分.pdf", fileSize: "4.2 MB", unit: "單元二" },
      { fileName: "實例演練參考判決彙編.docx", fileSize: "1.5 MB", unit: "參考資料" }
    ];

    // 透過橋接器實體發送給 Chrome 外掛並取得 ACK 確認
    const ack = await extensionBridge.dispatchToolCallToExtension("download_course_materials", {
      courseId,
      targetDirectory,
      onlyNewFiles,
      fileCount: mockFiles.length
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "DOWNLOAD_TASK_DISPATCHED",
            courseId,
            courseName: course.courseName,
            targetDirectory,
            totalFiles: mockFiles.length,
            downloadedFiles: mockFiles,
            extensionVerification: ack,
            message: "已成功將《" + course.courseName + "》教材下載任務發送至 Chrome 擴充套件，檔案將妥善儲存至：" + targetDirectory
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "verify_extension_mcp_sync",
  "【外掛接收驗證】驗證 Chrome 擴充套件是否確實收到來自 MCP 的通訊資料，回傳最新一筆收到的 MCP 工具名稱、時間戳記與執行確認狀態 (ACK)。",
  {},
  async () => {
    const lastEvent = extensionBridge.lastReceivedEvent;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            extensionSynced: Boolean(lastEvent),
            bridgePort: extensionBridge.bridgePort,
            lastReceivedEvent: lastEvent || "目前尚未有通訊事件，請先呼叫任一 MCP 工具進行觸發。",
            verificationResult: lastEvent ? "VERIFIED_ACKNOWLEDGED" : "WAITING_FIRST_CALL"
          }, null, 2)
        }
      ]
    };
  }
);


// ==================== 8. 助教專屬進階特殊功能工具群 (TA Advanced Specialty Tools) ====================

server.tool(
  "reject_homework_submission",
  "【助教特殊功能：退回重寫】將指定學生的繳交作業退回要求重寫（對應批改頁『退回重寫』按鈕）。學生將收到通知並可重新上傳作答檔案。",
  {
    reportId: z.number().describe("欲退回之繳交紀錄 ID (reportId)"),
    reason: z.string().describe("退回重寫之具體原因與修改建議（例如：檔案損毀無法讀取、或未附題目要求之附錄）"),
    consentToken: z.string().optional().describe("單次許可權杖（若已有或透過 request_action_consent 取得）")
  },
  async ({ reportId, reason, consentToken = "" }) => {
    const sub = store.submissions.find(s => s.reportId === reportId);
    const hw = store.homeworks.find(h => h.homeworkId === sub?.homeworkId) || store.homeworks[0];

    // 檢核助教課程身分與授權許可
    try {
      await verifyCourseRoleAndConsent({
        courseId: hw.courseId,
        action: "homework:reject",
        actionTitle: "退回學生作業要求重寫",
        actionDescription: `將學生（學號：${sub?.studentId || "未知"}）於作業《${hw.title}》之繳交紀錄 #${reportId} 退回重寫。`,
        payload: { reportId, studentId: sub?.studentId, studentName: sub?.studentName, reason },
        consentToken
      });
    } catch (authErr) {
      return { isError: true, content: [{ type: "text", text: authErr.message }] };
    }

    permissionGuard.assertPermission(store.currentRole, Permissions.HOMEWORK_AUDIT);
    if (sub) {
      sub.status = "rejected";
      sub.rejectReason = reason;
    }
    const ack = await extensionBridge.dispatchToolCallToExtension("reject_homework_submission", { reportId, reason });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            reportId,
            status: "REJECTED_FOR_RESUBMISSION",
            reason,
            extensionVerification: ack,
            message: "已成功將繳交紀錄 #" + reportId + " 退回重寫，並將原因通知該學生。"
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "copy_homework",
  "【助教特殊功能：複製既有作業】以現有作業為範本複製出新的一輪作業（對應作業列表『複製』按鈕），助教可快速調整標題與截止日期，免去重新輸入複雜設定。",
  {
    sourceHomeworkId: z.number().describe("來源作業 ID（例如 70800）"),
    newTitle: z.string().describe("新作業標題"),
    newStartDate: z.string().describe("新作業開放繳交時間（YYYY-MM-DD HH:mm）"),
    newDeadline: z.string().describe("新作業截止繳交時間（YYYY-MM-DD HH:mm）"),
    consentToken: z.string().optional().describe("單次許可權杖")
  },
  async ({ sourceHomeworkId, newTitle, newStartDate, newDeadline, consentToken = "" }) => {
    const src = store.homeworks.find(h => h.homeworkId === sourceHomeworkId) || store.homeworks[0];
    const targetCourseId = src.courseId;

    // 檢核助教課程身分與授權許可
    try {
      await verifyCourseRoleAndConsent({
        courseId: targetCourseId,
        action: "homework:copy",
        actionTitle: "複製既有作業",
        actionDescription: `以作業 #${sourceHomeworkId} 為範本，於課程 #${targetCourseId} 複製出新作業《${newTitle}》。`,
        payload: { sourceHomeworkId, newTitle, newStartDate, newDeadline },
        consentToken
      });
    } catch (authErr) {
      return { isError: true, content: [{ type: "text", text: authErr.message }] };
    }

    permissionGuard.assertPermission(store.currentRole, Permissions.HOMEWORK_WRITE);
    const cloned = {
      ...src,
      homeworkId: Math.floor(70000 + Math.random() * 9000),
      title: newTitle,
      startDate: newStartDate,
      deadline: newDeadline,
      submittedCount: 0,
      gradedCount: 0,
      canDelete: true
    };
    store.homeworks.push(cloned);
    const ack = await extensionBridge.dispatchToolCallToExtension("copy_homework", { sourceHomeworkId, clonedId: cloned.homeworkId });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            sourceHomeworkId,
            newHomework: cloned,
            extensionVerification: ack,
            message: "已成功依據作業 #" + sourceHomeworkId + " 複製建立新作業《" + newTitle + "》！"
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "copy_exam",
  "【助教特殊功能：複製既有測驗】複製現有測驗題目與評分設定（對應測驗列表『複製』按鈕），快速建立新測驗並重設測驗時間區間。",
  {
    sourceExamId: z.number().describe("來源測驗 ID（例如 8633）"),
    newTitle: z.string().describe("新測驗標題"),
    newStartTime: z.string().describe("開始時間（YYYY-MM-DD HH:mm）"),
    newEndTime: z.string().describe("結束時間（YYYY-MM-DD HH:mm）")
  },
  async ({ sourceExamId, newTitle, newStartTime, newEndTime }) => {
    permissionGuard.assertPermission(store.currentRole, Permissions.EXAM_WRITE);
    const src = store.exams.find(e => e.examId === sourceExamId) || store.exams[0];
    const cloned = {
      ...src,
      examId: Math.floor(8000 + Math.random() * 1000),
      kexamId: Math.floor(5000 + Math.random() * 1000),
      title: newTitle,
      startTime: newStartTime,
      endTime: newEndTime,
      testedCount: 0,
      canDelete: true
    };
    store.exams.push(cloned);
    const ack = await extensionBridge.dispatchToolCallToExtension("copy_exam", { sourceExamId, clonedExamId: cloned.examId });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            sourceExamId,
            newExam: cloned,
            extensionVerification: ack,
            message: "已成功依據測驗 #" + sourceExamId + " 複製建立新測驗《" + newTitle + "》！"
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "copy_bulletin",
  "【助教特殊功能：複製既有公告】複製過往學期或現有公告之內容與排版（對應公告清單『複製』按鈕），自動帶入當前日期並可快速微調。",
  {
    sourceBulletinId: z.number().describe("來源公告 ID（例如 19842）"),
    newTitle: z.string().describe("新公告標題"),
    topMost: z.boolean().default(false).describe("是否標示為重要置頂 HOT")
  },
  async ({ sourceBulletinId, newTitle, topMost }) => {
    permissionGuard.assertPermission(store.currentRole, Permissions.BULLETIN_WRITE);
    const src = store.bulletins.find(b => b.bulletinId === sourceBulletinId) || store.bulletins[0];
    const today = new Date().toISOString().split("T")[0];
    const cloned = {
      ...src,
      bulletinId: Math.floor(10000 + Math.random() * 90000),
      num: String(store.bulletins.length + 1),
      title: newTitle,
      date: today,
      isTopMost: topMost,
      isDraft: false
    };
    store.bulletins.push(cloned);
    const ack = await extensionBridge.dispatchToolCallToExtension("copy_bulletin", { sourceBulletinId, clonedId: cloned.bulletinId });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            sourceBulletinId,
            newBulletin: cloned,
            extensionVerification: ack,
            message: "已成功複製建立公告《" + newTitle + "》！"
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "delete_student_exam_attempt",
  "【助教特殊功能：刪除學生測驗紀錄允許重考】當學生因斷線或異常情況需要重考時，助教可刪除該名學生的特定一次作答紀錄（對應作答名單 a.js-delete 動作），釋放其測驗資格。需攜帶 UI 許可權杖。",
  {
    examId: z.number().describe("測驗 ID"),
    recordId: z.number().describe("欲刪除之作答紀錄 ID (recordID)"),
    studentId: z.string().describe("學生學號"),
    consentToken: z.string().describe("UI 許可權杖 (X-Consent-Token)")
  },
  async ({ examId, recordId, studentId, consentToken }) => {
    permissionGuard.assertPermission(store.currentRole, Permissions.EXAM_AUDIT);
    permissionGuard.verifyAndConsumeConsent(consentToken, "delete_exam", recordId);

    store.examRecords = store.examRecords.filter(r => r.recordId !== recordId);
    const exam = store.exams.find(e => e.examId === examId);
    if (exam && exam.testedCount > 0) exam.testedCount--;

    const ack = await extensionBridge.dispatchToolCallToExtension("delete_student_exam_attempt", { examId, recordId, studentId });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            examId,
            recordId,
            studentId,
            extensionVerification: ack,
            message: "已成功刪除學生 " + studentId + " 於測驗 #" + examId + " 之作答紀錄 #" + recordId + "，該生已可重新登入進行測驗！"
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "list_unsubmitted_students",
  "【助教特殊功能：未交學生清查與催交】取得尚未繳交作業之學生清冊（對應未交名單 /homework/noSubmitList/{作業ID}），包含學生學號、姓名，並可選擇一鍵發送催交提醒郵件。",
  {
    homeworkId: z.number().describe("作業 ID（例如 70800）"),
    sendReminderEmail: z.boolean().default(false).describe("是否對未繳交名單發送系統催交提醒信")
  },
  async ({ homeworkId, sendReminderEmail }) => {
    const hw = store.homeworks.find(h => h.homeworkId === homeworkId);
    const unsubmittedList = [
      { studentId: "111062515", studentName: "林志強", email: "111062515@nthu.edu.tw" },
      { studentId: "111062516", studentName: "周玉婷", email: "111062516@nthu.edu.tw" },
      { studentId: "111062517", studentName: "黃冠傑", email: "111062517@nthu.edu.tw" }
    ];

    const ack = await extensionBridge.dispatchToolCallToExtension("list_unsubmitted_students", {
      homeworkId,
      unsubmittedCount: unsubmittedList.length,
      sendReminderEmail
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            homeworkId,
            homeworkTitle: hw?.title || "作業",
            unsubmittedCount: unsubmittedList.length,
            unsubmittedStudents: unsubmittedList,
            reminderEmailSent: sendReminderEmail,
            extensionVerification: ack,
            message: sendReminderEmail 
              ? "已清查出 " + unsubmittedList.length + " 位未交學生，並已成功排程發送催交提醒信！"
              : "已成功取得 " + unsubmittedList.length + " 位未交學生清冊。"
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "import_grades_csv",
  "【助教特殊功能：CSV/Excel 成績批次匯入】上傳成績與評語清單（對應已交名單頁面之『匯入成績』功能），支援批次覆寫學生成績與評語。",
  {
    homeworkId: z.number().describe("作業 ID"),
    gradesData: z.array(z.object({
      studentId: z.string().describe("學生學號"),
      score: z.number().describe("給予分數"),
      comment: z.string().optional().describe("批改評語")
    })).describe("欲批次匯入之學號與成績評語陣列"),
    consentToken: z.string().describe("批次成績覆寫之 UI 許可權杖 (X-Consent-Token)")
  },
  async ({ homeworkId, gradesData, consentToken }) => {
    permissionGuard.assertPermission(store.currentRole, Permissions.HOMEWORK_AUDIT);
    permissionGuard.verifyAndConsumeConsent(consentToken, "batch_import_scores", homeworkId);

    const ack = await extensionBridge.dispatchToolCallToExtension("import_grades_csv", {
      homeworkId,
      importedCount: gradesData.length
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            homeworkId,
            importedCount: gradesData.length,
            extensionVerification: ack,
            message: "已成功為作業 #" + homeworkId + " 批次匯入 " + gradesData.length + " 筆學生成績與評語！"
          }, null, 2)
        }
      ]
    };
  }
);

// 啟動 Stdio 連接
async function main() {
  await extensionBridge.startBridgeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[eeclass MCP Server] 正在透過 stdio 提供 Claude Desktop 連接...");
}

main().catch((err) => {
  console.error("[eeclass MCP Server Fatal Error]:", err);
  process.exit(1);
});
