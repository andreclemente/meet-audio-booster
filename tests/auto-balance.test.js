import test from 'node:test'
import assert from 'node:assert/strict'
import { createParticipantLevelMeter, attributeLevelSample, AUTO_HORIZON_MS } from '../src/platforms/google-meet/levels.js'
import { createAutoBalance, referenceLevelDb, AUTO_TARGET_DB, AUTO_DEADBAND_DB, AUTO_STEP_DB, AUTO_SOLO_TOLERANCE_DB, AUTO_REFERENCE_RANGE_DB } from '../src/ui/auto-balance.js'

function fixture(values=[1,1]) {
  const people=values.map((value,i)=>({key:String(i),value})), writes=[]
  const meter=createParticipantLevelMeter({settleMs:0})
  const auto=createAutoBalance({participants:()=>people,levels:(k,o)=>meter.levelFor(k,o),onGain:(p,v,o)=>{writes.push({key:p.key,from:p.value,to:v,o});p.value=v}})
  let now=0
  function run(key,db,count=130){for(let i=0;i<count;i++){now+=100;const value=typeof db==='function'?db(i):db;const accepted=meter.tick({now,participantKeys:people.map(p=>p.key),attributedKey:value===null?null:String(key),readPower:()=>10**(value/10)});auto.tick(now,accepted?String(key):null)}}
  auto.start(now)
  return {people,writes,meter,auto,run,get now(){return now}}
}
const gainDb=v=>20*Math.log10(v)
// Make each voice's confident level known (ready from ~80 accepted 100 ms
// samples, then 30 more are needed to qualify a write), so a test starts from
// an established call reference instead of whichever voice was measured first.
const learn=(f,...voices)=>{for(const [key,db] of voices)f.run(key,db,90);assert.equal(f.writes.length,0,'learning alone never writes')}
test('call reference defaults to -20 dB (+/-6 dB clamp); 1 dB group tolerance, 4 dB lone-voice tolerance, 0.1 dB steps',()=>{
 assert.equal(AUTO_TARGET_DB,-20);assert.equal(AUTO_REFERENCE_RANGE_DB,6);assert.equal(AUTO_DEADBAND_DB,1);assert.equal(AUTO_SOLO_TOLERANCE_DB,4);assert.equal(AUTO_STEP_DB,0.1)
})
test('referenceLevelDb: fewer than two voices use -20 dB; median of odd/even counts; clamped to -20 +/- 6 dB',()=>{
 assert.equal(referenceLevelDb([]),-20);assert.equal(referenceLevelDb([-31]),-20);assert.equal(referenceLevelDb([-9]),-20)
 assert.equal(referenceLevelDb([NaN,-25,undefined,Infinity]),-20,'non-finite levels are not voices')
 const input=[-18,-30,-22]
 assert.equal(referenceLevelDb(input),-22,'odd count: middle voice');assert.deepEqual(input,[-18,-30,-22],'input not reordered')
 assert.equal(referenceLevelDb([-24,-18,-30,-22]),-23,'even count: mean of the middle two')
 assert.equal(referenceLevelDb([-23.5,-23.5]),-23.5)
 assert.equal(referenceLevelDb([-23.5,-23.5,-23.5,-28.5]),-23.5,'one quiet voice does not move the reference')
 assert.equal(referenceLevelDb([-40,-40]),-26,'quiet calls clamp at -26');assert.equal(referenceLevelDb([-26,-26,-26]),-26)
 assert.equal(referenceLevelDb([0,-2,-4]),-14,'loud calls clamp at -14');assert.equal(referenceLevelDb([-14.5,-13.5]),-14)
 assert.equal(referenceLevelDb([-25.9,-25.9]),-25.9,'inside the range: not clamped')
})
test('voices far from the call reference adjust in correct directions with positive readiness',()=>{
 const f=fixture();f.run(0,-30);f.run(1,-10);f.run(0,-30)
 assert.equal(f.auto.targetDb,-20);assert.ok(f.people[0].value>1);assert.ok(f.people[1].value<1)
 for(const w of f.writes){assert.ok(Math.abs(gainDb(w.to/w.from))<=AUTO_STEP_DB+1e-7);assert.deepEqual(w.o,{automatic:true})}
})
for(const [db,dir] of [[-30,1],[-10,-1]]) test(`a single speaker at ${db} dB is corrected slowly toward the -20 dB default`,()=>{
 const f=fixture([1]);assert.equal(f.auto.targetDb,null,'learning until a voice is confidently measured')
 f.run(0,db,59);assert.equal(f.writes.length,0,'no write before supported qualification')
 f.run(0,db,200)
 assert.equal(f.auto.targetDb,-20);assert.ok(f.writes.length>0)
 for(const w of f.writes)assert.ok(Math.abs(gainDb(w.to/w.from)-dir*AUTO_STEP_DB)<1e-10,'only fixed-size steps in the right direction')
})
for(const db of [-20.9,-20,-19.1]) test(`a voice within 1 dB of the call reference (${db} dB) is untouched`,()=>{
 // Two voices at -20 dB hold the call median at -20 whatever the third measures.
 const f=fixture([1,1,1]);f.run(1,-20);f.run(2,-20);f.run(0,db,400)
 assert.equal(f.auto.targetDb,-20);assert.equal(f.writes.length,0);assert.deepEqual(f.people.map(p=>p.value),[1,1,1])
})
test('each person independently converges toward the call median (-20 dB) then stops at the deadband edge',()=>{
 // Median of -26 and -14 is -20; both are known before either is corrected.
 const f=fixture([1,1]);learn(f,[0,-26],[1,-14]);f.run(0,-26,400);f.run(1,-14,400)
 assert.equal(f.auto.targetDb,-20)
 const at0=f.writes.filter(w=>w.key==='0').length,at1=f.writes.filter(w=>w.key==='1').length
 assert.ok(gainDb(f.people[0].value)>=6-AUTO_DEADBAND_DB-1e-9&&gainDb(f.people[0].value)<=6-AUTO_DEADBAND_DB+AUTO_STEP_DB+1e-9,String(gainDb(f.people[0].value)))
 assert.ok(gainDb(f.people[1].value)<=-(6-AUTO_DEADBAND_DB)+1e-9&&gainDb(f.people[1].value)>=-(6-AUTO_DEADBAND_DB)-AUTO_STEP_DB-1e-9,String(gainDb(f.people[1].value)))
 f.run(0,-26,300);f.run(1,-14,300)
 assert.equal(f.writes.filter(w=>w.key==='0').length,at0,'no chasing inside the deadband')
 assert.equal(f.writes.filter(w=>w.key==='1').length,at1)
})
for(const loud of [-30,-20]) test('a voice already at the call reference stays at 100% while a preboosted voice is reduced '+loud,()=>{
 // Two unity voices at -20 dB set the reference; the 6x voice is too loud
 // after its gain whatever its microphone level.
 const f=fixture([1,6,1]);f.run(0,-20);f.run(2,-20);f.run(1,loud);f.run(0,-20)
 assert.equal(f.auto.targetDb,-20);assert.equal(f.people[0].value,1);assert.equal(f.people[2].value,1);assert.ok(f.people[1].value<6)
})
test('learning order, third entrant and off/on retained automatic values do not move the call reference',()=>{
 const f=fixture([1,6,1]);f.run(1,-20);f.run(0,-20);f.run(2,-21)
 assert.equal(f.auto.targetDb,-20);assert.equal(f.people[0].value,1);assert.equal(f.people[2].value,1);assert.ok(f.people[1].value<6)
 f.auto.stop();f.auto.start(f.now);f.run(1,-20);f.run(0,-20)
 assert.equal(f.auto.targetDb,-20);assert.equal(f.people[0].value,1)
})
test('voices whose current gain already gives the call reference are kept; mute never unmuted',()=>{
 // Three unity voices at -20 dB set the reference (pre-gain median of
 // -20,-20,-20,-26,-35.5 is -20); 2x and 6x already bring the other two
 // microphones to -20 dB effective. The muted voice is never measured.
 const f=fixture([2,6,0,1,1,1]);f.run(3,-20);f.run(4,-20);f.run(5,-20);f.run(0,-26);f.run(1,-35.5);f.run(2,-10)
 assert.equal(f.auto.targetDb,-20);assert.equal(f.writes.length,0);assert.equal(f.people[2].value,0)
 const muted=fixture([0]);muted.run(0,-40,400)
 assert.equal(muted.auto.targetDb,null);assert.equal(muted.writes.length,0);assert.equal(muted.people[0].value,0)
})
for(const modulation of [13,20]) test(`ordinary alternating ${modulation}dB phrasing is held after positive ready gate; sustained change eventually adjusts`,()=>{
 const f=fixture();f.run(0,-20);f.run(1,-20);assert.equal(f.auto.targetDb,-20)
 for(let i=0;i<10;i++)f.run(0,-20+(i%2?-1:1)*modulation/2,15)
 assert.equal(f.people[0].value,1);assert.equal(f.writes.length,0)
 f.run(0,-35,220);assert.ok(f.people[0].value>1)
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
 f.auto.start(f.now);f.run(0,-30,30);assert.equal(f.auto.targetDb,null,'pre-enable history is not fresh confidence');assert.equal(f.writes.length,0)
 f.run(1,-20);assert.equal(f.auto.targetDb,-20);assert.equal(f.writes.length,0);assert.equal(f.people[0].value,1)
 // Group-call turn-taking: silence alone keeps evidence within the horizon.
 f.meter.tick({now:f.now+31000,participantKeys:['0','1'],readPower:()=>0});assert.equal(f.meter.levelFor('0').autoDb,-30)
 f.meter.tick({now:f.now+AUTO_HORIZON_MS+1000,participantKeys:['0','1'],readPower:()=>0});assert.equal(f.meter.levelFor('0').autoDb,null)
})
test('retained automatic gains do not ratchet the call reference and keep correcting from the retained value',()=>{
 const f=fixture();f.run(0,-30);f.run(1,-10);f.run(0,-30)
 assert.equal(f.auto.targetDb,-20);assert.ok(f.writes.length>0)
 const retained=f.people.map(p=>p.value)
 f.auto.stop();assert.equal(f.auto.targetDb,null);assert.deepEqual(f.people.map(p=>p.value),retained,'stopping keeps current volumes')
 f.auto.start(f.now);f.run(0,-30,130);f.run(1,-10,130)
 assert.equal(f.auto.targetDb,-20);assert.equal(f.people[0].value,retained[0],"already within the deadband: kept");assert.ok(f.people[1].value<retained[1],"still too loud: keeps reducing")
})
test('a manual value that already gives the call reference is kept after Auto restarts',()=>{
 const f=fixture();f.run(0,-30);f.run(1,-10);f.run(0,-30);assert.ok(f.writes.length>0)
 f.auto.stop();f.people[0].value=10**(10/20);f.people[1].value=10**(-10/20);const n=f.writes.length
 f.auto.start(f.now);f.run(0,-30,200);f.run(1,-10,200)
 assert.equal(f.auto.targetDb,-20);assert.equal(f.writes.length,n)
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
 const speech=(period,phase)=>i=>i%23>=20?null:-20+modulation/2*Math.sin((i+phase)*2*Math.PI/period)
 f.run(0,speech(7,0),180)
 let a=f.meter.levelFor('0')
 assert.ok(a.autoPortions>=3&&a.autoSpread<=4&&Number.isFinite(a.autoDb),JSON.stringify(a))
 f.run(1,speech(11,3),180)
 let b=f.meter.levelFor('1')
 assert.ok(b.autoPortions>=3&&b.autoSpread<=4&&Number.isFinite(b.autoDb),JSON.stringify(b))
 assert.equal(f.auto.targetDb,-20,'positive readiness, not abstention')
 f.run(0,speech(7,2),180);f.run(1,speech(11,1),180)
 assert.deepEqual(f.people.map(p=>p.value),[1,1]);assert.equal(f.writes.length,0)
 // Same articulation at a genuinely new microphone level must eventually act.
 f.run(0,i=>-32+modulation/2*Math.sin(i*2*Math.PI/7),240)
 assert.ok(f.people[0].value>1,'sustained quiet shift must not freeze')
})

test('confidence uses completed portions; a brief disagreeing portion is an outlier; evidence survives turn gaps',()=>{
 const meter=createParticipantLevelMeter({settleMs:0})
 const add=(from,count,db)=>{for(let i=0;i<count;i++)meter.tick({now:from+i*100,participantKeys:['x'],attributedKey:'x',readPower:()=>10**(db/10)})}
 add(0,80,-30)
 assert.equal(meter.levelFor('x').autoPortions,4);assert.equal(meter.levelFor('x').autoSpread,0)
 add(8000,19,-20)
 assert.equal(meter.levelFor('x').autoPortions,4,'partial portion is not a fresh confidence vote')
 assert.equal(meter.levelFor('x').autoSpread,0)
 add(9900,1,-20)
 assert.equal(meter.levelFor('x').autoPortions,5)
 assert.equal(meter.levelFor('x').autoDb,-30,'one brief disagreeing portion is a minority outlier, not a new level')
 assert.equal(meter.levelFor('x').autoInlierPortions,4)
 add(26000,1,-30)
 assert.equal(meter.levelFor('x').autoFrames,101,'another speaker\'s turn or a pause does not discard evidence')
 assert.equal(meter.levelFor('x').autoDb,-30)
 // A sustained change is no longer a minority: the stale old level is never
 // reported; the new level takes over as old evidence rolls out.
 add(30000,60,-20)
 assert.notEqual(meter.levelFor('x').autoDb,-30,'sustained new speech must not keep the stale level')
 add(40000,120,-20)
 assert.equal(meter.levelFor('x').autoDb,-20)
 add(40000+AUTO_HORIZON_MS+15000,1,-20)
 assert.equal(meter.levelFor('x').autoFrames,1,'evidence older than the horizon expires')
})

test('rapid correlated frames and a single phonetic/cough burst cannot seed confidence or writes',()=>{
 const meter=createParticipantLevelMeter({sampleMs:0,settleMs:0})
 for(let now=0;now<120;now++)meter.tick({now,participantKeys:['x'],attributedKey:'x',readPower:()=>10**(-20/10)})
 assert.equal(meter.levelFor('x').autoDb,null,'120 near-simultaneous observations are not independent speech portions')
 const cough=fixture();cough.run(0,-5,12)
 assert.equal(cough.auto.targetDb,null);assert.equal(cough.writes.length,0)
 const f=fixture();f.run(0,-20);f.run(1,-5,12)
 assert.equal(f.auto.targetDb,-20);assert.equal(f.writes.length,0)
 f.run(1,-20,120);assert.equal(f.writes.length,0)
 f.run(0,-5,4);assert.equal(f.writes.length,0,'one short cough cannot change an established level')
})

test('persistent quiet/loud directions reverse and relearn after graph invalidation',()=>{
 const f=fixture();f.run(0,-30,130);f.run(1,-10,130);f.run(0,-30,130)
 assert.ok(f.people[0].value>1&&f.people[1].value<1)
 const before=f.people.map(p=>p.value)
 f.run(0,-10,240);f.run(1,-30,240)
 assert.ok(f.people[0].value<before[0]&&f.people[1].value>before[1])
 f.meter.reset();f.auto.invalidate(f.now)
 const n=f.writes.length
 f.run(0,-30,59);assert.equal(f.writes.length,n);assert.equal(f.auto.targetDb,null)
 const restart=f.people.map(p=>p.value)
 f.run(0,-30,80);f.run(1,-10,130);f.run(0,-30,130)
 assert.equal(f.auto.targetDb,-20)
 assert.ok(f.people[0].value>restart[0]&&f.people[1].value<restart[1])
})

test('a raised or lowered target moves voices toward the new level without discarding measurements',()=>{
 // A second voice at -20 dB makes this a call (1 dB tolerance), so the
 // +2.9 dB (140%) offset is beyond tolerance for voice 0.
 const f=fixture([1,1]);f.run(1,-20,130);f.run(0,-20,200)
 assert.equal(f.auto.targetDb,-20);assert.equal(f.writes.length,0)
 f.auto.setTargetOffset(20*Math.log10(1.4))
 assert.ok(Math.abs(f.auto.targetDb-(-20+20*Math.log10(1.4)))<1e-9,'target follows the user level immediately')
 f.run(0,-20,400)
 assert.ok(f.writes.length>0&&f.writes.every(w=>w.to>w.from&&w.key==='0'),'boosts toward the higher target')
 const n=f.writes.length;f.auto.setTargetOffset(0);f.run(0,-20,400)
 assert.ok(f.writes.slice(n).every(w=>w.to<w.from),'then reduces after lowering it back')
})
test('target offset applies once Auto has measured a first voice, also after an invalidation',()=>{
 const f=fixture([1]);f.auto.setTargetOffset(-3);assert.equal(f.auto.targetDb,null)
 f.run(0,-20,200);assert.equal(f.auto.targetDb,-23)
 f.auto.invalidate(f.now);assert.equal(f.auto.targetDb,null)
})

// Owner report (2.7.0): every voice arrived ~3.5 dB below -20 dB and the fixed
// target boosted everyone although only one person was quiet. The reference is
// now the call's median voice, so a shift shared by everyone moves nobody.
for(const count of [3,4]) for(const order of ['quiet speaks last','all learned first, quiet first']) test(`shift invariance: ${count} voices ~3.5 dB below -20, one 5 dB quieter (${order}) -> only the quiet one is boosted`,()=>{
 const levels=[...Array(count-1).fill(-23.5),-28.5],quiet=String(count-1)
 const f=fixture(levels.map(()=>1))
 if(order==='quiet speaks last')for(let i=0;i<count;i++)f.run(i,levels[i])
 else learn(f,[count-1,-28.5],...levels.slice(0,-1).map((db,i)=>[i,db]))
 f.run(count-1,-28.5,400)
 for(let i=0;i<count-1;i++)f.run(i,-23.5,300)
 assert.ok(Math.abs(f.auto.targetDb-(-23.5))<1e-6,String(f.auto.targetDb))
 assert.ok(f.writes.length>0&&f.writes.every(w=>w.key===quiet&&w.to>w.from),JSON.stringify(f.writes.slice(0,3)))
 assert.deepEqual(f.people.slice(0,-1).map(p=>p.value),Array(count-1).fill(1),'typical voices untouched (the fixed -20 dB target would have boosted all of them ~2.5 dB)')
 // 5 dB below the call: stops at the 1 dB deadband edge, i.e. a 4 dB boost.
 const g=gainDb(f.people[count-1].value)
 assert.ok(g>=4-1e-9&&g<=4+AUTO_STEP_DB+1e-9,String(g))
 const n=f.writes.length;f.run(count-1,-28.5,300);assert.equal(f.writes.length,n,'no chasing inside the deadband')
})
for(const db of [-23.9,-20,-16.1]) test(`a lone voice within the 4 dB lone-voice tolerance of -20 dB (${db} dB) is untouched`,()=>{
 const f=fixture([1]);f.run(0,db,600)
 assert.equal(f.auto.targetDb,-20);assert.equal(f.writes.length,0);assert.equal(f.people[0].value,1)
})
for(const [db,dir] of [[-30,1],[-10,-1]]) test(`a lone voice at ${db} dB is corrected only to the 4 dB lone-voice tolerance edge`,()=>{
 const f=fixture([1]);f.run(0,db,500)
 assert.equal(f.auto.targetDb,-20)
 const g=dir*gainDb(f.people[0].value)
 // 10 dB off; correction stops once within 4 dB: a 6 dB move (+ one step).
 assert.ok(g>=10-AUTO_SOLO_TOLERANCE_DB-1e-9&&g<=10-AUTO_SOLO_TOLERANCE_DB+AUTO_STEP_DB+1e-9,String(g))
 for(const w of f.writes)assert.ok(Math.abs(gainDb(w.to/w.from)-dir*AUTO_STEP_DB)<1e-10)
 const n=f.writes.length;f.run(0,db,300);assert.equal(f.writes.length,n,'no chasing inside the lone-voice tolerance')
})
test('the user target offset applies on top of the call reference',()=>{
 const f=fixture([1,1,1]);learn(f,[0,-24],[1,-24],[2,-24])
 assert.ok(Math.abs(f.auto.targetDb-(-24))<1e-6,'the call sits at -24 dB, which is its own reference')
 f.auto.setTargetOffset(-3);assert.ok(Math.abs(f.auto.targetDb-(-27))<1e-6,String(f.auto.targetDb))
 for(let i=0;i<3;i++)f.run(i,-24,400)
 assert.ok(Math.abs(f.auto.targetDb-(-27))<1e-6,'reference uses levels before the user volumes, so lowering does not ratchet')
 for(const p of f.people){const g=gainDb(p.value);assert.ok(g<=-2+1e-9&&g>=-2-AUTO_STEP_DB-1e-9,String(g))}
 assert.ok(f.writes.every(w=>w.to<w.from))
 f.auto.setTargetOffset(3);assert.ok(Math.abs(f.auto.targetDb-(-21))<1e-6,String(f.auto.targetDb))
 const n=f.writes.length;for(let i=0;i<3;i++)f.run(i,-24,600)
 assert.ok(f.writes.slice(n).length>0&&f.writes.slice(n).every(w=>w.to>w.from))
 for(const p of f.people){const g=gainDb(p.value);assert.ok(g>=2-1e-9&&g<=2+AUTO_STEP_DB+1e-9,String(g))}
 // On a clamped reference too: a very quiet call (-30 dB) uses -26 dB, plus the offset.
 const q=fixture([1,1]);q.auto.setTargetOffset(2);learn(q,[0,-30],[1,-30])
 assert.ok(Math.abs(q.auto.targetDb-(-24))<1e-6,String(q.auto.targetDb))
})
test('a quiet voice stays in the call reference after its evidence goes stale; departure prunes it; invalidation clears it',()=>{
 const f=fixture([1,1,1]);learn(f,[0,-20],[1,-24],[2,-30])
 assert.ok(Math.abs(f.auto.targetDb-(-24))<1e-6,'median of -20, -24 and -30')
 // Only voices 0 and 1 speak for longer than the 180 s evidence horizon.
 for(let i=0;i<10;i++){f.run(0,-20,100);f.run(1,-24,100)}
 assert.equal(f.meter.levelFor('2').autoDb,null,'the quiet voice is no longer ready')
 assert.ok(Math.abs(f.auto.targetDb-(-24))<1e-6,'but its last confident level still counts: '+f.auto.targetDb)
 // Voice 0 is 4 dB above the reference and stops at the 1 dB edge (-3 dB);
 // without the quiet voice the reference would be -22 and it would stop at -1 dB.
 const g=gainDb(f.people[0].value)
 assert.ok(g<=-3+1e-9&&g>=-3-AUTO_STEP_DB-1e-9,String(g))
 assert.ok(f.writes.every(w=>w.key==='0'&&w.to<w.from))
 // A compatible native gain change keeps the known levels.
 f.auto.invalidate(f.now,{reason:'compatible-native-gain'})
 assert.ok(Math.abs(f.auto.targetDb-(-24))<1e-6)
 f.run(0,-20,130);assert.ok(Math.abs(f.auto.targetDb-(-24))<1e-6,'known levels survive a compatible change')
 // Departure prunes the person from the reference: mean of -20 and -24.
 f.people.splice(2,1);f.run(0,-20,5);assert.ok(Math.abs(f.auto.targetDb-(-22))<1e-6,String(f.auto.targetDb))
 // Graph invalidation discards every known level: voice 0 is a lone voice again.
 f.auto.invalidate(f.now);assert.equal(f.auto.targetDb,null)
 const n=f.writes.length
 f.run(0,-20,59);assert.equal(f.auto.targetDb,null,'no reference before fresh evidence')
 f.run(0,-20,200)
 assert.equal(f.auto.targetDb,-20,'voice 1 is not retained across invalidation')
 assert.equal(f.writes.length,n,'about -23 dB after its gain: inside the lone-voice tolerance')
 f.run(1,-24,130);assert.ok(Math.abs(f.auto.targetDb-(-22))<1e-6,'voice 1 rejoins only from fresh evidence')
 f.auto.stop();assert.equal(f.auto.targetDb,null)
 f.auto.start(f.now);f.run(0,-20,100);assert.equal(f.auto.targetDb,-20,'stop clears known levels')
})
