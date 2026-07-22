import esbuild from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dist = path.join(root, 'dist')
const watch = process.argv.includes('--watch')

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const options = {
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  outfile: path.join(dist, 'audio-booster.js'),
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  legalComments: 'none',
  charset: 'utf8',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  plugins: [{
    name: 'publish-root-bundle',
    setup(build) {
      build.onEnd(async result => {
        if (!result.errors.length) {
          await cp(path.join(dist, 'audio-booster.js'), path.join(root, 'audio-booster.js'))
        }
      })
    }
  }]
}

if (watch) {
  const context = await esbuild.context(options)
  await context.watch()
} else {
  await esbuild.build(options)
}

const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))
await writeFile(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await cp(path.join(root, 'service-worker.js'), path.join(dist, 'service-worker.js'))
await cp(path.join(root, 'icons'), path.join(dist, 'icons'), { recursive: true })
