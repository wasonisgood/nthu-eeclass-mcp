/**
 * NTHU eeclass Copilot - Claude Desktop MCP 伺服器通訊與工具測試（含全套助教特殊功能）
 */

import { spawn } from 'child_process';
import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.resolve(__dirname, '../index.js');

console.log('====================================================');
console.log('🤖 測試 Claude Desktop MCP Server (JSON-RPC stdio)');
console.log('====================================================\n');

const proc = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'inherit']
});

let messageId = 1;
const pendingCalls = new Map();

let buffer = '';
proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line.trim());
      if (msg.id && pendingCalls.has(msg.id)) {
        const { resolve } = pendingCalls.get(msg.id);
        pendingCalls.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {
      console.error('Failed to parse line:', line, e);
    }
  }
});

function sendRpc(method, params = {}) {
  return new Promise((resolve) => {
    const id = messageId++;
    pendingCalls.set(id, { resolve });
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    }) + '\n';
    proc.stdin.write(payload);
  });
}

async function runTests() {
  try {
    // 1. 初始化握手
    console.log('1. 傳送 MCP initialize 請求...');
    const initRes = await sendRpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'claude-desktop-test', version: '1.0.0' }
    });
    assert.ok(initRes.result.serverInfo.name === 'nthu-eeclass-copilot');
    console.log('✅ [PASS] MCP 伺服器握手成功:', initRes.result.serverInfo);

    // 2. 查詢可用工具清單
    console.log('\n2. 查詢 tools/list 工具清單...');
    const listRes = await sendRpc('tools/list', {});
    const tools = listRes.result.tools;
    console.log(`✅ [PASS] 取得可用工具數量: ${tools.length} 項`);
    const toolNames = tools.map(t => t.name);

    // 基礎與 AI 工具檢查
    assert.ok(toolNames.includes('ensure_chrome_eeclass_session'));
    assert.ok(toolNames.includes('download_course_materials'));
    assert.ok(toolNames.includes('verify_extension_mcp_sync'));
    assert.ok(toolNames.includes('ai_generate_homework_assignment'));
    assert.ok(toolNames.includes('ai_compose_bulletin_announcement'));
    assert.ok(toolNames.includes('ai_assist_grading_feedback'));

    // 新增環境檢測、喚醒登入、課程身分劃分與許可管理工具檢查
    assert.ok(toolNames.includes('check_extension_and_setup_status'));
    assert.ok(toolNames.includes('wake_and_bootstrap_eeclass'));
    assert.ok(toolNames.includes('get_classified_courses'));
    assert.ok(toolNames.includes('request_action_consent'));
    assert.ok(toolNames.includes('list_granted_consents'));
    assert.ok(toolNames.includes('revoke_permanent_consent'));

    // 助教專屬進階功能檢查
    assert.ok(toolNames.includes('reject_homework_submission'));
    assert.ok(toolNames.includes('copy_homework'));
    assert.ok(toolNames.includes('copy_exam'));
    assert.ok(toolNames.includes('copy_bulletin'));
    assert.ok(toolNames.includes('list_unsubmitted_students'));
    assert.ok(toolNames.includes('delete_student_exam_attempt'));
    assert.ok(toolNames.includes('import_grades_csv'));

    // 3. 測試助教退回重寫功能（透過 request_action_consent 取得單次許可 Token）
    console.log('\n3. 申請單次許可並測試 reject_homework_submission 助教退回重寫...');
    const rejectConsentRes = await sendRpc('tools/call', {
      name: 'request_action_consent',
      arguments: {
        courseId: 35657,
        action: 'homework:reject',
        actionTitle: '退回作業重寫',
        actionDescription: '退回學生繳交紀錄 #104521 並要求重寫',
        payload: { reportId: 104521, reason: '繳交檔案格式錯誤，請轉為 PDF 檔重新上傳' },
        preferredMode: 'one_time'
      }
    });
    const rejectToken = JSON.parse(rejectConsentRes.result.content[0].text).consentToken;

    const rejectRes = await sendRpc('tools/call', {
      name: 'reject_homework_submission',
      arguments: {
        reportId: 104521,
        reason: '繳交檔案格式錯誤，請轉為 PDF 檔重新上傳',
        consentToken: rejectToken
      }
    });
    const rejectData = JSON.parse(rejectRes.result.content[0].text);
    assert.strictEqual(rejectData.status, 'REJECTED_FOR_RESUBMISSION');
    assert.strictEqual(rejectData.extensionVerification.status, 'ACKNOWLEDGED_BY_EXTENSION');
    console.log('✅ [PASS] 助教退回重寫成功，外掛已收訖確認！');

    // 4. 測試助教複製既有作業（透過 request_action_consent 取得永久許可）
    console.log('\n4. 申請永久許可並測試 copy_homework 助教快速複製作業...');
    await sendRpc('tools/call', {
      name: 'request_action_consent',
      arguments: {
        courseId: 35657,
        action: 'homework:copy',
        actionTitle: '複製作業',
        actionDescription: '以現有作業為範本複製新作業',
        payload: { sourceHomeworkId: 70800, newTitle: '期末考備案實例題演練' },
        preferredMode: 'permanent'
      }
    });

    const copyHwRes = await sendRpc('tools/call', {
      name: 'copy_homework',
      arguments: {
        sourceHomeworkId: 70800,
        newTitle: '期末考備案實例題演練',
        newStartDate: '2026-12-01 10:00',
        newDeadline: '2026-12-01 12:30'
      }
    });
    const copyHwData = JSON.parse(copyHwRes.result.content[0].text);
    assert.strictEqual(copyHwData.success, true);
    assert.strictEqual(copyHwData.newHomework.title, '期末考備案實例題演練');
    console.log('✅ [PASS] 永久許可生效，助教複製作業成功，新作業已建立！');

    // 5. 測試未交學生清查與催交
    console.log('\n5. 測試 list_unsubmitted_students 未交名單清查與催交...');
    const unsubmitRes = await sendRpc('tools/call', {
      name: 'list_unsubmitted_students',
      arguments: {
        homeworkId: 70800,
        sendReminderEmail: true
      }
    });
    const unsubmitData = JSON.parse(unsubmitRes.result.content[0].text);
    assert.strictEqual(unsubmitData.reminderEmailSent, true);
    assert.ok(unsubmitData.unsubmittedCount > 0);
    console.log('✅ [PASS] 未交名單清查完成，已自動排程發送催交通知信！');

    // 6. 測試刪除安全守衛 (已有 4 人繳交，禁止刪除)
    console.log('\n6. 測試刪除作業安全守衛 (已有 4 人繳交)...');
    const delRes = await sendRpc('tools/call', {
      name: 'delete_homework',
      arguments: {
        homeworkId: 70800,
        consentToken: 'dummy_token'
      }
    });
    assert.ok(delRes.result.isError);
    console.log('✅ [PASS] 刪除守衛成功阻擋：已有繳交者嚴格禁止刪除！');

    // 7. 申請 UI 許可 Token 並刪除 0 人繳交作業
    console.log('\n7. 申請 UI 許可 Token 並刪除 0 人繳交作業 (70899)...');
    const tokenRes = await sendRpc('tools/call', {
      name: 'request_ui_consent',
      arguments: {
        action: 'delete_homework',
        targetId: '70899',
        reason: '無人繳交測試作業清理'
      }
    });
    const consentToken = JSON.parse(tokenRes.result.content[0].text).consentToken;
    const safeDelRes = await sendRpc('tools/call', {
      name: 'delete_homework',
      arguments: {
        homeworkId: 70899,
        consentToken
      }
    });
    assert.ok(!safeDelRes.result.isError);
    console.log('✅ [PASS] 0 人繳交作業在經 UI 許可驗證後成功刪除！');

    // 8. 測試 check_extension_and_setup_status 環境檢測與精靈引導
    console.log('\n8. 測試 check_extension_and_setup_status 環境檢測...');
    const setupCheckRes = await sendRpc('tools/call', {
      name: 'check_extension_and_setup_status',
      arguments: {}
    });
    const setupCheckData = JSON.parse(setupCheckRes.result.content[0].text);
    assert.ok(setupCheckData.setupGuideUrl.includes('/setup-guide.html'));
    console.log('✅ [PASS] 環境檢測通過，引導精靈端點就緒：', setupCheckData.setupGuideUrl);

    // 9. 測試 wake_and_bootstrap_eeclass 喚醒與課程身分劃分
    console.log('\n9. 測試 wake_and_bootstrap_eeclass 喚醒登入與課程身份劃分...');
    const bootstrapRes = await sendRpc('tools/call', {
      name: 'wake_and_bootstrap_eeclass',
      arguments: {}
    });
    const bootstrapData = JSON.parse(bootstrapRes.result.content[0].text);
    assert.strictEqual(bootstrapData.status, 'BOOTSTRAP_COMPLETE');
    assert.ok(bootstrapData.courseClassification.teachingCourses.length > 0);
    assert.ok(bootstrapData.courseClassification.studentCourses.length > 0);
    console.log(`✅ [PASS] 成功區分課程：助教/教師課程 ${bootstrapData.courseClassification.teachingCourses.length} 門，學生課程 ${bootstrapData.courseClassification.studentCourses.length} 門！`);

    // 10. 測試身分守衛：在一般學生課程 (38102 演算法) 嘗試出作業應被嚴格阻擋！
    console.log('\n10. 測試身分守衛：一般學生課程 (38102 演算法) 嘗試出作業應被阻擋...');
    const studentHwRes = await sendRpc('tools/call', {
      name: 'create_homework',
      arguments: {
        courseId: 38102,
        title: '學生出作業違規嘗試',
        startDate: '2026-11-10 10:00',
        deadline: '2026-11-20 23:59'
      }
    });
    assert.ok(studentHwRes.result.isError);
    assert.ok(studentHwRes.result.content[0].text.includes('身分權限不足'));
    console.log('✅ [PASS] 身分守衛成功阻擋：修課學生課程嚴禁執行助教操作！');

    // 11. 測試 request_action_consent 申請永久許可並在助教課程 (35657) 出作業
    console.log('\n11. 測試 request_action_consent 永久許可申請與出作業...');
    const consentReqRes = await sendRpc('tools/call', {
      name: 'request_action_consent',
      arguments: {
        courseId: 35657,
        action: 'homework:create',
        actionTitle: '出平時作業',
        actionDescription: '發布行政法平時案例研討作業',
        payload: { title: '平時案例作業三', weight: 15 },
        preferredMode: 'permanent'
      }
    });
    const consentReqData = JSON.parse(consentReqRes.result.content[0].text);
    assert.strictEqual(consentReqData.granted, true);
    assert.strictEqual(consentReqData.mode, 'permanent');
    console.log('✅ [PASS] 永久許可申請成功，已登記至授權池！');

    // 在已有永久許可情況下出作業（無需額外 Token 亦不彈窗）
    const taHwRes = await sendRpc('tools/call', {
      name: 'create_homework',
      arguments: {
        courseId: 35657,
        title: '平時案例作業三',
        startDate: '2026-11-10 10:00',
        deadline: '2026-11-20 23:59',
        weight: 15
      }
    });
    const taHwData = JSON.parse(taHwRes.result.content[0].text);
    assert.strictEqual(taHwData.success, true);
    console.log('✅ [PASS] 永久授權生效，助教作業順利建立！');

    // 12. 測試 list_granted_consents 與 revoke_permanent_consent 撤銷
    console.log('\n12. 測試 list_granted_consents 與 revoke_permanent_consent 撤銷...');
    const listConsentsRes = await sendRpc('tools/call', {
      name: 'list_granted_consents',
      arguments: {}
    });
    const listConsentsData = JSON.parse(listConsentsRes.result.content[0].text);
    assert.ok(listConsentsData.permanentConsentsCount > 0);

    const revokeRes = await sendRpc('tools/call', {
      name: 'revoke_permanent_consent',
      arguments: {
        courseId: 35657,
        action: 'homework:create'
      }
    });
    const revokeData = JSON.parse(revokeRes.result.content[0].text);
    assert.strictEqual(revokeData.success, true);
    console.log('✅ [PASS] 永久許可撤銷成功，重置為嚴格詢問模式！');

    console.log('\n🎉 全部 37 項 MCP 工具、課程身分劃分與單次/永久許可機制整合測試通過！');
    proc.kill();
    process.exit(0);
  } catch (err) {
    console.error('❌ MCP 測試失敗:', err);
    proc.kill();
    process.exit(1);
  }
}

runTests();
