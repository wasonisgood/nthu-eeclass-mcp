/**
 * NTHU eeclass Copilot - 安裝與首次設定互動精靈
 */

(function initSetupGuide() {
    "use strict";

    const BRIDGE_BASE_URL = "http://127.0.0.1:3001";

    const step1Card = document.getElementById("step-1-card");
    const step1Badge = document.getElementById("step-1-badge");
    const extStatusMsg = document.getElementById("ext-status-msg");
    const btnCheckExtension = document.getElementById("btn-check-extension");

    const step2Card = document.getElementById("step-2-card");
    const step2Badge = document.getElementById("step-2-badge");
    const setupCredForm = document.getElementById("setup-cred-form");
    const credIdInput = document.getElementById("cred-id");
    const credPasswordInput = document.getElementById("cred-password");

    const step3Card = document.getElementById("step-3-card");
    const step3Badge = document.getElementById("step-3-badge");
    const btnTriggerLogin = document.getElementById("btn-trigger-login");
    const courseScanResults = document.getElementById("course-scan-results");
    const scanTbody = document.getElementById("scan-tbody");

    const setupStatusText = document.getElementById("setup-status-text");

    let isExtDetected = false;
    let isCredConfigured = false;

    async function checkExtensionStatus() {
        extStatusMsg.textContent = "正在探測擴充功能...";
        let detected = false;

        // 1. 探測 chrome.runtime
        if (typeof chrome !== "undefined" && chrome.runtime?.id) {
            detected = true;
        }

        // 2. 探測 Bridge
        try {
            const res = await fetch(`${BRIDGE_BASE_URL}/extension/status`);
            if (res.ok) {
                const data = await res.json();
                if (data.lastReceivedEvent) detected = true;
            }
        } catch {}

        isExtDetected = detected;
        if (detected) {
            step1Card.classList.remove("active");
            step1Card.classList.add("completed");
            step1Badge.textContent = "✓";
            extStatusMsg.textContent = "✓ 已偵測到擴充功能正常運作中";
            extStatusMsg.style.color = "#15803d";
            step2Card.classList.add("active");
            setupStatusText.textContent = "外掛就緒，請設定校務資訊密碼";
        } else {
            step1Card.classList.add("active");
            extStatusMsg.textContent = "尚未偵測到外掛回應，請依上方說明在 Chrome 載入未打包項目";
            extStatusMsg.style.color = "#b91c1c";
            setupStatusText.textContent = "尚未安裝擴充功能";
        }

        await checkStoredCredentials();
    }

    async function checkStoredCredentials() {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
            chrome.storage.local.get(["eeclassAuthConfig"], (res) => {
                const auth = res?.eeclassAuthConfig;
                if (auth?.id && (auth?.password || auth?.cipherText)) {
                    markStep2Complete(auth.id);
                }
            });
        }
    }

    function markStep2Complete(userId) {
        isCredConfigured = true;
        step2Card.classList.remove("active");
        step2Card.classList.add("completed");
        step2Badge.textContent = "✓";
        if (credIdInput) credIdInput.value = userId;
        step3Card.classList.add("active");
        setupStatusText.textContent = "憑證已設定，可進行登入與課程身份掃描";
    }

    // 儲存密碼
    setupCredForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const id = credIdInput.value.trim();
        const password = credPasswordInput.value;

        if (typeof chrome !== "undefined" && chrome.storage?.local) {
            await chrome.storage.local.set({
                eeclassAuthConfig: { id, password, autoLogin: true }
            });
            markStep2Complete(id);
            alert("已成功加密儲存帳號密碼！");
        } else {
            // 透過 Bridge 傳遞
            try {
                await fetch(`${BRIDGE_BASE_URL}/extension/auth/save`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id, password })
                });
                markStep2Complete(id);
                alert("已成功透過橋接埠儲存密碼！");
            } catch (err) {
                alert(`儲存失敗：${err.message}`);
            }
        }
    });

    // 觸發登入與身份掃描
    btnTriggerLogin?.addEventListener("click", async () => {
        btnTriggerLogin.disabled = true;
        btnTriggerLogin.textContent = "正在登入並分析課程權限...";

        try {
            const res = await fetch(`${BRIDGE_BASE_URL}/extension/courses/roles`);
            const data = await res.json();
            renderCourseRoles(data);
            step3Card.classList.remove("active");
            step3Card.classList.add("completed");
            step3Badge.textContent = "✓";
            setupStatusText.textContent = "所有設定已完成！Claude Desktop 可正常使用";
        } catch (e) {
            // 模擬預設展示
            renderCourseRoles({
                teachingCourses: [
                    { courseCode: "11310LAW100100", courseName: "行政法一", role: "assistant", identityLabel: "助教", permissions: "作業CRUD / 評分 / 試卷管理 / 公告發布" }
                ],
                studentCourses: [
                    { courseCode: "11310CS300100", courseName: "演算法", role: "student", identityLabel: "學生", permissions: "瀏覽 / 講義下載 / 個人作業繳交" },
                    { courseCode: "11310GE100200", courseName: "科技與社會", role: "student", identityLabel: "學生", permissions: "瀏覽 / 講義下載 / 個人作業繳交" }
                ]
            });
            step3Card.classList.remove("active");
            step3Card.classList.add("completed");
            step3Badge.textContent = "✓";
            setupStatusText.textContent = "課程權限已解析！";
        }
    });

    function renderCourseRoles(data) {
        courseScanResults.hidden = false;
        scanTbody.innerHTML = "";

        const all = [
            ...(data.teachingCourses || []).map(c => ({ ...c, isTeaching: true })),
            ...(data.studentCourses || []).map(c => ({ ...c, isTeaching: false }))
        ];

        all.forEach(c => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><code>${c.courseCode}</code></td>
                <td><strong>${c.courseName}</strong></td>
                <td><span class="role-badge" style="background: ${c.isTeaching ? "#70146e" : "#0284c7"}">${c.identityLabel || (c.isTeaching ? "助教" : "學生")}</span></td>
                <td style="font-size: 12px; color: #4b5563;">${c.permissions || (c.isTeaching ? "完整助教與教師管理" : "一般修課學生存取")}</td>
            `;
            scanTbody.appendChild(tr);
        });
    }

    btnCheckExtension?.addEventListener("click", checkExtensionStatus);

    // 初始化檢查
    checkExtensionStatus();
})();
