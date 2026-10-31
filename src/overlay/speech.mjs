/**
 * Turns controller events into one short line for the Live2D host.
 * Only confirmed facts speak: a rejected or unverified action never claims
 * success on stream. Model-authored speech takes precedence over canned lines.
 */
const PLANT_SPEECH = Object.freeze({
  sunflower: "补个向日葵",
  peashooter: "上豌豆",
  snowpea: "寒冰射手就位",
  wallnut: "坚果顶住",
  repeater: "双发上膛",
  cherrybomb: "樱桃炸弹！",
  chomper: "大嘴花张嘴",
  potatomine: "土豆雷埋好"
})

const PLANT_EMOTION = Object.freeze({
  cherrybomb: "surprised",
  wallnut: "thinking",
  sunflower: "happy"
})

export function speechForEvent(event, {level = 1} = {}) {
  if (!event || typeof event.type !== "string") return null
  const action = event.action ?? {}
  switch (event.type) {
    case "command_verified":
      if (typeof event.speech === "string" && event.speech.trim()) {
        return {
          text: event.speech.trim(),
          emotion: "happy",
          goal: "第 " + level + " 关"
        }
      }
      if (action.type === "plant") {
        const verb = PLANT_SPEECH[action.plant] ?? "种下去"
        return {
          text: "第" + action.row + "路，" + verb + "。",
          emotion: PLANT_EMOTION[action.plant] ?? "happy",
          goal: "第 " + level + " 关防守"
        }
      }
      if (action.type === "collect_sun") {
        return {text: "阳光收下。", emotion: "happy", goal: "第 " + level + " 关攒经济"}
      }
      if (action.type === "next_level") {
        return {text: "继续，下一关。", emotion: "excited", goal: "推进关卡"}
      }
      if (action.type === "enter_adventure") {
        return {text: "开局了，先看僵尸从哪路来。", emotion: "thinking", goal: "开局"}
      }
      if (action.type === "choose_seeds") {
        return {text: "这套卡组，够用了。", emotion: "happy", goal: "选卡"}
      }
      return null
    case "command_rejected":
      return {text: "这一步不行，换一个。", emotion: "thinking", goal: "调整"}
    case "command_abandoned":
      return {text: "刚才那一下没确认，稳住。", emotion: "thinking", goal: "核对状态"}
    case "level_summary":
      if (event.cleared) {
        return {text: "第 " + event.level + " 关，拿下！", emotion: "excited", goal: "过关"}
      }
      return {text: "第 " + event.level + " 关丢了，再来。", emotion: "sad", goal: "复盘"}
    case "finished":
      if (event.reason === "campaign_complete") {
        return {text: "十关打完，收工！", emotion: "excited", goal: "完成"}
      }
      if (event.reason === "lost") {
        return {text: "这局没守住，重来。", emotion: "sad", goal: "重开"}
      }
      return null
    case "narration":
      return typeof event.text === "string" && event.text
        ? {text: event.text, emotion: "happy", goal: "第 " + level + " 关"}
        : null
    case "agent_error":
      return {text: "脑子有点卡，我先稳住。", emotion: "tired", goal: "模型重试"}
    default:
      return null
  }
}

/** Keeps the avatar from babbling on every sun; level events always pass. */
export class SpeechThrottle {
  constructor({minIntervalMs = 4500, now = () => Date.now()} = {}) {
    this.minIntervalMs = minIntervalMs
    this.now = now
    this.lastAt = Number.NEGATIVE_INFINITY
  }

  accept(event) {
    const important = event.type === "level_summary" || event.type === "finished"
    const now = this.now()
    if (!important && now - this.lastAt < this.minIntervalMs) return false
    this.lastAt = now
    return true
  }
}
