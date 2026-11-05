import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
const root = process.env.MAB_ROOT || new URL('../', import.meta.url).pathname
const { createParticipantLevelMeter } = await import(pathToFileURL(root + '/src/platforms/google-meet/levels.js'))
const { createAutoBalance } = await import(pathToFileURL(root + '/src/ui/auto-balance.js'))

for (const cadence of [50,100,120,200,300]) test(`six seconds bounded support and sparse acquisition at ${cadence}ms`, () => {
  const meter = createParticipantLevelMeter({ settleMs: 0 })
  let first = null
  for (let now = 0; now < 14000; now += cadence) {
    meter.tick({ now, participantKeys:['x'], attributedKey:'x', readPower:()=>.001 })
    const l = meter.levelFor('x')
    if (l.autoSupportMs < 6000) assert.equal(l.autoDb,null)
    if (l.autoDb !== null && first === null) first = { now, ...l }
  }
  assert.ok(first, 'adequately supported sparse speech must qualify')
  assert.ok(first.autoSupportMs >= 6000 && first.autoInlierFrames >= 24 && first.autoInlierPortions >= 3)
  assert.ok(first.now >= 6000)
  if (cadence >= 200) assert.ok(first.autoFrames < 60, 'no hidden 60-callback quorum')
})

test('unsupported gaps and interrupted speakers cannot contribute speech duration', () => {
  const meter = createParticipantLevelMeter({sampleMs:0,settleMs:0})
  for (let now=0;now<30000;now+=1000) {
    meter.tick({now,participantKeys:['x'],attributedKey:'x',readPower:()=>.001})
    meter.tick({now:now+1,participantKeys:['x'],attributedKey:null,readPower:()=>.001})
  }
  assert.equal(meter.levelFor('x').autoSupportMs,0)
  assert.equal(meter.levelFor('x').autoDb,null)
})

test('policy consumes explicit support, never legacy frame count or missing metadata', () => {
  for (const bad of [{autoSupportMs:undefined},{autoSupportMs:NaN},{autoSupportMs:5999},
    {autoInlierFrames:undefined},{autoInlierFrames:23},{autoInlierPortions:undefined},{autoInlierPortions:2}]) {
    const people = ['A','B'].map(key=>({key,value:1}));let now=1000
    const auto=createAutoBalance({participants:()=>people,levels:()=>({autoDb:-30,autoFrames:120,
      autoSupportMs:6000,autoInlierFrames:24,autoInlierPortions:3,autoSpread:0,autoSince:0,sampledAt:now,...bad}),onGain:()=>assert.fail('unexpected write')})
    auto.start(0);auto.tick(now,'A');now+=100;auto.tick(now,'B');assert.equal(auto.targetDb,null)
  }
  const people=['A','B'].map(key=>({key,value:1}));let now=1000
  const auto=createAutoBalance({participants:()=>people,levels:()=>({autoDb:-30,autoFrames:24,
    autoSupportMs:6000,autoInlierFrames:24,autoInlierPortions:3,autoSpread:0,autoSince:0,sampledAt:now}),onGain:()=>assert.fail('unexpected write')})
  auto.start(0);auto.tick(now,'A');now+=100;auto.tick(now,'B');assert.equal(auto.targetDb,-30)
})
