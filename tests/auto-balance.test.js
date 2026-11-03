import test from 'node:test'
import assert from 'node:assert/strict'
import { createParticipantLevelMeter } from '../src/platforms/google-meet/levels.js'
import { createAutoBalance } from '../src/ui/auto-balance.js'

function feed(meter, key, db, start, count) {
  for (let i = 0; i < count; i++) meter.tick({ now: start + i * 100, participantKeys: ['a', 'b'], attributedKey: key, readPower: () => 10 ** (db / 10) })
}
test('automatic evidence cannot reuse 300-frame old-direction median after a speech gap', () => {
  const m = createParticipantLevelMeter({ settleMs: 0 })
  feed(m, 'a', -20, 0, 300)
  feed(m, 'b', -40, 30000, 300)
  feed(m, 'a', -40, 61000, 12)
  const a = m.levelFor('a')
  assert.equal(a.autoDb, -40)
  assert.equal(a.autoFrames, 12)
  assert.equal(a.sampledAt, 62100)
  assert.equal(a.typicalDb, -20, 'legacy visual median is deliberately distinct')
})
test('fast automatic window expires by time and resets after gap, prune and reset', () => {
  const m = createParticipantLevelMeter({ settleMs: 0 })
  feed(m, 'a', -30, 0, 12)
  assert.equal(m.levelFor('a').autoDb, -30)
  m.tick({ now: 4000, participantKeys: ['a','b'], attributedKey: null, readPower: () => { throw Error('unsafe sample') } })
  assert.equal(m.levelFor('a').autoDb, null)
  feed(m, 'a', -10, 4100, 1)
  assert.equal(m.levelFor('a').autoDb, null)
  assert.equal(m.levelFor('a').autoFrames, 1)
  m.tick({now:4200, participantKeys:['b'], readPower:()=>0})
  assert.equal(m.levelFor('a').autoFrames, 0)
  m.reset()
  assert.equal(m.levelFor('b').autoDb, null)
})

function automaticFixture() {
  const people = [{ key:'a', value:1 }, { key:'b', value:1 }, { key:'muted', value:0 }]
  const data = new Map(), writes = []
  const auto = createAutoBalance({ participants:()=>people, levels:key=>data.get(key), onGain:(p,v,options)=>{ writes.push({key:p.key,from:p.value,to:v,options}); p.value=v } })
  function sample(key, db, now, extra={}) {
    data.set(key,{autoDb:db,autoFrames:10,autoSince:now-900,sampledAt:now,...extra})
    auto.tick(now,key)
  }
  return { people, data, writes, auto, sample }
}

test('fixed target, correct directions, gradual bounds, deadband and no reused-sample feedback',()=>{
  const f=automaticFixture()
  f.sample('a',-40,1000); assert.equal(f.writes.length,0)
  f.auto.start(0)
  f.sample('a',-40,1000); f.sample('b',-20,2000)
  assert.equal(f.auto.targetDb,-30)
  assert.ok(f.people[1].value<1)
  const n=f.writes.length
  f.auto.tick(2000,'b'); f.auto.tick(2030,'b'); f.auto.tick(2060,null)
  assert.equal(f.writes.length,n)
  f.sample('a',-40,3000)
  assert.ok(f.people[0].value>1)
  for(let i=0;i<800;i++) f.sample(i%2?'a':'b',i%2?-40:-20,3100+i*100)
  assert.equal(f.auto.targetDb,-30,'own gain changes never move the target')
  for(const w of f.writes) {
    assert.ok(Math.abs(20*Math.log10(w.to/w.from))<=0.10000001)
    assert.ok(w.to>0&&w.to<=6)
    assert.deepEqual(w.options,{automatic:true})
  }
  const before=f.writes.length
  f.sample('a',-30-20*Math.log10(f.people[0].value),84000)
  assert.equal(f.writes.length,before)
})

test('mute, stale data, insufficient frames, pre-enable history and unknown sample cannot adjust',()=>{
  const f=automaticFixture(); f.auto.start(1000)
  f.sample('a',-40,2000);f.sample('b',-20,3000)
  const before=f.writes.length
  f.sample('muted',-10,4000)
  f.sample('a',-40,5000,{sampledAt:4900})
  f.sample('a',-40,5100,{autoFrames:9})
  f.sample('a',-40,5200,{autoSince:0})
  f.sample('a',NaN,5300)
  f.auto.tick(5400,'unknown');f.auto.tick(5500,null)
  assert.equal(f.writes.length,before)
  assert.equal(f.people[2].value,0)
  f.auto.stop();f.sample('a',-40,6000)
  assert.equal(f.writes.length,before)
})

test('learning expires after 15 seconds, departure/new object cannot inherit evidence; graph reset relearns',()=>{
  const f=automaticFixture();f.auto.start(0)
  f.sample('a',-40,1000);f.sample('b',-20,17000)
  assert.equal(f.auto.targetDb,null)
  f.people.splice(0,1,{key:'a',value:1})
  f.auto.tick(17100,null)
  f.sample('a',-40,18000)
  assert.equal(f.auto.targetDb,-30)
  const target=f.auto.targetDb
  f.auto.invalidate(19000)
  const before=f.writes.length
  f.sample('b',-20,19500,{autoSince:18500})
  assert.equal(f.writes.length,before)
  f.sample('b',-20,20100)
  assert.equal(f.auto.targetDb,target)
  f.auto.stop();f.auto.start(21000)
  assert.equal(f.auto.targetDb,null)
})

test('changed current levels reverse correction without consuming the stale 300-frame median',()=>{
  const meter=createParticipantLevelMeter({settleMs:0})
  let now=0
  const people=[{key:'a',value:1},{key:'b',value:1}]
  const writes=[]
  const auto=createAutoBalance({participants:()=>people,levels:k=>meter.levelFor(k),onGain:(p,v)=>{writes.push([p.key,v-p.value]);p.value=v}})
  function run(key,db,count){for(let i=0;i<count;i++,now+=100){const accepted=meter.tick({now,participantKeys:['a','b'],attributedKey:key,readPower:()=>10**(db/10)});auto.tick(now,accepted?key:null)}}
  run('a',-20,300);run('b',-40,300)
  auto.start(now)
  run('a',-40,15);run('b',-20,15);run('a',-40,15)
  assert.equal(meter.levelFor('a').typicalDb,-20)
  assert.ok(writes.some(([k,delta])=>k==='a'&&delta>0))
  assert.ok(writes.some(([k,delta])=>k==='b'&&delta<0))
  assert.ok(writes.every(([k,delta])=>k==='a'?delta>0:delta<0))
})
