import {randomUUID} from "node:crypto";
import {validateAction} from "./policy.mjs";

/** Intended for an embedded native PvZ game-thread bridge on 127.0.0.1.
 * A live server is not provided by PvZ-Portable out of the box.
 */
export class PvzBridgeClient {
  constructor({url="http://127.0.0.1:45941",token}={}) {
    const parsed=new URL(url);
    if(parsed.hostname!=="127.0.0.1"&&parsed.hostname!=="localhost")throw Error("Bridge must be localhost only");
    if(!token)throw Error("Bridge token required");
    this.url=parsed.origin;this.token=token;
  }
  async request(path,method="GET",body) {
    const headers={"authorization":"Bearer "+this.token};
    if(body)headers["content-type"]="application/json";
    const response=await fetch(this.url+path,{
      method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(3000)
    });
    if(!response.ok)throw Error("Bridge HTTP "+response.status);
    return response.json();
  }
  async snapshot(){return this.request("/snapshot");}
  async execute(state,action,challenge={}) {
    const issue=validateAction(state,action,challenge);
    if(issue)throw Error("Rejected: "+issue);
    const commandId=randomUUID();
    // Do not retry on timeouts: command may have been executed natively.
    const receipt=await this.request("/command","POST",{commandId,action});
    if(receipt.commandId!==commandId)throw Error("Receipt identity mismatch");
    const after=await this.snapshot();
    if(after.gameId!==state.gameId||after.revision<=state.revision)
      throw Error("Ambiguous action: require manual state reconciliation");
    if(receipt.status!=="applied")throw Error("Native action was not applied");
    const confirmed=action.type==="plant"
      ?(after.plants||[]).some(p=>p.row===action.row&&p.col===action.col&&p.type===action.plant)
      :action.type==="collect_sun" ?!(after.suns||[]).some(s=>s.id===action.id):false;
    if(!confirmed)throw Error("Action not confirmed in fresh game state");
    return {receipt,after};
  }
}
