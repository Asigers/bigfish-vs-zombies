export function viewForModel(s) {
  return {
    gameId:s.gameId,revision:s.revision,level:s.level,wave:s.wave,sun:s.sun,
    rows:s.rows,columns:s.columns,
    plants:(s.plants||[]).map(p=>({type:p.type,row:p.row,col:p.col})),
    zombies:(s.zombies||[]).map(z=>({type:z.type,row:z.row,x:z.x,hp:z.hp})),
    cards:(s.cards||[]).map(c=>({type:c.type,cost:c.cost,ready:c.ready})),
    suns:(s.suns||[]).map(x=>({id:x.id,x:x.x,y:x.y}))
  };
}
export function validateAction(s,a,challenge={}) {
  if(!s||!a||a.gameId!==s.gameId||a.revision!==s.revision) return "stale_state";
  if(s.status!=="playing") return "not_playing";
  if(a.type==="collect_sun")
    return (s.suns||[]).some(x=>x.id===a.id)?null:"sun_missing";
  if(a.type!=="plant") return "unsupported_action";
  if(!Number.isInteger(a.row)||!Number.isInteger(a.col)||
     a.row<1||a.row>s.rows||a.col<1||a.col>s.columns) return "out_of_bounds";
  if((s.plants||[]).some(p=>p.row===a.row&&p.col===a.col)) return "occupied";
  if((s.blocked||[]).some(p=>p.row===a.row&&p.col===a.col)) return "blocked";
  if((challenge.bannedPlants||[]).includes(a.plant)) return "challenge_ban";
  const card=(s.cards||[]).find(c=>c.type===a.plant);
  if(!card) return "missing_card";
  if(!card.ready) return "cooldown";
  if(typeof card.cost!=="number"||card.cost>s.sun) return "insufficient_sun";
  return null;
}
export function candidates(s,challenge={}) {
  if(s.status!=="playing") return [];
  const out=[];
  for(const sun of (s.suns||[]).slice(0,3))
    out.push({type:"collect_sun",id:sun.id,gameId:s.gameId,revision:s.revision});
  const rows=[...new Set([...(s.zombies||[]).sort((a,b)=>a.x-b.x).map(z=>z.row),
    ...Array.from({length:s.rows},(_,i)=>i+1)])];
  for(const row of rows) {
    for(const plant of ["peashooter","wallnut","sunflower"]) {
      for(let col=2;col<=Math.min(5,s.columns);col++) {
        const a={type:"plant",plant,row,col,gameId:s.gameId,revision:s.revision};
        if(!validateAction(s,a,challenge)){out.push(a);break;}
      }
    }
    if(out.length>=10)break;
  }
  return out.slice(0,10);
}
export function chooseModelAction(s,modelText,challenge={}) {
  const options=candidates(s,challenge);
  const choice=JSON.parse(String(modelText).trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""));
  if(!Number.isInteger(choice.index)||!options[choice.index]) throw Error("bad_choice");
  const action=options[choice.index];
  if(validateAction(s,action,challenge)) throw Error("stale_or_illegal");
  return action;
}
