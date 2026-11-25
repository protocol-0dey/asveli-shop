import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.addInitScript(() => { localStorage.setItem('asv_consent', 'essential'); if (!localStorage.getItem('asv_lang')) localStorage.setItem('asv_lang', 'en'); }); });

test('home page renders products and has no horizontal scroll', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.pcard, [class*=product]').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('search → product page → add to cart → cart shows the line', async ({ page }) => {
  await page.goto('/search?q=headphones');
  const first = page.locator('a[href^="/p/"]').first(); await expect(first).toBeVisible();
  await first.click(); await expect(page).toHaveURL(/\/p\//);
  await page.getByRole('button', { name: /add to cart/i }).first().click();
  await page.goto('/cart');
  await expect(page.locator('a[href^="/p/"]').first()).toBeVisible();
});

test('language switch changes the page language and is remembered', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^EN · / }).click();
  await page.locator('select.input').first().selectOption('de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang', 'de');
});

test('unknown URL shows a 404 page, not a blank screen', async ({ page }) => { await page.goto('/no/such/page'); await expect(page.getByText('404')).toBeVisible(); });

test('buyer login rejects bad credentials with a visible error', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type=email]').fill('nobody@example.com'); await page.locator('input[type=password]').fill('wrong-password-123');
  await page.locator('form button[type=submit], form .btn-primary').first().click();
  await expect(page.locator('.err, [role=alert], .toast.err, .error').first()).toBeVisible();
});

test('seller can sign in to Seller Central and sees the dashboard', async ({ page }) => {
  await page.goto('/seller');
  await page.locator('input[type=email]').fill('seller@asveli.test'); await page.locator('input[type=password]').fill('seller-demo-12345');
  await page.locator('form button[type=submit], form .btn-primary').first().click();
  await expect(page.getByText(/dashboard|analytics|products|товар/i).first()).toBeVisible({ timeout: 10_000 });
});

test('admin panel is not served by the public API', async ({ request }) => {
  const r = await request.get(`http://localhost:${process.env.API_PORT || '3400'}/api/admin/me`); expect(r.status()).toBe(404);
});
