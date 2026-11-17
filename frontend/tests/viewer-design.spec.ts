import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Playback } from '../../shared/playback';
import { selectOptionsCategory } from './fixtures/viewer-options';

type Language = 'en' | 'fr';
type Theme = 'light' | 'dark';
const french = JSON.parse(
  readFileSync(new URL('../src/locales/fr.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const message = (language: Language, key: string) => (language === 'fr' ? french[key] || key : key);
const sizes = [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 844, height: 390 },
];

// Explicitly synthetic, protocol-shaped UI data. No game artwork, audio,
// production accounts or personal match history is used by this test.
const players = [
  'Fixture reviewer',
  'A deliberately long fixture teammate',
  'Fixture three',
  'Fixture four',
  'Fixture five',
  'Fixture opponent',
  'Un adversaire au pseudonyme assez long',
  'Fixture eight',
  'Fixture nine',
  'Fixture ten',
].map((name, index) => ({
  id: String(76561198000000001n + BigInt(index)),
  name,
  team: index < 5 ? 3 : 2,
}));
const actor = players[0].id;
const replay: Playback = {
  version: 1,
  map: 'de_viewer_design_fixture',
  sample: false,
  tickRate: 64,
  players,
  frames: [0, 560, 1536].map((tick) => ({
    tick,
    players: players.map((player, index) => ({
      id: player.id,
      x: index * 60 - 300,
      y: index < 5 ? 100 : -100,
      z: 0,
      yaw: 0,
      pitch: 0,
      health: index === 5 && tick >= 560 ? 0 : 100,
      alive: !(index === 5 && tick >= 560),
      team: player.team,
      weapon: index === 3 ? 'awp' : 'ak47',
      money: index === 0 ? 0 : 16000,
      armor: 100,
      ammo: 30,
      helmet: true,
      defuser: player.team === 3,
      equipmentValue: 5200,
      inventory: ['SmokeGrenade', 'Flashbang', 'Flashbang', 'HEGrenade', 'ak47'],
      input: {
        source: 'usercmd',
        buttons: '65545',
        forward: true,
        back: false,
        left: false,
        right: false,
        jump: false,
        duck: false,
        walk: true,
        attack: true,
        attack2: false,
        reload: false,
        use: false,
        mouseDx: 12,
        mouseDy: -4,
      },
    })),
  })),
  rounds: [{ number: 1, tick: 0, liveTick: 64, endTick: 1500 }],
  events: [
    {
      type: 'grenade_thrown',
      tick: 256,
      user_steamid: actor,
      user_name: players[0].name,
      weapon: 'smokegrenade',
      entityid: 73,
    },
    {
      type: 'player_death',
      tick: 448,
      attacker_steamid: actor,
      user_steamid: players[5].id,
      attacker_name: players[0].name,
      user_name: players[5].name,
      weapon: 'ak47',
    },
    {
      type: 'smokegrenade_detonate',
      tick: 512,
      user_steamid: actor,
      user_name: players[0].name,
      entityid: 73,
      x: 320,
      y: 0,
      z: 0,
    },
  ],
  grenades: [
    {
      id: '73-256',
      kind: 'CSmokeGrenadeProjectile',
      points: [
        { tick: 256, x: 64, y: 0, z: 80 },
        { tick: 384, x: 192, y: 80, z: 180 },
        { tick: 512, x: 320, y: 0, z: 0 },
      ],
    },
  ],
  capabilities: {
    economy: true,
    equipment: true,
    inventory: true,
    inputButtons: 'usercmd',
    mouseInput: true,
    utilityThrows: true,
  },
  communications: {
    voice: 'absent',
    chat: 'absent',
    captions: 'ready',
    unsupportedPackets: 0,
  },
  worldBounds: { minX: -500, maxX: 500, minY: -500, maxY: 500, minZ: 0, maxZ: 200 },
};

async function openFixture(
  page: Page,
  language: Language,
  theme: Theme,
  playback: Playback = replay,
) {
  await page.addInitScript(
    ({ language, theme }) => {
      localStorage.setItem('theme', theme);
      localStorage.setItem('cswatch.language', language);
      localStorage.setItem(
        'viewer-settings',
        JSON.stringify({
          quality: 'low',
          inputs: true,
          mouseInput: true,
          inputLayout: 'zqsd',
          inputDetails: false,
          economy: true,
          teamLayout: 'split',
          radar: true,
          killfeed: true,
          subtitles: true,
          voiceScope: 'all',
          autoHideControls: false,
        }),
      );
    },
    { language, theme },
  );
  await page.route('**/api/demos/viewer-design-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'viewer-design-fixture',
        name: 'Explicit synthetic design regression fixture',
        source: 'synthetic-qa',
        status: 'ready',
        size: 1024,
        created_at: 1700000000,
        public: true,
        owned: false,
        map: replay.map,
        duration: 24,
        rounds: 1,
        error: null,
      },
    }),
  );
  await page.route('**/api/demos/viewer-design-fixture/playback', (route) =>
    route.fulfill({ json: playback }),
  );
  await page.route('**/api/demos/viewer-design-fixture/captions', (route) =>
    route.fulfill({
      json: {
        status: 'ready',
        cues: [
          {
            id: 'synthetic-layout-caption',
            startTick: 0,
            endTick: 1536,
            speaker: actor,
            text:
              language === 'fr'
                ? 'Sous-titre fictif de test : ces lignes vérifient que les commandes, les joueurs et les actions restent lisibles ensemble sur un petit écran.'
                : 'Synthetic test subtitle: these lines check that controls, player information and review actions remain readable together on a small screen.',
            source: 'imported',
            language,
          },
        ],
      },
    }),
  );
  await page.route('**/api/maps/' + replay.map, (route) =>
    route.fulfill({ json: { model: null, mobile: null } }),
  );
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({ json: { ct: null, t: null } }),
  );
  await page.route('**/api/assets/equipment', (route) => route.fulfill({ json: { icons: {} } }));
  await page.goto('/watch/viewer-design-fixture');
  await expect(page.locator('.input-mouse-button-label')).toHaveText(['LMB', 'RMB']);
  await setCamera(page, language, '2D tactical · low power');
  await page
    .getByRole('slider', { name: message(language, 'Playback position'), exact: true })
    .fill('560');
  await expect(page.locator('.viewer-context-actions button')).toHaveCount(2);
  await expect(page.locator('.voice-caption')).toContainText(
    language === 'fr' ? 'Sous-titre fictif de test' : 'Synthetic test subtitle',
  );
  await page.evaluate(() => document.fonts.ready.then(() => null));
}

async function setCamera(page: Page, language: Language, name: string) {
  await page.getByRole('combobox', { name: message(language, 'Camera mode'), exact: true }).click();
  await page.getByRole('option', { name: message(language, name), exact: true }).click();
}

// DOM Ranges deliberately measure the text itself. scrollWidth/clientWidth or
// the label's clipped box alone would incorrectly accept the old LMB/RMB bug.
async function inputTextIssues(page: Page) {
  return page.evaluate(() => {
    const issues: string[] = [];
    const inside = (inner: DOMRect, outer: DOMRect) =>
      inner.left >= outer.left - 0.75 &&
      inner.top >= outer.top - 0.75 &&
      inner.right <= outer.right + 0.75 &&
      inner.bottom <= outer.bottom + 0.75;
    const check = (node: Element, containers: string[]) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const textRects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
      const text = node.textContent?.trim();
      if (textRects.length !== 1) issues.push(`${text}: expected one visible text line`);
      for (const selector of containers) {
        const outer = node.closest(selector);
        if (!outer || !textRects.every((rect) => inside(rect, outer.getBoundingClientRect())))
          issues.push(`${text}: text escapes ${selector}`);
      }
      const style = getComputedStyle(node);
      if (style.visibility !== 'visible' || style.opacity === '0')
        issues.push(`${text}: label is hidden`);
    };
    document
      .querySelectorAll('.input-mouse-button-label')
      .forEach((node) =>
        check(node, ['.input-mouse-button', '.input-mouse-shell', '.review-inputs-panel']),
      );
    document
      .querySelectorAll('.input-action-key kbd')
      .forEach((node) =>
        check(node, ['.input-action-key', '.input-keyboard-block', '.review-inputs-panel']),
      );
    if (document.querySelectorAll('.input-mouse-button-label').length !== 2)
      issues.push('Both physical mouse button labels must be present');
    if (document.querySelectorAll('.input-action-key kbd').length !== 9)
      issues.push('All movement and modifier key labels must be present');
    return issues;
  });
}

async function layoutIssues(page: Page) {
  return page.evaluate(() => {
    const issues: string[] = [];
    const selectors = [
      '.viewer-titlebar',
      '.viewer-dock',
      '.review-inputs-panel',
      // The scroll viewport is visible; offscreen roster rows intentionally are not.
      '.broadcast-lineup-stack',
      '.viewer-context-actions',
      '.voice-caption',
      '.position-radar',
      '.killfeed > div',
    ];
    const visible = (node: Element) => {
      let current: Element | null = node;
      while (current) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0')
          return false;
        current = current.parentElement;
      }
      return true;
    };
    const boxes = selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)]
        .filter(visible)
        .map((node) => ({ selector, box: node.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.height > 0),
    );
    for (const { selector, box } of boxes)
      if (
        box.left < -1 ||
        box.top < -1 ||
        box.right > innerWidth + 1 ||
        box.bottom > innerHeight + 1
      )
        issues.push(`${selector} escapes ${innerWidth}x${innerHeight}`);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i],
          b = boxes[j];
        const overlapWidth = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        const overlapHeight = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        if (overlapWidth > 1 && overlapHeight > 1)
          issues.push(`${a.selector} overlaps ${b.selector}`);
      }
    // A clipped toolbar can have a perfectly sized outer box while hiding an
    // action. Its visible hit targets must fit the surface that owns them too.
    document
      .querySelectorAll(
        '.viewer-titlebar button, .viewer-titlebar a, .viewer-titlebar [role="combobox"], .viewer-dock button, .viewer-dock [role="combobox"], .viewer-dock input[type="range"]',
      )
      .forEach((node) => {
        if (!visible(node)) return;
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height) return;
        const parent = node.closest('.viewer-titlebar,.viewer-dock')!.getBoundingClientRect();
        if (
          box.left < parent.left - 1 ||
          box.top < parent.top - 1 ||
          box.right > parent.right + 1 ||
          box.bottom > parent.bottom + 1
        )
          issues.push(
            `${node.getAttribute('aria-label') || node.textContent}: control escapes its bar`,
          );
      });
    const scene = document.querySelector('.viewer-stage')!.getBoundingClientRect();
    if (
      Math.abs(scene.left) > 1 ||
      Math.abs(scene.top) > 1 ||
      Math.abs(scene.width - innerWidth) > 1 ||
      Math.abs(scene.height - innerHeight) > 1
    )
      issues.push('Scene does not fill the browser tab');
    const header = document.querySelector('.viewer-titlebar')!.getBoundingClientRect();
    if (Math.abs(header.height - 48) > 1) issues.push('Toolbar is not one compact 48px row');
    const play = document.querySelector('.play-button')!.getBoundingClientRect();
    if (Math.abs(play.left + play.width / 2 - innerWidth / 2) > 1)
      issues.push('Play must be centered on the viewport');
    const dock = document.querySelector('.viewer-dock')!.getBoundingClientRect();
    if (dock.width > 1001) issues.push('The playback deck must retain its narrow maximum width');
    const input = document.querySelector('.review-inputs-panel')?.getBoundingClientRect();
    if (innerWidth >= 1101) {
      const column = document.querySelector('.broadcast-economy')?.getBoundingClientRect();
      if (column) {
        const gutter = Number.parseFloat(
          getComputedStyle(document.querySelector('.viewer-frame')!).getPropertyValue(
            '--viewer-edge',
          ),
        );
        if (
          dock.left < column.width + gutter + 12 ||
          innerWidth - dock.right < column.width + gutter + 12
        )
          issues.push('Desktop playback must clear both roster column widths');
      }
    }
    if (innerWidth >= 1101 && input) {
      if (input.right + 12 > dock.left)
        issues.push('Desktop inputs need their own lane beside the playback deck');
      if (Math.abs(input.bottom - dock.bottom) > 1)
        issues.push('Desktop inputs and the playback deck must share a bottom baseline');
    }
    if (
      document.documentElement.scrollWidth > innerWidth + 1 ||
      document.documentElement.scrollHeight > innerHeight + 1
    )
      issues.push('Viewer creates document overflow');
    return issues;
  });
}

async function rosterEdgeIssues(page: Page) {
  return page.locator('.broadcast-lineup-stack').evaluateAll((stacks) => {
    const issues: string[] = [];
    if (!stacks.length) return ['Enabled roster must be present'];
    for (const stack of stacks) {
      const viewport = stack.getBoundingClientRect();
      const visibleRows = [...stack.querySelectorAll('.broadcast-player-select')]
        .map((node) => ({
          name: node.getAttribute('aria-label'),
          box: node.getBoundingClientRect(),
        }))
        .filter(({ box }) => box.bottom > viewport.top + 1 && box.top < viewport.bottom - 1);
      if (!visibleRows.length) {
        issues.push('Enabled roster must show at least one complete player');
        continue;
      }
      for (const row of [visibleRows[0], visibleRows.at(-1)!])
        if (row.box.top < viewport.top - 1 || row.box.bottom > viewport.bottom + 1)
          issues.push(
            `${row.name}: player row [${row.box.top.toFixed(1)},${row.box.bottom.toFixed(1)}] is cropped by roster [${viewport.top.toFixed(1)},${viewport.bottom.toFixed(1)}], scrollTop=${stack.scrollTop}`,
          );
      if (visibleRows.some(({ box }) => box.height < 44))
        issues.push('Visible player rows must retain 44px touch targets');
      for (const row of stack.querySelectorAll('.broadcast-player-select')) {
        const equipment = row.querySelector('.broadcast-player-equipment')!;
        const status = row.querySelector('.broadcast-player-status')!;
        const equipmentBox = equipment.getBoundingClientRect();
        const statusBox = status.getBoundingClientRect();
        if (equipmentBox.bottom > statusBox.top - 3)
          issues.push('Full equipment kit must have clearance above health/armor');
        for (const glyph of equipment.querySelectorAll('.equipment-glyph')) {
          const box = glyph.getBoundingClientRect();
          if (
            box.bottom > statusBox.top - 3 ||
            box.left < equipmentBox.left - 1 ||
            box.right > equipmentBox.right + 1
          )
            issues.push('Equipment glyph escapes its own row or enters health/armor');
        }
      }
      if (stack.scrollHeight > stack.clientHeight + 1) {
        const cue = stack.parentElement?.querySelector('.broadcast-scroll-cue');
        const box = cue?.getBoundingClientRect();
        if (!cue || !box?.width || !box.height || getComputedStyle(cue).display === 'none')
          issues.push('Hidden players need a persistent visible scroll cue on touch screens');
      }
    }
    return issues;
  });
}

async function teamLayout(
  page: Page,
  language: Language,
  option: 'Teams on both sides' | 'Teams on the right',
) {
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await selectOptionsCategory(page, 'Visuals');
  await page
    .getByRole('combobox', { name: message(language, 'Player overview layout'), exact: true })
    .click();
  await page.getByRole('option', { name: message(language, option), exact: true }).click();
  await page
    .getByRole('button', { name: message(language, 'Close viewer options'), exact: true })
    .click();
  await expect(page.locator('.broadcast-player-select')).toHaveCount(10);
}

async function checkDialog(page: Page, language: Language) {
  const trigger = page.getByRole('button', { name: 'Options', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', {
    name: message(language, 'Viewer options'),
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return (
        box.left >= -1 &&
        box.top >= -1 &&
        box.right <= innerWidth + 1 &&
        box.bottom <= innerHeight + 1 &&
        node.scrollWidth <= node.clientWidth + 1 &&
        document.documentElement.scrollWidth <= innerWidth + 1
      );
    }),
    'Viewer options must scroll internally without overflowing the tab',
  ).toBe(true);
  const mouseSwitch = dialog.getByRole('switch', {
    name: new RegExp('^' + message(language, 'Mouse buttons and movement')),
  });
  await mouseSwitch.focus();
  await expect(mouseSwitch).toBeFocused();
  await expect(mouseSwitch).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

async function checkPlayersPanel(page: Page, language: Language, modal: boolean) {
  const direct = page.getByRole('button', { name: message(language, 'Players'), exact: true });
  const trigger = (await direct.isVisible())
    ? direct
    : page.getByRole('button', { name: message(language, 'More controls'), exact: true });
  await trigger.click();
  if (trigger !== direct)
    await page.getByRole('menuitem', { name: message(language, 'Players'), exact: true }).click();
  const drawer = page.locator('.viewer-drawer');
  const header = page.locator('.viewer-titlebar');
  const dock = page.locator('.viewer-dock');
  const title = drawer.getByRole('heading', { name: message(language, 'Players'), exact: true });
  const close = drawer.getByRole('button', { name: message(language, 'Close panel'), exact: true });
  await expect(title).toBeVisible();
  await expect(close).toBeVisible();
  if (modal) {
    await expect(
      page.getByRole('dialog', { name: message(language, 'Players'), exact: true }),
    ).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    // Bounds alone missed the old header painting over the modal title/close.
    // The underlying bars must actually stop painting and receiving focus.
    await expect(header).toBeHidden();
    await expect(dock).toBeHidden();
    await expect(header).toHaveAttribute('inert', '');
    await expect(dock).toHaveAttribute('inert', '');
  } else {
    await expect(drawer).not.toHaveAttribute('aria-modal', 'true');
    await expect(header).toBeVisible();
    await expect(dock).toBeVisible();
    await expect(header).not.toHaveAttribute('inert', '');
    await expect(dock).not.toHaveAttribute('inert', '');
  }
  expect(
    await close.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return (
        box.left >= 0 &&
        box.top >= 0 &&
        box.right <= innerWidth &&
        box.bottom <= innerHeight &&
        node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
      );
    }),
    'The panel close target must be on screen and unobscured',
  ).toBe(true);
  await close.click();
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(header).toBeVisible();
  await expect(dock).toBeVisible();
  await expect(header).not.toHaveAttribute('inert', '');
  await expect(dock).not.toHaveAttribute('inert', '');
}

for (const language of ['en', 'fr'] as const)
  for (const theme of ['dark', 'light'] as const)
    test(`${language} ${theme}: actual input text and simultaneous overlays fit phone through TV`, async ({
      page,
    }) => {
      test.skip(Boolean(process.env.E2E_PRIVATE), 'Synthetic public replay UI fixture.');
      test.setTimeout(120000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1440, height: 900 });
      await openFixture(page, language, theme);
      for (const size of sizes)
        await test.step(`${size.width}x${size.height}`, async () => {
          await page.setViewportSize(size);
          await expect(page.locator('.viewer-context-actions button')).toHaveCount(2);
          await expect(page.locator('.voice-caption')).toBeVisible();
          await expect.poll(() => inputTextIssues(page)).toEqual([]);
          await expect.poll(() => layoutIssues(page)).toEqual([]);
          await expect.poll(() => rosterEdgeIssues(page)).toEqual([]);
          await expect(page.locator('.broadcast-player-select')).toHaveCount(10);
          await expect(page.locator('.broadcast-lineup-stack')).toHaveCount(
            size.width >= 1440 ? 2 : 1,
          );
          const keyboard = (await page.locator('.input-keyboard-block').boundingBox())!;
          const mouse = (await page.locator('.input-mouse-device').boundingBox())!;
          expect(mouse.x).toBeGreaterThanOrEqual(keyboard.x + keyboard.width - 1);
          for (const control of [
            page.getByRole('button', { name: 'Options', exact: true }),
            page.getByRole('button', { name: message(language, 'Play'), exact: true }),
            page.getByRole('button', { name: message(language, 'More controls'), exact: true }),
            ...((await page.locator('.viewer-context-actions button').all()) || []),
          ]) {
            const box = (await control.boundingBox())!;
            expect(
              box.height,
              'Primary controls retain a 44px touch target',
            ).toBeGreaterThanOrEqual(44);
            expect(box.width, 'Primary controls retain a 44px touch target').toBeGreaterThanOrEqual(
              44,
            );
          }
          await checkDialog(page, language);
          await checkPlayersPanel(page, language, size.width <= 390 || size.height <= 390);
          if (size.width === 1440) {
            const ct = (await page.locator('.broadcast-bank[data-team="3"]').boundingBox())!;
            const opponents = (await page.locator('.broadcast-bank[data-team="2"]').boundingBox())!;
            expect(ct.x + ct.width).toBeLessThan(size.width / 2);
            expect(opponents.x).toBeGreaterThan(size.width / 2);
            await teamLayout(page, language, 'Teams on the right');
            await expect(page.locator('.broadcast-lineup-stack')).toHaveCount(1);
            expect(
              (await page.locator('.broadcast-bank[data-team="3"]').boundingBox())!.x,
            ).toBeGreaterThan(size.width / 2);
            await expect.poll(() => layoutIssues(page)).toEqual([]);
            await expect.poll(() => rosterEdgeIssues(page)).toEqual([]);
            await teamLayout(page, language, 'Teams on both sides');
            await expect(page.locator('.broadcast-lineup-stack')).toHaveCount(2);
          }
        });
      // Include the actual optional radar once, without running WebGL at every size.
      await setCamera(page, language, 'Free camera');
      await expect(page.locator('.position-radar')).toBeVisible();
      expect((await page.locator('.position-radar').boundingBox())!.width).toBeGreaterThanOrEqual(
        80,
      );
      await expect.poll(() => layoutIssues(page)).toEqual([]);
      const lastPlayer = page.locator('.broadcast-player-select').last();
      await lastPlayer.click();
      await expect(lastPlayer).toHaveAttribute('aria-pressed', 'true');
      expect((await lastPlayer.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect
        .poll(() =>
          page.locator('.broadcast-lineup-stack').evaluate((stack) => {
            const thumb = stack.parentElement!.querySelector('.broadcast-scroll-cue > span')!;
            return thumb.getBoundingClientRect().top > stack.getBoundingClientRect().top + 1;
          }),
        )
        .toBe(true);
      await page.locator('.viewer-stage').press('h');
      await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'false');
      await expect(page.locator('.voice-caption')).toBeVisible();
      await expect(page.locator('.viewer-review-hud')).toHaveAttribute('inert', '');
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'true');
      await expect(page.getByRole('button', { name: 'Options', exact: true })).toBeFocused();
      expect(errors).toEqual([]);
    });

test.describe('touch design recovery', () => {
  test.use({ hasTouch: true });
  test('phone controls remain usable beside readable instruments in portrait and landscape', async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE), 'Synthetic public replay UI fixture.');
    await page.setViewportSize({ width: 390, height: 844 });
    await openFixture(page, 'fr', 'light');
    for (const size of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(size);
      await expect.poll(() => inputTextIssues(page)).toEqual([]);
      await expect.poll(() => layoutIssues(page)).toEqual([]);
      await expect.poll(() => rosterEdgeIssues(page)).toEqual([]);
      const row = page.locator('.broadcast-player-select').last();
      await row.tap();
      await expect(row).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'true');
      await page.locator('.broadcast-player-select').first().tap();
      await expect(page.locator('.viewer-context-actions button')).toHaveCount(2);
      // The optional short-landscape moment card now owns the middle lane.
      // Exercise a real scene tap rather than activating that deliberate control.
      const center = await page.evaluate(() => {
        for (let y = 160; y < innerHeight - 100; y += 20)
          for (let x = 24; x < innerWidth - 24; x += 20) {
            const target = document.elementFromPoint(x, y);
            if (
              target?.closest('.viewer-stage') &&
              !target.closest('button,a,input,select,textarea,[data-viewer-chrome]')
            )
              return { x, y };
          }
        throw new Error('No unobscured scene point remains for touch viewing');
      });
      await page.touchscreen.tap(center.x, center.y);
      await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'false');
      await expect(page.locator('.voice-caption')).toBeVisible();
      await page.touchscreen.tap(center.x, center.y);
      await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'true');
      await checkDialog(page, 'fr');
      await checkPlayersPanel(page, 'fr', true);
    }
  });
});

for (const language of ['en', 'fr'] as const)
  for (const theme of ['dark', 'light'] as const)
    test(`${language} ${theme}: round review uses a bounded modal on compact screens and restores instruments`, async ({
      page,
    }) => {
      test.skip(Boolean(process.env.E2E_PRIVATE), 'Synthetic public replay UI fixture.');
      const objectiveReplay: Playback = {
        ...replay,
        matchState: {
          complete: true,
          samples: [
            {
              tick: 0,
              ctScore: 8,
              tScore: 4,
              roundNumber: 13,
              phase: 'live',
              clock: { kind: 'round', startTick: 0, endTick: 1536 },
            },
          ],
        },
        objectives: {
          complete: true,
          samples: [
            {
              kind: 'bomb',
              entity: 'synthetic-objective',
              tick: 512,
              present: true,
              ticking: true,
              beingDefused: true,
              actor,
              endTick: 5120,
              duration: 75,
              defuseEndTick: 960,
              defuseDuration: 7,
              site: 1,
            },
          ],
        },
      };
      await page.setViewportSize({ width: 1440, height: 900 });
      await openFixture(page, language, theme, objectiveReplay);
      for (const size of [
        { width: 1440, height: 900 },
        { width: 768, height: 1024 },
        { width: 390, height: 844 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(size);
        await expect(page.locator('.objective-hud')).toBeVisible();
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const objective = document.querySelector('.objective-hud')!.getBoundingClientRect();
                return [...document.querySelectorAll('.killfeed > div')].some((node) => {
                  const box = node.getBoundingClientRect();
                  return (
                    Math.min(box.right, objective.right) - Math.max(box.left, objective.left) > 1 &&
                    Math.min(box.bottom, objective.bottom) - Math.max(box.top, objective.top) > 1
                  );
                });
              }),
            { message: 'Recorded killfeed must remain visible outside the objective ribbon' },
          )
          .toBe(false);
        const more = page.getByRole('button', {
          name: message(language, 'More controls'),
          exact: true,
        });
        await more.click();
        await page
          .getByRole('menuitem', {
            name: message(language, 'Kills and utility review'),
            exact: true,
          })
          .click();
        const feed = page.locator('.review-feed');
        await feed.getByRole('tab', { name: new RegExp('^' + message(language, 'Kills')) }).click();
        const modal = size.width <= 540 || size.height <= 560;
        await expect(page.locator('.review-feed-dialog[open]')).toHaveCount(modal ? 1 : 0);
        if (modal) {
          await expect(
            page.getByRole('dialog', { name: message(language, 'Round review'), exact: true }),
          ).toBeVisible();
          await expect(page.locator('.viewer-review-hud')).toBeHidden();
          await expect(page.locator('.viewer-match-score')).toBeHidden();
          await expect(page.locator('.viewer-objective-layer')).toBeHidden();
        } else {
          await expect(page.locator('.viewer-review-hud')).toBeVisible();
          const area = (await feed.boundingBox())!;
          for (const roster of await page.locator('.broadcast-lineup-stack').all()) {
            const bounds = (await roster.boundingBox())!;
            const width =
              Math.min(area.x + area.width, bounds.x + bounds.width) - Math.max(area.x, bounds.x);
            const height =
              Math.min(area.y + area.height, bounds.y + bounds.height) - Math.max(area.y, bounds.y);
            expect(width > 1 && height > 1, 'Inline round review must clear the player lists').toBe(
              false,
            );
          }
        }
        const action = feed.getByRole('button', {
          name: message(language, 'Replay kill from {{player}}’s perspective').replace(
            '{{player}}',
            players[0].name,
          ),
          exact: true,
        });
        expect(
          await action.evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return (
              bounds.width >= 44 &&
              bounds.height >= 44 &&
              node.contains(
                document.elementFromPoint(
                  bounds.left + bounds.width / 2,
                  bounds.top + bounds.height / 2,
                ),
              )
            );
          }),
          'Replay perspective action must remain touch sized and unobscured',
        ).toBe(true);
        await feed
          .getByRole('tab', { name: new RegExp('^' + message(language, 'Utility')) })
          .click();
        if (modal) {
          const bounds = (await page.locator('.review-feed-dialog[open]').boundingBox())!;
          expect(bounds.x + bounds.width / 2).toBeCloseTo(size.width / 2, 0);
          expect(bounds.y + bounds.height / 2).toBeCloseTo(size.height / 2, 0);
        }
        await expect(
          feed.getByRole('button', {
            name: message(language, 'View grenade landing'),
            exact: true,
          }),
        ).toBeVisible();
        await feed
          .getByRole('button', { name: message(language, 'Close round review'), exact: true })
          .click();
        await expect(feed).toHaveCount(0);
        await expect(more).toBeFocused();
        await expect(page.locator('.viewer-review-hud')).toBeVisible();
        await expect(page.locator('.viewer-match-score')).toBeVisible();
        await expect(page.locator('.objective-hud')).toBeVisible();
      }
    });

// Event-driven prompts must never change the geometry of the player list. The
// fixture keeps equipment and caption dimensions constant across these seeks.
test('roster lanes stay fixed when a kill prompt appears and expires', async ({ page }) => {
  test.skip(Boolean(process.env.E2E_PRIVATE), 'Synthetic public replay UI fixture.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page, 'en', 'dark');
  const slider = page.getByRole('slider', { name: 'Playback position', exact: true });
  const caption = page.locator('.voice-caption');
  const settleLayout = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const captionBounds = () =>
    caption.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100);
    });
  const bounds = () =>
    page.locator('.broadcast-lineup-stack').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100);
      }),
    );
  for (const size of [...sizes, { width: 1101, height: 900 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(size);
    await slider.fill('0');
    await expect(page.locator('.viewer-context-actions')).toHaveCount(0);
    await expect(caption).toBeVisible();
    await settleLayout();
    await expect.poll(() => layoutIssues(page)).toEqual([]);
    await expect.poll(() => rosterEdgeIssues(page)).toEqual([]);
    const initial = await bounds();
    const initialCaption = await captionBounds();
    await slider.fill('560');
    await expect(page.locator('.viewer-context-actions button')).toHaveCount(2);
    await expect(caption).toBeVisible();
    await settleLayout();
    expect(await captionBounds(), 'The caption must retain its occupied lane').toEqual(
      initialCaption,
    );
    await expect
      .poll(bounds, {
        message: `A prompt must not resize the roster at ${size.width}×${size.height}`,
      })
      .toEqual(initial);
    await expect.poll(() => layoutIssues(page)).toEqual([]);
    // The moment has expired, but the fixture caption still runs until 1536.
    // Seeking to the last tick would also reclaim the caption's occupied lane.
    await slider.fill('1200');
    await expect(page.locator('.viewer-context-actions')).toHaveCount(0);
    await expect(caption).toBeVisible();
    await settleLayout();
    expect(await captionBounds(), 'Prompt expiry must not also expire the caption').toEqual(
      initialCaption,
    );
    await expect
      .poll(bounds, { message: 'Expiring a prompt must not enlarge the roster again' })
      .toEqual(initial);
  }
});
