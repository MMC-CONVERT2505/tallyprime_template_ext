// One-off smoke driver — not part of the app, just for this verification pass.
// Run: node e2e-smoke.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

mkdirSync('e2e-shots', { recursive: true });

const consoleErrors = [];
const networkErrors = [];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('response', (res) => {
  if (res.status() >= 400) networkErrors.push(`${res.status()} ${res.url()}`);
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

const shot = async (name) => {
  await page.screenshot({ path: `e2e-shots/${name}.png`, fullPage: true });
  console.log('screenshot:', name);
};

await page.goto('http://localhost:5173');
await page.waitForSelector('.auth-card');
await shot('01-auth-form');

// Switch the auth panel's own tab from Login to Register.
await page.click('.tabs-small button:has-text("Register")');
await shot('02-register-mode');

const email = `smoke-${Date.now()}@example.com`;
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', 'SmokeTest123!');
const labels = page.locator('.auth-card .form label');
await labels.nth(2).locator('input').fill('Smoke Test User');
await labels.nth(3).locator('input').fill('Smoke Test Org');
await shot('03-register-filled');

await page.click('button[type="submit"]');
await page.waitForSelector('nav.tabs', { timeout: 10000 });
await shot('04-logged-in-connections-tab');

for (const tabName of ['Device Pairing', 'Tally Direct', 'Extractions', 'Connections']) {
  await page.click(`nav.tabs button:has-text("${tabName}")`);
  await page.waitForTimeout(300);
  await shot(`05-tab-${tabName.replace(/\s+/g, '-').toLowerCase()}`);
}

// Back on Connections — click Refresh and wait for the table to populate.
await page.click('button:has-text("Refresh")');
await page.waitForTimeout(1000);
await shot('06-connections-refreshed');

const rowCount = await page.locator('table tbody tr').count();
const rowsText = await page.locator('table tbody').innerText();

console.log('\n=== RESULTS ===');
console.log('Connections table rows:', rowCount);
console.log('Rows text:\n', rowsText);
console.log('Console errors:', consoleErrors.length ? consoleErrors : 'none');
console.log('Network errors (4xx/5xx):', networkErrors.length ? networkErrors : 'none');

await browser.close();
