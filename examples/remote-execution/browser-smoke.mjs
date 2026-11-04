import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { portalUrl, waitForRemoteResult } from "./smoke-support.mjs";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => sessionStorage.setItem("pilotswarm.devAuth.persona", JSON.stringify({
        id: "alice", displayName: "Alice Anderson", email: "alice@dev.local", role: "user",
    })));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let created;
    page.on("response", async response => {
        if (response.request().method() === "POST" && /\/api\/v1\/sessions(?:\/for-agent)?$/.test(new URL(response.url()).pathname) && response.ok()) {
            created = (await response.json()).result;
        }
    });
    await page.goto(portalUrl);
    await page.getByRole("button", { name: "New session — choose model and agent", exact: true }).click({ timeout: 30_000 });
    for (let stage = 0; stage < 5 && !created; stage++) {
        const search = page.getByRole("searchbox", { name: "Search agents" });
        if (await search.isVisible()) {
            await search.fill("remote-coder");
            await page.locator(".ps-modal-list-button").filter({ hasText: "remote-coder" }).first().click();
        } else {
            await page.locator(".ps-modal-list-button:not(.is-disabled)").first().click();
        }
        await page.getByRole("button", { name: "Create Session", exact: true }).click();
        await sleep(500);
    }
    assert.ok(created?.sessionId, "browser must create a real portal session");
    const nonce = `browser-${randomUUID()}`;
    const composer = page.getByTestId("composer-input");
    await composer.fill(`Use sandbox_exec to run this exact shell command:\n\n\`\`\`sh\nprintf '%s' '${nonce}' > browser-proof.txt; cat browser-proof.txt; hostname\n\`\`\`\n\nReport the verified file contents.`);
    await composer.press("Enter");
    const { job } = await waitForRemoteResult(created.sessionId, "alice", 0, nonce);
    await page.locator(".ps-chat-call").first().waitFor({ timeout: 30_000 });
    assert.equal(errors.length, 0, "portal must not raise browser runtime errors");
    if (process.env.REMOTE_BROWSER_SCREENSHOT) await page.screenshot({ path: process.env.REMOTE_BROWSER_SCREENSHOT, fullPage: true });
    console.log(JSON.stringify({ browserCreate: "PASS", browserSend: "PASS", liveRemoteTool: "PASS", sessionId: created.sessionId, executor: job.executor }));
} finally {
    await browser.close();
}
