/**
 * Конвертирует исходную иконку в нужные форматы и размеры для сборки.
 *
 * Положите вашу иконку в build/ как icon-source.png (или icon.png — тогда будет перезаписана).
 * Запуск: npm run convert-icon
 *
 * Создаёт:
 *   build/icon.png  — 256×256 для приложения и electron-builder
 *   build/icon.ico  — 256, 48, 32, 16 для Windows exe/установщика (опционально)
 *   build/tray.png — 32×32 для иконки в трее
 */

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ico = require('sharp-ico');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const SOURCE_CANDIDATES = ['icon-source.png', 'icon-source.jpg', 'icon-source.jpeg', 'icon.png', 'icon.jpg'];
const SIZES = { icon: 256, tray: 32 };
const ICO_SIZES = [256, 48, 32, 16];

function findSource() {
  for (const name of SOURCE_CANDIDATES) {
    const p = path.join(BUILD_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function run() {
  const sourcePath = findSource();
  if (!sourcePath) {
    console.error('Исходная иконка не найдена. Положите в папку build/ один из файлов:');
    SOURCE_CANDIDATES.forEach((n) => console.error('  -', n));
    process.exit(1);
  }

  console.log('Источник:', path.basename(sourcePath));

  const pipeline = sharp(sourcePath);
  const meta = await pipeline.metadata();
  const size = meta.width && meta.height ? `${meta.width}x${meta.height}` : '?';
  console.log('Размер исходника:', size);

  const outIconPng = path.join(BUILD_DIR, 'icon.png');
  const outTrayPng = path.join(BUILD_DIR, 'tray.png');
  const outIco = path.join(BUILD_DIR, 'icon.ico');

  await pipeline
    .resize(SIZES.icon, SIZES.icon)
    .png()
    .toFile(outIconPng);
  console.log('Создан:', 'icon.png', `(${SIZES.icon}x${SIZES.icon})`);

  await sharp(sourcePath)
    .resize(SIZES.tray, SIZES.tray)
    .png()
    .toFile(outTrayPng);
  console.log('Создан:', 'tray.png', `(${SIZES.tray}x${SIZES.tray})`);

  try {
    await ico.sharpsToIco(
      [sharp(sourcePath)],
      outIco,
      { sizes: ICO_SIZES, resizeOptions: {} }
    );
    console.log('Создан:', 'icon.ico', `(размеры: ${ICO_SIZES.join(', ')})`);
  } catch (e) {
    console.warn('icon.ico не создан (не критично для сборки с icon.png):', e.message);
  }

  console.log('Готово.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
