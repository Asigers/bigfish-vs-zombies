/**
 * Audience interaction director.
 *
 * Votes are deduplicated and bounded. Recent comments are exposed to the AI as
 * untrusted audience context, never as instructions. Only validated poll
 * challenges become hard constraints in the game policy and native bridge.
 */
export class AudienceDirector {
  constructor({
    now = () => Date.now(),
    dedupeLimit = 4096,
    questionLimit = 32,
    messageLimit = 64,
    maxVoteOptions = 4
  } = {}) {
    this.now = now
    this.dedupeLimit = dedupeLimit
    this.questionLimit = questionLimit
    this.messageLimit = messageLimit
    this.maxVoteOptions = maxVoteOptions
    this.poll = null
    this.messageIds = new Set()
    this.questions = []
    this.messages = []
    this.activeBans = new Map()
    this.history = []
    this.version = 0
  }

  open({id, options, durationMs = 12000, now = this.now()}) {
    if (this.poll) throw new Error("poll_open")
    if (typeof id !== "string" || !id) throw new Error("bad_poll_id")
    if (!Array.isArray(options) || options.length < 2 || options.length > this.maxVoteOptions) {
      throw new Error("bad_options")
    }
    for (const option of options) {
      if (!option?.id || !option?.label) throw new Error("bad_options")
      if (option.challenge?.bannedPlants?.some((plant) => typeof plant !== "string")) {
        throw new Error("bad_challenge")
      }
    }
    this.poll = {
      id,
      options: options.map((option) => ({...option})),
      endAt: now + durationMs,
      votes: new Map(),
      openedAt: now
    }
    this.version += 1
    return this.summary()
  }

  comment({messageId, userId, content}, now = this.now()) {
    if (typeof messageId !== "string" || !messageId) return "invalid"
    if (typeof userId !== "string" || !userId) return "invalid"
    if (typeof content !== "string") return "invalid"
    if (this.messageIds.has(messageId)) return "duplicate"

    this.messageIds.add(messageId)
    if (this.messageIds.size > this.dedupeLimit) {
      this.messageIds.delete(this.messageIds.values().next().value)
    }

    const text = content.trim().replace(/\s+/g, " ").slice(0, 120)
    if (!text) return "ignored"

    const poll = this.poll
    if (poll && now < poll.endAt && /^[1-4]$/.test(text)) {
      const option = poll.options[Number(text) - 1]
      if (!option) return "ignored"
      if (poll.votes.has(userId)) return "already_voted"
      poll.votes.set(userId, option.id)
      this.version += 1
      return "voted"
    }

    if (this.messages.length < this.messageLimit) {
      this.messages.push({text, at: now})
      this.version += 1
    }

    if (/^(鱼|大肥鱼)[：:,，]?/.test(text) && this.questions.length < this.questionLimit) {
      this.questions.push({text, userId, at: now})
      return "question"
    }
    return "message"
  }

  summary() {
    if (!this.poll) return null
    const poll = this.poll
    const votes = [...poll.votes.values()]
    return {
      id: poll.id,
      openedAt: poll.openedAt,
      endAt: poll.endAt,
      total: votes.length,
      options: poll.options.map((option) => ({
        id: option.id,
        label: option.label,
        votes: votes.filter((vote) => vote === option.id).length
      }))
    }
  }

  /** Close the poll if it expired. Idempotent; returns null while still open. */
  close(now = this.now()) {
    if (!this.poll || now < this.poll.endAt) return null
    const result = this.summary()
    const definition = this.poll
    this.poll = null
    const ranked = [...result.options].sort((a, b) => b.votes - a.votes)
    const winnerId = result.total ? ranked[0].id : null
    const tied = result.total > 1 && ranked[0].votes === ranked[1].votes
    const effectiveWinner = tied ? definition.options[0].id : winnerId
    const winnerOption = definition.options.find((option) => option.id === effectiveWinner) ?? null

    if (winnerOption?.challenge) {
      for (const plant of winnerOption.challenge.bannedPlants ?? []) {
        this.activeBans.set(plant, {
          until: now + (winnerOption.challenge.durationMs ?? 60000),
          pollId: definition.id
        })
      }
    }

    const outcome = {
      ...result,
      winner: effectiveWinner,
      tied,
      challenge: winnerOption?.challenge ?? null
    }
    this.history.push({...outcome, closedAt: now})
    this.version += 1
    return outcome
  }

  challenge(now = this.now()) {
    const bannedPlants = []
    let changed = false
    for (const [plant, ban] of this.activeBans) {
      if (ban.until <= now) {
        this.activeBans.delete(plant)
        changed = true
      } else {
        bannedPlants.push(plant)
      }
    }
    if (changed) this.version += 1
    return {bannedPlants}
  }

  /** Non-destructive view; messages are acknowledged only after a model reply. */
  peekMessages(limit = 8) {
    return this.messages.slice(-limit).map((message) => ({...message}))
  }

  clearMessages() {
    this.messages = []
  }

  takeQuestions(limit = 5) {
    return this.questions.splice(0, limit)
  }
}
