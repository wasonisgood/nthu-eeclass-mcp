/**
 * NTHU eeclass MCP - 擴充套件安裝與連線引導腳本
 */

(function initSetupGuide() {
    "use strict";

    const BRIDGE_BASE_URL = "http://127.0.0.1:3001";
    let isConnected = false;
    let wizardOpened = false;

    const step1Card = document.getElementById("step-1-card");
    const step1Badge = document.getElementById("step-1-badge");
    const step2Card = document.getElementById("step-2-card");
    const step2Badge = document.getElementById("step-2-badge");
    const step3Card = document.getElementById("step-3-card");
    const step3Badge = document.getElementById("step-3-badge");

    const extStatusDot = document.getElementById("ext-status-dot");
    const extStatusTitle = document.getElementById("ext-status-title");
    const extStatusDesc = document.getElementById("ext-status-desc");
    const setupStatusText = document.getElementById("setup-status-text");

    const btnOpenFolder = document.getElementById("btn-open-folder");
    const btnVerifyAndLaunch = document.getElementById("btn-verify-and-launch");
    const btnDirectWizard = document.getElementById("btn-direct-wizard");

    // 1. 開啟外掛本機目錄
    btnOpenFolder?.addEventListener("click", async () => {
        try {
            await fetch(`${BRIDGE_BASE_URL}/extension/open-folder`, { method: "POST" });
        } catch (e) {
            alert("無法自動開啟目錄，請手動前往：C:\\Users\\user\\Downloads\\式\\nthu-eeclass-copilot");
        }
    });

    // 2. 檢測擴充套件狀態
    async function checkExtensionStatus(triggerWizard = false) {
        try {
            const res = await fetch(`${BRIDGE_BASE_URL}/extension/status`);
            if (res.ok) {
                const data = await res.json();
                if (data.extensionConnected) {
                    onExtensionConnected(data, triggerWizard);
                    return true;
                }
            }
        } catch (err) {}
        return false;
    }

    // 3. 連線成功處理
    async function onExtensionConnected(data, shouldOpenWizard = true) {
        if (isConnected && wizardOpened) return;
        isConnected = true;

        // 更新 UI 狀態
        step1Card?.classList.remove("active");
        step1Card?.classList.add("completed");
        if (step1Badge) step1Badge.textContent = "✓";

        step2Card?.classList.remove("active");
        step2Card?.classList.add("completed");
        if (step2Badge) step2Badge.textContent = "✓";

        step3Card?.classList.add("completed");
        if (step3Badge) step3Badge.textContent = "✓";

        if (extStatusDot) extStatusDot.className = "status-dot-pulse success";
        if (extStatusTitle) extStatusTitle.textContent = "✓ 已成功偵測到 Chrome 擴充功能！";
        if (extStatusDesc) extStatusDesc.textContent = "已為您在 Chrome 開啟擴充功能專屬的全螢幕設定精靈。請切換至該分頁完成學號密碼加密與課程身分劃分。";
        if (setupStatusText) setupStatusText.textContent = "外掛已連線就緒";

        const wizardUrl = data.wizardUrl || (data.extensionInfo?.wizardUrl);
        if (wizardUrl && btnDirectWizard) {
            btnDirectWizard.href = wizardUrl;
            btnDirectWizard.style.display = "inline-flex";
        }

        if (btnVerifyAndLaunch) {
            btnVerifyAndLaunch.textContent = "✓ 外掛已連線，設定精靈已啟動";
            btnVerifyAndLaunch.disabled = true;
        }

        // 觸發在 Chrome 開啟擴充功能全螢幕精靈
        if (shouldOpenWizard && !wizardOpened) {
            wizardOpened = true;
            try {
                await fetch(`${BRIDGE_BASE_URL}/extension/open-wizard`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        sessionId: "mcp_setup_" + Date.now(),
                        caller: "Claude Desktop MCP"
                    })
                });
            } catch (e) {}
        }
    }

    // 4. 手動點擊「檢測連線並啟動設定精靈」
    btnVerifyAndLaunch?.addEventListener("click", async () => {
        btnVerifyAndLaunch.textContent = "正在檢測中...";
        btnVerifyAndLaunch.disabled = true;

        const ok = await checkExtensionStatus(true);
        if (!ok) {
            btnVerifyAndLaunch.textContent = "我已載入完成，檢測連線並啟動設定精靈";
            btnVerifyAndLaunch.disabled = false;
            if (extStatusDesc) {
                extStatusDesc.textContent = "尚未偵測到外掛回應。請確認已在 Chrome「開發人員模式」下點選「載入未打包項目」，並確認外掛已啟用。";
                extStatusDesc.style.color = "#b91c1c";
            }
        }
    });

    // 5. 背景自動輪詢探測 (每 1.2 秒一次)
    setInterval(() => {
        if (!wizardOpened) {
            checkExtensionStatus(true);
        }
    }, 1200);

    // 初始檢測
    checkExtensionStatus(false);
})();