import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

/** Run against a disposable, authenticated localhost fixture using a Playwright Page.
 * This deliberately never invokes scan, review, execution, pairing, or Undo mutations.
 * The caller provides fixture routes and a browser; no production credentials belong here.
 */
export async function checkPresentation(page, { baseUrl, routes, screenshotDir, widths = [320, 390, 768, 1024, 1440] }) {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname), "Use a local fixture server only");
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on("pageerror", onError);
  const checks = [];
  try {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of routes) {
        const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
        assert.ok(response && response.status() < 400, `${width}px ${route} did not load`);
        assert.ok(!new URL(page.url()).pathname.startsWith("/login") || route.startsWith("/login"), "Fixture session is missing");
        const content = await page.locator("body").innerText();
        assert.ok(!content.includes("This page couldn’t load"), `${route} rendered its server error boundary`);
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(scrollWidth <= width, `${route} overflows ${width}px by ${scrollWidth - width}px`);
        assert.deepEqual(errors, [], `${route} raised browser errors`);
        if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${width}${route.replaceAll("/", "-") || "-home"}.png`, fullPage: true });
        checks.push({ route, width, scrollWidth });
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/admin/library`, { waitUntil: "networkidle" });
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await menu.click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog.nsn-menu-dialog").isVisible(), false);
    assert.equal(await menu.evaluate(element => element === document.activeElement), true);
    await menu.click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => !document.querySelector("dialog.nsn-menu-dialog")?.open);
    await page.setViewportSize({ width: 390, height: 844 });
    await menu.click();
    await page.locator("dialog.nsn-menu-dialog").getByRole("link", { name: "Notebook", exact: true }).click();
    await page.waitForURL("**/notebook");
    assert.equal(await page.locator("dialog.nsn-menu-dialog").isVisible(), false);
    await page.getByLabel("Account and sign out").click();
    const accountBounds = await page.locator(".nsn-account-panel").boundingBox();
    assert.ok(accountBounds && accountBounds.x >= 0 && accountBounds.x + accountBounds.width <= 390, "Account controls must fit on mobile");
    await page.getByLabel("Account and sign out").click();

    await page.goto(`${baseUrl}/admin/library/review`, { waitUntil: "networkidle" });
    const tabs = page.getByRole("tablist", { name: "Recommendation type" });
    await tabs.getByRole("tab", { name: "Observations", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await tabs.getByRole("tab", { name: "File organization" }).getAttribute("aria-selected"), "true");
    const panel = page.getByRole("tabpanel", { name: "File organization" });
    const inputs = panel.locator('input[type="search"], input[type="text"]');
    if (await inputs.count()) {
      await inputs.first().fill("attention");
      await tabs.getByRole("tab", { name: "Observations", exact: true }).click();
      await tabs.getByRole("tab", { name: "File organization" }).click();
      assert.equal(await inputs.first().inputValue(), "attention", "Tab changes must preserve form state");
    }
    await tabs.getByRole("tab", { name: "File organization" }).focus();
    await page.keyboard.press("Home");
    assert.equal(await tabs.getByRole("tab", { name: "Observations", exact: true }).getAttribute("aria-selected"), "true");
    assert.deepEqual(errors, []);
    return { checks, mobileMenu: "passed", reviewTabs: "passed", browserErrors: errors };
  } finally {
    page.off("pageerror", onError);
  }
}
