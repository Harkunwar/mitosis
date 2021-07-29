import {
  componentToReact,
  componentToReactNative,
  componentToSolid,
  componentToVue,
  MitosisComponent,
  parseJsx,
} from '@builder.io/mitosis';
import { outputFile, readFile, remove } from 'fs-extra';
import { compileVueFile } from './helpers/compile-vue-file';
import { transpile } from './helpers/transpile';
import dedent from 'dedent';
import * as json5 from 'json5';
import { transpileSolidFile } from './helpers/transpile-solid-file';
import glob from 'fast-glob';
import { MitosisConfig, Target } from '../types/mitosis-config';
import { flatten } from 'lodash'

const cwd = process.cwd();

export async function build(options?: MitosisConfig) {
  const config: MitosisConfig = {
    targets: [],
    dest: 'dist',
    files: 'src/*',
    ...options
  }

  await clean();

  const tsLiteFiles = await Promise.all(
    (await glob(flatten([config.files, `**/*.lite.tsx`]), { cwd })).map(async path => ({
      path,
      mitosisJson: parseJsx(await readFile(path, 'utf8'), {
        jsonHookNames: ['registerComponent'],
      }),
    }))
  );

  await Promise.all(
    config.targets.map(async target => {
      const jsFiles = await buildTsFiles(target);
      await Promise.all([outputTsFiles(target, jsFiles), outputTsxLiteFiles(target, tsLiteFiles, config)]);
      await outputOverrides(target, config);
    })
  );
}

async function clean() {
  const files = await glob('output/*/src/**/*');
  await Promise.all(
    files.map(async file => {
      await remove(file);
    })
  );
}

async function outputOverrides(target: Target, options: MitosisConfig) {
  const files = await glob([`overrides/${target}/**/*`, `!overrides/${target}/node_modules/**/*`]);
  await Promise.all(
    files.map(async file => {
      let contents = await readFile(file, 'utf8');

      const esbuildTranspile = file.match(/\.tsx?$/);
      if (esbuildTranspile) {
        contents = await transpile({ path: file, target });
      }

      await outputFile(
        file.replace('overrides/', `${options.dest}/`).replace(/\.tsx?$/, '.js'),
        contents
      );
    })
  );
}

async function outputTsxLiteFiles(
  target: Target,
  files: { path: string; mitosisJson: MitosisComponent }[],
  options: MitosisConfig
) {
  const output = files.map(async ({ path, mitosisJson }) => {
    let transpiled =
      target === 'reactNative'
        ? componentToReactNative(mitosisJson, {
            stateType: 'useState',
          })
        : target === 'vue'
        ? componentToVue(mitosisJson)
        : target === 'react'
        ? componentToReact(mitosisJson)
        : target === 'solid'
        ? componentToSolid(mitosisJson)
        : (null as never);

    const original = transpiled;

    const solidTranspile = target === 'solid';
    if (solidTranspile) {
      transpiled = await transpileSolidFile({
        contents: transpiled,
        path,
        mitosisComponent: mitosisJson,
      });
    }

    const esbuildTranspile = target === 'reactNative' || target === 'react';
    if (esbuildTranspile) {
      transpiled = await transpile({ path, content: transpiled, target });
      const registerComponentHook = mitosisJson.meta.registerComponent;
      if (registerComponentHook) {
        transpiled = dedent`
          import { registerComponent } from '../functions/register-component';

          ${transpiled}

          registerComponent(${mitosisJson.name}, ${json5.stringify(registerComponentHook)});
        
        `;
      }
    }
    const vueCompile = target === 'vue';
    if (vueCompile) {
      const files = await compileVueFile({
        distDir: options.dest,
        contents: transpiled,
        path,
        mitosisComponent: mitosisJson,
      });
      await Promise.all(files.map(file => outputFile(file.path, file.contents)));
    } else {
      return await Promise.all([
        outputFile(`${options.dest}/${target}/${path.replace(/\.lite\.tsx$/, '.js')}`, transpiled),
        outputFile(`${options.dest}/${target}/${path.replace(/\.original\.jsx$/, '.js')}`, original),
      ]);
    }
  });
  await Promise.all(output);
}

async function outputTsFiles(target: Target, files: { path: string; output: string }[], options?: MitosisConfig) {
  const output = files.map(({ path, output }) => {
    return outputFile(`${options.dest}/${target}/${path.replace(/\.tsx?$/, '.js')}`, output);
  });
  await Promise.all(output);
}

async function buildTsFiles(target: Target, options?: MitosisConfig) {
  const tsFiles = await glob(`src/**/*.ts`, {
    cwd: cwd,
  });

  return await Promise.all(
    tsFiles.map(async path => {
      const output = await transpile({ path, target });

      return {
        path,
        output,
      };
    })
  );
}

if (require.main === module) {
  build().catch(console.error);
}