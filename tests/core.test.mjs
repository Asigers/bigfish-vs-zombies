import test from "node:test";
import assert from "node:assert/strict";
import {viewForModel,validateAction,candidates,chooseModelAction} from "../src/policy.mjs";
import {InteractionDirector} from "../src/interaction.mjs";
import {douyinCommentBatch} from "../src/douyin-events.mjs";
const s={gameId:"g1",revision:1,level:1,wave:2,sun:150,status:"playing",
  rows:5,columns:9,cards:[{type:"peashooter",cost:100,ready:true},
    {type:"sunflower",cost:50,ready:true}],
  zombies:[{type:"normal",row:3,x:500,hp:100}],
  plants:[{type:"sunflower",row:2,col:2}],blocked:[],suns:[]};
test("LLM projection hides internal future waves",()=>{
  assert.equal("hiddenWaves" in viewForModel({...s,hiddenWaves:["boss"]}),false);
});
test("actions are checked against current state",()=>{
  const a={type:"plant",plant:"peashooter",row:3,col:3,gameId:"g1",revision:1};
  assert.equal(validateAction(s,a),null);
  assert.equal(validateAction(s,{...a,revision:0}),"stale_state");
  assert.equal(validateAction(s,{...a,row:6}),"out_of_bounds");
  assert.equal(validateAction(s,{...a,row:2,col:2}),"occupied");
  assert.equal(validateAction(s,a,{bannedPlants:["peashooter"]}),"challenge_ban");
  assert.ok(candidates(s).length>0);
  assert.equal(validateAction(s,chooseModelAction(s,'{"index":0}')),null);
  assert.throws(()=>chooseModelAction(s,'{"index":999}'));
});
test("audience votes are deduplicated by message and user",()=>{
  const d=new InteractionDirector();
  d.open({id:"p1",options:[{id:"a",label:"防御"},{id:"b",label:"攒钱"}],durationMs:1000,now:100});
  assert.equal(d.comment({messageId:"m1",userId:"u1",content:"1"},200),"voted");
  assert.equal(d.comment({messageId:"m1",userId:"u1",content:"2"},210),"duplicate");
  assert.equal(d.comment({messageId:"m2",userId:"u1",content:"2"},220),"already_voted");
  assert.equal(d.close(500),null);
  assert.equal(d.close(1100).winner,"a");
  d.open({id:"p2",options:[{id:"a",label:"A"},{id:"b",label:"B"}],durationMs:1,now:2000});
  assert.equal(d.close(2001).winner,null);
});
test("approved Douyin comment payload is normalized",()=>{
  const b=douyinCommentBatch({"x-msg-type":"live_comment"},JSON.stringify([
    {msg_id:"m1",sec_openid:"u1",content:"1"}, {msg_id:"m2",content:"ignored"}
  ]));
  assert.equal(b.length,1);assert.equal(b[0].platform,"douyin");
});
