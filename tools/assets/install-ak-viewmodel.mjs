#!/usr/bin/env node
import { installViewmodel } from './install-viewmodel.mjs';

const [input, maps, ...extra] = process.argv.slice(2);
if (!input || !maps || extra.length)
  throw Error(
    'Usage: node tools/assets/install-ak-viewmodel.mjs <verified AK GLB> <MAP_ASSETS_DIR>',
  );
await installViewmodel({ equipment: 'ak47', input, maps });
