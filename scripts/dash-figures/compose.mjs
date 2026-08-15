#!/usr/bin/env node
//
// Assembles the dash figures used by docs/api-reference/extensions/path-style-extension.md
// from render-test golden images.
//
// "After" panels are read straight out of test/render/golden-images, so a published figure
// cannot drift away from what the code does - if behavior changes, the golden test fails
// before the figure goes stale. "Before" panels come from scripts/dash-figures/capture-before.sh,
// which re-renders the same scenes against the pre-9.4 implementation.
//
// Usage:
//   node scripts/dash-figures/compose.mjs [--before <dir>] [--out <dir>]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const GOLDEN_DIR = path.join(REPO_ROOT, 'test/render/golden-images');

const PANEL_WIDTH = 800;
const PADDING = 16;
const CAPTION_HEIGHT = 34;
const SUBCAPTION_HEIGHT = 26;
const BACKGROUND = {r: 255, g: 255, b: 255, alpha: 1};

function parseArgs(argv) {
  const args = {
    before: path.join(REPO_ROOT, '.dash-figures/before'),
    // Writes straight into the tracked location, so the committed figures are this
    // pipeline's real output rather than a copy that can drift from it.
    out: path.join(REPO_ROOT, 'docs/images/path-style')
  };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--before') args.before = path.resolve(argv[i + 1]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[i + 1]);
  }
  return args;
}

function escapeXml(text) {
  return text.replace(/[<>&]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;'})[c]);
}

/** A caption strip. `tone` picks the accent colour used for before/after labelling. */
function caption(text, {height = CAPTION_HEIGHT, size = 15, weight = 600, tone = '#1a1a1a'} = {}) {
  const svg = `<svg width="${PANEL_WIDTH}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${PANEL_WIDTH}" height="${height}" fill="#ffffff"/>
    <text x="${PADDING}" y="${height - Math.round(height / 3)}"
      font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
      font-size="${size}" font-weight="${weight}" fill="${tone}">${escapeXml(text)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const MAX_INTERNAL_GAP = 26;

/**
 * Collapses runs of blank scanlines down to `maxGap`.
 *
 * Trimming alone only removes whitespace at the edges. These panels lay their content out as
 * widely spaced rows, so a trimmed panel is still mostly empty in the middle and the stacked
 * figure ends up several thousand pixels tall for a few hundred pixels of content. Squeezing
 * the interior keeps the rows in their original order and relative grouping while making the
 * figure readable at a glance.
 */
function squeezeBlankRows({data, info}) {
  const {width, height, channels} = info;
  const rowIsBlank = [];
  for (let y = 0; y < height; y++) {
    let blank = true;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      // Panels are flattened onto white before this runs.
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        blank = false;
        break;
      }
    }
    rowIsBlank.push(blank);
  }

  const keep = [];
  let gap = 0;
  for (let y = 0; y < height; y++) {
    if (rowIsBlank[y]) {
      gap++;
      if (gap <= MAX_INTERNAL_GAP) keep.push(y);
    } else {
      gap = 0;
      keep.push(y);
    }
  }

  const out = Buffer.alloc(keep.length * width * channels);
  keep.forEach((y, index) => {
    data.copy(out, index * width * channels, y * width * channels, (y + 1) * width * channels);
  });
  return {buffer: out, width, height: keep.length, channels};
}

/**
 * Trims a panel to its content box, squeezes its interior whitespace and re-pads it, so
 * figures are compact instead of mostly empty. Golden images are 800x450 with the strokes
 * occupying a few widely spaced bands.
 */
async function panel(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing panel: ${file}\nRun scripts/dash-figures/capture-before.sh first.`);
  }
  const trimmed = await sharp(file)
    .flatten({background: BACKGROUND})
    .trim({threshold: 5})
    .raw()
    .toBuffer({resolveWithObject: true});

  const squeezed = squeezeBlankRows(trimmed);

  return sharp(squeezed.buffer, {
    raw: {width: squeezed.width, height: squeezed.height, channels: squeezed.channels}
  })
    .resize({
      width: PANEL_WIDTH - PADDING * 2,
      fit: 'contain',
      position: 'left',
      background: BACKGROUND
    })
    .extend({
      top: PADDING / 2,
      bottom: PADDING / 2,
      left: PADDING,
      right: PADDING,
      background: BACKGROUND
    })
    .png()
    .toBuffer();
}

/** Stacks buffers vertically on a white background. */
async function stack(buffers) {
  const images = await Promise.all(
    buffers.map(async buffer => ({buffer, meta: await sharp(buffer).metadata()}))
  );
  const height = images.reduce((total, {meta}) => total + meta.height, 0);

  let top = 0;
  const composites = images.map(({buffer, meta}) => {
    const entry = {input: buffer, left: 0, top};
    top += meta.height;
    return entry;
  });

  return sharp({
    create: {width: PANEL_WIDTH, height, channels: 4, background: BACKGROUND}
  })
    .composite(composites)
    .png()
    .toBuffer();
}

const golden = name => path.join(GOLDEN_DIR, `${name}.png`);

async function build(args) {
  const before = name => path.join(args.before, `${name}.png`);

  const figures = {
    'path-style-dash-modes': async () => [
      await caption('Dash modes, on one path whose segments are deliberately unequal'),
      await caption(
        'Ticks mark the joints. Rows: segment; segment + justified; path; path + justified.',
        {height: SUBCAPTION_HEIGHT, size: 13, weight: 400, tone: '#555555'}
      ),
      await panel(golden('path-dash-figure-modes'))
    ],

    'path-style-dash-density': async () => [
      await caption('dashMode and vertex density'),
      await caption(
        'The same straight line drawn from 1, 2, 4, 12, 40 and 120 vertices, top to bottom.',
        {height: SUBCAPTION_HEIGHT, size: 13, weight: 400, tone: '#555555'}
      ),
      await caption("dashMode: 'segment' — the last two rows have no gaps left to draw", {
        height: SUBCAPTION_HEIGHT,
        size: 13,
        tone: '#b00000'
      }),
      await panel(golden('path-dash-density-default')),
      await caption("dashMode: 'path' — all six rows identical", {
        height: SUBCAPTION_HEIGHT,
        size: 13,
        tone: '#006400'
      }),
      await panel(golden('path-dash-density-mode-path'))
    ],

    'path-style-dash-units': async () => {
      const rows = [
        await caption('dashUnits, with widthUnits: ‘meters’ so the stroke itself scales'),
        await caption(
          "Top pair: dashUnits 'widths'. Bottom pair: dashUnits 'pixels'. Red is flat, blue is billboarded.",
          {height: SUBCAPTION_HEIGHT, size: 13, weight: 400, tone: '#555555'}
        )
      ];
      for (const zoom of [12, 13, 14]) {
        rows.push(
          await caption(`zoom ${zoom}`, {height: SUBCAPTION_HEIGHT, size: 13, tone: '#555555'})
        );
        rows.push(await panel(golden(`path-dash-units-z${zoom}`)));
      }
      return rows;
    },

    'path-style-dash-fixes': async () => {
      const pairs = [
        [
          'path-dash-subpixel-square',
          'Sub-pixel dash periods',
          'Periods from 40px down to 0.2px. Every pattern is half solid, so each row should read as an even tone.'
        ],
        [
          'path-dash-billboard-map-z14',
          'billboard: true parity',
          'The same geometry drawn flat (red) and billboarded (blue). The two should match.'
        ],
        [
          'path-dash-3d-flat',
          'Paths that move in Z',
          'Four identical screen lines descending by 0, 300, 720 and 900 units. Spacing should stay even along each.'
        ]
        // getOffset is fixed too, and path-dash-offset-mode-path covers it, but it is left
        // out here on purpose: the drift it corrects is about 4% of a period (43.4px against
        // 41.6px at offset 8), which does not read in a figure. A pair that looks identical
        // on both sides would suggest the fix did nothing.
      ];

      const rows = [
        await caption('Fixed in v9.4 — no opt-in required'),
        await caption('Each pair renders the identical scene; only the implementation differs.', {
          height: SUBCAPTION_HEIGHT,
          size: 13,
          weight: 400,
          tone: '#555555'
        })
      ];
      for (const [name, title, blurb] of pairs) {
        rows.push(await caption(title));
        rows.push(
          await caption(blurb, {height: SUBCAPTION_HEIGHT, size: 13, weight: 400, tone: '#555555'})
        );
        rows.push(await caption('before', {height: SUBCAPTION_HEIGHT, size: 13, tone: '#b00000'}));
        rows.push(await panel(before(name)));
        rows.push(await caption('after', {height: SUBCAPTION_HEIGHT, size: 13, tone: '#006400'}));
        rows.push(await panel(golden(name)));
      }
      return rows;
    }
  };

  fs.mkdirSync(args.out, {recursive: true});
  for (const [name, buildRows] of Object.entries(figures)) {
    const image = await stack(await buildRows());
    const target = path.join(args.out, `${name}.png`);
    fs.writeFileSync(target, image);
    const {width, height, size} = await sharp(target).metadata();
    console.log(`${name}.png  ${width}x${height}  ${(size / 1024).toFixed(0)}KB`);
  }
}

build(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(error.message);
  process.exit(1);
});
