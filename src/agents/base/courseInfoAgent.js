/**
 * NTHU eeclass Copilot - 基礎課程資訊與身份識別 Agent (Course Info Base Agent)
 * 
 * 依據「預計要開發的功能.txt」第 4 項：
 * 「取得所有所屬為助教或老師的的課程代號（前述功能之基礎）」
 * 
 * 以及「總論/eeclass-功能定位總表.md」第 0 節：
 * - 課程代碼只顯示在標題括號中（span.fs-banner-extInfo），網址使用數字 ID。
 * - 「我的課程」列表中，每列 li 內 href="/course/數字" 為課程 ID，代碼: 為課程代碼。
 * - 側欄：div.mod_course-courseSidebar 內「老師:」「助教:」「身份:」（身份只在有特殊身份時出現，如助教）。
 */

import permissionGuard, { Roles, Permissions } from '../auth/permissionGuard.js';

export class CourseInfoAgent {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://eeclass.nthu.edu.tw';
  }

  /**
   * 解析「我的課程」頁面或 DOM，取得所有課程並過濾出使用者具備「老師」或「助教」身份之課程
   * @param {Document|string} docOrHtml - 頁面 DOM Document 或 HTML 字串
   * @returns {Array<Object>} 助教/老師課程清單
   */
  parseTeachingCourses(docOrHtml) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      const parser = new DOMParser();
      doc = parser.parseFromString(docOrHtml, 'text/html');
    }

    const courseItems = [];
    // 支援多種 eeclass 課程列表選擇器
    const listElements = doc.querySelectorAll('ul.course-list li, .my-course-list li, tr.course-row, div.course-card');

    listElements.forEach(item => {
      const link = item.querySelector('a[href*="/course/"]');
      if (!link) return;

      const href = link.getAttribute('href') || '';
      const matchId = href.match(/\/course\/(\d+)/);
      if (!matchId) return;

      const courseId = parseInt(matchId[1], 10);
      const fullText = item.textContent || '';

      // 解析課程代碼：通常位於括號內或「代碼:」之後
      let courseCode = '';
      const codeMatch = fullText.match(/代碼[:：]\s*([A-Za-z0-9_-]+)/) ||
                        fullText.match(/\(([\d]{3,5}[A-Z0-9]+)\)/) ||
                        (link.querySelector('span.fs-banner-extInfo') ? link.querySelector('span.fs-banner-extInfo').textContent.match(/\(([^)]+)\)/) : null);

      if (codeMatch) {
        courseCode = codeMatch[1].trim();
      }

      // 解析名稱
      const courseName = (link.textContent || '').replace(/\([^)]+\)/g, '').replace(/代碼[:：].*$/g, '').trim();

      // 檢查身份標記（「老師」、「助教」、「身份:」）
      let role = null;
      if (/助教/i.test(fullText)) {
        role = Roles.ASSISTANT;
      } else if (/授課教師|老師|教師/i.test(fullText)) {
        role = Roles.TEACHER;
      }

      // 檢查標籤標示（例如 span.badge 等）
      const roleBadge = item.querySelector('.badge, .role-tag, .label');
      if (roleBadge) {
        const badgeText = roleBadge.textContent.trim();
        if (badgeText.includes('助教')) role = Roles.ASSISTANT;
        if (badgeText.includes('老師') || badgeText.includes('教師')) role = Roles.TEACHER;
      }

      if (role === Roles.TEACHER || role === Roles.ASSISTANT) {
        courseItems.push({
          courseId,
          courseCode,
          courseName,
          role,
          url: `${this.baseUrl}/course/${courseId}`
        });
      }
    });

    return courseItems;
  }

  /**
   * 完整掃描所有課程並進行權限身份分類：區分哪些課程是「助教/老師」，哪些是「一般學生」
   * 確保後續 MCP 與工作台能正確分流與施行權限防護
   * @param {Document|string} docOrHtml - 頁面 DOM Document 或 HTML 字串
   * @returns {{ teachingCourses: Array<Object>, studentCourses: Array<Object>, allCourses: Array<Object> }}
   */
  classifyAllCourses(docOrHtml) {
    let doc = null;
    let rawHtml = '';
    if (typeof docOrHtml === 'string') {
      rawHtml = docOrHtml;
      if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        doc = parser.parseFromString(docOrHtml, 'text/html');
      }
    } else {
      doc = docOrHtml;
    }

    const teachingCourses = [];
    const studentCourses = [];
    const allCourses = [];

    if (doc) {
      const listElements = doc.querySelectorAll('ul.course-list li, .my-course-list li, tr.course-row, div.course-card, .course-item');

      listElements.forEach(item => {
        const link = item.querySelector('a[href*="/course/"]');
        if (!link) return;

        const href = link.getAttribute('href') || '';
        const matchId = href.match(/\/course\/(\d+)/);
        if (!matchId) return;

        const courseId = parseInt(matchId[1], 10);
        const fullText = item.textContent || '';

        // 解析課程代碼
        let courseCode = '';
        const codeMatch = fullText.match(/代碼[:：]\s*([A-Za-z0-9_-]+)/) ||
                          fullText.match(/\(([\d]{3,5}[A-Z0-9]+)\)/) ||
                          (link.querySelector('span.fs-banner-extInfo') ? link.querySelector('span.fs-banner-extInfo').textContent.match(/\(([^)]+)\)/) : null);

        if (codeMatch) {
          courseCode = codeMatch[1].trim();
        }

        // 解析名稱
        const courseName = (link.textContent || '').replace(/\([^)]+\)/g, '').replace(/代碼[:：].*$/g, '').trim();

        // 檢查身份標記
        let role = Roles.STUDENT; // 預設為一般修課學生
        let identityLabel = '學生';

        if (/助教/i.test(fullText)) {
          role = Roles.ASSISTANT;
          identityLabel = '助教';
        } else if (/授課教師|老師|教師/i.test(fullText)) {
          role = Roles.TEACHER;
          identityLabel = '授課教師';
        }

        const roleBadge = item.querySelector('.badge, .role-tag, .label');
        if (roleBadge) {
          const badgeText = roleBadge.textContent.trim();
          if (badgeText.includes('助教')) {
            role = Roles.ASSISTANT;
            identityLabel = '助教';
          }
          if (badgeText.includes('老師') || badgeText.includes('教師')) {
            role = Roles.TEACHER;
            identityLabel = '授課教師';
          }
        }

        const courseObj = {
          courseId,
          courseCode: courseCode || `CRS${courseId}`,
          courseName,
          role,
          identityLabel,
          isTeaching: role === Roles.TEACHER || role === Roles.ASSISTANT,
          url: `${this.baseUrl}/course/${courseId}`
        };

        allCourses.push(courseObj);
        if (courseObj.isTeaching) {
          teachingCourses.push(courseObj);
        } else {
          studentCourses.push(courseObj);
        }
      });
    } else {
      // Node.js Regex Fallback
      const regex = /<li[^>]*class="[^"]*course-[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
      let match;
      while ((match = regex.exec(rawHtml)) !== null) {
        const itemHtml = match[1];
        const idMatch = itemHtml.match(/\/course\/(\d+)/);
        if (!idMatch) continue;
        const courseId = parseInt(idMatch[1], 10);
        const codeMatch = itemHtml.match(/\((113\d+[A-Z0-9]+)\)/i);
        const courseCode = codeMatch ? codeMatch[1].trim() : `CRS${courseId}`;
        const nameMatch = itemHtml.match(/<a[^>]*>([^<]+)/);
        const courseName = nameMatch ? nameMatch[1].trim() : `課程 ${courseId}`;
        const isTa = /助教/i.test(itemHtml);
        const isTeacher = /授課教師|老師/i.test(itemHtml);
        const role = isTa ? Roles.ASSISTANT : isTeacher ? Roles.TEACHER : Roles.STUDENT;
        const identityLabel = isTa ? '助教' : isTeacher ? '授課教師' : '學生';
        const courseObj = {
          courseId,
          courseCode,
          courseName,
          role,
          identityLabel,
          isTeaching: role !== Roles.STUDENT,
          url: `${this.baseUrl}/course/${courseId}`
        };
        allCourses.push(courseObj);
        if (courseObj.isTeaching) teachingCourses.push(courseObj);
        else studentCourses.push(courseObj);
      }
    }

    return {
      teachingCourses,
      studentCourses,
      allCourses,
      summary: {
        total: allCourses.length,
        teachingCount: teachingCourses.length,
        studentCount: studentCourses.length
      }
    };
  }

  /**
   * 進入課程首頁解析側欄資訊（div.mod_course-courseSidebar）
   * 讀取：老師名單、助教名單、當前使用者身份、課程代號
   */
  parseCourseSidebar(docOrHtml, courseId) {
    let doc = null;
    let rawHtml = '';
    if (typeof docOrHtml === 'string') {
      rawHtml = docOrHtml;
      if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        doc = parser.parseFromString(docOrHtml, 'text/html');
      }
    } else {
      doc = docOrHtml;
    }

    const result = {
      courseId,
      courseCode: '',
      courseName: '',
      teachers: [],
      assistants: [],
      currentUserIdentity: '',
      isTeacherOrTA: false
    };

    if (doc) {
      const bannerExt = doc.querySelector('span.fs-banner-extInfo, .fs-banner-extInfo');
      if (bannerExt) {
        const match = bannerExt.textContent.match(/\(([^)]+)\)/);
        if (match) result.courseCode = match[1].trim();
      }

      const titleEl = doc.querySelector('.fs-banner-courseTitle, h1.title, .course-title');
      if (titleEl) {
        result.courseName = titleEl.textContent.trim();
      }

      const sidebar = doc.querySelector('div.mod_course-courseSidebar, .course-sidebar');
      if (sidebar) {
        const textContent = sidebar.textContent;
        const teacherMatch = textContent.match(/老師[:：]\s*([^\n\r]+)/);
        if (teacherMatch) {
          result.teachers = teacherMatch[1].split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
        }
        const taMatch = textContent.match(/助教[:：]\s*([^\n\r]+)/);
        if (taMatch) {
          result.assistants = taMatch[1].split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
        }
        const identityMatch = textContent.match(/身份[:：]\s*([^\n\r]+)/);
        if (identityMatch) {
          result.currentUserIdentity = identityMatch[1].trim();
          if (result.currentUserIdentity.includes('助教') || result.currentUserIdentity.includes('老師')) {
            result.isTeacherOrTA = true;
          }
        }
      }
      return result;
    }

    // Node.js Regex Fallback
    const codeMatch = rawHtml.match(/fs-banner-extInfo[^>]*>\s*\(([^)]+)\)/i) || rawHtml.match(/\((113\d+[A-Z0-9]+)\)/i);
    if (codeMatch) result.courseCode = codeMatch[1].trim();
    const titleMatch = rawHtml.match(/fs-banner-courseTitle[^>]*>([^<]+)/i) || rawHtml.match(/<h1[^>]*>([^<]+)/i);
    if (titleMatch) result.courseName = titleMatch[1].trim();
    const teacherMatch = rawHtml.match(/老師[:：]\s*([^\n\r<]+)/);
    if (teacherMatch) result.teachers = teacherMatch[1].split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
    const taMatch = rawHtml.match(/助教[:：]\s*([^\n\r<]+)/);
    if (taMatch) result.assistants = taMatch[1].split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
    const identityMatch = rawHtml.match(/身份[:：]\s*([^\n\r<]+)/);
    if (identityMatch) {
      result.currentUserIdentity = identityMatch[1].trim();
      if (result.currentUserIdentity.includes('助教') || result.currentUserIdentity.includes('老師')) {
        result.isTeacherOrTA = true;
      }
    }
    return result;
  }

  /**
   * 驗證當前使用者是否具備對此課程之助教/老師操控權限
   */
  assertCourseControlPermission(sidebarInfo) {
    if (!sidebarInfo.isTeacherOrTA && !['助教', '老師', '教師'].some(k => sidebarInfo.currentUserIdentity.includes(k))) {
      permissionGuard.assertPermission(Roles.STUDENT, Permissions.COURSE_MANAGE);
    }
    return true;
  }
}

export const courseInfoAgent = new CourseInfoAgent();
export default courseInfoAgent;
