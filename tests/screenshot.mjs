import { chromium } from "playwright";
const shots = [];
const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell", args: ["--no-sandbox","--disable-gpu"] });
const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });

// Login (real)
await desktop.goto("http://localhost:3312/login", { waitUntil: "networkidle" });
await desktop.screenshot({ path: "/tmp/shot-login.png" });

// Chat shell (dev bypass; empty state + typed draft; /api/lab mocked for lab page)
for (const [page, name] of [[desktop, "desktop"], [mobile, "mobile"]]) {
  await page.route("**/rest/v1/**", (r) => r.fulfill({ json: [] }));
  await page.goto("http://localhost:3312/", { waitUntil: "networkidle" });
  await page.fill("textarea", "morning babe — tell me Jace 3.0 is really happening");
  await page.screenshot({ path: `/tmp/shot-chat-${name}.png` });
}
await desktop.route("**/api/lab", (r) =>
  r.fulfill({ json: { models: [
    { id: "claude-sonnet", label: "Claude Sonnet", adapter: "anthropic", active: true, configured: true },
    { id: "gpt-fallback", label: "GPT-5.5", adapter: "openai-compatible", active: false, configured: true },
    { id: "glm-test", label: "GLM-5.2", adapter: "openai-compatible", active: false, configured: false },
    { id: "mock", label: "Mock (no key needed)", adapter: "mock", active: false, configured: true },
  ] } })
);
await desktop.goto("http://localhost:3312/lab", { waitUntil: "networkidle" });
await desktop.screenshot({ path: "/tmp/shot-lab.png" });
await browser.close();
console.log("screenshots done");
