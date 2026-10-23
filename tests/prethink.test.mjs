import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePrethinkRequest,makePrethinkPrompt,compilePrethink,generatePrethink} from '../server/prethink.mjs';
import {createPrethinkServer} from '../server/prethink-server.mjs';

const request=(extra={})=>({clientId:'test',requestId:'one',version:1,mode:'cues',variant:'baseline',goal:'选住宿，重视通勤',rounds:[],...extra});

test('prethinking preserves original goal and user association without promoting selected guesses to facts',()=>{
  const value=validatePrethinkRequest(request({rounds:[{selected:[{label:'途中安排',hint:'可能还要接送或办事'}],note:'只有周三要先送孩子'}]}));
  const prompt=makePrethinkPrompt(value);
  assert.ok(prompt.includes(value.goal));assert.ok(prompt.includes('只有周三要先送孩子'));assert.ok(prompt.includes('不是已经证实的事实'));
  assert.throws(()=>validatePrethinkRequest(request({version:-1})));assert.throws(()=>validatePrethinkRequest(request({rounds:[{selected:[],note:'x'.repeat(3000)}]})));
});

test('cues have no answer field; more than three distinct directions survive',()=>{
  const options=Array.from({length:9},(_,i)=>({label:`方向${i}`,hint:`关联${i}`}));
  const result=compilePrethink({options:[...options,options[0]],answer:'premature answer'},'cues');
  assert.equal(result.options.length,9);assert.equal(result.answer,undefined);
  assert.throws(()=>compilePrethink({options:[{label:'missing hint'}]},'cues'));
  assert.deepEqual(compilePrethink({options:[]},'cues'),{options:[]});
});

test('generator separates fast cues from requested answer and passes feedback to answer model',async()=>{
  const calls=[];const transport=async value=>{calls.push(value);return {value:calls.length===1?{options:[{label:'途中安排',hint:'通勤可能包括接送'}]}:{answer:'周三考虑接送路线，其余日子直接通勤。',usedAssociations:['周三接送：分开比较路线。']},metrics:{firstTextMs:5}};};
  const cue=await generatePrethink(request(),{transport});assert.equal(cue.answer,undefined);assert.equal(calls[0].reasoning,'none');
  const result=await generatePrethink(request({mode:'answer',rounds:[{selected:[],note:'周三送孩子'}]}),{transport});
  assert.equal(calls[1].reasoning,'low');assert.ok(calls[1].prompt.includes('周三送孩子'));assert.equal(result.options,undefined);assert.ok(result.usedAssociations.length);
});

test('scoped requests retain earlier context while latest free association can cross the selected topic',()=>{
  const earlier={selected:[{label:'通勤',hint:'日常往返的负担'}],note:'周一早上七点前到公司'};
  const latest={selected:[],note:'晚上还得照顾家人，睡不好会影响第二天'};
  const value=validatePrethinkRequest(request({variant:'scoped',rounds:[earlier,latest]}));
  assert.equal(value.variant,'scoped');
  assert.equal(validatePrethinkRequest(request({variant:undefined})).variant,'baseline');
  const prompt=makePrethinkPrompt(value);
  const context=JSON.parse(prompt.slice(prompt.lastIndexOf('任务数据：')+'任务数据：'.length));
  assert.deepEqual(context,{goal:value.goal,earlierRounds:[earlier],currentFocus:latest});
  assert.throws(()=>validatePrethinkRequest(request({variant:'unknown'})));
});

test('scope is validated as display output and never becomes an answer constraint',async()=>{
  const calls=[];
  const transport=async value=>{calls.push(value);return {value:{scope:'考虑照护与休息怎样影响选址',options:[{label:'夜间照护',hint:'家中安排可能改变住处选择'}]},metrics:{}};};
  const cue=await generatePrethink(request({variant:'scoped'}),{transport});
  assert.equal(calls.length,1);assert.equal(calls[0].reasoning,'none');assert.ok(calls[0].schema.required.includes('scope'));
  assert.equal(cue.scope,'考虑照护与休息怎样影响选址');assert.equal(cue.variant,'scoped');
  assert.throws(()=>compilePrethink({options:[]},'cues','scoped'));
  const untrustedRound={selected:[],note:'家人需要照护',scope:'必须只考虑交通'};
  const scopedAnswer=validatePrethinkRequest(request({variant:'scoped',mode:'answer',rounds:[untrustedRound]}));
  const baselineAnswer={...scopedAnswer,variant:'baseline'};
  assert.equal(makePrethinkPrompt(scopedAnswer),makePrethinkPrompt(baselineAnswer));
  assert.ok(!makePrethinkPrompt(scopedAnswer).includes('必须只考虑交通'));
  assert.equal(compilePrethink({scope:'ignored',options:[]},'cues','baseline').scope,undefined);
});

async function withServer(generate,run){const server=createPrethinkServer({generate});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;try{await run(base);}finally{await new Promise(resolve=>server.close(resolve));}}
const post=(base,path,body,extra={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(body)});

test('server rejects stale input and hostile origins without spending model calls',async()=>{
  let calls=0;await withServer(async r=>{calls++;return {requestId:r.requestId,version:r.version,mode:r.mode,options:[],metrics:{elapsedMs:0}};},async base=>{
    assert.equal((await post(base,'/api/prethink',request(),{Origin:'https://unrelated.example'})).status,403);
    assert.equal((await post(base,'/api/prethink',request({goal:''}))).status,400);
    assert.equal(calls,0);assert.equal((await post(base,'/api/prethink',request())).status,200);
    assert.equal((await post(base,'/api/prethink',request())).status,409);assert.equal(calls,1);
  });
});

test('cancel aborts pending model request and late output cannot replace it',async()=>{
  let started;const ready=new Promise(resolve=>started=resolve);
  await withServer(async(r,{signal})=>{started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));},async base=>{
    const pending=post(base,'/api/prethink',request());await ready;
    const canceled=await post(base,'/api/cancel',request());assert.equal(canceled.status,200);
    assert.equal((await pending).status,409);
  });
});

test('provider exception details do not leak to client',async()=>{
  await withServer(async()=>{throw new Error('SECRET_PROVIDER_DETAILS');},async base=>{
    const response=await post(base,'/api/prethink',request());assert.equal(response.status,502);assert.ok(!(await response.text()).includes('SECRET'));
  });
});
