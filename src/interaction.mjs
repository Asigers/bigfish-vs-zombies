export class InteractionDirector {
  constructor() { this.poll=null;this.messageIds=new Set();this.questions=[]; }
  open({id,options,now=Date.now(),durationMs=12000}) {
    if(this.poll) throw Error("poll_open");
    if(!Array.isArray(options)||options.length<2||options.length>4||
      options.some(o=>!o.id||!o.label))throw Error("bad_options");
    this.poll={id,options,endAt:now+durationMs,votes:new Map()};
  }
  comment({messageId,userId,content},now=Date.now()) {
    if(!messageId||!userId||typeof content!=="string")return "invalid";
    if(this.messageIds.has(messageId))return "duplicate";
    this.messageIds.add(messageId);
    if(this.messageIds.size>4096)this.messageIds.delete(this.messageIds.values().next().value);
    const text=content.trim().slice(0,120);
    const p=this.poll;
    if(p&&now<p.endAt&&/^[1-4]$/.test(text)) {
      const option=p.options[Number(text)-1];
      if(!option)return "ignored";
      if(p.votes.has(userId))return "already_voted";
      p.votes.set(userId,option.id);
      return "voted";
    }
    if(/^(鱼|大肥鱼)[：:,，]?/.test(text)&&this.questions.length<32){
      this.questions.push(text);return "question";
    }
    return "ignored";
  }
  summary() {
    if(!this.poll)return null;
    const p=this.poll, values=[...p.votes.values()];
    return {id:p.id,endAt:p.endAt,total:values.length,
      options:p.options.map(o=>({...o,votes:values.filter(v=>v===o.id).length}))};
  }
  close(now=Date.now()){
    if(!this.poll||now<this.poll.endAt)return null;
    const result=this.summary();this.poll=null;
    const ranked=[...result.options].sort((a,b)=>b.votes-a.votes);
    return {...result,winner:result.total?ranked[0].id:null};
  }
}
