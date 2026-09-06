import { expect, test, type Page } from "@playwright/test";

/** Guided is the default. Pro is a different layout, not the same one with denser text. */
async function goPro(page: Page) {
  await page.getByRole("button", { name: /Pro view/ }).click();
  await expect(page.locator(".terminal")).toBeVisible();
}

async function goGuided(page: Page) {
  await page.getByRole("button", { name: "GUIDED" }).click();
  await expect(page.locator(".app")).toBeVisible();
}

/**
 * Ensures the dashboard is showing a scan.
 *
 * Runs are persisted server-side, so once any test has scanned the rest can read that state
 * instead of each paying for another full pass over the chain — which during market hours is
 * slow enough to blow the test timeout. The explicit timeout must stay below the per-test
 * budget set by callers, or the wait can never actually reach it.
 */
async function runScan(page: Page) {
  const rows = page.locator(".universe .u-row");
  if (await rows.count() === 0) {
    await page.getByRole("button", { name: /Run a scan|Run scan|Run the first scan/ }).first().click();
  }
  await expect(rows.first()).toBeVisible({ timeout: 75_000 });
  // The first-run explainer covers the decision until dismissed. Clicking "Run a scan"
  // dismisses it as a side effect, so this only matters on the reuse path above.
  const dismiss = page.locator(".intro-dismiss");
  if (await dismiss.count() > 0) await dismiss.click();
}

// A run touches the live option chain for six symbols; the default 30s budget is not enough
// during market hours.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
});

test.describe("guided view", () => {
  test("is the default, and is a single light column rather than a terminal", async ({ page }) => {
    await expect(page).toHaveTitle(/VolGuard/);
    await expect(page.locator(".app")).toBeVisible();
    await expect(page.locator(".gmain")).toBeVisible();
    await expect(page.getByRole("button", { name: /Pro view/ })).toBeVisible();
    // The three-pane workspace and its dense chrome belong to Pro only.
    await expect(page.locator(".workspace")).toHaveCount(0);
    await expect(page.locator(".pane.right")).toHaveCount(0);
    await expect(page.locator(".jobs")).toHaveCount(0);
    // Guided is light; the body must follow it or overscroll shows the terminal's black.
    await expect(page.locator("body")).toHaveAttribute("data-view", "light");
  });

  test("offers only one primary action and no execution control", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Run a scan" })).toBeVisible();
    // A newcomer should not face a row of controls competing for attention.
    const header = page.locator(".gbar button");
    await expect(header).toHaveCount(4);  // Run a scan, How it works, Glossary, Pro view
    // Arming paper execution is an operator action; it is not reachable from guided mode.
    await expect(page.getByRole("button", { name: "PAPER", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Operator token")).toHaveCount(0);
    await expect(page.locator(".paper-tag")).toContainText("Paper money");
  });

  test("states the thesis in plain language, in the explainer a newcomer lands on", async ({ page }) => {
    const intro = page.locator(".intro");
    await expect(intro).toBeVisible();
    await expect(intro).toContainText(/are options priced below what this stock actually moves/i);
    await expect(intro.locator("h2")).not.toContainText(/variance risk premium/i);
  });

  test("leads with a plain headline and a single answer card", async ({ page }) => {
    await runScan(page);
    await expect(page.locator(".headline")).toContainText(/I looked at \d+ stocks/);
    await expect(page.locator(".subhead")).not.toBeEmpty();

    const answer = page.locator(".answer");
    await expect(answer).toHaveCount(1);
    await expect(answer.locator("h2")).not.toBeEmpty();
    await expect(answer.locator(".answer-line")).not.toBeEmpty();
  });

  test("shows the two numbers the whole thesis rests on", async ({ page }) => {
    await runScan(page);
    const versus = page.locator(".versus");
    if (await versus.count() === 0) test.skip(true, "This run returned no volatility data.");
    await expect(versus.getByText("Options cost")).toBeVisible();
    await expect(versus.getByText("Expected to move")).toBeVisible();

    // The default symbol is whichever one the run led with, and on a closed market that can
    // be a symbol Alpaca priced no options for. A dash there is the honest rendering, not a
    // failure — the assertions below are about the arithmetic when there is arithmetic.
    const strip = page.locator(".verdict-strip .vs-num");
    if ((await strip.textContent())?.trim() === "—") test.skip(true, "No premium for the leading symbol this run.");

    // The two figures on screen must subtract to the verdict beneath them. Showing the
    // trailing estimate beside a forecast-based premium shipped once; this catches it.
    const nums = await versus.locator(".v-num").allTextContents();
    const [cost, moves] = nums.map((t) => Number(t.replace("%", "")));
    const shown = Number(((await strip.textContent()) ?? "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(cost) && Number.isFinite(moves) && Number.isFinite(shown)) {
      expect(Math.abs(Math.abs(cost - moves) - shown), `${cost} − ${moves} should equal ${shown}`).toBeLessThan(0.15);
    }
    await expect(strip).toContainText(/pts (cheaper|pricier)/);
  });

  test("states risk as money, not as a Greek letter", async ({ page }) => {
    await runScan(page);
    const pair = page.locator(".risk-pair");
    if (await pair.count() === 0) test.skip(true, "This run produced no order to price.");
    await expect(pair.getByText("You could lose")).toBeVisible();
    await expect(pair.getByText("You could make")).toBeVisible();
    await expect(pair.locator(".risk-cell.lose .r-num")).toContainText(/^\$/);
  });

  test("charts the whole scan, including the basis it replaced", async ({ page }) => {
    await runScan(page);
    const chart = page.locator(".scanchart");
    await expect(chart).toBeVisible();

    const rows = await page.locator(".universe .u-row").count();
    // One bar per scanned symbol that produced a premium.
    expect(await chart.locator(".sc-bar").count()).toBeGreaterThan(0);
    expect(await chart.locator(".sc-bar").count()).toBeLessThanOrEqual(rows);

    // The dashed outline is the pre-forecast basis; showing both is the point of the chart.
    // It is drawn only for symbols where Alpaca returned both an ATM implied vol and enough
    // bars for the bipower estimate, which on a quiet session can be none of them — so the
    // assertion is that the chart never invents one, not that live data always supplies one.
    const ghosts = await chart.locator(".sc-ghost").count();
    expect(ghosts).toBeLessThanOrEqual(await chart.locator(".sc-bar").count());
    if (ghosts === 0) test.skip(true, "No symbol in this run carried the trailing basis.");
  });

  test("selecting from the chart drives the same answer as the chips", async ({ page }) => {
    await runScan(page);
    const chartRows = page.locator(".scanchart .sc-row");
    if (await chartRows.count() < 2) test.skip(true, "Not enough scanned symbols to compare.");

    const label = (await chartRows.nth(1).locator(".sc-label").textContent())?.trim() ?? "";
    await chartRows.nth(1).click();
    await expect(page.locator(".universe .u-row.sel .u-sym")).toHaveText(label);
  });

  test("keeps jargon out of the headline and the answer", async ({ page }) => {
    await runScan(page);
    const jargon = /variance risk premium|implied volatility|backwardation|bipower|convexity/i;
    await expect(page.locator(".headline")).not.toContainText(jargon);
    await expect(page.locator(".answer h2")).not.toContainText(jargon);
    await expect(page.locator(".answer .answer-line")).not.toContainText(jargon);
  });

  test("says everything above the fold in a handful of short lines", async ({ page }) => {
    await runScan(page);
    // The guided view exists so a newcomer is not met with a wall of prose. Anything longer
    // than this belongs behind a disclosure.
    const words = await page.evaluate(() => {
      const el = document.querySelector(".gmain");
      if (!el) return 0;
      // Count only what is actually on screen: strip every unopened disclosure, at any depth.
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("details:not([open])").forEach((d) => d.remove());
      return (clone.textContent ?? "").trim().split(/\s+/).filter(Boolean).length;
    });
    expect(words, `${words} words on screen before any disclosure is opened`).toBeLessThan(140);
  });

  test("keeps advanced detail closed until asked for", async ({ page }) => {
    await runScan(page);
    for (const title of ["Why this matters", "What else I checked", "Your account and positions"]) {
      const block = page.locator(".disclose-block", { hasText: title }).first();
      await expect(block).not.toHaveAttribute("open", /.*/);
    }
    // ...and reachable in one click.
    const peek = page.locator(".pro-peek");
    await peek.locator("> summary").click();
    await expect(peek.getByText("Variance risk premium")).toBeVisible();
  });

  test("every disclosed panel is legible, not white-on-white", async ({ page }) => {
    await runScan(page);
    // The disclosures reuse components written for the dark terminal. If the palette is not
    // remapped they render near-white text on a white card.
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")));
    const worst = await page.evaluate(() => {
      const lum = (rgb: string) => {
        const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3)
          .map((v) => Number(v) / 255)
          .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      let lowest = 21;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(".gmain *"))) {
        const text = (el.textContent ?? "").trim();
        if (!text || el.children.length > 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        // Walk up for the nearest painted background.
        let bgEl: HTMLElement | null = el;
        let bg = "rgb(255, 255, 255)";
        while (bgEl) {
          const c = getComputedStyle(bgEl).backgroundColor;
          if (c && !c.includes("rgba(0, 0, 0, 0)")) { bg = c; break; }
          bgEl = bgEl.parentElement;
        }
        const [a, b] = [lum(style.color), lum(bg)].sort((x, y) => y - x);
        lowest = Math.min(lowest, (a + 0.05) / (b + 0.05));
      }
      return lowest;
    });
    // 3:1 is the floor for large text; anything under it is a palette bug, not a design choice.
    expect(worst, `lowest text contrast found: ${worst.toFixed(2)}:1`).toBeGreaterThan(3);
  });

  test("summarises the safety checks in one line, with the list one tap away", async ({ page }) => {
    await runScan(page);
    const summary = page.locator(".safety-line");
    if (await summary.count() === 0) test.skip(true, "This run produced no order to check.");
    await expect(summary).toContainText(/\d+ of \d+ safety checks passed/);
    await expect(page.locator(".gates")).toBeHidden();

    await page.locator(".disclose-block", { hasText: "safety checks" }).first().locator("> summary").click();
    await expect(page.locator(".gates")).toContainText(/Paper account only, never real money/);
  });

  test("shows the risk limits after one tap", async ({ page }) => {
    await runScan(page);
    await page.locator(".disclose-block", { hasText: "Your account and positions" }).first().locator("> summary").click();
    await expect(page.getByText("Daily loss")).toBeVisible();
    await expect(page.getByText("Max loss / trade")).toBeVisible();
    await expect(page.locator('.meter-track[role="progressbar"]').first()).toHaveAttribute("aria-valuenow", /\d+/);
  });

  test("every scanned stock opens its own reasoning, not just the chosen one", async ({ page }) => {
    await runScan(page);
    const chips = page.locator(".universe .u-row");
    const count = await chips.count();
    expect(count).toBeGreaterThan(1);

    // Selection used to search for a *run* whose chosen symbol matched, so every symbol the
    // agent did not pick did nothing when clicked. Each row must select itself and change
    // the answer shown.
    const seen = new Set<string>();
    for (let i = 0; i < count; i += 1) {
      const chip = chips.nth(i);
      const symbol = (await chip.locator(".u-sym").textContent())?.trim() ?? "";
      await chip.click();
      await expect(page.locator(".universe .u-row.sel .u-sym")).toHaveText(symbol);
      const heading = (await page.locator(".answer h2").textContent()) ?? "";
      expect(heading, `no reasoning shown for ${symbol}`).not.toBe("");
      seen.add(heading);
    }
    // Not every symbol needs a unique headline, but they cannot all be identical — that is
    // exactly the bug: one symbol's answer rendered under every ticker.
    expect(seen.size).toBeGreaterThan(1);
  });

  test("a stock can be chosen with the keyboard alone", async ({ page }) => {
    await runScan(page);
    const first = page.locator(".universe .u-row").first();
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".universe .u-row.sel")).toHaveCount(1);
  });

  test("explains itself to a first-time visitor, then stays out of the way", async ({ page }) => {
    const intro = page.locator(".intro");
    await expect(intro).toBeVisible();
    await expect(intro).toContainText(/are options priced below what this stock actually moves/i);

    await page.locator(".intro-dismiss").click();
    await expect(intro).toBeHidden();

    await page.reload();
    await expect(page.locator(".intro")).toBeHidden();

    await page.getByRole("button", { name: "How it works" }).click();
    await expect(page.locator(".intro")).toBeVisible();
  });

  test("every term of art can be defined without leaving the page", async ({ page }) => {
    await page.getByRole("button", { name: "Glossary" }).first().click();
    const glossary = page.getByRole("dialog", { name: "Glossary" });
    await expect(glossary).toBeVisible();
    await expect(glossary).toContainText("Variance risk premium");
    await expect(glossary).toContainText("Defined-risk debit spread");

    await page.keyboard.press("Escape");
    await expect(glossary).toBeHidden();
  });

  test("an inline term opens its own definition", async ({ page }) => {
    const term = page.locator(".term").first();
    await term.click();
    await expect(page.getByRole("dialog", { name: "Glossary" })).toBeVisible();
  });

  test("offers a skip link to keyboard users", async ({ page }) => {
    await page.keyboard.press("Tab");
    await expect(page.locator(".skip-link")).toBeFocused();
  });
});

test.describe("pro view", () => {
  test("is remembered across a reload", async ({ page }) => {
    await goPro(page);
    await page.reload();
    await expect(page.locator(".workspace")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-view", "dark");
  });

  test("restores the three-pane terminal and the trader vocabulary", async ({ page }) => {
    await goPro(page);
    await expect(page.locator(".pane.left")).toBeVisible();
    await expect(page.locator(".pane.right")).toBeVisible();
    await expect(page.locator(".thesis-line")).toContainText(/variance risk premium/i);
    await expect(page.locator(".jobs .job b")).toHaveText([
      "Evaluate", "Propose", "Reject", "Execute", "Monitor", "Explain",
    ]);
  });

  test("dry run is the default and the action names the mode", async ({ page }) => {
    await goPro(page);
    await expect(page.getByRole("button", { name: "DRY RUN", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Run scan", exact: true })).toBeVisible();
  });

  test("paper mode reveals the operator token gate and blocks execution without it", async ({ page }) => {
    await goPro(page);
    await page.getByRole("button", { name: "PAPER", exact: true }).click();
    const token = page.getByLabel("Operator token");
    await expect(token).toBeVisible();
    await expect(token).toHaveAttribute("type", "password");
    await expect(page.getByRole("button", { name: /Execute/ })).toBeDisabled();
  });

  test("returning to guided disarms paper execution", async ({ page }) => {
    await goPro(page);
    await page.getByRole("button", { name: "PAPER", exact: true }).click();
    await expect(page.getByLabel("Operator token")).toBeVisible();

    await goGuided(page);
    await goPro(page);
    await expect(page.getByRole("button", { name: "DRY RUN", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("shows raw gate names rather than plain-language labels", async ({ page }) => {
    await runScan(page);
    await goPro(page);
    const gates = page.locator(".gates");
    if (await gates.count() === 0) test.skip(true, "This run produced no risk decision to render.");
    await expect(gates.first()).toContainText(/paper environment/);
  });
});

test.describe("both views", () => {
  test("no Alpaca or Anthropic secret reaches the browser", async ({ page }) => {
    const body = await page.content();
    expect(body).not.toMatch(/APCA-API-SECRET-KEY/i);
    expect(body).not.toMatch(/sk-ant-/);
    const dashboard = await page.evaluate(async () => {
      const response = await fetch("/api/dashboard");
      return response.text();
    });
    expect(dashboard).not.toMatch(/secretKey|APCA|sk-ant-/i);
  });

  for (const view of ["guided", "pro"] as const) {
    test(`${view} never scrolls horizontally, at desktop or mobile width`, async ({ page }) => {
      if (view === "pro") await goPro(page);
      for (const width of [1600, 1400, 1280, 1100, 1040, 1000, 900, 820, 780, 640, 500, 375]) {
        await page.setViewportSize({ width, height: 900 });
        // Name the widest offending element; a bare boolean tells you nothing about which
        // element pushed the page wide.
        const report = await page.evaluate(() => {
          const vw = window.innerWidth;
          const offenders = Array.from(document.querySelectorAll<HTMLElement>("*"))
            .map((el) => ({ el, rect: el.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width > 0 && rect.right > vw + 1)
            .sort((a, b) => b.rect.right - a.rect.right)
            .slice(0, 3)
            .map(({ el, rect }) => {
              const cls = typeof el.className === "string" && el.className
                ? `.${el.className.trim().split(/\s+/).join(".")}`
                : "";
              return `${el.tagName.toLowerCase()}${cls} right=${Math.round(rect.right)}`;
            });
          return { bodyScrollWidth: document.body.scrollWidth, viewport: vw, offenders };
        });
        expect(
          report.bodyScrollWidth,
          `horizontal overflow at ${width}px (body ${report.bodyScrollWidth}px): ${report.offenders.join(" | ") || "no element extends past the viewport"}`,
        ).toBeLessThanOrEqual(report.viewport + 1);
      }
    });
  }
});

test.describe("server contract", () => {
  test("paper execution is rejected without the operator token", async ({ request }) => {
    expect((await request.post("/api/agent/run", { data: { mode: "paper" } })).status()).toBe(403);
  });

  test("scheduled execution is rejected without the operator token", async ({ request }) => {
    expect((await request.post("/api/agent/scheduled")).status()).toBe(403);
  });

  test("an invalid mode is rejected before the agent is reached", async ({ request }) => {
    const response = await request.post("/api/agent/run", { data: { mode: "live" } });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toMatch(/dry-run.*paper/);
  });

  test("every response carries a request id and a rate-limit allowance", async ({ request }) => {
    const response = await request.post("/api/agent/run", { data: { mode: "live" } });
    expect(response.headers()["x-request-id"]).toBeTruthy();
    expect(Number(response.headers()["x-ratelimit-limit"])).toBeGreaterThan(0);
    expect(response.headers()["x-ratelimit-remaining"]).toBeTruthy();
  });

  test("health reports readiness and confirms the paper lock", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.live).toBe(true);
    expect(body.ready).toBe(true);
    expect(body.paperOnly).toBe(true);
    expect(body.checks.paper_lock.ok).toBe(true);
  });

  test("serves the security headers a financial dashboard needs", async ({ request }) => {
    const headers = (await request.get("/")).headers();
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  test("never lets account data be cached", async ({ request }) => {
    const headers = (await request.get("/api/health")).headers();
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-robots-tag"]).toContain("noindex");
  });
});
