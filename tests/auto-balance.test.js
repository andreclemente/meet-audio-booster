import test from 'node:test'
import assert from 'node:assert/strict'
import { createParticipantLevelMeter, attributeLevelSample } from '../src/platforms/google-meet/levels.js'
import { createAutoBalance } from '../src/ui/auto-balance.js'

function fixture(values=[1,1]) {
  const people=values.map((value,i)=>({key:String(i),value})), writes=[]
  const meter=createParticipantLevelMeter({settleMs:0})
  const auto=createAutoBalance({participants:()=>people,levels:k=>meter.levelFor(k),onGain:(p,v,o)=>{writes.push({key:p.key,from:p.value,to:v,o});p.value=v}})
  let now=0
  function run(key,db,count=130){for(let i=0;i<count;i++){now+=100;const value=typeof db==='function'?db(i):db;const accepted=meter.tick({now,participantKeys:people.map(p=>p.key),attributedKey:value===null?null:String(key),readPower:()=>10**(value/10)});auto.tick(now,accepted?String(key):null)}}
  auto.start(now)
  return {people,writes,meter,auto,run,get now(){return now}}
}
test('two unity voices genuinely far apart adjust in correct directions with positive readiness',()=>{
 const f=fixture();f.run(0,-40);f.run(1,-20);f.run(0,-40)
 assert.equal(f.auto.targetDb,-30);assert.ok(f.people[0].value>1);assert.ok(f.people[1].value<1)
 for(const w of f.writes){assert.ok(Math.abs(20*Math.log10(w.to/w.from))<=.0500001);assert.deepEqual(w.o,{automatic:true})}
})
for(const loud of [-30,-20]) test('comfortable unity preserved against preboosted voice '+loud,()=>{
 const f=fixture([1,6]);f.run(0,-30);f.run(1,loud);f.run(0,-30)
 assert.equal(f.auto.targetDb,-30);assert.equal(f.people[0].value,1);assert.ok(f.people[1].value<6)
})
test('learning order, third unity entrant and off/on retained automatic values do not lift target',()=>{
 const f=fixture([1,6,1]);f.run(1,-20);f.run(0,-30);f.run(2,-30)
 assert.equal(f.auto.targetDb,-30);assert.equal(f.people[2].value,1)
 f.auto.stop();f.auto.start(f.now);f.run(1,-20);f.run(0,-30)
 assert.equal(f.auto.targetDb,-30);assert.equal(f.people[0].value,1)
})
test('no untrusted all-nonunity target; mute never unmuted',()=>{
 const f=fixture([2,6,0]);f.run(0,-30);f.run(1,-20);f.run(2,-10)
 assert.equal(f.auto.targetDb,null);assert.equal(f.writes.length,0);assert.equal(f.people[2].value,0)
})
for(const modulation of [13,20]) test(`ordinary alternating ${modulation}dB phrasing is held after positive ready gate; sustained change eventually adjusts`,()=>{
 const f=fixture();f.run(0,-30);f.run(1,-30);assert.equal(f.auto.targetDb,-30)
 for(let i=0;i<10;i++)f.run(0,-30+(i%2?-1:1)*modulation/2,15)
 assert.equal(f.people[0].value,1);assert.equal(f.writes.length,0)
 f.run(0,-45,220);assert.ok(f.people[0].value>1)
})
test('freshness, noise, reset, replacement, disabled state and reused ticks cannot write',()=>{
 const f=fixture();f.run(0,-40);f.run(1,-20);const n=f.writes.length
 f.auto.tick(f.now,'1');f.auto.tick(f.now+30,'1');f.run(0,-70);assert.equal(f.writes.length,n)
 f.auto.invalidate(f.now);assert.equal(f.auto.targetDb,null)
 f.people[0]={key:'0',value:1};f.auto.tick(f.now,null);f.auto.stop();f.run(0,-40);assert.equal(f.writes.length,n)
})
test('longer robust control window expires and excludes pre-enable history',()=>{
 const f=fixture();f.run(0,-30,59);assert.equal(f.meter.levelFor('0').autoDb,null)
 f.run(0,-30,21);assert.equal(f.meter.levelFor('0').autoDb,-30)
 f.auto.start(f.now);f.run(1,-20);assert.equal(f.auto.targetDb,null)
 f.meter.tick({now:f.now+31000,participantKeys:['0','1'],readPower:()=>0});assert.equal(f.meter.levelFor('0').autoDb,null)
})
test('retained automatic gains on originally unity references do not ratchet next target',()=>{
 const f=fixture();f.run(0,-40);f.run(1,-20);f.run(0,-40)
 const target=f.auto.targetDb;assert.ok(f.writes.length>0)
 f.auto.stop();f.auto.start(f.now);f.run(0,-40,130);f.run(1,-20,130)
 assert.equal(f.auto.targetDb,target)
})
test('explicit manual selection equal to last auto value replaces provenance',()=>{
 const f=fixture();f.run(0,-40);f.run(1,-20);f.run(0,-40)
 f.auto.stop();for(const p of f.people)f.auto.noteManual(p,p.value)
 f.auto.start(f.now);f.run(0,-40,130);f.run(1,-20,130)
 assert.equal(f.auto.targetDb,null,'both manual nonunity choices are not comfort references')
})
test('local presentation, unknown and overlapping activity never attribute',()=>{
 const base={available:true,speakers:[{key:'0'}],routingState:'confirmed-speaker',appliedParticipantKey:'0'}
 assert.equal(attributeLevelSample(base),'0')
 for(const delta of [{available:false},{localPresentationActive:true},{speakers:[{key:'0'},{key:'1'}]},{appliedParticipantKey:'unknown'}])assert.equal(attributeLevelSample({...base,...delta}),null)
})

// Generic articulation envelopes, not copied participant data. Different
// periods, phases and inter-word pauses must not make equal voices unequal.
for(const modulation of [13,20]) test(`independent portions positively qualify ${modulation} dB articulation with pauses and distinct rhythms at unity`,()=>{
 const f=fixture()
 const speech=(period,phase)=>i=>i%23>=20?null:-30+modulation/2*Math.sin((i+phase)*2*Math.PI/period)
 f.run(0,speech(7,0),180)
 let a=f.meter.levelFor('0')
 assert.ok(a.autoPortions>=3&&a.autoSpread<=4&&Number.isFinite(a.autoDb),JSON.stringify(a))
 f.run(1,speech(11,3),180)
 let b=f.meter.levelFor('1')
 assert.ok(b.autoPortions>=3&&b.autoSpread<=4&&Number.isFinite(b.autoDb),JSON.stringify(b))
 assert.ok(Number.isFinite(f.auto.targetDb),'positive comparative readiness, not abstention')
 f.run(0,speech(7,2),180);f.run(1,speech(11,1),180)
 assert.deepEqual(f.people.map(p=>p.value),[1,1]);assert.equal(f.writes.length,0)
 // Same articulation at a genuinely new microphone level must eventually act.
 f.run(0,i=>-42+modulation/2*Math.sin(i*2*Math.PI/7),240)
 assert.ok(f.people[0].value>1,'sustained quiet shift must not freeze')
})

test('confidence uses completed non-overlapping portions, then resets on a long source gap',()=>{
 const meter=createParticipantLevelMeter({settleMs:0})
 const add=(from,count,db)=>{for(let i=0;i<count;i++)meter.tick({now:from+i*100,participantKeys:['x'],attributedKey:'x',readPower:()=>10**(db/10)})}
 add(0,80,-30)
 assert.equal(meter.levelFor('x').autoPortions,4);assert.equal(meter.levelFor('x').autoSpread,0)
 add(8000,19,-20)
 assert.equal(meter.levelFor('x').autoPortions,4,'partial portion is not a fresh confidence vote')
 assert.equal(meter.levelFor('x').autoSpread,0)
 add(9900,1,-20)
 assert.equal(meter.levelFor('x').autoPortions,5)
 assert.equal(meter.levelFor('x').autoDb,null,'newest completed portion disagrees, so stale consensus cannot authorize changes')
 assert.equal(meter.levelFor('x').autoSpread,Infinity)
 add(26000,1,-30)
 assert.equal(meter.levelFor('x').autoFrames,1);assert.equal(meter.levelFor('x').autoDb,null)
})

test('rapid correlated frames and a single phonetic/cough burst cannot seed confidence or writes',()=>{
 const meter=createParticipantLevelMeter({sampleMs:0,settleMs:0})
 for(let now=0;now<120;now++)meter.tick({now,participantKeys:['x'],attributedKey:'x',readPower:()=>10**(-20/10)})
 assert.equal(meter.levelFor('x').autoDb,null,'120 near-simultaneous observations are not independent speech portions')
 const f=fixture();f.run(0,-30);f.run(1,-5,12)
 assert.equal(f.auto.targetDb,null);assert.equal(f.writes.length,0)
 f.run(1,-30,120);assert.ok(Number.isFinite(f.auto.targetDb));assert.equal(f.writes.length,0)
 f.run(0,-5,4);assert.equal(f.writes.length,0,'one short cough cannot change an established level')
})

test('persistent quiet/loud directions reverse and relearn after graph invalidation',()=>{
 const f=fixture();f.run(0,-40,130);f.run(1,-20,130);f.run(0,-40,130)
 assert.ok(f.people[0].value>1&&f.people[1].value<1)
 const before=f.people.map(p=>p.value)
 f.run(0,-20,240);f.run(1,-40,240)
 assert.ok(f.people[0].value<before[0]&&f.people[1].value>before[1])
 f.meter.reset();f.auto.invalidate(f.now)
 const n=f.writes.length
 f.run(0,-40,59);assert.equal(f.writes.length,n);assert.equal(f.auto.targetDb,null)
 const restart=f.people.map(p=>p.value)
 f.run(0,-40,80);f.run(1,-20,130);f.run(0,-40,130)
 assert.equal(f.auto.targetDb,-30)
 assert.ok(f.people[0].value>restart[0]&&f.people[1].value<restart[1])
})
