// Normalize comment notifications received from an approved Douyin live-play gateway.
// The upstream gateway must authenticate official callbacks and verify their origin.
export function douyinCommentBatch(headers,rawBody){
  if(headers["x-msg-type"]!=="live_comment")return [];
  const data=JSON.parse(rawBody);
  if(!Array.isArray(data))throw Error("invalid_payload");
  return data.slice(0,500).filter(x=>typeof x.msg_id==="string"&&
    typeof x.sec_openid==="string"&&typeof x.content==="string")
    .map(x=>({platform:"douyin",messageId:x.msg_id,userId:x.sec_openid,
      content:x.content.slice(0,200),timestamp:Number(x.timestamp)||0}));
}
