/* BigFish's independent Live2D renderer. Upstream model/runtime installed separately. */
(() => {
  "use strict";
  const root=document.querySelector("#avatar");
  const container=document.querySelector("#live2d-canvas");
  const missing=document.querySelector("#missing");
  const caption=document.querySelector("#speech");
  const identity=document.querySelector("#identity");
  const query=new URLSearchParams(location.search);
  const preview=query.get("preview")==="1";
  const expressionByEmotion=Object.freeze({
    idle:null,happy:"开心兴奋",excited:"星星眼",thinking:"问号",
    tired:"闭眼口水",sad:"悲伤",surprised:"感叹号"
  });
  const motionByEmotion=Object.freeze({
    excited:"splash",happy:"aidale",thinking:"selfieQuick",tired:"bubble",surprised:"splash"
  });
  const known=new Set(Object.keys(expressionByEmotion));
  let app,model,core,manifest,closed=false;
  let speakingUntil=0,expression="idle",timer;
  let speechPhase=0;
  function status(message){
    missing.hidden=false;
    missing.querySelector("strong").textContent=message;
  }
  async function script(src){
    return await new Promise((resolve,reject)=>{
      const el=document.createElement("script");el.src=src;el.async=false;
      el.onload=()=>resolve();el.onerror=()=>reject(new Error("Failed to load "+src));
      document.head.appendChild(el);
    });
  }
  async function initialize(){
    const response=await fetch("/overlay/assets/status",{cache:"no-store"});
    if(!response.ok)throw Error("Live2D status unavailable");
    const state=await response.json();
    if(!state.installed){status("Live2D 模型尚未安装");return;}
    await script("/overlay/assets/vendor/live2dcubismcore.min.js");
    await script("/overlay/assets/vendor/pixi.min.js");
    await script("/overlay/assets/vendor/cubism4.min.js");
    if(!window.PIXI?.live2d?.Live2DModel)throw Error("Cubism4 adapter unavailable");
    const {Live2DModel}=PIXI.live2d;
    Live2DModel.registerTicker(PIXI.Ticker);
    const mresponse=await fetch("/overlay/assets/model/manifest.json");
    if(!mresponse.ok)throw Error("Model expression catalog unavailable");
    manifest=await mresponse.json();
    const width=container.clientWidth||480,height=container.clientHeight||435;
    app=new PIXI.Application({
      width,height,backgroundAlpha:0,antialias:true,resolution:Math.min(window.devicePixelRatio||1,1.5),
      autoDensity:true,powerPreference:"low-power",
    });
    app.ticker.maxFPS=30;
    container.appendChild(app.view);
    model=await Live2DModel.from("/overlay/assets/model/c_0120.model3.json",{
      autoInteract:false,autoUpdate:true,idleMotionGroup:"idle"
    });
    app.stage.addChild(model);
    core=model.internalModel.coreModel;
    const im=model.internalModel;
    const w=im.width||im.originalWidth||1,h=im.height||im.originalHeight||1;
    const zoom=Math.max(.4,Math.min(2.4,Number(query.get("zoom"))||1.0));
    const scale=Math.min(width*.95/w,height*.95/h)*zoom;
    model.scale.set(scale);
    model.anchor.set(.5,1);
    model.position.set(width/2,height*.98);
    im.on("beforeModelUpdate",rig);
    document.addEventListener("visibilitychange",()=>{
      if(!app)return;
      if(document.hidden)app.ticker.stop();else app.ticker.start();
    });
    window.addEventListener("pagehide",()=>{closed=true;app?.destroy(true);},{once:true});
    // Keep animation low power; no pixi event listeners/interactive hooks in the OBS view.
    missing.hidden=true;
    console.info("[BigFish Live2D] loaded",w,h,"zoom",zoom);
  }
  // Upstream expression files contain additive parameter offsets. Apply them only
  // in beforeModelUpdate, after Cubism motions/physics, to avoid sticky expressions.
  function rig(){
    if(!core||closed)return;
    const chosen=manifest?.expressions?.[expressionByEmotion[expression]];
    const args=chosen?.params||[];
    for(const param of args){
      try{
        if(typeof param.id==="string"&&Number.isFinite(param.value)){
          core.addParameterValueById(param.id,param.value*.7);
        }
      }catch{}
    }
    if(Date.now()<speakingUntil){
      speechPhase+=.14;
      try{core.addParameterValueById("ParamMouthOpenY",.24+.18*Math.sin(speechPhase*5));}catch{}
    }
  }
  function react(event){
    if(!event||typeof event!=="object")return;
    const emotion=known.has(event.emotion)?event.emotion:"idle";
    expression=emotion;
    root.dataset.emotion=emotion;
    root.dataset.speaking="true";
    caption.textContent=String(event.text||"").slice(0,120);
    identity.textContent="大肥鱼 · "+String(event.goal||"自主游戏中").slice(0,60);
    caption.classList.add("visible");
    speakingUntil=Date.now()+Math.min(11000,3500+caption.textContent.length*130);
    const motion=motionByEmotion[emotion];
    if(model&&motion&&manifest?.motions?.[motion]){
      try{model.motion(motion,0,3);}catch(error){console.warn("Motion failed",error);}
    }
    clearTimeout(timer);
    timer=setTimeout(()=>{
      speakingUntil=0;expression="idle";root.dataset.emotion="idle";
      root.dataset.speaking="false";caption.classList.remove("visible");
    },Math.min(11000,3500+caption.textContent.length*130));
  }
  const stream=new EventSource("/overlay/events");
  stream.addEventListener("speech",e=>{try{react(JSON.parse(e.data));}catch{}});
  stream.onopen=()=>{if(!caption.classList.contains("visible"))identity.textContent="大肥鱼 · 自主游戏中";};
  stream.onerror=()=>{identity.textContent="大肥鱼 · 等待连接";};
  initialize().catch(error=>{console.error("[BigFish Live2D]",error);status("Live2D 加载失败，请检查模型资源和浏览器控制台");});
  if(preview) {
    const examples=[
      {emotion:"happy",text:"庄稼都浇好水啦！",goal:"种田"},
      {emotion:"thinking",text:"让我想想，今天该去哪儿？",goal:"制定计划"},
      {emotion:"excited",text:"哇，今天的收成不错！",goal:"收获"},
      {emotion:"tired",text:"本鲸困了，回家睡觉。",goal:"休息"},
      {emotion:"surprised",text:"什么？礼物来啦！",goal:"互动"},
      {emotion:"sad",text:"走不动啦，这路被挡住了。",goal:"恢复"},
    ];
    let i=0;
    setTimeout(()=>react(examples[i++%examples.length]),2000);
    setInterval(()=>react(examples[i++%examples.length]),9000);
  }
})();
